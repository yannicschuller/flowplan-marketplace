import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, req, useTempData } from "./helpers";
useTempData();
import { handle } from "../lib/http";
import { inspectRoute, withdrawRoute } from "../lib/routes";
import { decide } from "../lib/admin";
import { one } from "../lib/db";
import { publicTemplates } from "../lib/store";
import { docPackage, workflowPackage } from "./fixtures";
import { author, submitVia } from "./flow";

test("submitting needs sign-in, CSRF, a valid package, a licence and the rights", async () => {
  const a = author("Form Autorin");
  const anon = await submitVia({ ...a, headers: { ...a.headers, cookie: "" } }, docPackage());
  assert.equal(anon.status, 401);
  const noCsrf = await submitVia({ ...a, headers: { ...a.headers, "x-csrf-token": "" } }, docPackage());
  assert.equal(noCsrf.status, 403);
  assert.equal((await submitVia(a, docPackage(), { rights: false })).data.error, "invalid_form");
  assert.equal((await submitVia(a, docPackage(), { license: "GPL-3.0" })).data.error, "invalid_form");
  assert.equal((await submitVia(a, docPackage(), { summaryDe: "", summaryEn: "" })).data.error, "invalid_form");
  const bad = await submitVia(a, Buffer.from("not a zip"));
  assert.equal(bad.status, 422);
  assert.equal(bad.data.findings[0].code, "zip-invalid");
  assert.equal((await submitVia(a, null)).data.error, "package_missing");
  const ok = await submitVia(a, docPackage(), { tags: ["A", "a", "b"] });
  assert.equal(ok.status, 201);
  assert.equal(one<{ license: string; tags: string }>("SELECT license, tags FROM versions WHERE id=?", ok.data.versionId)!.tags, '["a","b"]');
});

test("edit while waiting, resubmit after changes were requested, withdraw", async () => {
  const a = author("Edit Autor");
  const s = await submitVia(a, workflowPackage());
  const edited = await submitVia(a, null, { title: "Umbenannt" }, `?edit=${s.data.versionId}`);
  assert.equal(edited.data.status, "submitted");
  assert.equal(one<{ title: string }>("SELECT title FROM versions WHERE id=?", s.data.versionId)!.title, "Umbenannt");
  await decide(s.data.versionId, { decision: "request_changes", message: "Bitte prüfen" }, "test");
  const again = await submitVia(a, workflowPackage({ headers: [] }), { title: "Umbenannt" }, `?edit=${s.data.versionId}`);
  assert.equal(again.data.status, "submitted");
  // Another author can't touch it.
  const b = author("Fremd");
  assert.equal((await submitVia(b, null, {}, `?edit=${s.data.versionId}`)).status, 404);
  assert.equal((await handle(() => withdrawRoute(req("/x", { method: "POST", headers: b.headers }), s.data.versionId))).status, 404);
  // A different kind is refused.
  assert.equal((await submitVia(a, docPackage(), {}, `?edit=${s.data.versionId}`)).data.error, "kind_mismatch");
  const w = await handle(() => withdrawRoute(req("/x", { method: "POST", headers: a.headers }), s.data.versionId));
  assert.equal(((await w.json()) as any).status, "withdrawn");
  assert.equal((await handle(() => withdrawRoute(req("/x", { method: "POST", headers: a.headers }), s.data.versionId))).status, 409);
});

test("withdrawing the published version takes the template down", async () => {
  const a = author("Weg Autorin");
  const s = await submitVia(a, docPackage(), { title: "Bald weg" });
  await decide(s.data.versionId, { decision: "publish" }, "test");
  assert.equal(publicTemplates({ q: "Bald weg" }).total, 1);
  await handle(() => withdrawRoute(req("/x", { method: "POST", headers: a.headers }), s.data.versionId));
  assert.equal(publicTemplates({ q: "Bald weg" }).total, 0);
  assert.equal((await submitVia(a, docPackage(), {}, `?template=${s.data.templateId}`)).data.error, "withdrawn");
});

test("inspecting stores nothing and answers with previews", async () => {
  const r = await handle(() => inspectRoute(req("/api/packages/inspect", { method: "POST", body: new Uint8Array(docPackage()), headers: { origin: BASE } })));
  const data = (await r.json()) as any;
  assert.equal(data.ok, true);
  assert.equal(data.manifest.title, "Testvorlage");
  assert.equal(data.previews[0].type, "image/png");
  assert.ok(Buffer.from(data.previews[0].data, "base64").subarray(1, 4).equals(Buffer.from("PNG")));
  const cross = await handle(() => inspectRoute(req("/api/packages/inspect", { method: "POST", body: new Uint8Array(docPackage()), headers: { origin: "https://evil.example" } })));
  assert.equal(cross.status, 403);
});
