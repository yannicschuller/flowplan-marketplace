// The title in the visitor's language (#276): template.json `titles {de, en}`
// next to `title`. Official templates bring both; cards, the template page,
// search, sorting and the API show the visitor's one, admin edits and the
// seed keep them, and migration 6 fills them from stored manifests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ADMIN_TOKEN, req, useTempData } from "./helpers";
useTempData();
import { seedOfficial } from "../lib/official";
import { adminRoute } from "../lib/admin";
import { handle } from "../lib/http";
import { migrate, one, run, SCHEMA_VERSION } from "../lib/db";
import { readPackage } from "../lib/storage";
import { readZip } from "../lib/zip";
import { inspectPackage } from "../lib/package";
import { localTitle } from "../lib/i18n";
import { publicTemplate, publicTemplates, templateDetail, type PublicRow } from "../lib/store";
import { listTemplatesRoute, templateRoute } from "../lib/routes";
import { buildSamplePackage, workflowPayload } from "../lib/sample-packages";
import { TemplateCard } from "../components/template-card";
import { docPackage } from "./fixtures";
import { author, submitVia } from "./flow";

const quiet: Pick<Console, "info" | "warn"> = { info: () => {}, warn: () => {} };
const seedDir = mkdtempSync(join(tmpdir(), "marketplace-titles-"));
const admin = async (method: string, path: string, json?: unknown) => {
  const r = await handle(() => adminRoute(req(`/api/admin/${path}`, { method, json, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "x-admin-user": "Yannic" } }), path.split("?")[0].split("/")));
  return { status: r.status, data: (await r.json()) as any };
};
const card = (row: PublicRow, locale: "de" | "en") => renderToStaticMarkup(createElement(TemplateCard, { row, locale })).match(/<h3>(.*?)<\/h3>/)![1];
const storedManifest = async (slug: string) => {
  const id = one<{ published_version_id: string }>("SELECT published_version_id FROM templates WHERE slug=?", slug)!.published_version_id;
  return JSON.parse((await readZip(readPackage(id))).get("template.json")!.toString());
};
const wf = (title: string, titles?: { de?: string; en?: string }) =>
  buildSamplePackage({
    kind: "workflow",
    title,
    summary: { de: "Meldet jeden Statuswechsel.", en: "Reports every status change." },
    category: "projects",
    payload: [workflowPayload(title, [{ id: "n_sched01", type: "trigger.schedule", label: "Täglich", x: 0, y: 0, config: { cron: "0 8 * * *" } }], [])],
    ...(titles ? { manifest: { titles } } : {}),
  });

test("template.json `titles`: optional, de and en only, as long as a title", async () => {
  assert.equal((await inspectPackage(wf("Statuswechsel melden", { de: "Statuswechsel melden", en: "Notify on status change" }))).ok, true);
  assert.equal((await inspectPackage(wf("Statuswechsel melden"))).ok, true);
  const bad = await inspectPackage(wf("Statuswechsel melden", { de: "x", fr: "y" } as never));
  assert.equal(bad.ok, false);
  assert.equal((await inspectPackage(wf("Statuswechsel melden", { en: "x".repeat(200) }))).ok, false);
});

test("localTitle: the visitor's language, then the other one, then the template's own title", () => {
  assert.equal(localTitle("en", { title: "Wochenbericht", title_de: "Wochenbericht", title_en: "Weekly report" }), "Weekly report");
  assert.equal(localTitle("de", { title: "Wochenbericht", title_de: "Wochenbericht", title_en: "Weekly report" }), "Wochenbericht");
  assert.equal(localTitle("de", { title: "Report", title_de: "", title_en: "Weekly report" }), "Weekly report");
  assert.equal(localTitle("en", { title: "Wochenbericht", title_de: "", title_en: "" }), "Wochenbericht");
});

test("official: card, page, API, search and sorting in the visitor's language", async () => {
  writeFileSync(join(seedDir, "workflow-status-change-notify.flowplan-template"), wf("Statuswechsel melden", { de: "Statuswechsel melden", en: "Notify on status change" }));
  writeFileSync(join(seedDir, "workflow-overdue-digest.flowplan-template"), wf("Tägliche Übersicht überfälliger Einträge", { de: "Tägliche Übersicht überfälliger Einträge", en: "Daily digest of overdue records" }));
  const outcomes = await seedOfficial({ dir: seedDir, log: quiet });
  assert.deepEqual(outcomes.map((o) => o.result), ["created", "created"]);
  const row = publicTemplate("workflow-status-change-notify")!;
  assert.equal(row.title, "Statuswechsel melden");
  assert.equal(row.title_de, "Statuswechsel melden");
  assert.equal(row.title_en, "Notify on status change");
  // Cards (home page, search results, author page) and the template page.
  assert.equal(card(row, "en"), "Notify on status change");
  assert.equal(card(row, "de"), "Statuswechsel melden");
  // The API: `title` stays the template's own, `titles` per language.
  const detail = (await (await templateRoute("workflow-status-change-notify", req("/api/templates/workflow-status-change-notify"))).json() as any).template;
  assert.equal(detail.title, "Statuswechsel melden");
  assert.deepEqual(detail.titles, { de: "Statuswechsel melden", en: "Notify on status change" });
  const list = (await listTemplatesRoute(req("/api/templates?official=1")).json()) as any;
  assert.deepEqual(list.templates.map((x: any) => x.titles.en).sort(), ["Daily digest of overdue records", "Notify on status change"]);
  // Search finds the English title too; sorting by title follows the visitor's language.
  assert.deepEqual(publicTemplates({ q: "digest overdue" }).rows.map((r) => r.slug), ["workflow-overdue-digest"]);
  assert.deepEqual(publicTemplates({ q: "Statuswechsel melden" }).rows.map((r) => r.slug), ["workflow-status-change-notify"]);
  assert.deepEqual(publicTemplates({ sort: "title", locale: "en" }).rows.map((r) => r.slug), ["workflow-overdue-digest", "workflow-status-change-notify"]);
  assert.deepEqual(publicTemplates({ sort: "title", locale: "de" }).rows.map((r) => r.slug), ["workflow-status-change-notify", "workflow-overdue-digest"]);
  // The package handed out keeps both.
  assert.deepEqual((await storedManifest("workflow-status-change-notify")).titles, { de: "Statuswechsel melden", en: "Notify on status change" });
  assert.deepEqual(templateDetail(row).titles, { de: "Statuswechsel melden", en: "Notify on status change" });
});

test("community templates without `titles` (from before the English title was required): the one title in both languages", async () => {
  const a = author("Titelautorin");
  const sent = await submitVia(a, docPackage(), { title: "Projektplan" });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  // As a version stored before the English title was required holds it.
  run("UPDATE versions SET title_de='', title_en='' WHERE id=?", sent.data.versionId);
  const v = one<any>("SELECT * FROM versions WHERE id=?", sent.data.versionId);
  assert.equal(localTitle("en", v), "Projektplan");
  assert.equal(localTitle("de", v), "Projektplan");
});

test("admin edits: `titles` sets them, a new `title` alone replaces them, the seed keeps both", async () => {
  const id = publicTemplate("workflow-status-change-notify")!.t_id;
  let r = await admin("PATCH", `templates/${id}`, { titles: { en: "Report status changes" }, notify: false });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.changed, ["title.en"]);
  assert.equal(publicTemplate("workflow-status-change-notify")!.title_en, "Report status changes");
  // Sending the unchanged title along keeps the per-language titles.
  r = await admin("PATCH", `templates/${id}`, { title: "Statuswechsel melden", category: "other", notify: false });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(publicTemplate("workflow-status-change-notify")!.title_en, "Report status changes");
  // A new title the next seed keeps as well.
  r = await admin("PATCH", `templates/${id}`, { title: "Status melden", notify: false });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let row = publicTemplate("workflow-status-change-notify")!;
  assert.equal(card(row, "en"), "Status melden");
  // It becomes the English title; German pages fall back to it.
  assert.deepEqual((await storedManifest("workflow-status-change-notify")).titles, { en: "Status melden" });
  assert.equal(card(row, "de"), "Status melden");
  writeFileSync(join(seedDir, "workflow-status-change-notify.flowplan-template"), wf("Statuswechsel melden", { de: "Statuswechsel melden", en: "Notify on a status change" }));
  assert.deepEqual((await seedOfficial({ dir: seedDir, log: quiet })).map((o) => o.result).sort(), ["unchanged", "updated"]);
  row = publicTemplate("workflow-status-change-notify")!;
  assert.equal(row.number, 2);
  assert.equal(row.title, "Status melden");
  assert.equal(card(row, "en"), "Status melden");
  assert.equal(card(row, "de"), "Status melden");
  // Without an admin edit a new seed file brings its new English title.
  writeFileSync(join(seedDir, "workflow-overdue-digest.flowplan-template"), wf("Tägliche Übersicht überfälliger Einträge", { de: "Tägliche Übersicht überfälliger Einträge", en: "Overdue records every morning" }));
  await seedOfficial({ dir: seedDir, log: quiet });
  assert.equal(card(publicTemplate("workflow-overdue-digest")!, "en"), "Overdue records every morning");
});

test("migration 6 fills the titles from stored manifests, and running it is safe", () => {
  const conn = new DatabaseSync(":memory:");
  assert.equal(SCHEMA_VERSION, 6);
  migrate(conn);
  // Versions as a schema-5 database holds them: with titles in template.json, without, broken.
  conn.exec(`INSERT INTO users(id,handle,name,created_at) VALUES('u','u','U',0);
    INSERT INTO templates(id,slug,author_id,kind,created_at,updated_at) VALUES('t','t','u','document',0,0);
    INSERT INTO versions(id,template_id,number,status,title,category,min_version,language,license,manifest,size,sha256,submitted_at,updated_at)
      VALUES('a','t',1,'published','Jour fixe','meetings','0.9.4','de','CC0-1.0','{"title":"Jour fixe","titles":{"de":"Jour fixe","en":" Weekly team meeting "}}',1,'x',0,0),
            ('b','t',2,'published','Notizen','meetings','0.9.4','de','CC0-1.0','{"title":"Notizen"}',1,'x',0,0),
            ('c','t',3,'published','Kaputt','meetings','0.9.4','de','CC0-1.0','not json',1,'x',0,0);`);
  // Back to schema 5 with the columns as a fresh ALTER would leave them, then migrate again.
  conn.exec("ALTER TABLE versions DROP COLUMN title_de; ALTER TABLE versions DROP COLUMN title_en; PRAGMA user_version = 5");
  migrate(conn);
  const rows = conn.prepare("SELECT id,title_de,title_en FROM versions ORDER BY id").all();
  assert.deepEqual(
    rows.map((r) => ({ ...r })),
    [
      { id: "a", title_de: "Jour fixe", title_en: "Weekly team meeting" },
      { id: "b", title_de: "", title_en: "" },
      { id: "c", title_de: "", title_en: "" },
    ],
  );
  migrate(conn);
  assert.equal((conn.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 6);
  conn.close();
});

test("seed/official: every official template has a German and an English title", async () => {
  const dir = join(import.meta.dirname, "..", "seed", "official");
  const files = readdirSync(dir).filter((f) => f.endsWith(".flowplan-template"));
  assert.ok(files.length >= 100, `${files.length} files`);
  const missing: string[] = [];
  for (const f of files) {
    const m = (await inspectPackage(readFileSync(join(dir, f)))).manifest!;
    if (!m.titles?.de || !m.titles?.en || m.titles.de !== m.title) missing.push(f);
  }
  assert.deepEqual(missing, []);
});
