import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ADMIN_TOKEN, req, useTempData } from "./helpers";
useTempData();
import { OFFICIAL_ACTOR, officialAuthor, seedOfficial, type SeedOutcome } from "../lib/official";
import { adminRoute } from "../lib/admin";
import { handle, HttpError } from "../lib/http";
import { all, one, run } from "../lib/db";
import { readPackage } from "../lib/storage";
import { sha256 } from "../lib/secret";
import { OFFICIAL_HANDLE, createSession, createUser, githubUser, userByHandle, userForSessionToken, consumeMagicLink, requestMagicLink } from "../lib/auth";
import { publicTemplate, publicTemplates, templateSummary } from "../lib/store";
import { listTemplatesRoute } from "../lib/routes";
import { readZip } from "../lib/zip";
import { outbox } from "../lib/mail";
import { buildSamplePackage } from "../lib/sample-packages";
import { TemplateCard } from "../components/template-card";
import { officialSpecs } from "./fixtures/make-official";
import { docPackage } from "./fixtures";
import { author, submitVia } from "./flow";

const FIXTURES = join(import.meta.dirname, "fixtures", "official");
const seedDir = mkdtempSync(join(tmpdir(), "marketplace-official-"));
const quiet: Pick<Console, "info" | "warn"> = { info: () => {}, warn: () => {} };
const warnings: string[] = [];
const logged: Pick<Console, "info" | "warn"> = { info: () => {}, warn: (m: string) => void warnings.push(m) };
const seed = (log = quiet) => seedOfficial({ dir: seedDir, log });
const byFile = (outcomes: SeedOutcome[]) => Object.fromEntries(outcomes.map((o) => [o.file, o.result]));
const admin = async (method: string, path: string, json?: unknown) => {
  const r = await handle(() => adminRoute(req(`/api/admin/${path}`, { method, json, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), path.split("?")[0].split("/")));
  return { status: r.status, data: (await r.json()) as any };
};
const seedAudit = () => all<{ action: string; target: string }>("SELECT action,target FROM audit WHERE actor=? ORDER BY id", OFFICIAL_ACTOR);

test("the fixtures are what make-official.ts builds", () => {
  assert.deepEqual(readdirSync(FIXTURES).sort(), Object.keys(officialSpecs).map((k) => `${k}.flowplan-template`).sort());
});

test("a missing or empty folder publishes nothing", async () => {
  assert.deepEqual(await seedOfficial({ dir: join(seedDir, "nope"), log: quiet }), []);
  assert.deepEqual(await seed(), []);
});

test("new files become published official templates, named by the file", async () => {
  for (const f of readdirSync(FIXTURES)) copyFileSync(join(FIXTURES, f), join(seedDir, f));
  const outcomes = await seed();
  assert.deepEqual(byFile(outcomes), { "brainstorming.flowplan-template": "created", "meeting-notes.flowplan-template": "created", "weekly-report.flowplan-template": "created" });
  const row = publicTemplate("meeting-notes")!;
  assert.ok(row, "published at /t/<file name>");
  assert.equal(row.title, "Besprechungsnotizen");
  assert.equal(row.author_handle, OFFICIAL_HANDLE);
  assert.equal(row.author_name, "Flowplan");
  assert.equal(row.license, "CC0-1.0");
  assert.equal(row.number, 1);
  assert.equal(templateSummary(row).official, true);
  // The download is a normal marketplace package with the official author.
  const manifest = JSON.parse((await readZip(readPackage(one<{ published_version_id: string }>("SELECT published_version_id FROM templates WHERE id=?", row.t_id)!.published_version_id))).get("template.json")!.toString());
  assert.deepEqual(manifest.author, { name: "Flowplan", handle: "flowplan" });
  assert.equal(manifest.marketplace.slug, "meeting-notes");
  assert.equal(publicTemplates({ official: true }).total, 3);
  assert.deepEqual(
    seedAudit().map((a) => a.action),
    ["official_author_created", "official_created", "official_created", "official_created"],
  );
});

test("seeding again changes nothing", async () => {
  const versions = all("SELECT id FROM versions").length;
  const audits = seedAudit().length;
  assert.deepEqual(new Set((await seed()).map((o) => o.result)), new Set(["unchanged"]));
  assert.equal(all("SELECT id FROM versions").length, versions);
  assert.equal(seedAudit().length, audits);
  assert.equal(all("SELECT id FROM users WHERE system=1").length, 1);
});

test("a changed file is published as a new version right away", async () => {
  const spec = officialSpecs["meeting-notes"];
  writeFileSync(join(seedDir, "meeting-notes.flowplan-template"), buildSamplePackage({ ...spec, title: "Besprechungsnotizen 2", manifest: { changelog: "Neue Agenda", license: "CC-BY-4.0" } }));
  const outcomes = await seed();
  assert.equal(byFile(outcomes)["meeting-notes.flowplan-template"], "updated");
  assert.equal(byFile(outcomes)["brainstorming.flowplan-template"], "unchanged");
  const row = publicTemplate("meeting-notes")!;
  assert.equal(row.number, 2);
  assert.equal(row.title, "Besprechungsnotizen 2");
  assert.equal(row.changelog, "Neue Agenda");
  assert.equal(row.license, "CC-BY-4.0");
  assert.equal(row.status, "published");
  // Nothing waits for review.
  assert.equal((await admin("GET", "submissions")).data.submissions.length, 0);
  assert.equal(seedAudit().at(-1)!.action, "official_updated");
});

test("admin API: official flag; unpublish sticks across seeding; republish and feature work", async () => {
  const listed = (await admin("GET", "templates")).data.templates as any[];
  const official = listed.find((t) => t.slug === "brainstorming");
  assert.equal(official.official, true);
  assert.equal(official.author.official, true);
  assert.equal(official.author.handle, "flowplan");
  // A community template next to it is not official.
  const a = author("Community");
  const s = await submitVia(a, docPackage());
  await admin("POST", `submissions/${s.data.versionId}/decision`, { decision: "publish", message: "" });
  const community = ((await admin("GET", "templates")).data.templates as any[]).find((t) => t.id === s.data.templateId);
  assert.equal(community.official, false);
  assert.equal((await admin("GET", "submissions?status=all")).data.submissions.find((x: any) => x.slug === "brainstorming").official, true);

  assert.equal((await admin("POST", "featured", { templates: ["brainstorming", community.id] })).status, 200);
  assert.equal(publicTemplates({ featured: true }).rows[0].slug, "brainstorming");

  assert.equal((await admin("POST", "templates/brainstorming/unpublish", { reason: "Veraltet" })).status, 200);
  // Unchanged and changed files alike: the template stays unpublished.
  assert.equal(byFile(await seed())["brainstorming.flowplan-template"], "unchanged");
  writeFileSync(join(seedDir, "brainstorming.flowplan-template"), buildSamplePackage({ ...officialSpecs.brainstorming, title: "Brainstorming neu" }));
  assert.equal(byFile(await seed())["brainstorming.flowplan-template"], "skipped");
  assert.equal(byFile(await seed())["brainstorming.flowplan-template"], "skipped");
  assert.equal(publicTemplate("brainstorming"), null);
  assert.equal(seedAudit().filter((x) => x.action === "official_skipped").length, 1, "audited once per file content");
  assert.equal(all("SELECT id FROM versions v WHERE template_id=(SELECT id FROM templates WHERE slug='brainstorming')").length, 1);

  assert.equal((await admin("POST", "templates/brainstorming/republish")).status, 200);
  assert.equal(publicTemplate("brainstorming")!.title, "Brainstorming");
  // Once listed again, the next start brings the new content.
  assert.equal(byFile(await seed())["brainstorming.flowplan-template"], "updated");
  assert.equal(publicTemplate("brainstorming")!.title, "Brainstorming neu");
});

test("an invalid package is skipped with a warning, the others go on", async () => {
  writeFileSync(join(seedDir, "aaa-broken.flowplan-template"), Buffer.from("not a zip"));
  writeFileSync(join(seedDir, "Bad Name.flowplan-template"), docPackage());
  writeFileSync(join(seedDir, "no-summary.flowplan-template"), buildSamplePackage({ ...officialSpecs["meeting-notes"], summary: {} }));
  writeFileSync(join(seedDir, "zzz-new.flowplan-template"), docPackage({ title: "Neu" }));
  writeFileSync(join(seedDir, "notes.txt"), "ignored");
  warnings.length = 0;
  const outcomes = byFile(await seed(logged));
  assert.equal(outcomes["aaa-broken.flowplan-template"], "invalid");
  assert.equal(outcomes["Bad Name.flowplan-template"], "invalid");
  assert.equal(outcomes["no-summary.flowplan-template"], "invalid");
  assert.equal(outcomes["zzz-new.flowplan-template"], "created");
  assert.equal(outcomes["notes.txt"], undefined);
  assert.equal(warnings.length, 3);
  assert.ok(warnings.some((w) => /aaa-broken.*zip-invalid/.test(w)));
  assert.equal(publicTemplate("aaa-broken"), null);
  assert.ok(publicTemplate("zzz-new"));
  // A broken file is audited once, not on every start.
  await seed();
  assert.equal(seedAudit().filter((x) => x.action === "official_invalid").length, 3);
  rmSync(join(seedDir, "aaa-broken.flowplan-template"));
  rmSync(join(seedDir, "Bad Name.flowplan-template"));
  rmSync(join(seedDir, "no-summary.flowplan-template"));
});

test("a kind change is refused; a removed file leaves its template alone", async () => {
  writeFileSync(join(seedDir, "weekly-report.flowplan-template"), docPackage({ title: "Kein Workflow" }));
  assert.equal(byFile(await seed())["weekly-report.flowplan-template"], "invalid");
  assert.equal(publicTemplate("weekly-report")!.kind, "workflow");
  rmSync(join(seedDir, "weekly-report.flowplan-template"));
  await seed();
  assert.ok(publicTemplate("weekly-report"));
});

test("a community slug that is taken gets a suffix; the file name stays the key", async () => {
  const a = author("Squatter");
  const s = await submitVia(a, docPackage(), { title: "Taken slug" });
  await admin("POST", `submissions/${s.data.versionId}/decision`, { decision: "publish", message: "" });
  writeFileSync(join(seedDir, "taken-slug.flowplan-template"), docPackage({ title: "Offiziell" }));
  const out = (await seed()).find((o) => o.file === "taken-slug.flowplan-template")!;
  assert.equal(out.result, "created");
  assert.equal(out.slug, "taken-slug-2");
  assert.equal(byFile(await seed())["taken-slug.flowplan-template"], "unchanged");
  assert.equal(publicTemplate("taken-slug")!.official, 0);
});

test("the official author can't sign in and its handle is reserved", async () => {
  const system = officialAuthor();
  assert.equal(system.system, 1);
  assert.equal(system.email, null);
  assert.equal(system.github_id, null);
  assert.throws(() => createSession(system.id), (e: HttpError) => e.code === "system_account");
  // Even a session row put there by hand is not accepted.
  run("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)", sha256("forged-token"), system.id, Date.now(), Date.now() + 1e9);
  assert.equal(userForSessionToken("forged-token"), null);
  // Nobody else gets the handle "flowplan".
  assert.notEqual(createUser({ name: "Flowplan", handle: "flowplan" }).handle, "flowplan");
  assert.notEqual(githubUser({ id: "424242", login: "flowplan", name: "Flowplan" }).handle, "flowplan");
  await requestMagicLink("flowplan@example.org", "/", "203.0.113.50");
  const token = /token=([A-Za-z0-9_-]+)/.exec(outbox().at(-1)!.text)![1];
  const signedIn = consumeMagicLink(token).user;
  assert.notEqual(signedIn.id, system.id);
  assert.notEqual(signedIn.handle, "flowplan");
  assert.equal(userByHandle("flowplan")!.id, system.id);
});

test("public API: official flag and filter", async () => {
  const r = await handle(() => listTemplatesRoute(req("/api/templates?official=1&limit=100")));
  const data = (await r.json()) as { templates: { slug: string; official: boolean }[]; total: number };
  assert.ok(data.total >= 3);
  assert.ok(data.templates.every((t) => t.official));
  const everything = (await (await handle(() => listTemplatesRoute(req("/api/templates?limit=100")))).json()) as typeof data;
  assert.ok(everything.templates.some((t) => !t.official));
});

test("cards show the official badge only for official templates", () => {
  const official = publicTemplate("meeting-notes")!;
  const community = publicTemplates({ q: "Testvorlage" }).rows.find((r) => !r.official)!;
  const de = renderToStaticMarkup(createElement(TemplateCard, { row: official, locale: "de" }));
  assert.match(de, /class="official-badge"[^>]*>.*Offiziell<\/span>/);
  assert.match(renderToStaticMarkup(createElement(TemplateCard, { row: official, locale: "en" })), />Official<\/span>/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(TemplateCard, { row: community, locale: "de" })), /official-badge/);
});
