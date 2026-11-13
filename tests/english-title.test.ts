// The English title is required for what authors publish (follow-up to #276): the
// package (template.json `titles.en`, written by Flowplan's publish dialog)
// and the submit form. Older packages are refused with a reason that tells
// the author to update Flowplan; stored templates without one keep working;
// admins can change the English title but not remove it. Plus the language
// switch in the header.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ADMIN_TOKEN, BASE, req, useTempData } from "./helpers";
useTempData();
// The rule is on in these tests (MARKETPLACE_REQUIRE_ENGLISH_TITLE); the
// last test switches it off, as it is until a Flowplan release asks for it.
process.env.MARKETPLACE_REQUIRE_ENGLISH_TITLE = "on";
import { adminRoute } from "../lib/admin";
import { handle } from "../lib/http";
import { one, run } from "../lib/db";
import { inspectRoute } from "../lib/routes";
import { readPackage } from "../lib/storage";
import { readZip } from "../lib/zip";
import { inspectPackage } from "../lib/package";
import { localTitle, translate } from "../lib/i18n";
import { publicTemplate } from "../lib/store";
import { LanguageSwitch } from "../components/language-switch";
import { docPackage } from "./fixtures";
import { author, submitVia } from "./flow";

const auth = { authorization: `Bearer ${ADMIN_TOKEN}`, "x-admin-user": "Yannic" };
const admin = async (method: string, path: string, json?: unknown) => {
  const r = await handle(() => adminRoute(req(`/api/admin/${path}`, { method, json, headers: auth }), path.split("?")[0].split("/")));
  return { status: r.status, data: (await r.json()) as any };
};
const inspect = async (bytes: Buffer) => {
  const r = await handle(() => inspectRoute(req("/api/packages/inspect", { method: "POST", body: new Uint8Array(bytes), headers: { origin: BASE } })));
  return (await r.json()) as any;
};
const manifestOf = async (versionId: string) => JSON.parse((await readZip(readPackage(versionId))).get("template.json")!.toString());
// What an older Flowplan wrote: `title` only.
const oldPackage = () => docPackage({ titles: null });

test("a package without an English title is refused for submissions, with the reason (update Flowplan)", async () => {
  // The package check itself still accepts it (seed, admin replacement, stored templates) …
  assert.equal((await inspectPackage(oldPackage())).ok, true);
  // … but the submit page's check refuses it straight after the hand-over.
  const checked = await inspect(oldPackage());
  assert.equal(checked.ok, false);
  const finding = checked.findings.find((f: any) => f.code === "title-en-missing");
  assert.equal(finding.level, "error");
  assert.equal(finding.at, "titles.en");
  assert.match(finding.de, /Aktualisiere Flowplan/);
  assert.match(finding.en, /Update Flowplan/);
  // An empty English title counts as none.
  assert.equal((await inspect(docPackage({ titles: { de: "Testvorlage", en: " " } }))).ok, false);
  assert.equal((await inspect(docPackage({ titles: { en: "Test template" } }))).ok, true);

  // Submitting it anyway: 422 package_invalid with the finding.
  const a = author("Alte Version");
  const sent = await submitVia(a, oldPackage(), { titleEn: "Test template" });
  assert.equal(sent.status, 422);
  assert.equal(sent.data.error, "package_invalid");
  assert.ok(sent.data.findings.some((f: any) => f.code === "title-en-missing"));
});

test("the submit form: English title required (400 invalid_form, field titleEn), German optional, `title` follows", async () => {
  const a = author("Formular");
  for (const titleEn of ["", "  ", undefined]) {
    const r = await submitVia(a, docPackage(), { titleDe: "Projektplan", titleEn });
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.equal(r.data.error, "invalid_form");
    assert.deepEqual(r.data.fields, ["titleEn"]);
  }
  assert.deepEqual((await submitVia(a, docPackage(), { titleDe: "P", titleEn: "Project plan" })).data.fields, ["titleDe"]);

  // German content with both: `title` is the German one; English only: the English one.
  const both = await submitVia(a, docPackage(), { title: "ignored", titleDe: "Projektplan", titleEn: "Project plan", language: "de" });
  assert.equal(both.status, 201, JSON.stringify(both.data));
  let v = one<any>("SELECT * FROM versions WHERE id=?", both.data.versionId);
  assert.deepEqual([v.title, v.title_de, v.title_en], ["Projektplan", "Projektplan", "Project plan"]);
  assert.deepEqual((await manifestOf(both.data.versionId)).titles, { de: "Projektplan", en: "Project plan" });
  assert.equal(both.data.slug, "projektplan");

  const english = await submitVia(a, docPackage(), { title: "ignored", titleDe: "", titleEn: "Reading list", language: "de" });
  v = one<any>("SELECT * FROM versions WHERE id=?", english.data.versionId);
  assert.deepEqual([v.title, v.title_de, v.title_en], ["Reading list", "", "Reading list"]);
  assert.deepEqual((await manifestOf(english.data.versionId)).titles, { en: "Reading list" });

  // English content: `title` is the English one even with a German title.
  const en = await submitVia(a, docPackage(), { titleDe: "Leseliste", titleEn: "Reading log", language: "en" });
  assert.equal(one<any>("SELECT title FROM versions WHERE id=?", en.data.versionId).title, "Reading log");
});

test("a new version of a template from before the rule needs the English title; the published one keeps working", async () => {
  const a = author("Bestand");
  const first = await submitVia(a, docPackage(), { title: "Altvorlage" });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal((await admin("POST", `submissions/${first.data.versionId}/decision`, { decision: "publish" })).status, 200);
  // As it was stored before the rule: no per-language titles.
  run("UPDATE versions SET title_de='', title_en='' WHERE id=?", first.data.versionId);
  const row = publicTemplate(first.data.slug)!;
  assert.equal(localTitle("en", row), "Altvorlage");
  assert.equal(localTitle("de", row), "Altvorlage");
  // Admin edits of other fields still work without an English title.
  assert.equal((await admin("PATCH", `templates/${first.data.templateId}`, { category: "meetings", notify: false })).status, 200);

  const query = `?template=${first.data.templateId}`;
  const without = await submitVia(a, docPackage(), { titleDe: "Altvorlage", titleEn: "" }, query);
  assert.equal(without.status, 400);
  assert.deepEqual(without.data.fields, ["titleEn"]);
  assert.equal((await submitVia(a, oldPackage(), { titleDe: "Altvorlage", titleEn: "Old template" }, query)).status, 422);
  const ok = await submitVia(a, docPackage(), { titleDe: "Altvorlage", titleEn: "Old template" }, query);
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.number, 2);

  // Editing that waiting version without a new package: the English title stays required.
  const edit = `?edit=${ok.data.versionId}`;
  assert.deepEqual((await submitVia(a, null, { titleDe: "Altvorlage", titleEn: "" }, edit)).data.fields, ["titleEn"]);
  const edited = await submitVia(a, null, { titleDe: "Altvorlage", titleEn: "Legacy template" }, edit);
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(one<any>("SELECT title_en FROM versions WHERE id=?", ok.data.versionId).title_en, "Legacy template");
  // A new package in the edit must carry it too.
  assert.equal((await submitVia(a, oldPackage(), { titleDe: "Altvorlage", titleEn: "Legacy template" }, edit)).status, 422);
});

test("admin edits: both titles can be set, the English one can't be removed", async () => {
  const a = author("Adminfall");
  const s = await submitVia(a, docPackage(), { titleDe: "Wochenplan", titleEn: "Weekly plan" });
  assert.equal((await admin("POST", `submissions/${s.data.versionId}/decision`, { decision: "publish" })).status, 200);
  const path = `templates/${s.data.templateId}`;
  let r = await admin("PATCH", path, { titles: { de: "Wochenplanung", en: "Weekly planning" }, notify: false });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.changed, ["title.de", "title.en"]);
  for (const body of [{ titles: { en: "" } }, { titles: { de: "Wochenplanung", en: "  " } }]) {
    r = await admin("PATCH", path, { ...body, notify: false });
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.equal(r.data.error, "invalid_form");
    assert.deepEqual(r.data.fields, ["titles.en"]);
  }
  // Removing the German one is fine; a new `title` alone becomes the English one.
  assert.equal((await admin("PATCH", path, { titles: { de: "" }, notify: false })).status, 200);
  r = await admin("PATCH", path, { title: "Weekly planner", notify: false });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const row = publicTemplate(s.data.slug)!;
  assert.deepEqual([row.title, row.title_de, row.title_en], ["Weekly planner", "", "Weekly planner"]);
  assert.equal(localTitle("de", row), "Weekly planner");
});

test("header language switch: DE / EN links to /lang, the current one marked, back to the same page", () => {
  const html = (locale: "de" | "en") => renderToStaticMarkup(createElement(LanguageSwitch, { locale, back: "/t/wochenplan?x=1", t: translate(locale) }));
  const de = html("de");
  assert.match(de, /^<nav class="header-lang" aria-label="Sprache">/);
  assert.match(de, /<a href="\/lang\/de\?next=%2Ft%2Fwochenplan%3Fx%3D1" hrefLang="de" lang="de" aria-label="Deutsch" title="Deutsch" aria-current="true">DE<\/a>/);
  assert.match(de, /<a href="\/lang\/en\?next=%2Ft%2Fwochenplan%3Fx%3D1" hrefLang="en" lang="en" aria-label="English" title="English">EN<\/a>/);
  const en = html("en");
  assert.match(en, /aria-label="Language"/);
  assert.match(en, /aria-label="English" title="English" aria-current="true">EN/);
  assert.doesNotMatch(en, /aria-label="Deutsch"[^>]*aria-current/);
  // No script, no style attributes (CSP), nothing but links.
  for (const out of [de, en]) {
    assert.doesNotMatch(out, /style=|<script|onclick|<button/i);
    assert.equal(out.match(/<a /g)!.length, 2);
  }
});

test("until MARKETPLACE_REQUIRE_ENGLISH_TITLE is on, a missing English title is only a warning and the German title stands in", async () => {
  process.env.MARKETPLACE_REQUIRE_ENGLISH_TITLE = "";
  try {
    const { forSubmission } = await import("../lib/package");
    const { parseAuthorForm } = await import("../lib/store");
    const pkg = await inspectPackage(await docPackage({ title: "Nur deutsch" }));
    const checked = forSubmission({ ...pkg, manifest: pkg.manifest && { ...pkg.manifest, titles: undefined } });
    const missing = checked.findings.find((f) => f.code === "title-en-missing");
    assert.equal(missing?.level, "warning");
    assert.equal(checked.ok, pkg.ok);
    const { form: baseForm } = await import("./fixtures");
    const parsed = parseAuthorForm({ ...baseForm(), title: undefined, titleDe: "Nur deutsch", titleEn: "" });
    assert.equal(parsed.title, "Nur deutsch");
    assert.throws(() => parseAuthorForm({ ...baseForm(), title: undefined, titleDe: "", titleEn: "" }), /title/i);
  } finally {
    process.env.MARKETPLACE_REQUIRE_ENGLISH_TITLE = "on";
  }
});
