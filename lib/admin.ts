// The admin API for flowplan-admin (contract §4): bearer token
// MARKETPLACE_ADMIN_TOKEN, JSON in and out, every change in the audit log
// (who = the token's label, plus the person flowplan-admin names in the
// optional X-Admin-User header).
import { all, now, one, run, transaction } from "./db";
import { config } from "./config";
import { HttpError, clientIp, json, readJson } from "./http";
import { RateLimitError, allow, ipKey } from "./rate-limit";
import { safeEqual } from "./secret";
import { transition, STATUSES, PENDING, isStatus, type Status } from "./status";
import { findingsOf, parseJsonColumn, type PreviewInfo, type TemplateRow, type VersionRow } from "./store";
import { readPackage, readPreview } from "./storage";
import { IMAGE_MIME } from "./images";
import { sendMail } from "./mail";
import { deleteAccount, requireDeletableUser } from "./account";
import type { Analysis, Finding } from "./package";
import type { User } from "./auth";

// ---- Auth and audit ----

export function requireAdmin(request: Request): string {
  const token = config.adminToken();
  if (!token) throw new HttpError(404, "admin_off", "The admin API is not enabled.");
  const failures = `admin-fail:${ipKey(clientIp(request))}`;
  const row = one<{ count: number; window_start: number }>("SELECT count,window_start FROM rate_limits WHERE key=?", failures);
  if (row && row.count >= 20 && now() - row.window_start < 600_000) throw new RateLimitError(Math.ceil((row.window_start + 600_000 - now()) / 1000));
  const header = request.headers.get("authorization") || "";
  const sent = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() || "";
  if (!sent || !safeEqual(sent, token)) {
    allow(failures, 1_000_000, 600);
    throw new HttpError(401, "unauthorized", "Invalid admin token.");
  }
  const person = (request.headers.get("x-admin-user") || "").replace(/[^\p{L}\p{N} ._@+-]/gu, "").trim().slice(0, 100);
  return person ? `${config.adminTokenLabel()} (${person})` : config.adminTokenLabel();
}

export function audit(actor: string, action: string, target: string, details: Record<string, unknown> = {}, at = now()) {
  run("INSERT INTO audit(at,actor,action,target,details) VALUES(?,?,?,?,?)", at, actor, action, target, JSON.stringify(details));
}

// ---- Shapes ----

type VersionWithTemplate = VersionRow & {
  slug: string;
  kind: string;
  author_id: string;
  published_version_id: string | null;
  unpublished_at: number | null;
  withdrawn_at: number | null;
};
const SELECT_VERSION = "SELECT v.*, t.slug, t.kind, t.author_id, t.published_version_id, t.unpublished_at, t.withdrawn_at FROM versions v JOIN templates t ON t.id=v.template_id";

const iso = (at: number | null | undefined) => (at ? new Date(at).toISOString() : null);
const templateState = (t: { published_version_id: string | null; unpublished_at: number | null; withdrawn_at: number | null }) =>
  t.withdrawn_at ? "withdrawn" : t.unpublished_at ? "unpublished" : t.published_version_id ? "listed" : "unlisted";
const authorOf = (id: string) => {
  const u = one<User>("SELECT * FROM users WHERE id=?", id)!;
  // official: the built-in author "Flowplan" of the official templates (lib/official.ts).
  return { id: u.id, name: u.name, handle: u.handle, email: u.email, github: u.github_login, since: iso(u.created_at), blocked: !!u.blocked_at, official: !!u.system };
};
const counts = (findings: Finding[]) => ({
  error: findings.filter((f) => f.level === "error").length,
  warning: findings.filter((f) => f.level === "warning").length,
  info: findings.filter((f) => f.level === "info").length,
});
const adminBase = () => `${config.publicUrl()}/api/admin`;

function submissionSummary(v: VersionWithTemplate) {
  const findings = findingsOf(v);
  const previews = parseJsonColumn<PreviewInfo[]>(v.previews, []);
  const author = authorOf(v.author_id);
  return {
    id: v.id,
    templateId: v.template_id,
    slug: v.slug,
    number: v.number,
    status: v.status,
    kind: v.kind,
    title: v.title,
    summary: { de: v.summary_de, en: v.summary_en },
    category: v.category,
    tags: parseJsonColumn<string[]>(v.tags, []),
    language: v.language,
    minVersion: v.min_version,
    license: v.license,
    changelog: v.changelog,
    size: v.size,
    sha256: v.sha256,
    previewCount: previews.length,
    findings,
    findingCounts: counts(findings),
    analysis: parseJsonColumn<Analysis>(v.analysis, {}),
    reviewMessage: v.review_message,
    isUpdate: !!v.published_version_id && v.published_version_id !== v.id,
    templateState: templateState(v),
    official: author.official,
    author,
    submittedAt: iso(v.submitted_at),
    updatedAt: iso(v.updated_at),
    decidedAt: iso(v.decided_at),
    publishedAt: iso(v.published_at),
    publicUrl: v.published_version_id && !v.unpublished_at && !v.withdrawn_at ? `${config.publicUrl()}/t/${v.slug}` : null,
    packageUrl: `${adminBase()}/submissions/${v.id}/package`,
  };
}

// What changed against the published version (for updates).
function versionDiff(v: VersionRow, base: VersionRow | undefined) {
  if (!base || base.id === v.id) return null;
  const fields: [string, keyof VersionRow][] = [
    ["title", "title"],
    ["summary.de", "summary_de"],
    ["summary.en", "summary_en"],
    ["description.de", "description_de"],
    ["description.en", "description_en"],
    ["category", "category"],
    ["tags", "tags"],
    ["minVersion", "min_version"],
    ["language", "language"],
    ["license", "license"],
  ];
  const a = parseJsonColumn<Analysis>(base.analysis, {});
  const b = parseJsonColumn<Analysis>(v.analysis, {});
  const set = (x?: string[]) => new Set(x ?? []);
  const added = (from?: string[], to?: string[]) => [...set(to)].filter((x) => !set(from).has(x));
  return {
    against: base.number,
    changedFields: fields.filter(([, column]) => base[column] !== v[column]).map(([name]) => name),
    sizeDelta: v.size - base.size,
    previewsBefore: parseJsonColumn<PreviewInfo[]>(base.previews, []).length,
    previewsAfter: parseJsonColumn<PreviewInfo[]>(v.previews, []).length,
    payloadChanged: JSON.stringify(a) !== JSON.stringify(b) || base.sha256 !== v.sha256,
    ...(a.workflow || b.workflow
      ? {
          workflow: {
            nodeTypesAdded: added(Object.keys(a.workflow?.nodeTypes ?? {}), Object.keys(b.workflow?.nodeTypes ?? {})),
            nodeTypesRemoved: added(Object.keys(b.workflow?.nodeTypes ?? {}), Object.keys(a.workflow?.nodeTypes ?? {})),
            hostsAdded: added(a.workflow?.hosts, b.workflow?.hosts),
            hostsRemoved: added(b.workflow?.hosts, a.workflow?.hosts),
          },
        }
      : {}),
  };
}

function requireVersion(id: string) {
  const v = one<VersionWithTemplate>(`${SELECT_VERSION} WHERE v.id=?`, id);
  if (!v) throw new HttpError(404, "not_found", "Submission not found.");
  return v;
}
function requireTemplate(id: string) {
  const t = one<TemplateRow>("SELECT * FROM templates WHERE id=? OR slug=?", id, id);
  if (!t) throw new HttpError(404, "not_found", "Template not found.");
  return t;
}

// ---- Handlers ----

export function listSubmissions(statusParam: string | null) {
  const wanted = (statusParam ? statusParam.split(",").map((s) => s.trim()) : PENDING).filter(Boolean);
  if (!wanted.every((s) => s === "all" || isStatus(s))) throw new HttpError(400, "invalid_status", `status must be one of ${STATUSES.join(", ")}, all`);
  const statuses = wanted.includes("all") ? [...STATUSES] : (wanted as Status[]);
  const rows = all<VersionWithTemplate>(`${SELECT_VERSION} WHERE v.status IN (${statuses.map(() => "?").join(",")}) ORDER BY v.submitted_at ASC`, ...statuses);
  return { submissions: rows.map(submissionSummary) };
}

export function submissionDetail(id: string, actor: string) {
  let v = requireVersion(id);
  // Opening a fresh submission starts its review.
  if (v.status === "submitted") {
    const to = transition(v.status, "review", "admin");
    run("UPDATE versions SET status=?,updated_at=? WHERE id=?", to, now(), v.id);
    audit(actor, "review_started", v.id, { template: v.template_id, number: v.number });
    v = requireVersion(id);
  }
  const base = v.published_version_id ? one<VersionRow>("SELECT * FROM versions WHERE id=?", v.published_version_id) : undefined;
  const history = all<VersionRow & { slug: string }>(
    "SELECT v.*, t.slug FROM versions v JOIN templates t ON t.id=v.template_id WHERE t.author_id=? AND v.id<>? ORDER BY v.submitted_at DESC LIMIT 50",
    v.author_id,
    v.id,
  );
  const byStatus: Record<string, number> = {};
  for (const h of all<{ status: string; n: number }>("SELECT v.status, COUNT(*) AS n FROM versions v JOIN templates t ON t.id=v.template_id WHERE t.author_id=? GROUP BY v.status", v.author_id))
    byStatus[h.status] = h.n;
  return {
    submission: {
      ...submissionSummary(v),
      description: { de: v.description_de, en: v.description_en },
      templateJson: parseJsonColumn<unknown>(v.manifest, null),
      previews: parseJsonColumn<PreviewInfo[]>(v.previews, []).map((p) => ({
        n: p.n,
        type: IMAGE_MIME[p.type],
        url: `${adminBase()}/submissions/${v.id}/previews/${p.n}`,
      })),
      diff: versionDiff(v, base),
      authorHistory: {
        counts: byStatus,
        submissions: history.map((h) => ({ id: h.id, templateId: h.template_id, slug: h.slug, title: h.title, number: h.number, status: h.status, submittedAt: iso(h.submitted_at) })),
      },
    },
  };
}

export function submissionPackage(id: string) {
  const v = requireVersion(id);
  return new Response(new Uint8Array(readPackage(v.id)), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${v.slug}-v${v.number}.flowplan-template"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
export function submissionPreview(id: string, n: number) {
  const v = requireVersion(id);
  const p = parseJsonColumn<PreviewInfo[]>(v.previews, []).find((x) => x.n === n);
  if (!p) throw new HttpError(404, "not_found", "Preview not found.");
  return new Response(new Uint8Array(readPreview(v.id, n, p.type)), {
    headers: { "Content-Type": IMAGE_MIME[p.type], "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'" },
  });
}

const DECISIONS = { publish: "publish", request_changes: "request_changes", reject: "reject" } as const;
export async function decide(id: string, body: { decision?: unknown; message?: unknown }, actor: string) {
  const decision = typeof body.decision === "string" && body.decision in DECISIONS ? (body.decision as keyof typeof DECISIONS) : null;
  if (!decision) throw new HttpError(400, "invalid_decision", "decision must be publish, request_changes or reject.");
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 5000) : "";
  if (decision !== "publish" && !message) throw new HttpError(400, "message_required", "Please tell the author why.");
  const v = requireVersion(id);
  const to = transition(v.status, decision, "admin");
  const at = now();
  transaction(() => {
    run("UPDATE versions SET status=?,review_message=?,decided_at=?,updated_at=?,published_at=? WHERE id=?", to, message, at, at, decision === "publish" ? at : null, v.id);
    if (decision === "publish") run("UPDATE templates SET published_version_id=?,published_at=COALESCE(published_at,?),updated_at=? WHERE id=?", v.id, at, at, v.template_id);
    audit(actor, `decision_${decision}`, v.id, { template: v.template_id, number: v.number, from: v.status, message });
  });
  const author = authorOf(v.author_id);
  let notified = false;
  if (author.email) {
    const link = decision === "publish" ? `${config.publicUrl()}/t/${v.slug}` : `${config.publicUrl()}/me`;
    const [de, en] = {
      publish: ["ist jetzt im Marketplace veröffentlicht", "is now published in the marketplace"],
      request_changes: ["braucht noch Änderungen", "needs some changes"],
      reject: ["wurde leider abgelehnt", "was not accepted"],
    }[decision];
    notified = await sendMail({
      to: author.email,
      subject: `„${v.title}“ ${de} / "${v.title}" ${en}`,
      text: [`Hallo ${author.name},`, "", `deine Einreichung „${v.title}“ (Version ${v.number}) ${de}.`, message ? `\n${message}\n` : "", link, "", "—", "", `Hi ${author.name},`, "", `your submission "${v.title}" (version ${v.number}) ${en}.`, message ? `\n${message}\n` : "", link].join("\n"),
    });
  }
  return { submission: submissionSummary(requireVersion(id)), notified };
}

export function listTemplates(state: string | null) {
  const rows = all<TemplateRow & { title: string; number: number; status: string }>(
    "SELECT t.*, v.title, v.number, v.status FROM templates t JOIN versions v ON v.id=t.published_version_id ORDER BY t.published_at DESC",
  );
  const wanted = state || "listed";
  return {
    templates: rows
      .filter((t) => wanted === "all" || templateState(t) === wanted)
      .map((t) => {
        const author = authorOf(t.author_id);
        return {
          id: t.id,
          slug: t.slug,
          kind: t.kind,
          title: t.title,
          version: t.number,
          versionId: t.published_version_id,
          state: templateState(t),
          unpublishReason: t.unpublish_reason,
          featuredRank: t.featured_rank,
          downloads: t.downloads,
          opens: t.opens,
          official: author.official,
          author,
          publishedAt: iso(t.published_at),
          url: `${config.publicUrl()}/t/${t.slug}`,
        };
      }),
  };
}

// E-mail to the author of a template, if an address is known (GitHub-only
// accounts see the same on /me). false when nothing was sent.
async function mailAuthor(authorId: string, subject: [string, string], body: [string[], string[]]) {
  const author = authorOf(authorId);
  if (!author.email || author.official) return false;
  return sendMail({
    to: author.email,
    subject: `${subject[0]} / ${subject[1]}`,
    text: [`Hallo ${author.name},`, "", ...body[0], "", "—", "", `Hi ${author.name},`, "", ...body[1]].join("\n"),
  });
}

// Terms §5: the author learns by e-mail why a published template was taken
// down (and /me shows the reason).
export async function unpublish(id: string, body: { reason?: unknown }, actor: string) {
  const t = requireTemplate(id);
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 2000) : "";
  if (!reason) throw new HttpError(400, "reason_required", "Please give a reason.");
  if (templateState(t) !== "listed") throw new HttpError(409, "invalid_transition", "Only listed templates can be unpublished.");
  const v = one<VersionRow>("SELECT * FROM versions WHERE id=?", t.published_version_id!)!;
  const to = transition(v.status, "unpublish", "admin");
  const at = now();
  transaction(() => {
    run("UPDATE templates SET unpublished_at=?,unpublish_reason=?,featured_rank=NULL,updated_at=? WHERE id=?", at, reason, at, t.id);
    run("UPDATE versions SET status=?,updated_at=? WHERE id=?", to, at, v.id);
    audit(actor, "unpublish", t.id, { slug: t.slug, reason });
  });
  const me = `${config.publicUrl()}/me`;
  const notified = await mailAuthor(
    t.author_id,
    [`„${v.title}“ ist nicht mehr im Marketplace`, `"${v.title}" is no longer in the marketplace`],
    [
      [`wir haben deine Vorlage „${v.title}“ aus dem Flowplan Marketplace genommen. Der Grund:`, "", reason, "", `Du findest den Grund auch unter „Meine Einreichungen“: ${me}`, "Wenn du Fragen hast oder die Vorlage überarbeitet hast, antworte einfach auf diese E-Mail."],
      [`we have taken your template "${v.title}" out of the Flowplan Marketplace. The reason:`, "", reason, "", `You'll also find the reason under "My submissions": ${me}`, "If you have questions or have revised the template, just reply to this e-mail."],
    ],
  );
  return { ok: true, state: "unpublished", notified };
}
export async function republish(id: string, actor: string) {
  const t = requireTemplate(id);
  if (templateState(t) !== "unpublished") throw new HttpError(409, "invalid_transition", "Only unpublished templates can be republished.");
  const v = one<VersionRow>("SELECT * FROM versions WHERE id=?", t.published_version_id!)!;
  const at = now();
  transaction(() => {
    if (v.status === "unpublished") run("UPDATE versions SET status=?,updated_at=? WHERE id=?", transition(v.status, "republish", "admin"), at, v.id);
    run("UPDATE templates SET unpublished_at=NULL,unpublish_reason=NULL,updated_at=? WHERE id=?", at, t.id);
    audit(actor, "republish", t.id, { slug: t.slug });
  });
  const link = `${config.publicUrl()}/t/${t.slug}`;
  const notified = await mailAuthor(
    t.author_id,
    [`„${v.title}“ ist wieder im Marketplace`, `"${v.title}" is back in the marketplace`],
    [
      [`deine Vorlage „${v.title}“ ist wieder im Flowplan Marketplace veröffentlicht.`, link],
      [`your template "${v.title}" is published in the Flowplan Marketplace again.`, link],
    ],
  );
  return { ok: true, state: "listed", notified };
}

// On request (e-mail to the maintainer): the same deletion as "Konto
// löschen" on /me (lib/account.ts), with a reason in the audit log.
export async function deleteUser(id: string, body: { reason?: unknown }, actor: string) {
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 2000) : "";
  if (!reason) throw new HttpError(400, "reason_required", "Please give a reason.");
  const user = requireDeletableUser(id);
  return deleteAccount(user, { actor, reason, audit });
}

export function listReports(status: string | null) {
  const filter = status === "resolved" ? "r.resolved_at IS NOT NULL" : status === "all" ? "1=1" : "r.resolved_at IS NULL";
  const rows = all<{ id: string; template_id: string; version_id: string | null; reason: string; text: string; created_at: number; resolved_at: number | null; resolution: string; resolved_by: string | null; slug: string; title: string | null }>(
    `SELECT r.*, t.slug, (SELECT title FROM versions WHERE id=COALESCE(r.version_id,t.published_version_id)) AS title FROM reports r JOIN templates t ON t.id=r.template_id WHERE ${filter} ORDER BY r.created_at DESC LIMIT 500`,
  );
  return {
    reports: rows.map((r) => ({
      id: r.id,
      templateId: r.template_id,
      slug: r.slug,
      title: r.title,
      versionId: r.version_id,
      reason: r.reason,
      text: r.text,
      createdAt: iso(r.created_at),
      resolvedAt: iso(r.resolved_at),
      resolution: r.resolution,
      resolvedBy: r.resolved_by,
      url: `${config.publicUrl()}/t/${r.slug}`,
    })),
  };
}
export function resolveReport(id: string, body: { resolution?: unknown; note?: unknown }, actor: string) {
  const r = one<{ id: string; resolved_at: number | null }>("SELECT id,resolved_at FROM reports WHERE id=?", id);
  if (!r) throw new HttpError(404, "not_found", "Report not found.");
  if (r.resolved_at) throw new HttpError(409, "already_resolved", "Report already resolved.");
  const resolution = String(body.resolution ?? body.note ?? "").trim().slice(0, 2000);
  run("UPDATE reports SET resolved_at=?,resolution=?,resolved_by=? WHERE id=?", now(), resolution, actor, id);
  audit(actor, "report_resolved", id, { resolution });
  return { ok: true };
}

export function stats() {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const row of all<{ status: Status; n: number }>("SELECT status, COUNT(*) AS n FROM versions GROUP BY status")) byStatus[row.status] = row.n;
  const templates = all<TemplateRow>("SELECT * FROM templates");
  const state = { listed: 0, unpublished: 0, withdrawn: 0, unlisted: 0 };
  for (const t of templates) state[templateState(t)]++;
  return {
    submissions: byStatus,
    templates: state,
    downloads: templates.reduce((n, t) => n + t.downloads, 0),
    opens: templates.reduce((n, t) => n + t.opens, 0),
    reportsOpen: one<{ n: number }>("SELECT COUNT(*) AS n FROM reports WHERE resolved_at IS NULL")!.n,
    authors: one<{ n: number }>("SELECT COUNT(DISTINCT author_id) AS n FROM templates")!.n,
    users: one<{ n: number }>("SELECT COUNT(*) AS n FROM users")!.n,
  };
}

export const FEATURED_MAX = 12;
export function featured() {
  return {
    featured: all<{ id: string; slug: string; title: string; featured_rank: number }>(
      "SELECT t.id, t.slug, v.title, t.featured_rank FROM templates t JOIN versions v ON v.id=t.published_version_id WHERE t.featured_rank IS NOT NULL ORDER BY t.featured_rank",
    ).map((t) => ({ id: t.id, slug: t.slug, title: t.title, rank: t.featured_rank })),
  };
}
export function setFeatured(body: { templates?: unknown }, actor: string) {
  if (!Array.isArray(body.templates) || body.templates.length > FEATURED_MAX || !body.templates.every((x) => typeof x === "string"))
    throw new HttpError(400, "invalid_featured", `templates must be a list of at most ${FEATURED_MAX} ids or slugs.`);
  const ids = (body.templates as string[]).map((x) => {
    const t = requireTemplate(x);
    if (templateState(t) !== "listed") throw new HttpError(409, "not_listed", `${t.slug} is not listed.`);
    return t.id;
  });
  transaction(() => {
    run("UPDATE templates SET featured_rank=NULL");
    [...new Set(ids)].forEach((id, i) => run("UPDATE templates SET featured_rank=? WHERE id=?", i + 1, id));
    audit(actor, "featured_set", "", { templates: [...new Set(ids)] });
  });
  return featured();
}

export function auditLog(limit: number) {
  return {
    entries: all<{ id: number; at: number; actor: string; action: string; target: string; details: string }>("SELECT * FROM audit ORDER BY id DESC LIMIT ?", Math.min(Math.max(limit, 1), 500)).map((e) => ({
      id: e.id,
      at: iso(e.at),
      actor: e.actor,
      action: e.action,
      target: e.target,
      details: parseJsonColumn(e.details, {}),
    })),
  };
}

// One router for /api/admin/* (app/api/admin/[...path]/route.ts).
export async function adminRoute(request: Request, path: string[]): Promise<Response> {
  const actor = requireAdmin(request);
  const method = request.method;
  const url = new URL(request.url);
  const [a, b, c, d] = path;
  const body = async () => (method === "POST" ? await readJson(request) : {});
  if (method === "GET" && a === "submissions" && !b) return json(listSubmissions(url.searchParams.get("status")));
  if (method === "GET" && a === "submissions" && b && !c) return json(submissionDetail(b, actor));
  if (method === "GET" && a === "submissions" && b && c === "package" && !d) return submissionPackage(b);
  if (method === "GET" && a === "submissions" && b && c === "previews" && d) return submissionPreview(b, Number(d));
  if (method === "POST" && a === "submissions" && b && c === "decision") return json(await decide(b, await body(), actor));
  if (method === "GET" && a === "templates" && !b) return json(listTemplates(url.searchParams.get("state")));
  if (method === "POST" && a === "templates" && b && c === "unpublish") return json(await unpublish(b, await body(), actor));
  if (method === "POST" && a === "templates" && b && c === "republish") return json(await republish(b, actor));
  if (method === "POST" && a === "users" && b && c === "delete" && !d) return json(await deleteUser(b, await body(), actor));
  if (method === "GET" && a === "reports" && !b) return json(listReports(url.searchParams.get("status")));
  if (method === "POST" && a === "reports" && b && c === "resolve") return json(resolveReport(b, await body(), actor));
  if (method === "GET" && a === "stats") return json(stats());
  if (method === "GET" && a === "featured") return json(featured());
  if (method === "POST" && a === "featured") return json(setFeatured(await body(), actor));
  if (method === "GET" && a === "audit") return json(auditLog(Number(url.searchParams.get("limit") || 100)));
  throw new HttpError(404, "not_found", "Unknown admin endpoint.");
}
