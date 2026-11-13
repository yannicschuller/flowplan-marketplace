import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_TOKEN, req, useTempData } from "./helpers";
useTempData();
import { adminRoute } from "../lib/admin";
import { handle } from "../lib/http";
import { all } from "../lib/db";
import { outbox } from "../lib/mail";
import { publicTemplates } from "../lib/store";
import { readZip } from "../lib/zip";
import { createReport } from "../lib/reports";
import { docPackage, workflowPackage } from "./fixtures";
import { author, submitVia } from "./flow";

const call = async (method: string, path: string, json?: unknown, headers: Record<string, string> = { authorization: `Bearer ${ADMIN_TOKEN}` }) => {
  const r = await handle(() => adminRoute(req(`/api/admin/${path}`, { method, json, headers }), path.split("?")[0].split("/")));
  const type = r.headers.get("content-type") || "";
  return { status: r.status, data: type.includes("json") ? ((await r.json()) as any) : await r.arrayBuffer() };
};

test("bearer token: missing, wrong, off, right", async () => {
  assert.equal((await call("GET", "stats", undefined, {})).status, 401);
  assert.equal((await call("GET", "stats", undefined, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await call("GET", "stats", undefined, { authorization: `Basic ${ADMIN_TOKEN}` })).status, 401);
  assert.equal((await call("GET", "stats")).status, 200);
  const saved = process.env.MARKETPLACE_ADMIN_TOKEN;
  delete process.env.MARKETPLACE_ADMIN_TOKEN;
  assert.equal((await call("GET", "stats")).status, 404);
  process.env.MARKETPLACE_ADMIN_TOKEN = saved;
  assert.equal((await call("GET", "nothing")).status, 404);
});

test("repeated wrong tokens are rate-limited per client", async () => {
  const h = { authorization: "Bearer guess", "x-forwarded-for": "192.0.2.99" };
  for (let i = 0; i < 20; i++) assert.equal((await call("GET", "stats", undefined, h)).status, 401);
  assert.equal((await call("GET", "stats", undefined, h)).status, 429);
  assert.equal((await call("GET", "stats", undefined, { ...h, authorization: `Bearer ${ADMIN_TOKEN}` })).status, 429);
  assert.equal((await call("GET", "stats")).status, 200);
});

test("queue, detail, decisions, notifications and audit", async () => {
  const a = author("Queue Autorin");
  const first = await submitVia(a, docPackage());
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const second = await submitVia(a, workflowPackage(), { title: "Workflow" });
  const queue = await call("GET", "submissions");
  assert.deepEqual(queue.data.submissions.map((s: any) => s.status), ["submitted", "submitted"]);
  assert.equal(queue.data.submissions[0].author.email, a.user.email);
  assert.ok(queue.data.submissions[1].findingCounts.warning >= 1);

  const detail = await call("GET", `submissions/${first.data.versionId}`, undefined, { authorization: `Bearer ${ADMIN_TOKEN}`, "x-admin-user": "Yannic" });
  assert.equal(detail.data.submission.status, "in_review");
  assert.equal(detail.data.submission.templateJson.format, "flowplan-marketplace-1");
  assert.equal(detail.data.submission.previews.length, 1);
  assert.match(detail.data.submission.previews[0].url, /\/api\/admin\/submissions\/.+\/previews\/1$/);
  assert.equal(detail.data.submission.authorHistory.submissions.length, 1);
  const preview = await call("GET", `submissions/${first.data.versionId}/previews/1`);
  assert.equal(preview.status, 200);
  const pkg = await call("GET", `submissions/${first.data.versionId}/package`);
  const entries = await readZip(Buffer.from(pkg.data as ArrayBuffer));
  assert.equal(JSON.parse(entries.get("template.json")!.toString()).author.name, "Queue Autorin");

  assert.equal((await call("POST", `submissions/${second.data.versionId}/decision`, { decision: "reject" })).status, 400);
  assert.equal((await call("POST", `submissions/${second.data.versionId}/decision`, { decision: "maybe", message: "x" })).status, 400);
  const changes = await call("POST", `submissions/${second.data.versionId}/decision`, { decision: "request_changes", message: "Bitte Token entfernen." });
  assert.equal(changes.data.submission.status, "changes_requested");
  assert.ok(outbox().some((m) => m.to === a.user.email && m.text.includes("Bitte Token entfernen.")));
  assert.equal((await call("POST", `submissions/${second.data.versionId}/decision`, { decision: "publish" })).status, 409);

  assert.equal(publicTemplates().total, 0);
  const pub = await call("POST", `submissions/${first.data.versionId}/decision`, { decision: "publish", message: "" });
  assert.equal(pub.data.submission.status, "published");
  assert.equal(pub.data.notified, false); // no SMTP in tests
  assert.equal(publicTemplates().total, 1);

  const auditRows = (await call("GET", "audit")).data.entries;
  assert.deepEqual(
    auditRows.map((e: any) => e.action).reverse(),
    ["review_started", "decision_request_changes", "decision_publish"],
  );
  assert.equal(auditRows.at(-1).actor, "flowplan-admin (Yannic)");
  assert.equal(auditRows[0].actor, "flowplan-admin");
});

test("updates: diff, published version stays until the new one is accepted", async () => {
  const a = author("Update Autor");
  const v1 = await submitVia(a, docPackage());
  await call("POST", `submissions/${v1.data.versionId}/decision`, { decision: "publish" });
  const v2 = await submitVia(a, docPackage({ previews: [] }), { title: "Neuer Titel", changelog: "Besser" }, `?template=${v1.data.templateId}`);
  assert.equal(v2.status, 201, JSON.stringify(v2.data));
  assert.equal(v2.data.number, 2);
  const conflict = await submitVia(a, docPackage(), {}, `?template=${v1.data.templateId}`);
  assert.equal(conflict.data.error, "pending_version");
  const d = (await call("GET", `submissions/${v2.data.versionId}`)).data.submission;
  assert.equal(d.isUpdate, true);
  assert.deepEqual(d.diff.changedFields, ["title", "title.de", "title.en"]);
  assert.equal(d.diff.previewsBefore, 1);
  assert.equal(d.diff.previewsAfter, 0);
  assert.equal(publicTemplates({ q: "Testvorlage" }).rows[0]?.number, 1);
  await call("POST", `submissions/${v2.data.versionId}/decision`, { decision: "publish" });
  const row = publicTemplates({ q: "Neuer Titel" }).rows[0];
  assert.equal(row.number, 2);
});

test("unpublish, republish, featured, reports, stats", async () => {
  const a = author("Feature Autorin");
  const s = await submitVia(a, docPackage(), { title: "Zum Hervorheben" });
  await call("POST", `submissions/${s.data.versionId}/decision`, { decision: "publish" });
  const slug = s.data.slug;
  const featured = await call("POST", "featured", { templates: [slug] });
  assert.deepEqual(featured.data.featured.map((f: any) => f.slug), [slug]);
  assert.equal((await call("POST", "featured", { templates: "nope" })).status, 400);

  assert.equal((await call("POST", `templates/${s.data.templateId}/unpublish`, {})).status, 400);
  const off = await call("POST", `templates/${s.data.templateId}/unpublish`, { reason: "Verstößt gegen Rechte" });
  assert.equal(off.data.state, "unpublished");
  assert.equal(publicTemplates({ q: "Zum Hervorheben" }).total, 0);
  assert.equal((await call("GET", "featured")).data.featured.length, 0);
  assert.equal((await call("POST", `templates/${s.data.templateId}/unpublish`, { reason: "again" })).status, 409);
  assert.equal((await call("GET", "templates?state=unpublished")).data.templates[0].unpublishReason, "Verstößt gegen Rechte");
  assert.equal((await call("POST", `templates/${slug}/republish`)).data.state, "listed");
  assert.equal(publicTemplates({ q: "Zum Hervorheben" }).total, 1);

  createReport({ slug, reason: "spam", text: "Werbung" }, "192.0.2.1");
  const reports = (await call("GET", "reports")).data.reports;
  assert.equal(reports.length, 1);
  assert.equal(reports[0].title, "Zum Hervorheben");
  assert.equal((await call("POST", `reports/${reports[0].id}/resolve`, { resolution: "Kein Spam" })).status, 200);
  assert.equal((await call("POST", `reports/${reports[0].id}/resolve`, { resolution: "x" })).status, 409);
  assert.equal((await call("GET", "reports")).data.reports.length, 0);
  assert.equal((await call("GET", "reports?status=resolved")).data.reports[0].resolution, "Kein Spam");

  const stats = (await call("GET", "stats")).data;
  assert.ok(stats.submissions.published >= 1);
  assert.equal(stats.reportsOpen, 0);
  const actions = all<{ action: string }>("SELECT action FROM audit").map((r) => r.action);
  for (const action of ["unpublish", "republish", "featured_set", "report_resolved"]) assert.ok(actions.includes(action), action);
  assert.equal((await call("GET", "submissions?status=bogus")).status, 400);
  assert.ok((await call("GET", "submissions?status=all")).data.submissions.length >= 5);
});
