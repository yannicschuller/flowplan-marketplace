// The read-only workflow viewer: workflow-meta.json is validated (bad
// symbols dropped, unknown fields stripped), the SVG escapes whatever the
// package says, large graphs are cut, nodes sit at their positions, the
// summary of every official workflow reads right in both languages, older
// packages without meta still render, the viewer renders without inline
// styles or scripts, and the inspect route and the admin API carry it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ADMIN_TOKEN, BASE, req, useTempData } from "./helpers";
useTempData();
import { parseWorkflowMeta, readWorkflowMeta, WORKFLOW_META_PATH } from "../lib/workflow-meta";
import { buildWorkflowView, CARD, summaryText, VIEW_LIMITS } from "../lib/workflow-view";
import { svgMarkup, workflowDiagram } from "../lib/workflow-svg";
import { viewerFromEntries } from "../lib/workflow-viewer";
import { VIEWER_ICONS } from "../lib/viewer-icons";
import { readZip } from "../lib/zip";
import { inspectRoute } from "../lib/routes";
import { adminRoute } from "../lib/admin";
import { handle } from "../lib/http";
import { buildSamplePackage, workflowPayload } from "../lib/sample-packages";
import { WorkflowViewer } from "../components/workflow-viewer";
import { WorkflowSummary } from "../components/workflow-summary";
import { LocaleProvider } from "../components/i18n";
import { translate } from "../lib/i18n";
import { author, submitVia } from "./flow";

const OFFICIAL = join(import.meta.dirname, "..", "seed", "official");
const ICON = "M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Z";
const meta = (nodes: Record<string, unknown>, gaps: unknown[] = []) => ({ format: "flowplan.workflow-meta", version: 1, nodes, gaps });
const graph = (nodes: { id: string; type: string; label: string; x?: number; y?: number; config?: Record<string, unknown> }[], edges: [string, string, string?][]) => ({
  format: "flowplan.workflow",
  version: 1,
  graph: {
    nodes: nodes.map((n) => ({ id: n.id, type: n.type, label: n.label, position: { x: n.x ?? 0, y: n.y ?? 0 }, config: n.config ?? {} })),
    edges: edges.map(([from, to, port], i) => ({ id: `e_${i}`, from: { node: from, port: port ?? "out" }, to: { node: to, port: "in" } })),
  },
});
const official = async (file: string) => readZip(readFileSync(join(OFFICIAL, file)));

test("meta: unknown fields stripped, bad symbols dropped, limits, a wrong format refused", () => {
  const parsed = parseWorkflowMeta(
    meta(
      {
        "http.request": { name: { de: "HTTP-Anfrage", en: "HTTP request", fr: "x" }, icon: ICON, group: "http", ports: { error: { de: "Fehler", en: "Error" } }, external: true, evil: "<script>" },
        "ai.summarize": { name: { de: "KI", en: "AI" }, icon: '<path d="M0 0" onload="alert(1)"/>' },
        "notify.email": { name: { de: "Mail", en: "Mail" }, icon: "M0,0 url(javascript:alert(1))" },
        "logic.if": { name: { de: "Wenn", en: "If" }, icon: "M0,0 L1,1 Z&#x3C;" },
        __proto__: { name: { de: "x", en: "x" } },
      },
      [{ id: "database", label: { de: "Datenbank", en: "Database" }, kind: "database", extra: 1 }, { id: "database", label: { de: "doppelt" } }, { label: "no id" }],
    ),
  );
  assert.ok(parsed.meta);
  const m = parsed.meta!;
  assert.deepEqual(Object.keys(m.nodes).sort(), ["ai.summarize", "http.request", "logic.if", "notify.email"]);
  assert.deepEqual(m.nodes["http.request"].name, { de: "HTTP-Anfrage", en: "HTTP request" });
  assert.equal(m.nodes["http.request"].icon, ICON);
  assert.equal(m.nodes["http.request"].external, true);
  assert.equal("evil" in m.nodes["http.request"], false);
  for (const type of ["ai.summarize", "notify.email", "logic.if"]) assert.equal(m.nodes[type].icon, null, type);
  assert.ok(parsed.problems.includes("icon"));
  assert.ok(parsed.problems.includes("gap"));
  assert.deepEqual(m.gaps, [{ id: "database", label: { de: "Datenbank", en: "Database" }, kind: "database", optional: false }]);
  // Not this format, a newer version, broken JSON, too large: no meta.
  assert.equal(parseWorkflowMeta({ format: "other", version: 1, nodes: {} }).meta, null);
  assert.equal(parseWorkflowMeta(meta({}) && { ...meta({}), version: 2 }).meta, null);
  assert.equal(readWorkflowMeta(Buffer.from("{nope")).meta, null);
  assert.equal(readWorkflowMeta(Buffer.alloc(600 * 1024, 32)).meta, null);
  assert.equal(readWorkflowMeta(undefined).meta, null);
  // Long texts are cut by the schema (the node is dropped, not the whole meta).
  const long = parseWorkflowMeta(meta({ "a.b": { name: { de: "x".repeat(500), en: "y" } } }));
  assert.equal(long.meta!.nodes["a.b"].name.de, "");
});

const EVIL = '</text><script>alert(1)</script><foreignObject><a href="https://evil.example">x</a></foreignObject>';
test("svg: whatever the package says stays text – no tags, handlers, styles or links get through", () => {
  const view = buildWorkflowView({
    workflow: graph(
      [
        { id: "n_start1", type: "trigger.manual", label: EVIL },
        { id: "n_http01", type: "http.request", label: 'a" onclick="alert(1)', x: 320, config: { url: "https://api.example.com/x?<b>", body: '<img src=x onerror="alert(1)">', headers: [{ name: "X", value: "{{n_start1.x}}" }] } },
      ],
      [["n_start1", "n_http01", 'out" onmouseover="x']],
    ),
    meta: parseWorkflowMeta(meta({ "trigger.manual": { name: { de: '"><script>alert(2)</script>', en: "x" }, icon: ICON } })).meta,
    locale: "de",
  })!;
  const markup = svgMarkup(workflowDiagram(view).tree);
  assert.doesNotMatch(markup, /<script|<foreignObject|<a[\s>]|<img/i);
  assert.doesNotMatch(markup, /\son[a-z]+="/i);
  assert.doesNotMatch(markup, /\s(?:style|href|xlink:href|src)="/i);
  assert.match(markup, /&lt;\/text&gt;&lt;script&gt;/);
  assert.match(markup, /&quot;&gt;&lt;script&gt;/);
  // Only the builder's own tags.
  for (const m of markup.matchAll(/<([a-zA-Z]+)/g)) assert.ok(["svg", "defs", "marker", "g", "rect", "path", "text", "title"].includes(m[1]), m[1]);
  // The serializer itself refuses foreign tags and attributes.
  assert.equal(svgMarkup({ t: "script", c: ["x"] }), "");
  assert.equal(svgMarkup({ t: "g", a: { onclick: "x", style: "x", href: "x", "a b": 1, class: '"><x' } }), '<g class="&quot;&gt;&lt;x"></g>');
  // The settings are texts too; hosts are text, never fetched or linked.
  const http = view.nodes[1];
  assert.equal(http.host, "api.example.com");
  assert.deepEqual(http.risks.map((r) => r.kind), ["external"]);
  const body = http.settings.find((r) => r.key === "body")!.value;
  assert.equal(body.k, "text");
  assert.deepEqual(body.k === "text" && body.parts, [{ k: "t", v: '<img src=x onerror="alert(1)">' }]);
});

test("size: large graphs are cut with a note, coordinates and settings are limited", () => {
  const nodes = [{ id: "n_start1", type: "trigger.manual", label: "Start", x: -1e12, y: 1e12 }, ...Array.from({ length: 149 }, (_, i) => ({ id: `n_s${String(i).padStart(5, "0")}`, type: "logic.set", label: `Schritt ${i}`, x: (i + 1) * 320, y: 0, config: Object.fromEntries(Array.from({ length: 60 }, (_, k) => [`k${k}`, "v".repeat(1000)])) }))];
  const edges: [string, string][] = nodes.slice(1).map((n, i) => [nodes[i].id, n.id]);
  const view = buildWorkflowView({ workflow: graph(nodes, edges), meta: null, locale: "en" })!;
  assert.equal(view.total, 150);
  assert.equal(view.shown, VIEW_LIMITS.nodes);
  assert.ok(view.edges.length <= VIEW_LIMITS.edges);
  assert.ok(view.edges.every((e) => view.nodes.some((n) => n.id === e.from) && view.nodes.some((n) => n.id === e.to)));
  assert.match(view.summary.notes.join(" "), /first 100 of 150/);
  assert.equal(view.nodes[0].x, -VIEW_LIMITS.coordinate);
  assert.equal(view.nodes[0].y, VIEW_LIMITS.coordinate);
  const step = view.nodes[1];
  assert.equal(step.settings.length, VIEW_LIMITS.rows);
  assert.equal(step.moreSettings, 20);
  const first = step.settings[0].value;
  assert.ok(first.k === "text" && first.parts[0].v.length <= VIEW_LIMITS.text);
  // A broken graph is no viewer; broken nodes and dangling edges are left out.
  assert.equal(buildWorkflowView({ workflow: { format: "flowplan.workflow" }, meta: null, locale: "de" }), null);
  const loose = buildWorkflowView({ workflow: { graph: { nodes: [{ id: "n_a", type: "trigger.manual", label: "A" }, { nope: 1 }, "x"], edges: [{ from: { node: "n_a" }, to: { node: "n_zz" } }] } }, meta: null, locale: "de" })!;
  assert.equal(loose.nodes.length, 1);
  assert.equal(loose.edges.length, 0);
});

test("positions: cards at the graph's positions, edges from the output to the input", () => {
  const view = buildWorkflowView({
    workflow: graph(
      [
        { id: "n_t00001", type: "trigger.manual", label: "Start", x: 10, y: 20 },
        { id: "n_if0001", type: "logic.if", label: "Prüfen", x: 330, y: 20 },
        { id: "n_yes001", type: "notify.person", label: "Ja", x: 650, y: -80 },
        { id: "n_no0001", type: "notify.person", label: "Nein", x: 650, y: 120 },
      ],
      [
        ["n_t00001", "n_if0001"],
        ["n_if0001", "n_yes001", "true"],
        ["n_if0001", "n_no0001", "false"],
      ],
    ),
    meta: null,
    locale: "de",
  })!;
  const diagram = workflowDiagram(view);
  const markup = svgMarkup(diagram.tree);
  assert.match(markup, /data-node="n_yes001"[^>]*>/);
  assert.match(markup, /transform="translate\(650 -80\)" data-node="n_yes001"/);
  assert.match(markup, /<path d="M230,58 C/);
  // The two outputs of the condition, spread over its right edge, named.
  assert.match(markup, new RegExp(`<path d="M550,${Math.round((20 + CARD.h / 3) * 10) / 10} C`));
  assert.match(markup, /<text x="6" y="11.5">ja<\/text>/);
  assert.match(markup, /<text x="6" y="11.5">nein<\/text>/);
  assert.ok(diagram.bounds.x <= 10 && diagram.bounds.y <= -80 - 12 && diagram.bounds.x + diagram.bounds.w >= 870 && diagram.bounds.y + diagram.bounds.h >= 120 + CARD.h);
  // Conditions read as "field – operator – value".
  const cond = buildWorkflowView({
    workflow: graph([{ id: "n_if0001", type: "logic.if", label: "If", config: { condition: { kind: "group", join: "and", rules: [{ kind: "condition", left: "{{n_if0001.x}}", op: "neq", value: "$ask:done" }] } } }], []),
    meta: parseWorkflowMeta(meta({}, [{ id: "done", label: { de: "Wert für erledigt", en: "Value for done" }, kind: "option" }])).meta,
    locale: "de",
  })!;
  const c = cond.nodes[0].settings[0].value;
  assert.equal(c.k, "conditions");
  assert.deepEqual(c.k === "conditions" && c.rules[0], { k: "cond", field: [{ k: "ph", v: "{{If.x}}" }], op: "ist nicht", value: [{ k: "gap", v: "Wert für erledigt" }] });
});

const OFFICIAL_SUMMARIES: Record<string, { trigger: string; steps: number; de: RegExp[]; en: RegExp[]; gaps: string[] }> = {
  "workflow-due-reminder.flowplan-template": { trigger: "Zwei Tage vor Fälligkeit", steps: 2, de: [/bei „ja“ weiter mit Schritt 2, sonst endet er hier/], en: [/on “yes” continue with step 2/], gaps: ["Datenbank", "Fälligkeitsdatum"] },
  "workflow-form-triage.flowplan-template": { trigger: "Formularantwort", steps: 3, de: [/nutzt KI/, /bei „unklar“ weiter mit Schritt 3, sonst mit Schritt 2/], en: [/uses AI/, /on “unclear” continue with step 3/], gaps: ["Teamleitung"] },
  "workflow-mail-ticket.flowplan-template": { trigger: "E-Mail empfangen", steps: 3, de: [/empfängt E-Mails/, /verschickt eine E-Mail/, /nutzt KI/], en: [/receives e-mail/, /sends an e-mail/], gaps: ["E-Mail-Adresse", "Ticket-Datenbank"] },
  "workflow-subpages-overview.flowplan-template": { trigger: "Neue Unterseite", steps: 2, de: [/bei „Fehler“ weiter mit Schritt 2/], en: [/on “Error” continue with step 2/], gaps: ["Übersichtsseite"] },
  "workflow-webhook-record.flowplan-template": { trigger: "Eingehender Webhook", steps: 1, de: [/wird von außen aufgerufen/], en: [/is called from outside/], gaps: ["Datenbank"] },
  "workflow-weekly-report.flowplan-template": { trigger: "Freitags 15:00", steps: 4, de: [/Zeitplan/, /„Im Chat posten“ \(Chat-Nachricht\) – spricht einen externen Dienst an/], en: [/Schedule/, /talks to an external service/], gaps: ["Berichte ablegen unter"] },
};
test("summary: the six official workflows in plain language, German and English", async () => {
  const files = readdirSync(OFFICIAL).filter((f) => f.startsWith("workflow-"));
  assert.deepEqual(files.sort(), Object.keys(OFFICIAL_SUMMARIES).sort());
  for (const file of files) {
    const expected = OFFICIAL_SUMMARIES[file];
    const entries = await official(file);
    assert.ok(entries.has(WORKFLOW_META_PATH), `${file}: has workflow-meta.json`);
    for (const locale of ["de", "en"] as const) {
      const data = viewerFromEntries(entries, "payload/workflow.json", locale)!;
      const s = data.view.summary;
      assert.ok(data.view.hasMeta, file);
      assert.ok(s.lead.startsWith(locale === "de" ? `Startet mit „${expected.trigger}“` : `Starts with “${expected.trigger}”`), `${file} ${locale}: ${s.lead}`);
      assert.equal(s.steps.length, expected.steps, `${file} ${locale}`);
      const text = summaryText(s);
      for (const re of expected[locale]) assert.match(text, re, `${file} ${locale}`);
      assert.doesNotMatch(text, /\$ask:|n_[a-z0-9]{4,}|undefined|\[object/, `${file} ${locale}`);
      // Every node has a name from the meta and a symbol.
      for (const n of data.view.nodes) {
        assert.notEqual(n.name, n.type, `${file}: ${n.type} named`);
        assert.ok(n.icon, `${file}: ${n.type} symbol`);
      }
      if (locale === "de") for (const gap of expected.gaps) assert.ok(data.view.gaps.includes(gap), `${file}: gap ${gap} in ${data.view.gaps.join(", ")}`);
      else assert.ok(data.view.gaps.every((g) => g.trim()), file);
    }
  }
  // A placeholder naming a gap reads as that gap: "Status (optional) – ist nicht – Wert für erledigt".
  const reminder = viewerFromEntries(await official("workflow-due-reminder.flowplan-template"), "payload/workflow.json", "de")!.view;
  const condition = reminder.nodes.find((n) => n.type === "logic.if")!.settings[0].value;
  assert.ok(condition.k === "conditions" && condition.rules[0].k === "cond");
  if (condition.k === "conditions" && condition.rules[0].k === "cond") {
    assert.deepEqual(condition.rules[0].field, [{ k: "gap", v: "Status (optional)" }]);
    assert.deepEqual(condition.rules[0].value, [{ k: "gap", v: "Wert für erledigt" }]);
  }
  // AI and e-mail nodes are marked from their types, whatever the meta says.
  const entries = await official("workflow-mail-ticket.flowplan-template");
  const lying = new Map(entries);
  const m = JSON.parse(entries.get(WORKFLOW_META_PATH)!.toString());
  for (const n of Object.values(m.nodes) as Record<string, unknown>[]) delete n.ai, delete n.email;
  lying.set(WORKFLOW_META_PATH, Buffer.from(JSON.stringify(m)));
  const kinds = viewerFromEntries(lying, "payload/workflow.json", "de")!.view.nodes.flatMap((n) => n.risks.map((r) => r.kind));
  assert.deepEqual(kinds.sort(), ["ai", "email", "email"]);
});

test("without workflow-meta.json (older packages): raw types and the generic symbol", async () => {
  const entries = await official("workflow-due-reminder.flowplan-template");
  entries.delete(WORKFLOW_META_PATH);
  const data = viewerFromEntries(entries, "payload/workflow.json", "de")!;
  assert.equal(data.view.hasMeta, false);
  assert.deepEqual(data.view.nodes.map((n) => n.name), ["trigger.record.date", "logic.if", "notify.person"]);
  assert.match(svgMarkup(data.tree), new RegExp(VIEWER_ICONS.generic.slice(0, 30).replace(/[.]/g, "\\.")));
  // The gaps still come from the tokens.
  assert.ok(data.view.gaps.includes("database"));
  assert.match(data.view.summary.steps[0], /bei „ja“ weiter mit Schritt 2/);
});

test("the viewer renders without inline styles or scripts, in both languages", async () => {
  for (const file of ["workflow-form-triage.flowplan-template", "workflow-weekly-report.flowplan-template"])
    for (const locale of ["de", "en"] as const) {
      const data = viewerFromEntries(await official(file), "payload/workflow.json", locale)!;
      const html = renderToStaticMarkup(createElement(LocaleProvider, { locale, children: [createElement(WorkflowViewer, { key: "v", data }), createElement(WorkflowSummary, { key: "s", view: data.view, t: translate(locale) })] }));
      assert.doesNotMatch(html, /\sstyle=/i, `${file}: no style attribute`);
      assert.doesNotMatch(html, /<script|<style/i, `${file}: no inline script or style`);
      assert.doesNotMatch(html, /\son[a-z]+=/i, `${file}: no event handler attributes`);
      assert.doesNotMatch(html.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, ""), /\shref=|https?:\/\//i, `${file}: nothing linked`);
      assert.match(html, /<svg[^>]*viewBox=/);
      assert.match(html, locale === "de" ? /Einpassen/ : /Fit/);
      assert.match(html, locale === "de" ? /Was er macht/ : /What it does/);
      assert.match(html, locale === "de" ? /Nach dem Import legst du fest/ : /After the import you set/);
    }
});

test("inspect route and admin API carry the viewer", async () => {
  const pkg = buildSamplePackage({
    kind: "workflow",
    title: "Mit Meta",
    summary: { de: "Kurz", en: "Short" },
    category: "other",
    payload: [
      workflowPayload("Mit Meta", [{ id: "n_trigger1", type: "trigger.manual", label: "Start", x: 0, y: 0 }, { id: "n_ai000001", type: "ai.summarize", label: "Zusammenfassen <b>", x: 320, y: 0 }], [["n_trigger1", "n_ai000001"]]),
      { path: WORKFLOW_META_PATH, bytes: Buffer.from(JSON.stringify(meta({ "ai.summarize": { name: { de: "KI: Zusammenfassen", en: "AI: Summarize" }, icon: "<svg onload=x>" } }))) },
    ],
  });
  const r = await handle(() => inspectRoute(req("/api/packages/inspect", { method: "POST", body: new Uint8Array(pkg), headers: { origin: BASE, "accept-language": "en" } })));
  const data = (await r.json()) as any;
  assert.equal(r.status, 200);
  assert.equal(data.ok, true);
  assert.ok(data.findings.some((f: { code: string }) => f.code === "workflow-meta-icon"), "the bad symbol is reported");
  assert.equal(data.analysis.workflow.meta, true);
  assert.equal(data.viewer.view.locale, "en");
  assert.equal(data.viewer.view.nodes[1].name, "AI: Summarize");
  assert.equal(data.viewer.view.nodes[1].icon, null);

  const a = author("Viewerin");
  const sent = await submitVia(a, pkg);
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  const detail = await handle(() => adminRoute(req(`/api/admin/submissions/${sent.data.versionId}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), ["submissions", sent.data.versionId]));
  const body = (await detail.json()) as any;
  const wf = body.submission.workflow;
  assert.ok(wf, "workflow viewer in the detail");
  assert.match(wf.summary.de, /^Startet mit „Start“/);
  assert.match(wf.summary.en, /“Zusammenfassen <b>” \(AI: Summarize\) – uses AI/);
  assert.match(wf.viewer.de.svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="/);
  assert.match(wf.viewer.de.svg, /Zusammenfassen &lt;b&gt;/);
  assert.equal(wf.viewer.en.nodes.length, 2);
  assert.ok(wf.viewer.de.bounds.w > 0);
  // Other kinds: null.
  const doc = await submitVia(a, (await import("./fixtures")).docPackage());
  const docDetail = (await (await handle(() => adminRoute(req(`/api/admin/submissions/${doc.data.versionId}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), ["submissions", doc.data.versionId]))).json()) as any;
  assert.equal(docDetail.submission.workflow, null);
});
