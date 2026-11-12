// The security scan in the admin API (lib/security-store.ts, lib/admin.ts):
// the detail carries the full scan, the queue its verdict, "Erneut prüfen"
// scans again, a block verdict keeps a submission from being published
// unless the reviewer gives a reason (audited), and an outdated scan is run
// again on start.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_TOKEN, req, useTempData } from "./helpers";
useTempData();
import { adminRoute } from "../lib/admin";
import { handle } from "../lib/http";
import { all, run } from "../lib/db";
import { publicTemplates } from "../lib/store";
import { rescanOutdated, securityOf } from "../lib/security-store";
import { SCANNER_VERSION } from "../lib/security-scan";
import { docPackage, workflowPackage } from "./fixtures";
import { documentPayload } from "../lib/sample-packages";
import { author, submitVia } from "./flow";

const call = async (method: string, path: string, json?: unknown) => {
  const r = await handle(() => adminRoute(req(`/api/admin/${path}`, { method, json, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "x-admin-user": "Yannic" } }), path.split("?")[0].split("/")));
  return { status: r.status, data: (await r.json()) as any };
};

test("detail: security {verdict, findings, scannedAt, scannerVersion}; queue: the verdict", async () => {
  const a = author("Sicher Autorin");
  const clean = await submitVia(a, docPackage());
  const detail = (await call("GET", `submissions/${clean.data.versionId}`)).data.submission;
  assert.equal(detail.security.verdict, "clean");
  assert.equal(detail.security.label.de, "unbedenklich");
  assert.equal(detail.security.scannerVersion, SCANNER_VERSION);
  assert.ok(Date.parse(detail.security.scannedAt));
  assert.ok(Array.isArray(detail.security.findings));
  assert.equal(detail.security.override, null);
  const queue = (await call("GET", "submissions")).data.submissions;
  const row = queue.find((s: any) => s.id === clean.data.versionId);
  assert.equal(row.security.verdict, "clean");
  assert.deepEqual(row.security.counts, { block: 0, warn: 0, info: detail.security.counts.info });
  assert.equal(row.security.findings, undefined, "the queue carries the summary only");
});

test("block verdict: publish refused without a reason, allowed with one, audited", async () => {
  const a = author("Block Autor");
  // The fixture's HTTP step carries a fixed bearer header.
  const s = await submitVia(a, workflowPackage(), { title: "Mit Token" });
  const detail = (await call("GET", `submissions/${s.data.versionId}`)).data.submission;
  assert.equal(detail.security.verdict, "block");
  assert.ok(detail.security.findings.some((f: any) => f.code === "http-secret-header" && f.severity === "block"));
  const refused = await call("POST", `submissions/${s.data.versionId}/decision`, { decision: "publish" });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.error, "security_blocked");
  assert.equal((await call("POST", `submissions/${s.data.versionId}/decision`, { decision: "publish", securityOverride: "ok" })).status, 409, "a reason needs 10 characters");
  assert.equal(publicTemplates().total, 0);
  // Asking for changes is always possible.
  const reason = "Header is a documented example token, checked by hand.";
  const pub = await call("POST", `submissions/${s.data.versionId}/decision`, { decision: "publish", securityOverride: reason });
  assert.equal(pub.status, 200, JSON.stringify(pub.data));
  assert.equal(pub.data.submission.status, "published");
  const audit = all<{ action: string; actor: string; details: string }>("SELECT action,actor,details FROM audit WHERE target=? ORDER BY id", s.data.versionId);
  const override = audit.find((e) => e.action === "security_override")!;
  assert.equal(override.actor, "flowplan-admin (Yannic)");
  assert.equal(JSON.parse(override.details).reason, reason);
  assert.ok(JSON.parse(override.details).blocking.includes("http-secret-header"));
  assert.equal(JSON.parse(audit.find((e) => e.action === "decision_publish")!.details).securityOverride, reason);
  const after = (await call("GET", `submissions/${s.data.versionId}`)).data.submission;
  assert.equal(after.security.override.reason, reason);
  assert.equal(after.security.override.by, "flowplan-admin (Yannic)");
});

test("request changes and reject work whatever the verdict", async () => {
  const a = author("Andere Autorin");
  const s = await submitVia(a, workflowPackage(), { title: "Noch ein Token" });
  const r = await call("POST", `submissions/${s.data.versionId}/decision`, { decision: "request_changes", message: "Bitte das Token entfernen." });
  assert.equal(r.status, 200);
});

test("rescan: POST /submissions/:id/rescan scans again and is audited; 404 for unknown ids", async () => {
  const a = author("Rescan Autorin");
  const s = await submitVia(a, docPackage());
  const first = await securityOf(s.data.versionId);
  const again = await call("POST", `submissions/${s.data.versionId}/rescan`);
  assert.equal(again.status, 200);
  assert.equal(again.data.security.verdict, "clean");
  assert.ok(Date.parse(again.data.security.scannedAt) >= Date.parse(first!.scannedAt));
  assert.ok(all("SELECT 1 FROM audit WHERE action='security_rescan' AND target=?", s.data.versionId).length === 1);
  assert.equal((await call("POST", "submissions/00000000-0000-0000-0000-000000000000/rescan")).status, 404);
  assert.equal((await call("GET", `submissions/${s.data.versionId}/rescan`)).status, 404, "POST only");
});

test("on start: scans of an older scanner version are run again", async () => {
  const a = author("Alt Autor");
  const s = await submitVia(a, docPackage());
  await securityOf(s.data.versionId);
  run("UPDATE security_scans SET scanner_version='0.0.1', verdict='block' WHERE version_id=?", s.data.versionId);
  const n = await rescanOutdated();
  assert.ok(n >= 1);
  const row = all<{ scanner_version: string; verdict: string }>("SELECT scanner_version,verdict FROM security_scans WHERE version_id=?", s.data.versionId)[0];
  assert.equal(row.scanner_version, SCANNER_VERSION);
  assert.equal(row.verdict, "clean");
});

test("an override belongs to the package: a changed package is scanned and blocked again", async () => {
  const a = author("Wechsel Autorin");
  const s = await submitVia(a, workflowPackage(), { title: "Wechsel" });
  await securityOf(s.data.versionId);
  run("UPDATE security_scans SET override_reason='Earlier package was fine', override_by='x', override_at=1, override_sha256='other' WHERE version_id=?", s.data.versionId);
  const sec = await securityOf(s.data.versionId);
  assert.equal(sec!.override, null, "an override for other bytes does not count");
});

test("a package replaced by an admin is scanned like a submission; on a published template a block needs securityOverride", async () => {
  const a = author("Ersatz Autorin");
  const s = await submitVia(a, docPackage(), { title: "Ersatz" });
  assert.equal((await call("POST", `submissions/${s.data.versionId}/decision`, { decision: "publish" })).status, 200);
  const upload = async (path: string, bytes: Buffer, extra: Record<string, string> = {}) => {
    const body = new FormData();
    body.append("package", new Blob([new Uint8Array(bytes)]), "p.flowplan-template");
    for (const [k, v] of Object.entries(extra)) body.append(k, v);
    const r = await handle(() => adminRoute(req(`/api/admin/${path}`, { method: "POST", body, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), path.split("?")[0].split("/")));
    return { status: r.status, data: (await r.json()) as any };
  };
  const evil = docPackage({ payload: [documentPayload("Ersatz", "projects", "<p>x</p><script>alert(1)</script>")] });
  const dry = await upload(`templates/${s.data.templateId}/package?dryRun=1`, evil);
  assert.equal(dry.data.security.verdict, "block", "the dry run shows the scan");
  const refused = await upload(`templates/${s.data.templateId}/package`, evil);
  assert.equal(refused.status, 409);
  assert.equal(refused.data.error, "security_blocked");
  assert.equal(all("SELECT 1 FROM versions WHERE template_id=?", s.data.templateId).length, 1, "nothing stored");
  const reason = "Script tag is documentation text, checked.";
  const ok = await upload(`templates/${s.data.templateId}/package`, evil, { securityOverride: reason });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.security.verdict, "block");
  assert.equal(ok.data.security.override.reason, reason);
  assert.ok(all("SELECT 1 FROM audit WHERE action='security_override' AND target=?", ok.data.versionId).length === 1);
  // A submission's package is replaced in place and scanned again; publishing decides later.
  const sub = await submitVia(author("Ersatz Zwei"), docPackage(), { title: "Ersatz zwei" });
  assert.equal((await securityOf(sub.data.versionId))!.verdict, "clean");
  const inPlace = await upload(`submissions/${sub.data.versionId}/package`, evil);
  assert.equal(inPlace.status, 200);
  assert.equal(inPlace.data.security.verdict, "block");
  assert.equal((await call("POST", `submissions/${sub.data.versionId}/decision`, { decision: "publish" })).data.error, "security_blocked");
});
