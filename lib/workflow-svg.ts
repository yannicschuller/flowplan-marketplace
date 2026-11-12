// The workflow diagram as SVG (lib/workflow-view.ts → a small element
// tree): the template page turns the tree into React elements
// (components/workflow-viewer.tsx), the admin API into markup with
// svgMarkup(). Styling is by class only (app/globals.css, light and dark),
// no style attributes, no scripts, no links, no external references – the
// only url() is the arrow marker inside the same SVG. Texts come from the
// package: they are clipped here and escaped by React or by svgMarkup().
// Client-safe.
import { translate, type T } from "./i18n";
import { CARD, type ViewNode, type WorkflowView } from "./workflow-view";
import { VIEWER_ICONS } from "./viewer-icons";

export type SvgEl = { t: string; a?: Record<string, string | number>; c?: (SvgEl | string)[] };
export type Bounds = { x: number; y: number; w: number; h: number };
export type Diagram = { tree: SvgEl; bounds: Bounds };

const PAD = 36;
const ICON = 18;
// Average glyph width per pixel of font size (Instrument Sans; the monospace
// line 0.6), for clipping without measuring.
const GLYPH = 0.52;
const fit = (s: string, px: number, size: number, glyph = GLYPH) => {
  const max = Math.max(4, Math.floor(px / (size * glyph)));
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const r1 = (n: number) => Math.round(n * 10) / 10;
const el = (t: string, a: SvgEl["a"] = {}, c: SvgEl["c"] = []): SvgEl => ({ t, a, c });
const icon = (d: string, x: number, y: number, size: number, cls: string): SvgEl =>
  el("g", { transform: `translate(${r1(x)} ${r1(y)}) scale(${Math.round((size / 256) * 10000) / 10000})`, class: cls, "aria-hidden": "true" }, [el("path", { d })]);

// Where an output leaves a card: spread over its right edge like on the canvas.
export function portPoint(node: Pick<ViewNode, "x" | "y" | "ports">, port: string) {
  const i = Math.max(0, node.ports.findIndex((p) => p.id === port));
  const n = Math.max(1, node.ports.length);
  return { x: node.x + CARD.w, y: node.y + (CARD.h * (i + 1)) / (n + 1) };
}
export function edgePath(a: { x: number; y: number }, b: { x: number; y: number }) {
  const forward = b.x - a.x;
  const dx = forward > 40 ? Math.max(36, forward / 2) : 70 + Math.min(160, Math.abs(b.y - a.y) / 3);
  return `M${r1(a.x)},${r1(a.y)} C${r1(a.x + dx)},${r1(a.y)} ${r1(b.x - dx)},${r1(b.y)} ${r1(b.x)},${r1(b.y)}`;
}

export function workflowDiagram(view: WorkflowView): Diagram {
  const t: T = translate(view.locale);
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  // Bounds of cards, frames and the curves' reach.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const n of view.nodes) {
    grow(n.x, n.y - 12);
    grow(n.x + CARD.w, n.y + CARD.h);
  }

  const frames: SvgEl[] = view.loops.map((loop) => {
    const members = loop.members.map((id) => byId.get(id)).filter((n): n is ViewNode => !!n);
    const x = Math.min(...members.map((n) => n.x)) - 18;
    const y = Math.min(...members.map((n) => n.y)) - 46;
    const w = Math.max(...members.map((n) => n.x)) + CARD.w + 18 - x;
    const h = Math.max(...members.map((n) => n.y)) + CARD.h + 18 - y;
    grow(x, y);
    grow(x + w, y + h);
    return el("g", { class: "wf-loop" }, [
      el("rect", { x, y, width: w, height: h, rx: 14 }),
      icon(VIEWER_ICONS.loop, x + 12, y + 9, 14, "wf-loop-icon"),
      el("text", { x: x + 32, y: y + 21, class: "wf-loop-label" }, [fit(loop.label, w - 44, 12)]),
    ]);
  });

  const edges: SvgEl[] = [];
  const labels: SvgEl[] = [];
  for (const e of view.edges) {
    const from = byId.get(e.from)!;
    const to = byId.get(e.to)!;
    const a = portPoint(from, e.port);
    const b = { x: to.x, y: to.y + CARD.h / 2 };
    const d = edgePath(a, b);
    if (b.x - a.x <= 40) {
      grow(a.x + 70 + Math.min(160, Math.abs(b.y - a.y) / 3), a.y);
      grow(b.x - 70 - Math.min(160, Math.abs(b.y - a.y) / 3), b.y);
    }
    const kind = e.port === "error" ? "error" : ["false", "rejected", "timeout", "unclear", "default"].includes(e.port) ? "alt" : "main";
    edges.push(
      el("g", { class: `wf-edge wf-edge-${kind}` }, [
        el("title", {}, [t(`Von „${from.label}“ (${e.label}) nach „${to.label}“`, `From “${from.label}” (${e.label}) to “${to.label}”`)]),
        el("path", { d, "marker-end": `url(#wfv-arrow-${kind})` }),
      ]),
    );
  }
  // Output names beside the card where they leave it (not for a lone "next").
  for (const n of view.nodes) {
    if (!n.ports.length || (n.ports.length === 1 && n.ports[0].id === "out")) continue;
    for (const p of n.ports) {
      const a = portPoint(n, p.id);
      const text = fit(p.label, 92, 11);
      const w = Math.ceil(text.length * 11 * GLYPH) + 12;
      const kind = p.id === "error" ? "error" : ["false", "rejected", "timeout", "unclear", "default"].includes(p.id) ? "alt" : "main";
      labels.push(
        el("g", { class: `wf-port wf-port-${kind}`, transform: `translate(${r1(a.x + 6)} ${r1(a.y - 19)})` }, [el("rect", { width: w, height: 16, rx: 8 }), el("text", { x: 6, y: 11.5 }, [text])]),
      );
    }
  }

  const cards: SvgEl[] = view.nodes.map((n) => {
    const sub = n.disabled ? t("abgeschaltet", "switched off") : (n.risks.find((r) => r.kind === "external")?.text ?? (n.risks[0]?.kind === "ai" ? t("KI-Schritt", "AI step") : n.risks[0]?.kind === "email" ? t("E-Mail", "E-mail") : ""));
    const riskText = n.risks.map((r) => (r.kind === "external" ? t("extern", "external") : r.text)).join(" · ");
    const classes = ["wf-node", `wf-cat-${n.group}`, ...n.risks.map((r) => `wf-risk-${r.kind}`), n.trigger ? "wf-trigger" : "", n.disabled ? "wf-off" : ""].filter(Boolean).join(" ");
    const badges: SvgEl[] = [];
    let bx = CARD.w - 8;
    for (const r of [...n.risks].reverse()) {
      const label = r.kind === "external" ? t("extern", "external") : r.text;
      const w = Math.ceil(label.length * 10.5 * GLYPH) + 30;
      bx -= w;
      badges.push(el("g", { class: `wf-badge wf-badge-${r.kind}`, transform: `translate(${bx} -10)` }, [el("rect", { width: w, height: 20, rx: 10 }), icon(VIEWER_ICONS[r.kind], 7, 3, 14, "wf-badge-icon"), el("text", { x: 24, y: 14 }, [label])]));
      bx -= 4;
    }
    const aria = [n.name !== n.label ? `${n.name}: ${n.label}` : n.label, riskText, n.disabled ? t("abgeschaltet", "switched off") : ""].filter(Boolean).join(", ");
    return el(
      "g",
      { class: classes, transform: `translate(${n.x} ${n.y})`, "data-node": n.id, tabindex: 0, role: "button", "aria-label": t(`${aria}. Einstellungen ansehen`, `${aria}. View settings`) },
      [
        el("rect", { class: "wf-node-box", width: CARD.w, height: CARD.h, rx: 10 }),
        el("rect", { class: "wf-node-bar", x: 0, y: 10, width: 3, height: CARD.h - 20, rx: 1.5 }),
        icon(n.icon ?? VIEWER_ICONS.generic, 14, 12, ICON, "wf-node-icon"),
        el("text", { class: "wf-node-type", x: 38, y: 26 }, [fit(n.name, CARD.w - 50, 11.5)]),
        el("text", { class: "wf-node-label", x: 14, y: sub ? 49 : 54 }, [fit(n.label, CARD.w - 26, 13.5)]),
        ...(sub ? [el("text", { class: "wf-node-sub", x: 14, y: 66 }, [fit(sub, CARD.w - 26, 11.5, 0.6)])] : []),
        ...badges,
      ],
    );
  });

  if (!view.nodes.length) {
    grow(0, 0);
    grow(CARD.w, CARD.h);
  }
  const bounds = { x: Math.floor(minX - PAD), y: Math.floor(minY - PAD), w: Math.ceil(maxX - minX + 2 * PAD), h: Math.ceil(maxY - minY + 2 * PAD) };
  const marker = (kind: string) =>
    el("marker", { id: `wfv-arrow-${kind}`, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse", class: `wf-arrow wf-arrow-${kind}` }, [el("path", { d: "M0,1 L9,5 L0,9 z" })]);
  const tree = el(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: `${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`,
      class: "wf-svg",
      role: "group",
      "aria-label": t(`Ablaufdiagramm mit ${view.nodes.length} Knoten`, `Flow diagram with ${view.nodes.length} nodes`),
    },
    [el("defs", {}, ["main", "alt", "error"].map(marker)), el("g", { class: "wf-frames" }, frames), el("g", { class: "wf-edges" }, edges), el("g", { class: "wf-nodes" }, cards), el("g", { class: "wf-ports" }, labels)],
  );
  return { tree, bounds };
}

// ---- Markup (admin API) ----

const TAGS = new Set(["svg", "defs", "marker", "g", "rect", "path", "text", "title"]);
const ATTR = /^[a-z][a-zA-Z0-9-]*$/;
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
// Only the tags and attribute names the builder uses; every text and value escaped.
export function svgMarkup(node: SvgEl | string): string {
  if (typeof node === "string") return escapeXml(node);
  if (!TAGS.has(node.t)) return "";
  const attrs = Object.entries(node.a ?? {})
    .filter(([k]) => ATTR.test(k) && !/^on/i.test(k) && k !== "style" && k !== "href")
    .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
    .join("");
  return `<${node.t}${attrs}>${(node.c ?? []).map(svgMarkup).join("")}</${node.t}>`;
}
