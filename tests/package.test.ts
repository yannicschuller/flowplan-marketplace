import { test } from "node:test";
import assert from "node:assert/strict";
import { useTempData } from "./helpers";
useTempData();
import { inspectPackage, buildPackage } from "../lib/package";
import { readZip, writeZip, safeEntryName } from "../lib/zip";
import { buildSamplePackage, documentPayload, linkRulesPayload, flowplanTemplateZip } from "../lib/sample-packages";
import { allKindPackages, docPackage, docSpec, workflowPackage } from "./fixtures";

const codes = (r: { findings: { level: string; code: string }[] }, level = "error") => r.findings.filter((f) => f.level === level).map((f) => f.code);

test("valid packages of every kind pass", async () => {
  for (const bytes of allKindPackages()) {
    const r = await inspectPackage(bytes);
    assert.equal(r.ok, true, JSON.stringify(r.findings));
    assert.ok(r.manifest);
  }
});

test("missing or broken template.json is an error", async () => {
  assert.deepEqual(codes(await inspectPackage(writeZip([["payload/x.json", Buffer.from("{}")]]))), ["manifest-missing"]);
  assert.deepEqual(codes(await inspectPackage(writeZip([["template.json", Buffer.from("{nope")]]))), ["manifest-json"]);
  assert.ok(codes(await inspectPackage(docPackage({ manifest: { format: "something-else" } }))).includes("manifest-schema"));
  assert.ok(codes(await inspectPackage(docPackage({ manifest: { kind: "spreadsheet" } }))).includes("manifest-schema"));
  assert.ok(codes(await inspectPackage(docPackage({ manifest: { summary: { de: "x".repeat(301) } } }))).includes("manifest-schema"));
  assert.ok(codes(await inspectPackage(docPackage({ manifest: { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) } }))).includes("manifest-schema"));
  assert.ok(codes(await inspectPackage(docPackage({ manifest: { minVersion: "latest" } }))).includes("manifest-schema"));
  const big = writeZip([["template.json", Buffer.alloc(65 * 1024, 32)]]);
  assert.deepEqual(codes(await inspectPackage(big)), ["manifest-too-large"]);
});

test("not a zip, too large", async () => {
  assert.deepEqual(codes(await inspectPackage(Buffer.from("hello"))), ["zip-invalid"]);
  assert.deepEqual(codes(await inspectPackage(Buffer.alloc(25 * 1024 * 1024 + 1))), ["package-too-large"]);
});

test("payload must exist and match its kind", async () => {
  assert.ok(codes(await inspectPackage(docPackage({ manifest: { payload: "payload/nothing.zip" } }))).includes("payload-missing"));
  assert.ok(codes(await inspectPackage(docPackage({ manifest: { payload: "template.json" } }))).includes("payload-missing"));
  // A database template inside a "document" package.
  const wrongKind = { path: "payload/template.zip", bytes: flowplanTemplateZip({ name: "x", kind: "database", category: "", content: { database: { fields: [{}], views: [{}] } } }) };
  assert.ok(codes(await inspectPackage(docPackage({ payload: [wrongKind] }))).includes("payload-kind"));
  // Attachment listed but missing / damaged.
  const inner = writeZip([["template.json", Buffer.from(JSON.stringify({ format: "flowplan-template-1", name: "x", kind: "document", payload: JSON.stringify({ html: "<p/>" }), files: [{ id: "00000000-0000-4000-8000-000000000000", name: "a.png", mime: "image/png", sha256: "0".repeat(64) }] }))]]);
  assert.ok(codes(await inspectPackage(docPackage({ payload: [{ path: "payload/template.zip", bytes: inner }] }))).includes("payload-file"));
  const notJson = buildSamplePackage({ ...docSpec(), kind: "workflow", payload: [{ path: "payload/w.json", bytes: Buffer.from("nope") }] });
  assert.ok(codes(await inspectPackage(notJson)).includes("payload-json"));
  const badRule = buildSamplePackage({ ...docSpec(), kind: "link-rules", payload: [linkRulesPayload([{ name: "x", pattern: "(unclosed", template: "https://x" }])] });
  assert.ok(codes(await inspectPackage(badRule)).includes("payload-rule"));
});

test("previews are checked by their bytes, not their names", async () => {
  const fake = await inspectPackage(docPackage({ previews: [], extra: [["preview/1.png", Buffer.from("<svg onload=alert(1)>")]] }));
  assert.ok(codes(fake).includes("preview-type"));
  const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), (await import("node:crypto")).randomBytes(1024 * 1024)]);
  assert.ok(codes(await inspectPackage(docPackage({ previews: [], extra: [["preview/1.png", big]] }))).includes("preview-too-large"));
  const png = docSpec().previews![0];
  const five = await inspectPackage(docPackage({ previews: [png, png, png, png], extra: [["preview/5.png", png]] }));
  assert.ok(codes(five).includes("preview-count"));
  // PNG bytes behind a .jpg name: accepted as PNG, with a warning.
  const renamed = await inspectPackage(docPackage({ previews: [], extra: [["preview/1.jpg", png]] }));
  assert.equal(renamed.ok, true);
  assert.equal(renamed.previews[0].type, "png");
  assert.ok(codes(renamed, "warning").includes("preview-extension"));
});

test("zip bombs are refused", async () => {
  // 5 MB of zeros compress about 1000:1.
  const ratio = await inspectPackage(writeZip([["template.json", Buffer.from("{}")], ["payload/big.json", Buffer.alloc(5 * 1024 * 1024)]]));
  assert.deepEqual(codes(ratio), ["zip-bomb"]);
  // A nested bomb in the payload ZIP.
  const nested = writeZip([["template.json", Buffer.from("{}")], ["files/x", Buffer.alloc(5 * 1024 * 1024)]]);
  const r = await inspectPackage(docPackage({ payload: [{ path: "payload/template.zip", bytes: nested }] }));
  assert.ok(codes(r).includes("zip-bomb"));
  // Declared size smaller than the real data: the stream is cut off.
  const lying = writeZip([["template.json", Buffer.alloc(2000, 65)]]);
  const central = lying.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  lying.writeUInt32LE(10, central + 24); // uncompressed size in the central directory
  lying.writeUInt32LE(10, 22); // and in the local header
  await assert.rejects(readZip(lying));
  // Too many entries.
  const many = writeZip(Array.from({ length: 301 }, (_, i) => [`payload/${i}`, Buffer.from("x")] as [string, Buffer]));
  assert.deepEqual(codes(await inspectPackage(many)), ["zip-too-many"]);
});

test("path traversal, absolute paths and symlinks are refused", async () => {
  for (const name of ["../evil.json", "payload/../../evil", "/etc/passwd", "C:/x", "payload\\x", "a\u0000b"]) assert.equal(safeEntryName(name), false, name);
  assert.equal(safeEntryName("payload/template.zip"), true);
  for (const name of ["../evil.json", "/abs.json", "payload/../../x"]) {
    const r = await inspectPackage(writeZip([["template.json", Buffer.from("{}")], [name, Buffer.from("x")]]));
    assert.equal(r.ok, false, name);
    assert.ok(codes(r).some((c) => c === "zip-path" || c === "zip-invalid"), `${name}: ${codes(r)}`);
  }
  const link = writeZip([["template.json", Buffer.from("{}")], ["payload/link", Buffer.from("/etc/passwd")]]);
  const central = link.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  link.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
  assert.deepEqual(codes(await inspectPackage(link)), ["zip-symlink"]);
});

test("workflow analysis: hosts, AI, e-mail, secret-like values", async () => {
  const r = await inspectPackage(workflowPackage());
  assert.equal(r.ok, true);
  const wf = r.analysis.workflow!;
  assert.deepEqual(wf.hosts, ["api.example.com"]);
  assert.equal(wf.ai, true);
  assert.equal(wf.email, true);
  assert.equal(wf.nodeCount, 4);
  assert.deepEqual(wf.triggers, ["trigger.manual"]);
  assert.ok(wf.secretWarnings >= 1);
  assert.ok(codes(r, "warning").includes("secret-like"));
  const clean = await inspectPackage(workflowPackage({ headers: [{ name: "Authorization", value: "{{credential}}" }] }));
  assert.equal(clean.analysis.workflow!.secretWarnings, 0);
  const token = await inspectPackage(workflowPackage({ headers: [], body: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789" }));
  assert.ok(codes(token, "warning").includes("secret-like"));
});

test("HTML in descriptions is flagged; unknown files are dropped", async () => {
  const r = await inspectPackage(docPackage({ description: { de: "Hallo <script>alert(1)</script>" }, extra: [["notes.txt", Buffer.from("x")]] }));
  assert.equal(r.ok, true);
  assert.ok(codes(r, "warning").includes("html-stripped"));
  assert.ok(codes(r, "warning").includes("entry-ignored"));
  const out = await readZip(
    buildPackage(r, {
      title: "Neu",
      summary: { de: "a", en: "" },
      description: { de: "", en: "" },
      category: "projects",
      tags: [],
      minVersion: "0.9.4",
      language: "de",
      license: "MIT",
      author: { name: "A", handle: "a" },
      marketplace: { id: "t", slug: "neu", version: 1, url: "http://x/t/neu" },
    }),
  );
  assert.deepEqual([...out.keys()].sort(), ["payload/template.zip", "preview/1.png", "template.json"]);
  const manifest = JSON.parse(out.get("template.json")!.toString());
  assert.equal(manifest.title, "Neu");
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.summary, { de: "a" });
  // The repacked package passes again.
  assert.equal((await inspectPackage(writeZip([...out]))).ok, true);
});

test("a document payload is the unchanged flowplan-template-1 ZIP", async () => {
  const payload = documentPayload("X", "projects", "<p>x</p>");
  const r = await inspectPackage(docPackage({ payload: [payload] }));
  assert.deepEqual(r.payloadEntries[0][1], payload.bytes);
});
