// Flashcard decks (README "Flashcard decks"): payload/study-meta.json is
// checked and cleaned (schema, lengths, invisible characters, masks on the
// picture, pictures only as the template's own PNG/JPEG/WebP attachments),
// a broken one only costs the preview, what Flowplan really builds passes,
// the sample cards render as text and SVG shapes (no HTML from the package,
// no style attributes), pictures come through the marketplace's own routes,
// and the inspect route and the admin API carry the samples.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ADMIN_TOKEN, req, sameOrigin, useTempData } from "./helpers";
useTempData();
import { parseStudyMeta, readStudyMeta, withImages, STUDY_LIMITS } from "../lib/study-meta";
import { inspectPackage } from "../lib/package";
import { scanPackage } from "../lib/security-scan";
import { handle } from "../lib/http";
import { inspectRoute, studyCardRoute } from "../lib/routes";
import { adminRoute, decide } from "../lib/admin";
import { readZip } from "../lib/zip";
import { translate } from "../lib/i18n";
import { StudySamples } from "../components/study-samples";
import { deckPackage } from "./fixtures";
import { author, submitVia } from "./flow";

const FLOWPLAN_DECK = readFileSync(new URL("./fixtures/flowplan-deck.flowplan-template", import.meta.url));
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const base = { format: "flowplan.study-meta", version: 1, records: 1, cards: 1 };
const t = translate("en");
const html = (meta: NonNullable<ReturnType<typeof parseStudyMeta>["meta"]>, src: (n: number) => string | null = () => "/x.png") =>
  renderToStaticMarkup(createElement(StudySamples, { meta, imageSrc: src, t, number: (n: number) => String(n) }));

test("the deck Flowplan builds passes: numbers, one sample per card type, no warnings", async () => {
  const inspection = await inspectPackage(FLOWPLAN_DECK);
  assert.ok(inspection.ok, JSON.stringify(inspection.findings));
  assert.ok(!inspection.findings.some((f) => f.code.startsWith("study-meta")), JSON.stringify(inspection.findings));
  const study = inspection.analysis.study!;
  assert.ok(study.cards >= study.records && study.records > 0);
  assert.deepEqual(Object.keys(study.types).sort(), ["basic", "choice", "cloze", "occlusion", "typed"]);
  assert.equal(study.samples, 5);
  assert.equal(study.images, 0, "the built-in deck's picture is Flowplan's own SVG – not part of the package");
  assert.equal((await scanPackage(FLOWPLAN_DECK)).verdict, "clean");
});

test("a deck with an uploaded picture: the picture is the template's attachment, the scan stays clean", async () => {
  const bytes = deckPackage();
  const inspection = await inspectPackage(bytes);
  assert.ok(inspection.ok, JSON.stringify(inspection.findings));
  assert.equal(inspection.analysis.study!.images, 1);
  assert.equal(inspection.findings.filter((f) => f.level !== "info").length, 0, JSON.stringify(inspection.findings));
  const scan = await scanPackage(bytes);
  assert.equal(scan.verdict, "clean", JSON.stringify(scan.findings.filter((f) => f.severity !== "info")));
});

test("study-meta.json is cleaned: lengths, invisible characters, unknown fields, masks off the picture", () => {
  const long = "x".repeat(5000);
  const parsed = parseStudyMeta({
    ...base,
    extra: "dropped",
    types: { cloze: 3, basic: -1, nonsense: 4 },
    samples: [
      { type: "cloze", front: [{ text: "A‮B​<b>C</b>" }, { text: "gap", gap: true, html: "<i>x</i>" }], back: [{ text: long }] },
      { type: "occlusion", front: [], back: [], image: { file: "../../etc/passwd" }, masks: [{ shape: "rect", x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: "ok", asked: true }, { shape: "rect", x: 5, y: 0, w: 0.1, h: 0.1 }, { shape: "polygon", x: 0, y: 0, w: 0.1, h: 0.1, points: [[0, 0]] }, { shape: "circle", x: 0, y: 0, w: 1, h: 1 }] },
      { type: "basic", front: [], back: [] },
      { type: "nonsense", front: [{ text: "x" }], back: [] },
      ...Array.from({ length: 5 }, () => ({ type: "basic", front: [{ text: "more" }], back: [{ text: "x" }] })),
    ],
  });
  const meta = parsed.meta!;
  assert.deepEqual(meta.types, { cloze: 3 });
  assert.equal(meta.samples.length, 3, "the empty and unknown samples dropped, at most five looked at");
  assert.equal(meta.samples[0].front[0].text, "AB<b>C</b>", "bidi and zero-width characters gone, markup stays text");
  assert.equal(meta.samples[0].front[1].gap, true);
  assert.ok(!("html" in meta.samples[0].front[1]));
  assert.ok(meta.samples[0].back[0].text.length <= STUDY_LIMITS.run);
  assert.equal(meta.samples[1].image, null, "only an attachment id");
  assert.equal(meta.samples[1].masks.length, 1);
  assert.deepEqual(new Set(parsed.problems), new Set(["image", "mask", "sample", "too-many"]));
  assert.equal(readStudyMeta(Buffer.from("{")).meta, null);
  assert.equal(readStudyMeta(Buffer.alloc(STUDY_LIMITS.bytes + 1, 32)).meta, null);
  assert.equal(parseStudyMeta({ ...base, format: "x" }).meta, null);
});

test("a picture must be the template's own PNG, JPEG or WebP: missing files and SVG are left out with a warning", async () => {
  // (Too large: random bytes after a PNG signature – incompressible, no zip bomb.)
  for (const picture of [SVG, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(STUDY_LIMITS.imageBytes)])]) {
    const inspection = await inspectPackage(deckPackage({}, picture));
    assert.ok(inspection.ok, "the deck itself is fine");
    assert.equal(inspection.analysis.study!.images, 0);
    assert.ok(inspection.findings.some((f) => f.code === "study-meta-image"));
  }
  const other = await inspectPackage(deckPackage({ samples: [{ type: "occlusion", front: [{ text: "x" }], back: [], image: { file: "0b6c5c1e-1111-4222-8333-944455556666" }, masks: [{ shape: "rect", x: 0, y: 0, w: 0.5, h: 0.5 }] }] }));
  assert.ok(other.findings.some((f) => f.code === "study-meta-image"));
  const parsed = withImages(parseStudyMeta({ ...base, samples: [{ type: "occlusion", front: [], back: [], image: { file: "0b6c5c1e-1111-4222-8333-944455556666" }, masks: [{ shape: "rect", x: 0, y: 0, w: 0.5, h: 0.5 }] }] }), new Map());
  assert.equal(parsed.meta!.samples[0].image, null);
  // A broken meta costs only the preview.
  const broken = await inspectPackage(deckPackage({ format: "nope" }));
  assert.ok(broken.ok);
  assert.equal(broken.analysis.study, undefined);
  assert.ok(broken.findings.some((f) => f.code === "study-meta-invalid" && f.level === "warning"));
});

test("the sample cards render as text and SVG shapes – nothing from the package as HTML, no style attributes", () => {
  const meta = parseStudyMeta({
    ...base,
    types: { cloze: 1, choice: 1, occlusion: 1 },
    samples: [
      { type: "cloze", front: [{ text: "<img src=x onerror=alert(1)>" }, { text: "…", gap: true }], back: [{ text: "<img src=x onerror=alert(1)>" }, { text: "Paris", gap: true }] },
      { type: "choice", front: [{ text: "Pick" }], back: [{ text: "B" }], choices: ["A", "B", "<script>alert(1)</script>"] },
      { type: "occlusion", front: [{ text: "Name it" }], back: [], image: { file: "0b6c5c1e-1111-4222-8333-944455556666", alt: '"><script>' }, masks: [{ shape: "rect", x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: "Nucleus", asked: true }, { shape: "polygon", x: 0.5, y: 0.5, w: 0.2, h: 0.2, points: [[0.5, 0.5], [0.7, 0.5], [0.6, 0.7]] }] },
    ],
  }).meta!;
  const out = html(meta);
  assert.ok(!out.includes("<img src=x") && !out.includes("<script>"), out);
  assert.ok(out.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(!/\sstyle=/.test(out), "no style attributes (strict CSP)");
  assert.match(out, /class="study-gap">\[…\]/);
  assert.match(out, /<mark class="study-answer">Paris<\/mark>/);
  assert.match(out, /<li class="is-correct">B/);
  assert.match(out, /<rect class="study-mask study-mask-asked" x="100" y="100" width="200" height="200"/);
  assert.match(out, /<polygon class="study-mask" points="500,500 700,500 600,700"/);
  assert.match(out, /Answer: Nucleus/);
  // Without a picture: the masks over a placeholder.
  assert.match(html(meta, () => null), /Picture not in the preview/);
});

test("published: the template page's picture route and the admin API carry the samples; inspect shows them before submitting", async () => {
  const bytes = deckPackage();
  const inspect = await handle(() => inspectRoute(req("/api/packages/inspect", { method: "POST", body: new Uint8Array(bytes), headers: sameOrigin })));
  const data = (await inspect.json()) as any;
  assert.equal(data.study.meta.samples.length, 3);
  assert.match(data.study.images["3"], /^data:image\/png;base64,/);
  assert.equal(data.study.images["1"], undefined);

  const a = author("Deck Autorin");
  const sent = await submitVia(a, bytes, { title: "Cell biology", category: "knowledge" });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  const admin = (path: string[]) => handle(() => adminRoute(req(`/api/admin/${path.join("/")}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), path));
  const detail = (await (await admin(["submissions", sent.data.versionId])).json()) as any;
  const study = detail.submission.study;
  assert.equal(study.cards, 5);
  assert.equal(study.samples[2].type, "occlusion");
  assert.match(study.samples[2].image.url, new RegExp(`/api/admin/submissions/${sent.data.versionId}/cards/3$`));
  assert.ok(!("file" in study.samples[2].image), "the admin gets a URL, not the attachment id");
  const card = await admin(["submissions", sent.data.versionId, "cards", "3"]);
  assert.equal(card.status, 200);
  assert.equal(card.headers.get("content-type"), "image/png");
  assert.equal(card.headers.get("content-security-policy"), "default-src 'none'");
  assert.equal((await admin(["submissions", sent.data.versionId, "cards", "1"])).status, 404);
  assert.equal(detail.submission.analysis.study.images, 1);

  await decide(sent.data.versionId, { decision: "publish" }, "test");
  const pic = await handle(() => studyCardRoute(req(`/api/templates/${sent.data.slug}/cards/3`), sent.data.slug, 3), { cors: true });
  assert.equal(pic.status, 200);
  assert.equal(pic.headers.get("x-content-type-options"), "nosniff");
  const inner = await readZip((await readZip(bytes)).get("payload/template.zip")!);
  const file = [...inner.keys()].find((k) => k.startsWith("files/"))!;
  assert.ok(Buffer.from(await pic.arrayBuffer()).equals(inner.get(file)!), "the attachment's bytes");
  for (const n of [1, 0, 9]) assert.equal((await handle(() => studyCardRoute(req(`/api/templates/${sent.data.slug}/cards/${n}`), sent.data.slug, n), { cors: true })).status, 404);

  // Other kinds and databases without meta: no study.
  const plain = await submitVia(a, (await import("./fixtures")).docPackage(), { title: "Doc" });
  const plainDetail = (await (await admin(["submissions", plain.data.versionId])).json()) as any;
  assert.equal(plainDetail.submission.study, null);
});
