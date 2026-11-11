import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PACKAGE_BYTES, READY_MESSAGE, checkInstanceUrl, compareVersions, fromOpener, importAddress, instanceTooOld, isPrivateHost, parseInstanceReady, parsePackageMessage, templateMessage } from "../lib/handover";

test("§2 package message: only {type, name, bytes: ArrayBuffer} within 25 MB", () => {
  const bytes = new ArrayBuffer(10);
  assert.deepEqual(parsePackageMessage({ type: "flowplan-marketplace-package", name: "a.flowplan-template", bytes }), { type: "flowplan-marketplace-package", name: "a.flowplan-template", bytes });
  assert.equal(parsePackageMessage({ type: "flowplan-marketplace-package", name: "a", bytes: new Uint8Array(10) }), null);
  assert.equal(parsePackageMessage({ type: "flowplan-marketplace-package", name: "a", bytes: "x" }), null);
  assert.equal(parsePackageMessage({ type: "flowplan-marketplace-package", name: "a", bytes: new ArrayBuffer(0) }), null);
  assert.equal(parsePackageMessage({ type: "flowplan-marketplace-package", name: "a", bytes: new ArrayBuffer(MAX_PACKAGE_BYTES + 1) }), null);
  assert.equal(parsePackageMessage({ type: "other", bytes }), null);
  assert.equal(parsePackageMessage(null), null);
  assert.equal(parsePackageMessage("flowplan-marketplace-package"), null);
  // Path parts and control characters leave the name; a missing name gets a default.
  assert.equal(parsePackageMessage({ type: "flowplan-marketplace-package", name: "../../etc/<x>.zip", bytes })!.name, "....etcx.zip");
  assert.equal(parsePackageMessage({ type: "flowplan-marketplace-package", bytes })!.name, "template.flowplan-template");
  assert.deepEqual(READY_MESSAGE, { type: "flowplan-marketplace-ready" });
});

test("§2 only the opener counts", () => {
  const opener = {};
  assert.equal(fromOpener(opener, opener), true);
  assert.equal(fromOpener({}, opener), false);
  assert.equal(fromOpener(null, null), false);
});

test("§3 instance ready and the template message", () => {
  assert.deepEqual(parseInstanceReady({ type: "flowplan-instance-ready", version: "0.9.4" }), { type: "flowplan-instance-ready", version: "0.9.4" });
  assert.deepEqual(parseInstanceReady({ type: "flowplan-instance-ready" }), { type: "flowplan-instance-ready", version: "" });
  assert.equal(parseInstanceReady({ type: "flowplan-marketplace-ready" }), null);
  const bytes = new ArrayBuffer(4);
  const m = templateMessage({ id: "t1", version: 2, bytes, sha256: "a".repeat(64) });
  assert.equal(m.type, "flowplan-marketplace-template");
  assert.equal(m.bytes, bytes);
  assert.throws(() => templateMessage({ id: "t1", version: 2, bytes, sha256: "nope" }));
});

test("§3 instance address: https, http only for private hosts", () => {
  assert.deepEqual(checkInstanceUrl("https://flowplan.example.org/some/page?x=1"), { ok: true, origin: "https://flowplan.example.org", warning: null });
  assert.deepEqual(checkInstanceUrl("flowplan.example.org"), { ok: true, origin: "https://flowplan.example.org", warning: null });
  assert.deepEqual(checkInstanceUrl("http://localhost:3000"), { ok: true, origin: "http://localhost:3000", warning: "http-private" });
  assert.deepEqual(checkInstanceUrl("http://192.168.1.20:3000"), { ok: true, origin: "http://192.168.1.20:3000", warning: "http-private" });
  assert.equal(checkInstanceUrl("http://flowplan.example.org").ok, false);
  assert.equal(checkInstanceUrl("javascript:alert(1)").ok, false);
  assert.equal(checkInstanceUrl("ftp://x.org").ok, false);
  assert.equal(checkInstanceUrl("https://user:pw@x.org").ok, false);
  assert.equal(checkInstanceUrl("").ok, false);
  assert.equal(importAddress("https://a.org"), "https://a.org/#marketplace-import");
  for (const h of ["localhost", "10.0.0.1", "172.20.1.1", "127.0.0.1", "nas.local", "[::1]", "fd12:3456::1"]) assert.equal(isPrivateHost(h), true, h);
  for (const h of ["8.8.8.8", "172.32.0.1", "example.org", "fdroid.org"]) assert.equal(isPrivateHost(h), false, h);
});

test("versions", () => {
  assert.equal(compareVersions("0.9.4", "0.9.4"), 0);
  assert.equal(compareVersions("0.9.3", "0.9.4"), -1);
  assert.equal(compareVersions("0.10.0", "0.9.4"), 1);
  assert.equal(compareVersions("1.0.0-beta.2", "1.0.0"), 0);
  assert.equal(compareVersions("v1.2", "1.2.0"), 0);
  assert.equal(compareVersions("", "1.0.0"), null);
  assert.equal(instanceTooOld("0.9.0", "0.9.4"), "older");
  assert.equal(instanceTooOld("1.0.0", "0.9.4"), "ok");
  assert.equal(instanceTooOld("dev", "0.9.4"), "unknown");
});
