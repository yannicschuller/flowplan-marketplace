// Official templates: Flowplan's built-in templates, published by the
// built-in author "Flowplan" from the *.flowplan-template files in
// seed/official/ (generated in the Flowplan repository with
// `npm run marketplace-official`). Runs on every start (instrumentation.ts)
// and as `npm run seed-official`; running it twice changes nothing.
//
// Per file (the file name without extension is the template's stable key):
//   new key                      → new template, version 1, published
//   known key, other SHA-256     → new version, published at once (no review)
//   known key, same SHA-256      → nothing
//   template unpublished by an admin → left alone (never published again)
//   package fails the checks     → skipped with a warning; the rest goes on
// A file that disappears leaves its template as it is.
//
// Metadata an admin edited in flowplan-admin (templates.admin_overrides,
// lib/admin-edit.ts) wins over template.json in every later version, and
// previews an admin changed stay; the payload always comes from the file.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { newId, now, one, run, transaction } from "./db";
import { OFFICIAL_HANDLE, type User } from "./auth";
import { audit } from "./admin";
import { HttpError } from "./http";
import { LICENSES } from "./catalog";
import { inspectPackage, PACKAGE_EXTENSION, type Inspection, type Preview } from "./package";
import { readPreview } from "./storage";
import type { PreviewInfo, SubmissionForm, VersionRow } from "./store";
import { insertVersion, nextVersionNumber, parseJsonColumn, parseSubmissionForm, slugInUse, store, uniqueSlug, versionFields, type TemplateRow } from "./store";

export const OFFICIAL_ACTOR = "seed";
export const OFFICIAL_NAME = "Flowplan";
// Official templates may be shared freely unless the package says otherwise.
export const OFFICIAL_DEFAULT_LICENSE = "CC0-1.0";
const KEY = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

// MARKETPLACE_OFFICIAL_DIR, default ./seed/official (/app/seed/official in the image).
export const officialDir = () => resolve(/*turbopackIgnore: true*/ (process.env.MARKETPLACE_OFFICIAL_DIR || "").trim() || "./seed/official");

// The built-in author: no e-mail, no GitHub account, system = 1 – no way to
// sign in (lib/auth.ts refuses sessions for it).
export function officialAuthor(): User {
  const existing = one<User>("SELECT * FROM users WHERE system=1 ORDER BY created_at LIMIT 1");
  if (existing) return existing;
  const id = newId();
  // The handle is reserved, so only a database from before that could hold it.
  const handle = one("SELECT 1 FROM users WHERE handle=?", OFFICIAL_HANDLE) ? `${OFFICIAL_HANDLE}-${id.slice(0, 6)}` : OFFICIAL_HANDLE;
  run("INSERT INTO users(id,handle,name,email,github_id,github_login,created_at,system) VALUES(?,?,?,NULL,NULL,NULL,?,1)", id, handle, OFFICIAL_NAME, now());
  audit(OFFICIAL_ACTOR, "official_author_created", id, { handle });
  return one<User>("SELECT * FROM users WHERE id=?", id)!;
}

export type SeedResult = "created" | "updated" | "unchanged" | "skipped" | "invalid";
export type SeedOutcome = { file: string; key: string; result: SeedResult; slug?: string; version?: number; reason?: string };
type Log = Pick<Console, "info" | "warn">;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Skips and failures are logged on every start, but audited once per file content.
function auditOnce(action: string, file: string, sha: string, details: Record<string, unknown>) {
  if (one("SELECT 1 FROM audit WHERE action=? AND target=? AND json_extract(details,'$.sha256')=?", action, file, sha)) return;
  audit(OFFICIAL_ACTOR, action, file, { ...details, sha256: sha });
}

// The metadata comes from template.json: the package is the review.
function formOf(inspection: Inspection) {
  const m = inspection.manifest!;
  const raw = (inspection.rawManifest ?? {}) as Record<string, unknown>;
  const license = typeof raw.license === "string" && (LICENSES as readonly string[]).includes(raw.license) ? raw.license : OFFICIAL_DEFAULT_LICENSE;
  return parseSubmissionForm({
    title: m.title,
    titleDe: m.titles?.de ?? "",
    titleEn: m.titles?.en ?? "",
    summaryDe: m.summary.de ?? "",
    summaryEn: m.summary.en ?? "",
    descriptionDe: m.description?.de ?? "",
    descriptionEn: m.description?.en ?? "",
    category: m.category,
    tags: m.tags,
    language: m.language,
    minVersion: m.minVersion,
    license,
    rights: true,
    changelog: typeof raw.changelog === "string" ? raw.changelog : "",
  });
}

// What an admin set on the template (lib/admin-edit.ts) on top of the file's
// metadata; "previews": the current version's previews instead of the file's.
const OVERRIDE_FIELDS: Record<string, keyof SubmissionForm> = {
  title: "title",
  "title.de": "titleDe",
  "title.en": "titleEn",
  "summary.de": "summaryDe",
  "summary.en": "summaryEn",
  "description.de": "descriptionDe",
  "description.en": "descriptionEn",
  category: "category",
  tags: "tags",
  language: "language",
  minVersion: "minVersion",
};
function applyOverrides(template: TemplateRow, form: SubmissionForm, inspection: Inspection): { form: SubmissionForm; inspection: Inspection; fields: string[] } {
  const overrides = parseJsonColumn<Record<string, unknown>>(template.admin_overrides, {});
  const fields = Object.keys(overrides).filter((k) => k in OVERRIDE_FIELDS || k === "previews");
  if (!fields.length) return { form, inspection, fields };
  const input: Record<string, unknown> = { ...form };
  for (const k of fields) if (k in OVERRIDE_FIELDS) input[OVERRIDE_FIELDS[k]] = overrides[k];
  let next = inspection;
  if (overrides.previews && template.published_version_id) {
    const current = one<VersionRow>("SELECT * FROM versions WHERE id=?", template.published_version_id);
    const previews: Preview[] = parseJsonColumn<PreviewInfo[]>(current?.previews ?? "[]", []).map((p) => ({ n: p.n, type: p.type, bytes: readPreview(current!.id, p.n, p.type) }));
    next = { ...inspection, previews };
  }
  return { form: parseSubmissionForm(input), inspection: next, fields };
}

export function officialFiles(dir = officialDir()): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(PACKAGE_EXTENSION) && statSync(join(/*turbopackIgnore: true*/ dir, n)).isFile()).sort();
}

async function seedFile(dir: string, file: string): Promise<SeedOutcome> {
  const key = file.slice(0, -PACKAGE_EXTENSION.length);
  const out = (result: SeedResult, extra: Partial<SeedOutcome> = {}): SeedOutcome => ({ file, key, result, ...extra });
  const bytes = readFileSync(join(/*turbopackIgnore: true*/ dir, file));
  const sha = sha256(bytes);
  const invalid = (reason: string) => {
    auditOnce("official_invalid", file, sha, { reason });
    return out("invalid", { reason });
  };
  if (!KEY.test(key)) return invalid("file name must be a slug (a-z, 0-9, -; at most 60 characters)");
  const known = () => one<TemplateRow>("SELECT * FROM templates WHERE official_key=?", key);
  const before = known();
  if (before?.official_sha256 === sha) return out("unchanged", { slug: before.slug });
  if (before && (before.unpublished_at || before.withdrawn_at)) {
    auditOnce("official_skipped", file, sha, { template: before.id, slug: before.slug, reason: "unpublished" });
    return out("skipped", { slug: before.slug, reason: "unpublished by an admin – left alone" });
  }
  const inspection = await inspectPackage(bytes);
  if (!inspection.ok) return invalid(`package checks failed: ${inspection.findings.filter((f) => f.level === "error").map((f) => f.code).join(", ")}`);
  let form: ReturnType<typeof formOf>;
  try {
    form = formOf(inspection);
  } catch (error) {
    const fields = error instanceof HttpError && Array.isArray(error.extra.fields) ? (error.extra.fields as string[]) : [];
    return invalid(`template.json: ${error instanceof Error ? error.message : String(error)}${fields.length ? ` (${fields.join(", ")})` : ""}`);
  }
  const kind = inspection.manifest!.kind;
  if (before && before.kind !== kind) return invalid(`kind changed from ${before.kind} to ${kind}`);
  const author = officialAuthor();
  return transaction(() => {
    // Another process may have been quicker.
    let template = known();
    if (template?.official_sha256 === sha) return out("unchanged", { slug: template.slug });
    if (template && (template.unpublished_at || template.withdrawn_at)) return out("skipped", { slug: template.slug, reason: "unpublished by an admin – left alone" });
    const at = now();
    const created = !template;
    if (!template) {
      const id = newId();
      const slug = slugInUse(key) ? uniqueSlug(key) : key;
      run("INSERT INTO templates(id,slug,author_id,kind,created_at,updated_at,official_key) VALUES(?,?,?,?,?,?,?)", id, slug, author.id, kind, at, at, key);
      template = known()!;
    }
    const version = { id: newId(), number: nextVersionNumber(template.id) };
    const kept = applyOverrides(template, form, inspection);
    const stored = store(version, template, author, kept.inspection, kept.form);
    insertVersion(version, template.id, versionFields(kept.form, kept.inspection, stored), "published", at);
    run("UPDATE templates SET published_version_id=?,published_at=COALESCE(published_at,?),official_sha256=?,updated_at=? WHERE id=?", version.id, at, sha, at, template.id);
    audit(OFFICIAL_ACTOR, created ? "official_created" : "official_updated", template.id, {
      file,
      slug: template.slug,
      number: version.number,
      sha256: sha,
      ...(kept.fields.length ? { adminOverrides: kept.fields } : {}),
    });
    return out(created ? "created" : "updated", { slug: template.slug, version: version.number });
  });
}

// Publishes what is new or changed in the folder. Never throws for a single
// file: a broken package is logged and skipped.
export async function seedOfficial(opts: { dir?: string; log?: Log } = {}): Promise<SeedOutcome[]> {
  const dir = opts.dir ?? officialDir();
  const log = opts.log ?? console;
  const outcomes: SeedOutcome[] = [];
  for (const file of officialFiles(dir)) {
    let outcome: SeedOutcome;
    try {
      outcome = await seedFile(dir, file);
    } catch (error) {
      outcome = { file, key: file.slice(0, -PACKAGE_EXTENSION.length), result: "invalid", reason: error instanceof Error ? error.message : String(error) };
    }
    outcomes.push(outcome);
    if (outcome.result === "invalid") log.warn(`Official template ${file} skipped: ${outcome.reason}`);
    else if (outcome.result === "skipped") log.info(`Official template ${file}: ${outcome.reason}`);
    else if (outcome.result !== "unchanged") log.info(`Official template ${file}: ${outcome.result} /t/${outcome.slug} (version ${outcome.version})`);
  }
  return outcomes;
}

export const seedSummary = (outcomes: SeedOutcome[]) => {
  const n = (r: SeedResult) => outcomes.filter((o) => o.result === r).length;
  return `${outcomes.length} official template file(s): ${n("created")} new, ${n("updated")} updated, ${n("unchanged")} unchanged, ${n("skipped")} left alone, ${n("invalid")} invalid`;
};
