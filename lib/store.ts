// Templates and their versions: submitting, editing, withdrawing, and the
// public views of what is published.
import { z } from "zod";
import { createHash } from "node:crypto";
import { all, newId, now, one, run, transaction } from "./db";
import { CATEGORIES, LANGUAGES, LICENSES, type Kind } from "./catalog";
import { HttpError } from "./http";
import { slugify, type User } from "./auth";
import { buildPackage, forSubmission, inspectPackage, LIMITS, versionPattern, type Analysis, type Finding, type Inspection } from "./package";
import { readPackage, savePackage, savePreviews } from "./storage";
import { PENDING, transition, type Status } from "./status";
import { hit } from "./rate-limit";
import { config, requireEnglishTitle } from "./config";
import type { ImageType } from "./images";
import { localTitle, type Locale } from "./i18n";

export type TemplateRow = {
  id: string;
  slug: string;
  author_id: string;
  kind: Kind;
  published_version_id: string | null;
  published_at: number | null;
  unpublished_at: number | null;
  unpublish_reason: string | null;
  withdrawn_at: number | null;
  featured_rank: number | null;
  downloads: number;
  opens: number;
  created_at: number;
  updated_at: number;
  official_key: string | null;
  official_sha256: string | null;
  // Official templates: metadata an admin set (JSON, field → value; "previews": true) – lib/admin-edit.ts.
  admin_overrides: string;
};
export type VersionRow = {
  id: string;
  template_id: string;
  number: number;
  status: Status;
  // `title` is the template's own; title_de/title_en the title per interface
  // language when the package brings them (official templates), else ''.
  title: string;
  title_de: string;
  title_en: string;
  summary_de: string;
  summary_en: string;
  description_de: string;
  description_en: string;
  category: string;
  tags: string;
  min_version: string;
  language: string;
  license: string;
  changelog: string;
  manifest: string;
  findings: string;
  analysis: string;
  previews: string;
  size: number;
  sha256: string;
  review_message: string;
  downloads: number;
  submitted_at: number;
  updated_at: number;
  decided_at: number | null;
  published_at: number | null;
  // Edits made in flowplan-admin (JSON list of AdminEdit, lib/admin-edit.ts).
  admin_edits: string;
};
export type PreviewInfo = { n: number; type: ImageType };

// ---- The submit form ----

const text = (max: number) => z.string().trim().max(max).default("");
export const submissionFormSchema = z.object({
  title: z.string().trim().min(2).max(LIMITS.title),
  // The title in German and English (template.json `titles`): authors must
  // give the English one (parseAuthorForm); admin edits and the official
  // seed go through parseSubmissionForm.
  titleDe: text(LIMITS.title),
  titleEn: text(LIMITS.title),
  summaryDe: text(LIMITS.summary),
  summaryEn: text(LIMITS.summary),
  descriptionDe: text(LIMITS.description),
  descriptionEn: text(LIMITS.description),
  category: z.enum(CATEGORIES),
  tags: z
    .array(z.string().trim().toLowerCase().min(1).max(LIMITS.tag))
    .max(LIMITS.tags)
    .default([])
    .transform((tags) => [...new Set(tags)]),
  language: z.enum(LANGUAGES),
  minVersion: z.string().trim().regex(versionPattern),
  license: z.enum(LICENSES),
  rights: z.literal(true),
  changelog: text(LIMITS.changelog),
});
export type SubmissionForm = z.infer<typeof submissionFormSchema>;

export function parseSubmissionForm(input: unknown): SubmissionForm {
  const parsed = submissionFormSchema.safeParse(input);
  if (!parsed.success)
    throw new HttpError(400, "invalid_form", "Please check the form.", {
      fields: parsed.error.issues.map((i) => i.path.join(".")),
    });
  if (!parsed.data.summaryDe && !parsed.data.summaryEn) throw new HttpError(400, "invalid_form", "A summary is needed.", { fields: ["summaryDe", "summaryEn"] });
  return parsed.data;
}

// The title in the template's own language (template.json `title`, for
// readers that don't know `titles`): the German one for German content when
// there is one, else the English one.
export const ownTitle = (language: unknown, de: string, en: string) => (language === "de" && de ? de : en);

// What an author sends (new template, new version, edited submission): the
// English title is required, the German one optional, and `title` follows
// from them (a `title` sent along is ignored).
export function parseAuthorForm(input: unknown): SubmissionForm {
  const raw: Record<string, unknown> = input && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};
  const de = typeof raw.titleDe === "string" ? raw.titleDe.trim() : "";
  let en = typeof raw.titleEn === "string" ? raw.titleEn.trim() : "";
  if (!en && requireEnglishTitle()) throw new HttpError(400, "invalid_form", "An English title is needed (titleEn).", { fields: ["titleEn"] });
  // Until the English title is required (lib/config.ts), the German or the
  // single title of an older form stands in for it.
  if (!en) en = de || (typeof raw.title === "string" ? raw.title.trim() : "");
  if (!en) throw new HttpError(400, "invalid_form", "A title is needed.", { fields: ["titleDe", "titleEn"] });
  if (de.length === 1) throw new HttpError(400, "invalid_form", "The German title needs at least 2 characters.", { fields: ["titleDe"] });
  if (en.length === 1) throw new HttpError(400, "invalid_form", "The English title needs at least 2 characters.", { fields: ["titleEn"] });
  raw.title = ownTitle(raw.language, de, en);
  return parseSubmissionForm(raw);
}

// A slug is taken by a template's current address or by an old address that
// still redirects (to another template than `except`).
export function slugInUse(slug: string, except = "") {
  return !!(
    one("SELECT 1 FROM templates WHERE slug=? AND id<>?", slug, except) || one("SELECT 1 FROM slug_redirects WHERE slug=? AND template_id<>?", slug, except)
  );
}
export function uniqueSlug(title: string) {
  const root = slugify(title, 60);
  for (let i = 0; i < 1000; i++) {
    const slug = i ? `${root}-${i + 1}` : root;
    if (!slugInUse(slug)) return slug;
  }
  return `${root}-${newId().slice(0, 8)}`;
}
// The current slug of a template that was renamed (null: no such old address).
export function movedSlug(slug: string): string | null {
  return one<{ slug: string }>("SELECT t.slug FROM slug_redirects r JOIN templates t ON t.id=r.template_id WHERE r.slug=?", slug)?.slug ?? null;
}

const templateUrl = (slug: string) => `${config.publicUrl()}/t/${slug}`;

export function store(version: { id: string; number: number }, template: { id: string; slug: string }, user: User, inspection: Inspection, form: SubmissionForm) {
  const bytes = buildPackage(inspection, {
    title: form.title,
    titles: { de: form.titleDe, en: form.titleEn },
    summary: { de: form.summaryDe, en: form.summaryEn },
    description: { de: form.descriptionDe, en: form.descriptionEn },
    category: form.category,
    tags: form.tags,
    minVersion: form.minVersion,
    language: form.language,
    license: form.license,
    author: { name: user.name, handle: user.handle },
    marketplace: { id: template.id, slug: template.slug, version: version.number, url: templateUrl(template.slug) },
  });
  savePackage(version.id, bytes);
  savePreviews(version.id, inspection.previews);
  return bytes;
}
export const versionFields = (form: SubmissionForm, inspection: Inspection, bytes: Buffer) => {
  return {
    title: form.title,
    title_de: form.titleDe,
    title_en: form.titleEn,
    summary_de: form.summaryDe,
    summary_en: form.summaryEn,
    description_de: form.descriptionDe,
    description_en: form.descriptionEn,
    category: form.category,
    tags: JSON.stringify(form.tags),
    min_version: form.minVersion,
    language: form.language,
    license: form.license,
    changelog: form.changelog,
    manifest: JSON.stringify(inspection.rawManifest),
    findings: JSON.stringify(inspection.findings),
    analysis: JSON.stringify(inspection.analysis),
    previews: JSON.stringify(inspection.previews.map((p) => ({ n: p.n, type: p.type }))),
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};
const rejectFindings = (inspection: Inspection) => {
  if (!inspection.ok)
    throw new HttpError(422, "package_invalid", "The package did not pass the checks.", {
      findings: inspection.findings,
    });
};

// A new template, or a new version of one of the author's templates.
export async function submit(user: User, packageBytes: Uint8Array, formInput: unknown, opts: { templateId?: string | null } = {}) {
  const form = parseAuthorForm(formInput);
  hit(`submit:${user.id}`, 20, 86_400);
  const inspection = forSubmission(await inspectPackage(packageBytes));
  rejectFindings(inspection);
  const kind = inspection.manifest!.kind;
  const at = now();
  return transaction(() => {
    let template: TemplateRow;
    if (opts.templateId) {
      template = requireOwnTemplate(user, opts.templateId);
      if (template.withdrawn_at) throw new HttpError(409, "withdrawn", "This template was withdrawn.");
      if (template.kind !== kind) throw new HttpError(409, "kind_mismatch", "A new version must be of the same kind.");
      if (one("SELECT 1 FROM versions WHERE template_id=? AND status IN ('submitted','in_review','changes_requested')", template.id))
        throw new HttpError(409, "pending_version", "A version of this template is still waiting for review.");
    } else {
      template = {
        id: newId(),
        slug: uniqueSlug(form.title),
        author_id: user.id,
        kind,
        published_version_id: null,
        published_at: null,
        unpublished_at: null,
        unpublish_reason: null,
        withdrawn_at: null,
        featured_rank: null,
        downloads: 0,
        opens: 0,
        created_at: at,
        updated_at: at,
        official_key: null,
        official_sha256: null,
        admin_overrides: "{}",
      };
      run("INSERT INTO templates(id,slug,author_id,kind,created_at,updated_at) VALUES(?,?,?,?,?,?)", template.id, template.slug, user.id, kind, at, at);
    }
    const number = nextVersionNumber(template.id);
    const version = { id: newId(), number };
    const bytes = store(version, template, user, inspection, form);
    const f = versionFields(form, inspection, bytes);
    insertVersion(version, template.id, f, "submitted", at);
    run("UPDATE templates SET updated_at=? WHERE id=?", at, template.id);
    return { templateId: template.id, slug: template.slug, versionId: version.id, number, findings: inspection.findings };
  });
}

// One version row; "published" (official templates) is decided at once.
export function insertVersion(version: { id: string; number: number }, templateId: string, f: ReturnType<typeof versionFields>, status: "submitted" | "published", at: number) {
  const decided = status === "published" ? at : null;
  run(
    `INSERT INTO versions(id,template_id,number,status,title,title_de,title_en,summary_de,summary_en,description_de,description_en,category,tags,min_version,language,license,changelog,manifest,findings,analysis,previews,size,sha256,submitted_at,updated_at,decided_at,published_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    version.id,
    templateId,
    version.number,
    status,
    f.title,
    f.title_de,
    f.title_en,
    f.summary_de,
    f.summary_en,
    f.description_de,
    f.description_en,
    f.category,
    f.tags,
    f.min_version,
    f.language,
    f.license,
    f.changelog,
    f.manifest,
    f.findings,
    f.analysis,
    f.previews,
    f.size,
    f.sha256,
    at,
    at,
    decided,
    decided,
  );
}
export const nextVersionNumber = (templateId: string) => (one<{ n: number | null }>("SELECT MAX(number) AS n FROM versions WHERE template_id=?", templateId)?.n ?? 0) + 1;

// Changing a submission that waits (submitted) or came back (changes
// requested → submitted again). Without a new package the stored one is
// checked again and rewritten with the new metadata.
export async function editSubmission(user: User, versionId: string, packageBytes: Uint8Array | null, formInput: unknown) {
  const form = parseAuthorForm(formInput);
  hit(`submit:${user.id}`, 40, 86_400);
  const version = requireOwnVersion(user, versionId);
  const next = transition(version.status, version.status === "changes_requested" ? "resubmit" : "edit", "author");
  const template = one<TemplateRow>("SELECT * FROM templates WHERE id=?", version.template_id)!;
  // A new package must bring its English title; the stored one was rebuilt
  // with the form's titles (and may predate the rule).
  const inspection = packageBytes ? forSubmission(await inspectPackage(packageBytes)) : await inspectPackage(readPackage(version.id));
  rejectFindings(inspection);
  if (inspection.manifest!.kind !== template.kind) throw new HttpError(409, "kind_mismatch", "A new version must be of the same kind.");
  const at = now();
  const bytes = store(version, template, user, inspection, form);
  const f = versionFields(form, inspection, bytes);
  run(
    `UPDATE versions SET status=?,title=?,title_de=?,title_en=?,summary_de=?,summary_en=?,description_de=?,description_en=?,category=?,tags=?,min_version=?,language=?,license=?,changelog=?,manifest=?,findings=?,analysis=?,previews=?,size=?,sha256=?,updated_at=?,submitted_at=? WHERE id=?`,
    next,
    f.title,
    f.title_de,
    f.title_en,
    f.summary_de,
    f.summary_en,
    f.description_de,
    f.description_en,
    f.category,
    f.tags,
    f.min_version,
    f.language,
    f.license,
    f.changelog,
    f.manifest,
    f.findings,
    f.analysis,
    f.previews,
    f.size,
    f.sha256,
    at,
    at,
    version.id,
  );
  return { templateId: template.id, slug: template.slug, versionId: version.id, number: version.number, status: next, findings: inspection.findings };
}

export function requireOwnTemplate(user: User, templateId: string) {
  const template = one<TemplateRow>("SELECT * FROM templates WHERE id=?", templateId);
  if (!template || template.author_id !== user.id) throw new HttpError(404, "not_found", "Template not found.");
  return template;
}
export function requireOwnVersion(user: User, versionId: string) {
  const version = one<VersionRow & { author_id: string }>("SELECT v.*, t.author_id FROM versions v JOIN templates t ON t.id=v.template_id WHERE v.id=?", versionId);
  if (!version || version.author_id !== user.id) throw new HttpError(404, "not_found", "Submission not found.");
  return version;
}

// The author takes a submission back; for the published version the whole
// template leaves the marketplace (pending versions with it).
export function withdraw(user: User, versionId: string) {
  const version = requireOwnVersion(user, versionId);
  const to = transition(version.status, "withdraw", "author");
  const at = now();
  transaction(() => {
    if (version.status === "published") {
      run("UPDATE templates SET withdrawn_at=?,featured_rank=NULL,updated_at=? WHERE id=?", at, at, version.template_id);
      run("UPDATE versions SET status='withdrawn',updated_at=? WHERE template_id=? AND status IN ('published','submitted','in_review','changes_requested')", at, version.template_id);
    } else run("UPDATE versions SET status=?,updated_at=? WHERE id=?", to, at, version.id);
  });
  return { status: to };
}

// ---- What the author sees ----

export function mySubmissions(user: User) {
  const templates = all<TemplateRow>("SELECT * FROM templates WHERE author_id=? ORDER BY updated_at DESC", user.id);
  return templates.map((t) => ({
    template: t,
    versions: all<VersionRow>("SELECT * FROM versions WHERE template_id=? ORDER BY number DESC", t.id),
  }));
}

// ---- What everybody sees ----

// `locale`: the visitor's interface language – sorting by title uses the title they see.
export type PublicFilters = { kind?: string; category?: string; q?: string; lang?: string; sort?: string; author?: string; limit?: number; offset?: number; featured?: boolean; official?: boolean; locale?: Locale };
const PUBLIC_JOIN = `FROM templates t JOIN versions v ON v.id=t.published_version_id JOIN users u ON u.id=t.author_id
  WHERE t.unpublished_at IS NULL AND t.withdrawn_at IS NULL AND v.status='published'`;
export type PublicRow = VersionRow & {
  t_id: string;
  slug: string;
  kind: Kind;
  t_published_at: number;
  t_updated_at: number;
  t_downloads: number;
  opens: number;
  featured_rank: number | null;
  author_name: string;
  author_handle: string;
  // 1: published by the built-in author "Flowplan" (lib/official.ts).
  official: number;
};
const PUBLIC_SELECT = `SELECT v.*, t.id AS t_id, t.slug, t.kind, t.published_at AS t_published_at, t.updated_at AS t_updated_at, t.downloads AS t_downloads, t.opens, t.featured_rank, u.name AS author_name, u.handle AS author_handle, u.system AS official ${PUBLIC_JOIN}`;

// The title a visitor sees (lib/i18n.ts localTitle), in SQL; without a
// locale (the public API) the template's own title.
const titleSql = (locale?: Locale) =>
  !locale
    ? "v.title"
    : locale === "de"
      ? "COALESCE(NULLIF(v.title_de,''),NULLIF(v.title_en,''),v.title)"
      : "COALESCE(NULLIF(v.title_en,''),NULLIF(v.title_de,''),v.title)";

export function publicTemplates(filters: PublicFilters = {}) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filters.kind) {
    where.push("t.kind=?");
    params.push(filters.kind);
  }
  if (filters.category) {
    where.push("v.category=?");
    params.push(filters.category);
  }
  if (filters.lang) {
    where.push("(v.language=? OR v.language='multi')");
    params.push(filters.lang);
  }
  if (filters.author) {
    where.push("u.handle=?");
    params.push(filters.author);
  }
  if (filters.featured) where.push("t.featured_rank IS NOT NULL");
  if (filters.official) where.push("u.system=1");
  const q = filters.q?.trim().slice(0, 100);
  if (q)
    for (const word of q.split(/\s+/).slice(0, 5)) {
      const like = `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(
        "(v.title LIKE ? ESCAPE '\\' OR v.title_de LIKE ? ESCAPE '\\' OR v.title_en LIKE ? ESCAPE '\\' OR v.summary_de LIKE ? ESCAPE '\\' OR v.summary_en LIKE ? ESCAPE '\\' OR v.tags LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')",
      );
      params.push(like, like, like, like, like, like, like);
    }
  const order =
    filters.featured
      ? "t.featured_rank ASC"
      : ({
          popular: "(t.downloads + t.opens) DESC, t.published_at DESC",
          updated: "v.published_at DESC",
          title: `${titleSql(filters.locale)} COLLATE NOCASE ASC`,
          newest: "t.published_at DESC",
        } as Record<string, string>)[filters.sort || "newest"] ?? "t.published_at DESC";
  const extra = where.length ? ` AND ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(Math.trunc(filters.limit ?? 24), 1), 100);
  const offset = Math.max(Math.trunc(filters.offset ?? 0), 0);
  const rows = all<PublicRow>(`${PUBLIC_SELECT}${extra} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, offset);
  const total = one<{ n: number }>(`SELECT COUNT(*) AS n ${PUBLIC_JOIN}${extra}`, ...params)?.n ?? 0;
  return { rows, total };
}
export function publicTemplate(slug: string) {
  return one<PublicRow>(`${PUBLIC_SELECT} AND t.slug=?`, slug) ?? null;
}
export function publishedVersions(templateId: string) {
  return all<VersionRow>("SELECT * FROM versions WHERE template_id=? AND status='published' ORDER BY number DESC", templateId);
}
export const categoryCounts = () =>
  all<{ category: string; n: number }>(`SELECT v.category, COUNT(*) AS n ${PUBLIC_JOIN} GROUP BY v.category`);
export const kindCounts = () => all<{ kind: string; n: number }>(`SELECT t.kind, COUNT(*) AS n ${PUBLIC_JOIN} GROUP BY t.kind`);

// The package of a published version (the current one by default).
export function downloadable(slug: string, versionNumber?: number | null) {
  const row = publicTemplate(slug);
  if (!row) return null;
  const version = versionNumber
    ? one<VersionRow>("SELECT * FROM versions WHERE template_id=? AND number=? AND status='published'", row.t_id, versionNumber)
    : (row as VersionRow);
  if (!version) return null;
  return { template: row, version };
}
export function countDownload(templateId: string, versionId: string, via: "download" | "open") {
  if (via === "open") run("UPDATE templates SET opens=opens+1 WHERE id=?", templateId);
  else {
    run("UPDATE templates SET downloads=downloads+1 WHERE id=?", templateId);
    run("UPDATE versions SET downloads=downloads+1 WHERE id=?", versionId);
  }
}

// ---- Shapes for the APIs ----

export const parseJsonColumn = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};
// `r` changes with the package (an admin may change the previews of a
// version in place), so the long-cached images never go stale.
const previewRev = (version: { sha256: string }) => version.sha256.slice(0, 12);
const previewUrls = (slug: string, version: VersionRow) =>
  parseJsonColumn<PreviewInfo[]>(version.previews, []).map((p) => `${config.publicUrl()}/api/templates/${slug}/previews/${p.n}?version=${version.number}&r=${previewRev(version)}`);

export function templateSummary(row: PublicRow) {
  const previews = previewUrls(row.slug, row);
  return {
    id: row.t_id,
    slug: row.slug,
    url: templateUrl(row.slug),
    kind: row.kind,
    title: row.title,
    // The title per interface language; a missing one falls back to `title`.
    titles: { de: localTitle("de", row), en: localTitle("en", row) },
    summary: { de: row.summary_de, en: row.summary_en },
    category: row.category,
    tags: parseJsonColumn<string[]>(row.tags, []),
    language: row.language,
    minVersion: row.min_version,
    license: row.license,
    version: row.number,
    author: { name: row.author_name, handle: row.author_handle, url: `${config.publicUrl()}/u/${row.author_handle}` },
    publishedAt: new Date(row.t_published_at).toISOString(),
    updatedAt: new Date(row.published_at ?? row.t_published_at).toISOString(),
    downloads: row.t_downloads,
    opens: row.opens,
    featured: row.featured_rank !== null,
    official: !!row.official,
    previewUrl: previews[0] ?? null,
    previews,
    downloadUrl: `${config.publicUrl()}/api/templates/${row.slug}/download`,
  };
}
export function templateDetail(row: PublicRow) {
  return {
    ...templateSummary(row),
    description: { de: row.description_de, en: row.description_en },
    size: row.size,
    sha256: row.sha256,
    analysis: parseJsonColumn<Analysis>(row.analysis, {}),
    versions: publishedVersions(row.t_id).map((v) => ({
      number: v.number,
      publishedAt: v.published_at ? new Date(v.published_at).toISOString() : null,
      changelog: v.changelog,
      minVersion: v.min_version,
      size: v.size,
      sha256: v.sha256,
      downloadUrl: `${config.publicUrl()}/api/templates/${row.slug}/download?version=${v.number}`,
    })),
  };
}
export const findingsOf = (v: VersionRow) => parseJsonColumn<Finding[]>(v.findings, []);
export const pendingStatuses = PENDING;
