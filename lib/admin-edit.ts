// Editing as admin (README "Admin API", "Editing as admin"): flowplan-admin
// changes the metadata, previews or package of a published template or of a
// submission that waits for review.
//
//   scope "template"   – the template's published version (listed or
//                        unpublished). Metadata and previews change that
//                        version in place: same number, its package is
//                        rebuilt (payload untouched, template.json and
//                        previews new, SHA-256 and size recomputed) and the
//                        edit is recorded on the version. A new package
//                        becomes a new published version "by admin".
//   scope "submission" – a version in submitted, in_review or
//                        changes_requested; everything changes that version
//                        in place, the status stays.
//
// Validation is the submit form's (lib/store.ts parseSubmissionForm), the
// package checks are inspectPackage()'s. The licence is the author's choice
// and can't be changed here. On official templates the changed metadata is
// remembered in templates.admin_overrides, so the next seed (lib/official.ts)
// keeps it; the payload still comes from seed/official.
import { createHash } from "node:crypto";
import { newId, now, one, run, transaction } from "./db";
import { HttpError, readBody } from "./http";
import { hit } from "./rate-limit";
import { audit, mailAuthor } from "./admin";
import { buildPackage, inspectPackage, LIMITS, type Finding, type Inspection, type Preview } from "./package";
import { insertVersion, nextVersionNumber, parseJsonColumn, parseSubmissionForm, slugInUse, versionFields, type SubmissionForm, type TemplateRow, type VersionRow } from "./store";
import { readPackage, savePackage, savePreviews } from "./storage";
import { sniffImage } from "./images";
import { PENDING } from "./status";
import { config } from "./config";
import { fieldLabels } from "./edit-labels";
import type { User } from "./auth";

export type EditScope = "template" | "submission";
export type { AdminEdit } from "./edit-labels";
import type { AdminEdit } from "./edit-labels";

// The editable metadata: API name → submit form field.
const META = {
  title: "title",
  "summary.de": "summaryDe",
  "summary.en": "summaryEn",
  "description.de": "descriptionDe",
  "description.en": "descriptionEn",
  category: "category",
  tags: "tags",
  language: "language",
  minVersion: "minVersion",
} as const satisfies Record<string, keyof SubmissionForm>;
type MetaName = keyof typeof META;
const META_NAMES = Object.keys(META) as MetaName[];
// Fields too long for the audit log's before/after: only their lengths.
const LONG = new Set<string>(["description.de", "description.en"]);
// Reported by the other endpoints, named in PATCH `also` for the e-mail.
const ALSO = ["previews", "package"] as const;

export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
const MESSAGE_MAX = 2000;

// ---- Targets ----

type Target = { scope: EditScope; template: TemplateRow; version: VersionRow; author: User };

function requireTarget(scope: EditScope, id: string): Target {
  let template: TemplateRow | undefined;
  let version: VersionRow | undefined;
  if (scope === "template") {
    template = one<TemplateRow>("SELECT * FROM templates WHERE id=? OR slug=?", id, id);
    if (!template?.published_version_id) throw new HttpError(404, "not_found", "Template not found.");
    if (template.withdrawn_at) throw new HttpError(409, "withdrawn", "The author withdrew this template.");
    version = one<VersionRow>("SELECT * FROM versions WHERE id=?", template.published_version_id)!;
  } else {
    version = one<VersionRow>("SELECT * FROM versions WHERE id=?", id);
    if (!version) throw new HttpError(404, "not_found", "Submission not found.");
    if (!PENDING.includes(version.status))
      throw new HttpError(409, "not_in_review", `Only submissions waiting for review can be edited here (this one is ${version.status}); published templates through /api/admin/templates/:id.`, { status: version.status });
    template = one<TemplateRow>("SELECT * FROM templates WHERE id=?", version.template_id)!;
  }
  const author = one<User>("SELECT * FROM users WHERE id=?", template.author_id)!;
  return { scope, template, version, author };
}

const formOf = (v: VersionRow): SubmissionForm => ({
  title: v.title,
  summaryDe: v.summary_de,
  summaryEn: v.summary_en,
  descriptionDe: v.description_de,
  descriptionEn: v.description_en,
  category: v.category as SubmissionForm["category"],
  tags: parseJsonColumn<string[]>(v.tags, []),
  language: v.language as SubmissionForm["language"],
  minVersion: v.min_version,
  license: v.license as SubmissionForm["license"],
  rights: true,
  changelog: v.changelog,
});
const valueOf = (form: SubmissionForm, name: MetaName) => form[META[name]] as string | string[];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// The stored package, checked again (it passed when it was stored).
async function storedInspection(v: VersionRow): Promise<Inspection> {
  const inspection = await inspectPackage(readPackage(v.id));
  if (!inspection.ok) throw new HttpError(409, "stored_package_invalid", "The stored package no longer passes the checks; replace it.", { findings: inspection.findings });
  return inspection;
}

// The package of version `number` with this metadata, slug and previews,
// checked like a submission. Throws 422 with the findings when it fails.
async function rebuild(t: Target, base: Inspection, form: SubmissionForm, slug: string, number: number, previews: Preview[]) {
  const bytes = buildPackage(
    { ...base, previews },
    {
      title: form.title,
      summary: { de: form.summaryDe, en: form.summaryEn },
      description: { de: form.descriptionDe, en: form.descriptionEn },
      category: form.category,
      tags: form.tags,
      minVersion: form.minVersion,
      language: form.language,
      license: form.license,
      author: { name: t.author.name, handle: t.author.handle },
      marketplace: { id: t.template.id, slug, version: number, url: `${config.publicUrl()}/t/${slug}` },
    },
  );
  const check = await inspectPackage(bytes);
  if (!check.ok) throw new HttpError(422, "package_invalid", "The edited package did not pass the checks.", { findings: check.findings });
  return { bytes, check };
}

// Writes a version rebuilt in place: files first (as the author's edit does),
// then the row, the slug and the official overrides in one transaction.
function saveInPlace(t: Target, form: SubmissionForm, check: Inspection, bytes: Buffer, edit: AdminEdit, extra: { slug?: string; overrides?: Record<string, unknown> } = {}) {
  savePackage(t.version.id, bytes);
  savePreviews(t.version.id, check.previews);
  const f = versionFields(form, check, bytes);
  const edits = [...parseJsonColumn<AdminEdit[]>(t.version.admin_edits, []), edit];
  transaction(() => {
    run(
      `UPDATE versions SET title=?,summary_de=?,summary_en=?,description_de=?,description_en=?,category=?,tags=?,min_version=?,language=?,manifest=?,findings=?,analysis=?,previews=?,size=?,sha256=?,admin_edits=?,updated_at=? WHERE id=?`,
      f.title,
      f.summary_de,
      f.summary_en,
      f.description_de,
      f.description_en,
      f.category,
      f.tags,
      f.min_version,
      f.language,
      f.manifest,
      f.findings,
      f.analysis,
      f.previews,
      f.size,
      f.sha256,
      JSON.stringify(edits),
      edit.at,
      t.version.id,
    );
    if (extra.slug && extra.slug !== t.template.slug) {
      run("UPDATE templates SET slug=?,updated_at=? WHERE id=?", extra.slug, edit.at, t.template.id);
      run("INSERT INTO slug_redirects(slug,template_id,created_at) VALUES(?,?,?) ON CONFLICT(slug) DO UPDATE SET template_id=excluded.template_id", t.template.slug, t.template.id, edit.at);
      // Renamed back: the address is the template's own again.
      run("DELETE FROM slug_redirects WHERE slug=? AND template_id=?", extra.slug, t.template.id);
    }
    if (extra.overrides) run("UPDATE templates SET admin_overrides=?,updated_at=? WHERE id=?", JSON.stringify(extra.overrides), edit.at, t.template.id);
  });
}

// Official templates: what the admin set wins over the next seed.
function officialOverrides(t: Target, form: SubmissionForm, changed: string[]) {
  if (!t.author.system) return undefined;
  const overrides = parseJsonColumn<Record<string, unknown>>(t.template.admin_overrides, {});
  for (const name of changed) {
    if (name === "previews") overrides.previews = true;
    else if (name in META) overrides[name] = valueOf(form, name as MetaName);
  }
  return overrides;
}

const answer = (t: Target, extra: Record<string, unknown> = {}) => {
  const template = one<TemplateRow>("SELECT * FROM templates WHERE id=?", t.template.id)!;
  const version = one<VersionRow>("SELECT * FROM versions WHERE id=?", (extra.versionId as string) ?? t.version.id)!;
  return {
    ok: true,
    scope: t.scope,
    templateId: template.id,
    versionId: version.id,
    slug: template.slug,
    number: version.number,
    status: version.status,
    sha256: version.sha256,
    size: version.size,
    findings: parseJsonColumn<Finding[]>(version.findings, []),
    official: !!t.author.system,
    adminOverrides: Object.keys(parseJsonColumn<Record<string, unknown>>(template.admin_overrides, {})),
    ...extra,
  };
};

const rateLimit = () => hit("admin-edit", 300, 3600);
const auditBase = (t: Target) => ({ scope: t.scope, template: t.template.id, slug: t.template.slug, number: t.version.number, status: t.version.status, official: !!t.author.system });

// ---- PATCH: metadata and slug ----

const ALLOWED = new Set(["title", "summary", "description", "category", "tags", "language", "minVersion", "slug", "notify", "message", "also"]);
const bad = (message: string, fields: string[]) => new HttpError(400, "invalid_form", message, { fields });

function readLocalized(body: Record<string, unknown>, key: "summary" | "description", form: Record<string, unknown>) {
  if (!(key in body)) return;
  const v = body[key];
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad(`${key} must be {de, en}.`, [key]);
  for (const [lang, text] of Object.entries(v)) {
    if (lang !== "de" && lang !== "en") throw bad(`${key} has only de and en.`, [`${key}.${lang}`]);
    if (typeof text !== "string") throw bad(`${key}.${lang} must be text.`, [`${key}.${lang}`]);
    form[`${key}${lang === "de" ? "De" : "En"}`] = text;
  }
}

export async function adminEdit(scope: EditScope, id: string, body: Record<string, unknown>, actor: string) {
  if ("license" in body) throw new HttpError(400, "license_readonly", "The licence is the author's choice and can't be changed by an admin.");
  const unknown = Object.keys(body).filter((k) => !ALLOWED.has(k));
  if (unknown.length) throw new HttpError(400, "unknown_field", `Unknown fields: ${unknown.join(", ")}`, { fields: unknown });
  const t = requireTarget(scope, id);
  const before = formOf(t.version);

  // The submit form with the changed fields, checked exactly like a submission.
  const input: Record<string, unknown> = { ...before };
  for (const key of ["title", "category", "language", "minVersion"] as const)
    if (key in body) {
      if (typeof body[key] !== "string") throw bad(`${key} must be text.`, [key]);
      input[key] = body[key];
    }
  readLocalized(body, "summary", input);
  readLocalized(body, "description", input);
  if ("tags" in body) {
    if (!Array.isArray(body.tags) || !body.tags.every((x) => typeof x === "string")) throw bad("tags must be a list of words.", ["tags"]);
    input.tags = body.tags;
  }
  const form = parseSubmissionForm(input);

  let slug = t.template.slug;
  if (body.slug !== undefined) {
    if (typeof body.slug !== "string") throw bad("slug must be text.", ["slug"]);
    slug = body.slug.trim().toLowerCase();
    if (!SLUG.test(slug)) throw new HttpError(400, "invalid_slug", "slug: a-z, 0-9 and -, at most 60 characters, not starting or ending with -.", { fields: ["slug"] });
    if (slug !== t.template.slug && slugInUse(slug, t.template.id)) throw new HttpError(409, "slug_taken", "Another template uses this address (or did, and it still redirects there).", { fields: ["slug"] });
  }
  if (body.notify !== undefined && typeof body.notify !== "boolean") throw bad("notify must be true or false.", ["notify"]);
  if (body.message !== undefined && typeof body.message !== "string") throw bad("message must be text.", ["message"]);
  const message = typeof body.message === "string" ? body.message.trim().slice(0, MESSAGE_MAX) : "";
  const also = body.also === undefined ? [] : body.also;
  if (!Array.isArray(also) || !also.every((x) => (ALSO as readonly string[]).includes(x as string)))
    throw bad(`also is a list of ${ALSO.join(", ")}.`, ["also"]);
  // Published: the author hears about it by default; in review a decision follows anyway.
  const notify = typeof body.notify === "boolean" ? body.notify : scope === "template";

  const metaChanged = META_NAMES.filter((name) => !same(valueOf(before, name), valueOf(form, name)));
  const changed = [...metaChanged, ...(slug !== t.template.slug ? ["slug"] : [])];
  const reported = [...changed, ...(also as string[]).filter((x) => !changed.includes(x))];
  if (!reported.length) throw new HttpError(400, "no_changes", "Nothing changed.");
  rateLimit();

  const at = now();
  const edit: AdminEdit = { at, by: actor, fields: reported, notify, ...(message ? { message } : {}) };
  if (changed.length) {
    const base = await storedInspection(t.version);
    const { bytes, check } = await rebuild(t, base, form, slug, t.version.number, base.previews);
    saveInPlace(t, form, check, bytes, edit, { slug, overrides: officialOverrides(t, form, metaChanged) });
  } else {
    // Only previews or the package changed (through their endpoints): record the note.
    const edits = [...parseJsonColumn<AdminEdit[]>(t.version.admin_edits, []), edit];
    run("UPDATE versions SET admin_edits=? WHERE id=?", JSON.stringify(edits), t.version.id);
  }

  const changes: Record<string, unknown> = {};
  for (const name of metaChanged)
    changes[name] = LONG.has(name)
      ? { fromLength: String(valueOf(before, name)).length, toLength: String(valueOf(form, name)).length }
      : { from: valueOf(before, name), to: valueOf(form, name) };
  if (slug !== t.template.slug) changes.slug = { from: t.template.slug, to: slug };

  let notified = false;
  if (notify) {
    const title = form.title;
    const link = t.scope === "template" && !t.template.unpublished_at ? `${config.publicUrl()}/t/${slug}` : `${config.publicUrl()}/me`;
    notified = await mailAuthor(
      t.template.author_id,
      [`„${title}“ wurde vom Prüfteam angepasst`, `"${title}" was adjusted by the review team`],
      [
        [`Ein Admin hat deine Vorlage „${title}“ angepasst: ${fieldLabels(reported, "de")}.`, ...(message ? ["", message] : []), "", link],
        [`An admin adjusted your template "${title}": ${fieldLabels(reported, "en")}.`, ...(message ? ["", message] : []), "", link],
      ],
    );
    if (notified) {
      const v = one<VersionRow>("SELECT admin_edits FROM versions WHERE id=?", t.version.id)!;
      const edits = parseJsonColumn<AdminEdit[]>(v.admin_edits, []);
      if (edits.length) edits[edits.length - 1].notified = true;
      run("UPDATE versions SET admin_edits=? WHERE id=?", JSON.stringify(edits), t.version.id);
    }
  }
  audit(actor, "admin_edit", t.version.id, { ...auditBase(t), fields: reported, changes, notify, notified, ...(message ? { message } : {}) }, at);
  return answer(t, { changed: reported, notified });
}

// ---- Previews ----

async function previewEdit(t: Target, actor: string, action: string, next: (current: Preview[]) => Preview[], details: Record<string, unknown>) {
  const base = await storedInspection(t.version);
  const previews = next(base.previews).map((p, i) => ({ ...p, n: i + 1 }));
  if (previews.length > LIMITS.previews) throw new HttpError(409, "preview_limit", `At most ${LIMITS.previews} previews.`, { count: previews.length });
  rateLimit();
  const form = formOf(t.version);
  const { bytes, check } = await rebuild(t, base, form, t.template.slug, t.version.number, previews);
  const at = now();
  saveInPlace(t, form, check, bytes, { at, by: actor, fields: ["previews"], notify: false }, { overrides: officialOverrides(t, form, ["previews"]) });
  audit(actor, action, t.version.id, { ...auditBase(t), ...details, before: base.previews.length, after: previews.length }, at);
  return answer(t, { changed: ["previews"], previews: check.previews.length });
}

// POST …/previews (multipart, one or more files in "preview"): appended.
export async function addPreviews(scope: EditScope, id: string, request: Request, actor: string) {
  const t = requireTarget(scope, id);
  const files = (await readMultipart(request, LIMITS.previews * LIMITS.previewBytes + 64 * 1024)).getAll("preview").filter((f): f is File => typeof f === "object");
  if (!files.length) throw new HttpError(400, "preview_missing", "Add at least one image in the field \"preview\".");
  const added: Preview[] = [];
  for (const file of files) {
    if (file.size > LIMITS.previewBytes) throw new HttpError(413, "preview_too_large", "A preview is larger than 1 MB.", { name: file.name });
    const bytes = Buffer.from(await file.arrayBuffer());
    const type = sniffImage(bytes);
    if (!type) throw new HttpError(415, "preview_type", "A preview is not a WebP, PNG or JPEG image (checked by its bytes).", { name: file.name });
    added.push({ n: 0, type, bytes });
  }
  return previewEdit(t, actor, "admin_previews_added", (current) => [...current, ...added], { added: added.length });
}

// DELETE …/previews/:n
export async function removePreview(scope: EditScope, id: string, n: number, actor: string) {
  const t = requireTarget(scope, id);
  const current = parseJsonColumn<{ n: number }[]>(t.version.previews, []);
  if (!current.some((p) => p.n === n)) throw new HttpError(404, "not_found", "Preview not found.");
  return previewEdit(t, actor, "admin_preview_removed", (list) => list.filter((p) => p.n !== n), { removed: n });
}

// POST …/previews/order {order: [n, …]} – every current number once.
export async function orderPreviews(scope: EditScope, id: string, body: Record<string, unknown>, actor: string) {
  const t = requireTarget(scope, id);
  const current = parseJsonColumn<{ n: number }[]>(t.version.previews, []).map((p) => p.n);
  const order = body.order;
  if (!Array.isArray(order) || order.length !== current.length || !current.every((n) => order.includes(n)) || new Set(order).size !== order.length)
    throw new HttpError(400, "invalid_order", `order must list every preview number once (${current.join(", ")}).`);
  if (same(order, current)) throw new HttpError(400, "no_changes", "Nothing changed.");
  return previewEdit(t, actor, "admin_previews_reordered", (list) => (order as number[]).map((n) => list.find((p) => p.n === n)!), { order });
}

// ---- Package ----

async function readMultipart(request: Request, limit: number): Promise<FormData> {
  const type = request.headers.get("content-type") || "";
  if (!/^multipart\/form-data/i.test(type)) throw new HttpError(400, "invalid_form", "Expected multipart form data.");
  const body = await readBody(request, limit);
  try {
    return await new Response(new Uint8Array(body), { headers: { "content-type": type } }).formData();
  } catch {
    throw new HttpError(400, "invalid_form", "Expected multipart form data.");
  }
}
const inspectionAnswer = (inspection: Inspection) => ({
  ok: inspection.ok,
  kind: inspection.manifest?.kind ?? null,
  findings: inspection.findings,
  analysis: inspection.analysis,
  size: inspection.size,
  sha256: inspection.sha256,
  previews: inspection.previews.length,
});

// POST …/package (multipart "package", optional "changelog"; ?dryRun=1 or a
// field dryRun=1 only checks). The package runs the normal checks; its
// payload replaces the old one, its previews too if it brings any (else the
// current ones stay); the metadata stays as stored (edit it with PATCH).
//   submission → that version in place; published template → a new
//   published version "by admin" (refused while another version waits).
export async function replacePackage(scope: EditScope, id: string, request: Request, actor: string) {
  const t = requireTarget(scope, id);
  const form = await readMultipart(request, LIMITS.packageBytes + 256 * 1024);
  const file = form.get("package");
  if (!file || typeof file !== "object") throw new HttpError(400, "package_missing", "Add the package in the field \"package\".");
  if (file.size > LIMITS.packageBytes) throw new HttpError(413, "too_large", "The package is larger than 25 MB.");
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1" || form.get("dryRun") === "1";
  const changelogField = form.get("changelog");
  const changelog = typeof changelogField === "string" ? changelogField.trim().slice(0, LIMITS.changelog) : "";
  rateLimit();
  const inspection = await inspectPackage(new Uint8Array(await file.arrayBuffer()));
  const kindMatches = inspection.manifest?.kind === t.template.kind;
  if (dryRun) return { dryRun: true, ...inspectionAnswer(inspection), kindMatches, scope: t.scope, official: !!t.author.system };
  if (!inspection.ok) throw new HttpError(422, "package_invalid", "The package did not pass the checks.", { findings: inspection.findings });
  if (!kindMatches) throw new HttpError(409, "kind_mismatch", `The package is a ${inspection.manifest!.kind}, the template a ${t.template.kind}.`);
  const current = await storedInspection(t.version).catch(() => null);
  const previews = inspection.previews.length ? inspection.previews : (current?.previews ?? []);
  const at = now();
  const edit: AdminEdit = { at, by: actor, fields: ["package"], notify: false };

  if (t.scope === "submission") {
    const meta = formOf(t.version);
    const { bytes, check } = await rebuild(t, inspection, meta, t.template.slug, t.version.number, previews);
    saveInPlace(t, meta, check, bytes, edit);
    audit(actor, "admin_package_replaced", t.version.id, { ...auditBase(t), sha256: check.sha256, size: bytes.length, uploaded: inspection.sha256 }, at);
    return answer(t, { changed: ["package"], newVersion: false });
  }

  if (t.template.unpublished_at) throw new HttpError(409, "not_listed", "Republish the template first; a new version of an unpublished template is not published.");
  if (one("SELECT 1 FROM versions WHERE template_id=? AND status IN ('submitted','in_review','changes_requested')", t.template.id))
    throw new HttpError(409, "pending_version", "A version of this template waits for review – edit that submission instead.");
  const meta = { ...formOf(t.version), changelog: changelog || "Paket vom Prüfteam ersetzt. / Package replaced by the review team." };
  const version = { id: newId(), number: nextVersionNumber(t.template.id) };
  const { bytes, check } = await rebuild(t, inspection, meta, t.template.slug, version.number, previews);
  savePackage(version.id, bytes);
  savePreviews(version.id, check.previews);
  transaction(() => {
    insertVersion(version, t.template.id, versionFields(meta, check, bytes), "published", at);
    run("UPDATE versions SET admin_edits=? WHERE id=?", JSON.stringify([edit]), version.id);
    run("UPDATE templates SET published_version_id=?,updated_at=? WHERE id=?", version.id, at, t.template.id);
    audit(actor, "admin_package_replaced", version.id, { ...auditBase(t), number: version.number, previous: t.version.number, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, uploaded: inspection.sha256 }, at);
  });
  return answer(t, { versionId: version.id, changed: ["package"], newVersion: true, previous: t.version.number });
}
