import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ADMIN_TOKEN, req, useTempData } from "./helpers";
useTempData();
import { adminRoute } from "../lib/admin";
import { handle } from "../lib/http";
import { all, one } from "../lib/db";
import { outbox } from "../lib/mail";
import { movedSlug, mySubmissions, publicTemplate } from "../lib/store";
import { downloadRoute, previewRoute, templateRoute } from "../lib/routes";
import { readPackage } from "../lib/storage";
import { readZip } from "../lib/zip";
import { seedOfficial } from "../lib/official";
import { deleteAccount } from "../lib/account";
import { audit } from "../lib/admin";
import { buildSamplePackage, previewImage } from "../lib/sample-packages";
import { docPackage, workflowPackage } from "./fixtures";
import { officialSpecs } from "./fixtures/make-official";
import { author, submitVia } from "./flow";

const auth = { authorization: `Bearer ${ADMIN_TOKEN}`, "x-admin-user": "Yannic" };
const call = async (method: string, path: string, init: { json?: unknown; body?: FormData; headers?: Record<string, string> } = {}) => {
  const r = await handle(() => adminRoute(req(`/api/admin/${path}`, { method, json: init.json, body: init.body, headers: init.headers ?? auth }), path.split("?")[0].split("/")));
  return { status: r.status, data: (await r.json()) as any };
};
const patch = (path: string, json: unknown) => call("PATCH", path, { json });
const files = (field: string, ...items: [Buffer, string][]) => {
  const body = new FormData();
  for (const [bytes, name] of items) body.append(field, new Blob([new Uint8Array(bytes)]), name);
  return body;
};
const png = (color: string) => previewImage("document", color);
const versionOf = (id: string) => one<any>("SELECT * FROM versions WHERE id=?", id)!;
const entriesOf = async (versionId: string) => readZip(readPackage(versionId));
const manifestOf = async (versionId: string) => JSON.parse((await entriesOf(versionId)).get("template.json")!.toString());
const payloadOf = async (versionId: string) => [...(await entriesOf(versionId))].filter(([n]) => n.startsWith("payload/")).map(([n, b]) => [n, b.toString("base64")]);
const lastAudit = () => one<any>("SELECT * FROM audit ORDER BY id DESC LIMIT 1")!;

async function published(name: string, meta: Record<string, unknown> = {}, bytes = docPackage()) {
  const a = author(name);
  const s = await submitVia(a, bytes, meta);
  assert.equal(s.status, 201, JSON.stringify(s.data));
  assert.equal((await call("POST", `submissions/${s.data.versionId}/decision`, { json: { decision: "publish" } })).status, 200);
  return { a, ...s.data } as { a: ReturnType<typeof author>; templateId: string; versionId: string; slug: string };
}

test("only with the admin token; validation is the submit form's", async () => {
  const t = await published("Valid Autorin", { title: "Validierung" });
  assert.equal((await call("PATCH", `templates/${t.templateId}`, { json: { title: "Neu" }, headers: {} })).status, 401);
  assert.equal((await call("PATCH", `templates/${t.templateId}`, { json: { title: "Neu" }, headers: { authorization: "Bearer nope" } })).status, 401);
  const license = await patch(`templates/${t.templateId}`, { license: "MIT" });
  assert.equal(license.status, 400);
  assert.equal(license.data.error, "license_readonly");
  assert.equal((await patch(`templates/${t.templateId}`, { color: "red" })).data.error, "unknown_field");
  assert.deepEqual((await patch(`templates/${t.templateId}`, { title: "x" })).data.fields, ["title"]);
  assert.equal((await patch(`templates/${t.templateId}`, { category: "nope" })).data.error, "invalid_form");
  assert.equal((await patch(`templates/${t.templateId}`, { minVersion: "1.0" })).data.error, "invalid_form");
  assert.equal((await patch(`templates/${t.templateId}`, { language: "xx" })).data.error, "invalid_form");
  assert.equal((await patch(`templates/${t.templateId}`, { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).data.error, "invalid_form");
  assert.equal((await patch(`templates/${t.templateId}`, { summary: { de: "", en: "" } })).data.error, "invalid_form");
  assert.equal((await patch(`templates/${t.templateId}`, { description: { de: "x".repeat(10_001) } })).data.error, "invalid_form");
  assert.equal((await patch(`templates/${t.templateId}`, { summary: { fr: "x" } })).data.error, "invalid_form");
  assert.equal((await patch(`templates/${t.templateId}`, { notify: "yes" })).data.error, "invalid_form");
  assert.equal((await patch(`templates/${t.templateId}`, { also: ["license"] })).data.error, "invalid_form");
  assert.equal((await patch(`templates/${t.templateId}`, { title: "Validierung" })).data.error, "no_changes");
  assert.equal((await patch(`templates/nope`, { title: "Neu" })).status, 404);
  // Nothing was changed by the refusals.
  assert.equal(versionOf(t.versionId).title, "Validierung");
  assert.equal(all("SELECT 1 FROM audit WHERE action='admin_edit'").length, 0);
});

test("published: metadata changes the version in place, payload untouched, author notified", async () => {
  const t = await published("Edit Autorin", { title: "Original", descriptionDe: "**fett**" });
  const before = versionOf(t.versionId);
  const payload = await payloadOf(t.versionId);
  const mails = outbox().length;
  const r = await patch(`templates/${t.templateId}`, {
    title: "Korrigierter Titel",
    summary: { en: "Fixed summary" },
    description: { de: "Neue **Beschreibung**" },
    tags: ["Meeting", "meeting", "agenda"],
    category: "meetings",
    message: "Tippfehler im Titel korrigiert.",
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.changed, ["title", "summary.en", "description.de", "category", "tags"]);
  assert.equal(r.data.number, 1);
  assert.equal(r.data.versionId, t.versionId);
  const after = versionOf(t.versionId);
  assert.equal(after.status, "published");
  assert.equal(after.title, "Korrigierter Titel");
  assert.equal(after.summary_de, before.summary_de);
  assert.equal(after.license, before.license);
  assert.deepEqual(JSON.parse(after.tags), ["meeting", "agenda"]);
  assert.notEqual(after.sha256, before.sha256);
  assert.equal(after.size, readPackage(t.versionId).length);
  // The download matches the edited metadata; the payload is the same bytes.
  const manifest = await manifestOf(t.versionId);
  assert.equal(manifest.title, "Korrigierter Titel");
  assert.equal(manifest.description.de, "Neue **Beschreibung**");
  assert.equal(manifest.marketplace.version, 1);
  assert.equal(manifest.license, before.license);
  assert.deepEqual(await payloadOf(t.versionId), payload);
  const dl = await handle(() => downloadRoute(req(`/api/templates/${t.slug}/download`), t.slug));
  assert.equal(dl.headers.get("x-template-sha256"), after.sha256);
  assert.equal(publicTemplate(t.slug)!.title, "Korrigierter Titel");

  // The edit is recorded on the version and audited with before/after.
  const edits = JSON.parse(after.admin_edits);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].by, "flowplan-admin (Yannic)");
  assert.equal(edits[0].notify, true);
  const entry = lastAudit();
  assert.equal(entry.action, "admin_edit");
  assert.equal(entry.actor, "flowplan-admin (Yannic)");
  assert.equal(entry.target, t.versionId);
  const details = JSON.parse(entry.details);
  assert.deepEqual(details.changes.title, { from: "Original", to: "Korrigierter Titel" });
  assert.deepEqual(details.changes["description.de"], { fromLength: 8, toLength: 21 });
  assert.equal(details.scope, "template");
  assert.equal(details.message, "Tippfehler im Titel korrigiert.");
  // Published: the author gets a short e-mail by default, with the message.
  assert.equal(outbox().length, mails + 1);
  const mail = outbox().at(-1)!;
  assert.equal(mail.to, t.a.user.email);
  assert.match(mail.text, /Ein Admin hat deine Vorlage „Korrigierter Titel“ angepasst: Titel, Kurzbeschreibung \(Englisch\), Beschreibung \(Deutsch\), Kategorie, Schlagwörter\./);
  assert.match(mail.text, /Tippfehler im Titel korrigiert\./);
  // /me lists it (GitHub-only accounts see it only there).
  const mine = mySubmissions(t.a.user)[0].versions[0];
  assert.equal(JSON.parse(mine.admin_edits)[0].fields.length, 5);
  // The admin detail shows the edits.
  const d = (await call("GET", `submissions/${t.versionId}`)).data.submission;
  assert.equal(d.adminEdits.length, 1);
  assert.match(d.adminEdits[0].at, /^\d{4}-/);

  // notify: false sends nothing.
  await patch(`templates/${t.templateId}`, { title: "Noch einmal", notify: false });
  assert.equal(outbox().length, mails + 1);
});

test("in review: edits apply to that version, status stays, no e-mail by default", async () => {
  const a = author("Review Autor");
  const s = await submitVia(a, docPackage(), { title: "In Prüfung" });
  await call("GET", `submissions/${s.data.versionId}`);
  assert.equal(versionOf(s.data.versionId).status, "in_review");
  const mails = outbox().length;
  const r = await patch(`submissions/${s.data.versionId}`, { title: "In Prüfung (korrigiert)", minVersion: "1.2.0", language: "en" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, "in_review");
  const v = versionOf(s.data.versionId);
  assert.equal(v.min_version, "1.2.0");
  assert.equal((await manifestOf(s.data.versionId)).minVersion, "1.2.0");
  assert.equal(outbox().length, mails);
  assert.equal(JSON.parse(v.admin_edits)[0].notify, false);
  // …unless asked.
  await patch(`submissions/${s.data.versionId}`, { tags: ["neu"], notify: true });
  assert.equal(outbox().length, mails + 1);
  // changes_requested can be edited too; decided ones can't.
  await call("POST", `submissions/${s.data.versionId}/decision`, { json: { decision: "request_changes", message: "Bitte prüfen" } });
  assert.equal((await patch(`submissions/${s.data.versionId}`, { title: "Nochmal" })).status, 200);
  const t = await published("Fertig Autorin");
  const refused = await patch(`submissions/${t.versionId}`, { title: "Über den falschen Weg" });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.error, "not_in_review");
});

test("slug: unique, the old address redirects (308), renaming back works", async () => {
  const t = await published("Slug Autorin", { title: "Alter Name" });
  const other = await published("Andere Autorin", { title: "Belegt" });
  assert.equal((await patch(`templates/${t.templateId}`, { slug: "Nicht OK!" })).data.error, "invalid_slug");
  assert.equal((await patch(`templates/${t.templateId}`, { slug: "-x" })).data.error, "invalid_slug");
  const taken = await patch(`templates/${t.templateId}`, { slug: other.slug });
  assert.equal(taken.status, 409);
  assert.equal(taken.data.error, "slug_taken");

  const r = await patch(`templates/${t.templateId}`, { slug: "neuer-name" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.slug, "neuer-name");
  assert.equal(publicTemplate("alter-name"), null);
  assert.ok(publicTemplate("neuer-name"));
  assert.equal(movedSlug("alter-name"), "neuer-name");
  assert.equal((await manifestOf(t.versionId)).marketplace.slug, "neuer-name");
  assert.deepEqual(JSON.parse(lastAudit().details).changes.slug, { from: "alter-name", to: "neuer-name" });
  // Public API: 308 with the same path and query.
  const api = await handle(() => templateRoute("alter-name", req("/api/templates/alter-name")));
  assert.equal(api.status, 308);
  assert.equal(api.headers.get("location"), "/api/templates/neuer-name");
  const dl = await handle(() => downloadRoute(req("/api/templates/alter-name/download?version=1"), "alter-name"));
  assert.equal(dl.status, 308);
  assert.equal(dl.headers.get("location"), "/api/templates/neuer-name/download?version=1");
  assert.equal((await handle(() => previewRoute(req("/api/templates/alter-name/previews/1?version=1"), "alter-name", 1))).headers.get("location"), "/api/templates/neuer-name/previews/1?version=1");
  assert.equal((await handle(() => templateRoute("gibt-es-nicht"))).status, 404);

  // The old address stays reserved: no other template can take it, new submissions avoid it.
  assert.equal((await patch(`templates/${other.templateId}`, { slug: "alter-name" })).data.error, "slug_taken");
  const a = author("Neuling");
  const fresh = await submitVia(a, docPackage(), { title: "Alter Name" });
  assert.equal(fresh.data.slug, "alter-name-2");
  // Back to the old name: the redirect goes, the new name redirects instead.
  assert.equal((await patch(`templates/${t.templateId}`, { slug: "alter-name", notify: false })).status, 200);
  assert.equal(movedSlug("alter-name"), null);
  assert.equal(movedSlug("neuer-name"), "alter-name");
  assert.ok(publicTemplate("alter-name"));
});

test("previews: add, reorder, remove – same limits and checks as a submission", async () => {
  const t = await published("Bild Autor", { title: "Bilder" });
  const id = `templates/${t.templateId}`;
  const shaBefore = versionOf(t.versionId).sha256;
  const red = png("#cc0000");
  const green = png("#00aa00");
  const added = await call("POST", `${id}/previews`, { body: files("preview", [red, "rot.png"], [green, "gruen.jpg"]) });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  assert.equal(added.data.previews, 3);
  assert.equal(added.data.number, 1);
  assert.notEqual(versionOf(t.versionId).sha256, shaBefore);
  assert.deepEqual(JSON.parse(versionOf(t.versionId).previews).map((p: any) => p.n), [1, 2, 3]);
  let entries = await entriesOf(t.versionId);
  assert.ok(entries.get("preview/2.png")!.equals(red));
  // Checked by the bytes, at most 1 MB, at most four.
  const fake = await call("POST", `${id}/previews`, { body: files("preview", [Buffer.from("<svg onload=alert(1)>"), "x.png"]) });
  assert.equal(fake.status, 415);
  assert.equal(fake.data.error, "preview_type");
  const big = Buffer.concat([red.subarray(0, 8), Buffer.alloc(1024 * 1024)]);
  assert.equal((await call("POST", `${id}/previews`, { body: files("preview", [big, "big.png"]) })).data.error, "preview_too_large");
  const five = await call("POST", `${id}/previews`, { body: files("preview", [red, "a.png"], [red, "b.png"]) });
  assert.equal(five.status, 409);
  assert.equal(five.data.error, "preview_limit");
  assert.equal((await call("POST", `${id}/previews`, { body: new FormData() })).data.error, "preview_missing");
  assert.equal(JSON.parse(versionOf(t.versionId).previews).length, 3);

  assert.equal((await call("POST", `${id}/previews/order`, { json: { order: [1, 2] } })).data.error, "invalid_order");
  assert.equal((await call("POST", `${id}/previews/order`, { json: { order: [1, 1, 2] } })).data.error, "invalid_order");
  assert.equal((await call("POST", `${id}/previews/order`, { json: { order: [1, 2, 3] } })).data.error, "no_changes");
  assert.equal((await call("POST", `${id}/previews/order`, { json: { order: [3, 1, 2] } })).status, 200);
  entries = await entriesOf(t.versionId);
  assert.ok(entries.get("preview/1.png")!.equals(green), "stored by its real type, not its name");
  assert.ok(entries.get("preview/3.png")!.equals(red));

  assert.equal((await call("DELETE", `${id}/previews/9`)).status, 404);
  const removed = await call("DELETE", `${id}/previews/1`);
  assert.equal(removed.data.previews, 2);
  entries = await entriesOf(t.versionId);
  assert.ok(entries.get("preview/2.png")!.equals(red));
  assert.equal(entries.get("preview/3.png"), undefined);
  // The public image is the new one (the URL carries the package's hash, so caches don't keep the old one).
  const img = await handle(() => previewRoute(req(`/api/templates/${t.slug}/previews/2?version=1`), t.slug, 2));
  assert.ok(Buffer.from(await img.arrayBuffer()).equals(red));
  const actions = all<{ action: string }>("SELECT action FROM audit WHERE target=? ORDER BY id", t.versionId).map((a) => a.action);
  assert.deepEqual(actions.slice(-3), ["admin_previews_added", "admin_previews_reordered", "admin_preview_removed"]);
  // Previews alone don't mail; PATCH with also names them in the one e-mail.
  const mails = outbox().length;
  assert.equal(outbox().length, mails);
  const note = await patch(id, { also: ["previews"], message: "Bessere Bilder" });
  assert.equal(note.status, 200);
  assert.deepEqual(note.data.changed, ["previews"]);
  assert.match(outbox().at(-1)!.text, /angepasst: Vorschaubilder\./);
});

test("package replace runs the normal checks; dry run; published → new version by admin", async () => {
  const t = await published("Paket Autorin", { title: "Paket" });
  const id = `templates/${t.templateId}`;
  const fixed = docPackage({ title: "Ignoriert" });
  // Dry run: findings, nothing stored.
  const dry = await call("POST", `${id}/package?dryRun=1`, { body: files("package", [fixed, "p.flowplan-template"]) });
  assert.equal(dry.status, 200, JSON.stringify(dry.data));
  assert.equal(dry.data.dryRun, true);
  assert.equal(dry.data.ok, true);
  assert.equal(dry.data.kindMatches, true);
  assert.equal(all("SELECT 1 FROM versions WHERE template_id=?", t.templateId).length, 1);
  const broken = await call("POST", `${id}/package`, { body: files("package", [Buffer.from("not a zip"), "p.flowplan-template"]) });
  assert.equal(broken.status, 422);
  assert.equal(broken.data.findings[0].code, "zip-invalid");
  const wrongKind = await call("POST", `${id}/package`, { body: files("package", [workflowPackage(), "w.flowplan-template"]) });
  assert.equal(wrongKind.data.error, "kind_mismatch");
  assert.equal((await call("POST", `${id}/package`, { body: new FormData() })).data.error, "package_missing");

  const body = files("package", [docPackage({ previews: [] }), "p.flowplan-template"]);
  body.set("changelog", "Kaputten Anhang ersetzt");
  const r = await call("POST", `${id}/package`, { body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.newVersion, true);
  assert.equal(r.data.number, 2);
  const v2 = versionOf(r.data.versionId);
  assert.equal(v2.status, "published");
  assert.equal(v2.title, "Paket", "metadata stays as stored");
  assert.equal(v2.changelog, "Kaputten Anhang ersetzt");
  assert.deepEqual(JSON.parse(v2.admin_edits)[0].fields, ["package"]);
  // The package brought no previews: the current ones stay.
  assert.equal(JSON.parse(v2.previews).length, 1);
  assert.equal(publicTemplate(t.slug)!.number, 2);
  assert.equal(lastAudit().action, "admin_package_replaced");

  // While another version waits, replace that submission instead.
  const pending = await submitVia(t.a, docPackage(), { title: "Paket v3" }, `?template=${t.templateId}`);
  assert.equal(pending.status, 201);
  assert.equal((await call("POST", `${id}/package`, { body: files("package", [docPackage(), "p.flowplan-template"]) })).data.error, "pending_version");
  const inPlace = await call("POST", `submissions/${pending.data.versionId}/package`, { body: files("package", [docPackage({ previews: [png("#123456"), png("#654321")] }), "p.flowplan-template"]) });
  assert.equal(inPlace.status, 200, JSON.stringify(inPlace.data));
  assert.equal(inPlace.data.newVersion, false);
  assert.equal(inPlace.data.status, "submitted");
  assert.equal(JSON.parse(versionOf(pending.data.versionId).previews).length, 2);
  assert.equal(versionOf(pending.data.versionId).title, "Paket v3");
});

test("withdrawn templates can't be edited; account deletion takes the old addresses along", async () => {
  const t = await published("Weg Autor", { title: "Bald weg" });
  assert.equal((await patch(`templates/${t.templateId}`, { slug: "ganz-weg" })).status, 200);
  assert.equal(movedSlug("bald-weg"), "ganz-weg");
  await deleteAccount(t.a.user, { actor: "test", audit });
  assert.equal(movedSlug("bald-weg"), null);
  assert.equal(all("SELECT 1 FROM slug_redirects WHERE slug='bald-weg'").length, 0);

  const w = await published("Zurück Autorin", { title: "Zurückgezogen" });
  const { withdraw } = await import("../lib/store");
  withdraw(w.a.user, w.versionId);
  assert.equal((await patch(`templates/${w.templateId}`, { title: "Neu" })).data.error, "withdrawn");
});

test("official templates: admin-edited metadata and previews survive the next seed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "marketplace-official-edit-"));
  const spec = officialSpecs["meeting-notes"];
  writeFileSync(join(dir, "meeting-notes.flowplan-template"), buildSamplePackage(spec));
  await seedOfficial({ dir, log: { info() {}, warn() {} } });
  const row = publicTemplate("meeting-notes")!;
  const mails = outbox().length;
  const r = await patch(`templates/meeting-notes`, { title: "Besprechung (Admin)", tags: ["meeting", "admin"] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.official, true);
  assert.deepEqual(r.data.adminOverrides, ["title", "tags"]);
  assert.equal(outbox().length, mails, "the built-in author gets no e-mail");
  await call("POST", `templates/meeting-notes/previews`, { body: files("preview", [png("#ff00ff"), "x.png"]) });
  const listed = (await call("GET", "templates")).data.templates.find((x: any) => x.slug === "meeting-notes");
  assert.deepEqual(listed.adminOverrides, ["title", "tags", "previews"]);

  // Unchanged file: nothing happens. Changed file: new payload, admin metadata and previews kept.
  await seedOfficial({ dir, log: { info() {}, warn() {} } });
  assert.equal(publicTemplate("meeting-notes")!.number, 1);
  writeFileSync(join(dir, "meeting-notes.flowplan-template"), buildSamplePackage({ ...spec, title: "Besprechungsnotizen 2", summary: { de: "Neu aus dem Seed" } }));
  await seedOfficial({ dir, log: { info() {}, warn() {} } });
  const next = publicTemplate("meeting-notes")!;
  assert.equal(next.number, 2);
  assert.equal(next.title, "Besprechung (Admin)");
  assert.deepEqual(JSON.parse(next.tags), ["meeting", "admin"]);
  assert.equal(next.summary_de, "Neu aus dem Seed", "fields the admin didn't touch follow the file");
  assert.equal(JSON.parse(next.previews).length, 2);
  assert.equal((await manifestOf(next.id)).title, "Besprechung (Admin)");
  const seedAudit = one<any>("SELECT details FROM audit WHERE action='official_updated' ORDER BY id DESC LIMIT 1")!;
  assert.deepEqual(JSON.parse(seedAudit.details).adminOverrides, ["title", "tags", "previews"]);
  assert.notEqual(row.id, next.id);
});
