import { test, before } from "node:test";
import assert from "node:assert/strict";
import { req, useTempData } from "./helpers";
useTempData();
import { handle } from "../lib/http";
import { corsPreflight, downloadRoute, listTemplatesRoute, previewRoute, templateRoute } from "../lib/routes";
import { decide, unpublish } from "../lib/admin";
import { one } from "../lib/db";
import { allKindPackages } from "./fixtures";
import { author, submitVia } from "./flow";

const list = async (query: string) => {
  const r = await handle(() => listTemplatesRoute(req(`/api/templates${query}`)), { cors: true });
  return { status: r.status, cors: r.headers.get("access-control-allow-origin"), data: (await r.json()) as any };
};
const slugs: Record<string, string> = {};
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

before(async () => {
  const a = author("Public Autorin");
  const langs = ["de", "en", "multi", "fr", "de", "en"];
  const packages = allKindPackages();
  for (const [i, bytes] of packages.entries()) {
    const s = await submitVia(a, bytes, { title: `Vorlage ${i}`, language: langs[i], category: i % 2 ? "meetings" : "projects", tags: i === 2 ? ["automation"] : ["x"] });
    assert.equal(s.status, 201, JSON.stringify(s.data));
    if (i < 5) await decide(s.data.versionId, { decision: "publish", securityOverride: "Test fixture: the workflow carries a fake bearer header." }, "test");
    slugs[i] = s.data.slug;
  }
});

test("only published templates, CORS for everyone", async () => {
  const r = await list("");
  assert.equal(r.cors, "*");
  assert.equal(r.data.total, 5);
  assert.ok(!r.data.templates.some((t: any) => t.slug === slugs[5]));
  const t = r.data.templates[0];
  for (const key of ["id", "slug", "kind", "title", "summary", "category", "tags", "language", "minVersion", "license", "version", "author", "publishedAt", "downloads", "opens", "previewUrl", "downloadUrl"]) assert.ok(key in t, key);
  const pre = corsPreflight();
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-methods")!, /GET/);
});

test("filters: kind, category, q, lang, sort", async () => {
  assert.deepEqual((await list("?kind=workflow")).data.templates.map((t: any) => t.kind), ["workflow"]);
  assert.ok((await list("?category=meetings")).data.templates.every((t: any) => t.category === "meetings"));
  assert.deepEqual((await list("?q=automation")).data.templates.map((t: any) => t.slug), [slugs[2]]);
  assert.deepEqual((await list("?q=Vorlage%203")).data.templates.map((t: any) => t.slug), [slugs[3]]);
  assert.equal((await list("?q=%25")).data.total, 0);
  // German, English and multilingual for "de".
  assert.deepEqual((await list("?lang=de")).data.templates.map((t: any) => t.language).sort(), ["de", "de", "multi"]);
  assert.deepEqual((await list("?sort=title")).data.templates.map((t: any) => t.title), ["Vorlage 0", "Vorlage 1", "Vorlage 2", "Vorlage 3", "Vorlage 4"]);
  assert.equal((await list("?limit=2")).data.templates.length, 2);
  assert.equal((await list("?kind=spreadsheet")).status, 400);
  assert.equal((await list("?category=x")).status, 400);
  assert.equal((await list("?sort=random")).status, 400);
});

test("detail, download with counting, previews, versions", async () => {
  const detail = await handle(() => templateRoute(slugs[0]), { cors: true });
  const t = ((await detail.json()) as any).template;
  assert.equal(t.versions.length, 1);
  assert.equal(t.description.de, "");
  assert.equal((await handle(() => templateRoute(slugs[5]))).status, 404);

  const d = await handle(() => downloadRoute(req(`/api/templates/${slugs[0]}/download`, { headers: { "x-forwarded-for": "192.0.2.10" } }), slugs[0]));
  assert.equal(d.status, 200);
  assert.equal(d.headers.get("content-type"), "application/zip");
  assert.equal(d.headers.get("x-template-sha256"), t.sha256);
  assert.match(d.headers.get("content-disposition")!, /attachment; filename=".+-v1\.flowplan-template"/);
  // A person's click counts once a day; "open" counts separately. The
  // request above had no user agent and did not count.
  const click = { "x-forwarded-for": "192.0.2.10", "user-agent": BROWSER, "sec-fetch-mode": "navigate", "sec-fetch-user": "?1", "sec-fetch-site": "same-origin" };
  await downloadRoute(req(`/api/templates/${slugs[0]}/download`, { headers: click }), slugs[0]);
  await downloadRoute(req(`/api/templates/${slugs[0]}/download`, { headers: click }), slugs[0]);
  await downloadRoute(req(`/api/templates/${slugs[0]}/download?via=open`, { headers: { "x-forwarded-for": "192.0.2.10", "user-agent": BROWSER, "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin" } }), slugs[0]);
  const counts = one<{ downloads: number; opens: number }>("SELECT downloads, opens FROM templates WHERE slug=?", slugs[0])!;
  assert.deepEqual({ ...counts }, { downloads: 1, opens: 1 });
  assert.equal((await handle(() => downloadRoute(req(`/api/templates/${slugs[0]}/download?version=2`), slugs[0]))).status, 404);
  assert.equal((await handle(() => downloadRoute(req(`/api/templates/${slugs[0]}/download?version=x`), slugs[0]))).status, 400);
  assert.equal((await handle(() => downloadRoute(req(`/api/templates/${slugs[5]}/download`), slugs[5]))).status, 404);

  const p = await handle(() => previewRoute(req(`/api/templates/${slugs[0]}/previews/1?version=1`), slugs[0], 1));
  assert.equal(p.headers.get("content-type"), "image/png");
  assert.equal(p.headers.get("content-security-policy"), "default-src 'none'");
  assert.equal((await handle(() => previewRoute(req(`/api/templates/${slugs[0]}/previews/2`), slugs[0], 2))).status, 404);
});

test("unpublished templates disappear everywhere", async () => {
  const id = one<{ id: string }>("SELECT id FROM templates WHERE slug=?", slugs[1])!.id;
  await unpublish(id, { reason: "test" }, "test");
  assert.ok(!(await list("")).data.templates.some((t: any) => t.slug === slugs[1]));
  assert.equal((await handle(() => downloadRoute(req("/x"), slugs[1]))).status, 404);
});
