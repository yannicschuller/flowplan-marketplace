// Builds valid packages by hand from the exchange formats (contract §1):
// used by the demo data and the tests.
import { createHash, randomUUID } from "node:crypto";
import { writeZip } from "./zip";
import { Canvas, hex, type Rgb } from "./png";
import { PACKAGE_FORMAT } from "./package";
import type { Kind } from "./catalog";

export type PackageSpec = {
  kind: Kind;
  title: string;
  // template.json `titles`; default: the title as the English one (what a
  // current Flowplan always writes). null leaves it out (an older Flowplan).
  titles?: { de?: string; en?: string } | null;
  summary: { de?: string; en?: string };
  description?: { de?: string; en?: string };
  category: string;
  tags?: string[];
  minVersion?: string;
  language?: string;
  payload: { path: string; bytes: Buffer }[];
  previews?: Buffer[];
  // Overrides for broken packages in tests.
  manifest?: Record<string, unknown>;
  extra?: [string, Buffer][];
};

export function buildSamplePackage(spec: PackageSpec): Buffer {
  const manifest = {
    format: PACKAGE_FORMAT,
    kind: spec.kind,
    title: spec.title,
    ...(spec.titles === null ? {} : { titles: spec.titles ?? { en: spec.title } }),
    summary: spec.summary,
    ...(spec.description ? { description: spec.description } : {}),
    category: spec.category,
    tags: spec.tags ?? [],
    minVersion: spec.minVersion ?? "0.9.4",
    language: spec.language ?? "de",
    payload: spec.payload[0]?.path ?? "payload/missing",
    ...spec.manifest,
  };
  return writeZip([
    ["template.json", Buffer.from(JSON.stringify(manifest, null, 2))],
    ...spec.payload.map((p) => [p.path, p.bytes] as [string, Buffer]),
    ...(spec.previews ?? []).map((bytes, i) => [`preview/${i + 1}.png`, bytes] as [string, Buffer]),
    ...(spec.extra ?? []),
  ]);
}

// ---- Exchange formats ----

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// lib/template-exchange.ts: template.json {format, name, kind, category, payload, files}
// plus files/<id> for attachments.
export function flowplanTemplateZip(input: { name: string; kind: "document" | "database"; category: string; content: unknown; files?: { name: string; mime: string; data: Buffer }[] }) {
  const files = (input.files ?? []).map((f) => ({ id: randomUUID(), ...f }));
  const manifest = {
    format: "flowplan-template-1",
    name: input.name,
    kind: input.kind,
    category: input.category,
    payload: JSON.stringify(input.content),
    files: files.map((f) => ({ id: f.id, name: f.name, mime: f.mime, sha256: sha(f.data) })),
  };
  return writeZip([["template.json", Buffer.from(JSON.stringify(manifest))], ...files.map((f) => [`files/${f.id}`, f.data] as [string, Buffer])]);
}
export const documentPayload = (name: string, category: string, html: string) => ({
  path: "payload/template.zip",
  bytes: flowplanTemplateZip({ name, kind: "document", category, content: { html } }),
});

type Field = { id: string; name: string; type: string; options?: string[] };
export function databasePayload(name: string, category: string, fields: Field[], rows: Record<string, unknown>[], viewType = "table") {
  const views = [
    { id: "v-main", name: viewType === "board" ? "Board" : "Tabelle", type: viewType, filters: [], sorts: [], ...(viewType === "board" ? { groupBy: fields.find((f) => f.type === "select")?.id } : {}) },
    ...(viewType === "board" ? [{ id: "v-table", name: "Tabelle", type: "table", filters: [], sorts: [] }] : []),
  ];
  return {
    path: "payload/template.zip",
    bytes: flowplanTemplateZip({
      name,
      kind: "database",
      category,
      content: {
        database: { fields, views },
        rows: rows.map((cells, i) => ({ id: randomUUID(), cells, content: "", position: i })),
        relationPairs: [],
      },
    }),
  };
}

// lib/workflows/portable.ts export: {format, version, title, graph, references}.
type Node = { id: string; type: string; label: string; config?: Record<string, unknown>; x: number; y: number };
export function workflowPayload(title: string, nodes: Node[], edges: [string, string, string?][]) {
  const graph = {
    format: "flowplan.workflow",
    version: 1,
    settings: { timeZone: "Europe/Berlin", triggerOnOwnChanges: false, limits: {} },
    nodes: nodes.map((n) => ({ id: n.id, type: n.type, typeVersion: 1, label: n.label, note: "", position: { x: n.x, y: n.y }, disabled: false, config: n.config ?? {} })),
    edges: edges.map(([from, to, port], i) => ({ id: `e_${i + 1}`, from: { node: from, port: port ?? "out" }, to: { node: to, port: "in" } })),
  };
  const data = { format: "flowplan.workflow", version: 1, exportedAt: new Date().toISOString(), title, graph, references: {} };
  return { path: "payload/workflow.json", bytes: Buffer.from(JSON.stringify(data, null, 2)) };
}
export function whiteboardPayload(name: string, items: Record<string, unknown>[]) {
  return { path: "payload/whiteboard.json", bytes: Buffer.from(JSON.stringify({ format: "flowplan.whiteboard-template", version: 1, name, items }, null, 2)) };
}
export function appearancePayload(theme: Record<string, unknown>) {
  return { path: "payload/theme.json", bytes: Buffer.from(JSON.stringify({ theme }, null, 2)) };
}
export function linkRulesPayload(rules: { name: string; pattern: string; template: string }[]) {
  return { path: "payload/link-rules.json", bytes: Buffer.from(JSON.stringify({ rules: rules.map((r) => ({ ...r, enabled: true })) }, null, 2)) };
}

// ---- Preview pictures ----

const INK = hex("#d9d5cb");
const PAPER = hex("#fcfbf8");
export function previewImage(kind: Kind, accent: string, variant = 0): Buffer {
  const a = hex(accent);
  const soft: Rgb = [Math.round(a[0] * 0.18 + 255 * 0.82), Math.round(a[1] * 0.18 + 255 * 0.82), Math.round(a[2] * 0.18 + 255 * 0.82)];
  const c = new Canvas(960, 600, soft);
  // A window
  c.rect(60, 50, 840, 520, hex("#e4e0d6"), 18).rect(62, 52, 836, 516, PAPER, 16);
  c.rect(62, 52, 836, 44, hex("#f3f1eb"), 16).rect(62, 80, 836, 16, hex("#f3f1eb"));
  for (const [i, col] of ["#f0663a", "#e8b931", "#4cb782"].entries()) c.rect(86 + i * 22, 66, 12, 12, hex(col), 6);
  const body = { x: 110, y: 130 };
  switch (kind) {
    case "document":
      c.rect(body.x, body.y, 360, 26, hex("#1d1c22"), 6);
      for (let i = 0; i < 9; i++) {
        const y = body.y + 64 + i * 40;
        if (i === 3 || i === 6) c.rect(body.x, y, 220, 18, a, 5);
        else c.rect(body.x, y, 740 - ((i * 97 + variant * 53) % 260), 12, INK, 6);
      }
      break;
    case "database": {
      c.rect(body.x, body.y, 300, 24, hex("#1d1c22"), 6);
      const cols = [260, 160, 140, 180];
      for (let r = 0; r < 8; r++) {
        let x = body.x;
        const y = body.y + 56 + r * 42;
        c.rect(body.x, y + 38, 740, 2, hex("#ebe8e0"));
        for (const [ci, w] of cols.entries()) {
          if (r === 0) c.rect(x, y + 10, w * 0.5, 12, hex("#8e8a98"), 6);
          else if (ci === 1) c.rect(x, y + 8, 90, 20, [soft[0] - 30, soft[1] - 30, soft[2] - 10].map((v) => Math.max(0, v)) as Rgb, 10);
          else if (ci === 3) c.rect(x, y + 10, ((r * 37 + variant * 20) % 140) + 20, 14, a, 7);
          else c.rect(x, y + 12, w * (0.4 + ((r * 13 + ci * 7) % 5) / 10), 12, INK, 6);
          x += w + 14;
        }
      }
      break;
    }
    case "workflow": {
      const nodes = [
        [body.x, body.y + 140],
        [body.x + 270, body.y + 60],
        [body.x + 270, body.y + 240],
        [body.x + 540, body.y + 150],
      ];
      c.line(nodes[0][0] + 200, nodes[0][1] + 40, nodes[1][0], nodes[1][1] + 40, hex("#b3afbd"), 4);
      c.line(nodes[0][0] + 200, nodes[0][1] + 40, nodes[2][0], nodes[2][1] + 40, hex("#b3afbd"), 4);
      c.line(nodes[1][0] + 200, nodes[1][1] + 40, nodes[3][0], nodes[3][1] + 40, hex("#b3afbd"), 4);
      c.line(nodes[2][0] + 200, nodes[2][1] + 40, nodes[3][0], nodes[3][1] + 40, hex("#b3afbd"), 4);
      for (const [i, [x, y]] of nodes.entries()) {
        c.rect(x, y, 200, 80, hex("#e4e0d6"), 14).rect(x + 2, y + 2, 196, 76, PAPER, 12);
        c.rect(x + 16, y + 22, 36, 36, i === 0 ? hex("#f0663a") : a, 10);
        c.rect(x + 66, y + 26, 110, 12, hex("#1d1c22"), 6).rect(x + 66, y + 46, 80, 10, INK, 5);
      }
      break;
    }
    case "whiteboard": {
      const colors = ["#ffe58a", "#ffc4a8", "#bfe6cf", "#c8d4ff", "#ffe58a", "#e6c8ff"];
      for (let col = 0; col < 3; col++) {
        c.rect(body.x + col * 250, body.y, 160, 18, hex("#1d1c22"), 6);
        for (let r = 0; r < 2 + ((col + variant) % 2); r++) c.rect(body.x + col * 250 + (r % 2) * 20, body.y + 44 + r * 120, 200, 104, hex(colors[(col * 2 + r) % colors.length]), 8);
      }
      break;
    }
    case "appearance": {
      c.rect(body.x, body.y, 260, 26, hex("#1d1c22"), 6);
      const shades = [0.25, 0.45, 0.65, 0.85, 1];
      shades.forEach((s, i) => c.rect(body.x + i * 150, body.y + 70, 130, 130, a.map((v) => Math.round(v * s + 255 * (1 - s))) as Rgb, 16));
      c.rect(body.x, body.y + 240, 200, 48, a, 12).rect(body.x + 24, body.y + 258, 150, 12, hex("#ffffff"), 6);
      c.rect(body.x + 230, body.y + 240, 200, 48, hex("#e4e0d6"), 12).rect(body.x + 254, body.y + 258, 150, 12, hex("#8e8a98"), 6);
      for (let i = 0; i < 3; i++) c.rect(body.x, body.y + 320 + i * 26, 600 - i * 120, 12, INK, 6);
      break;
    }
    case "link-rules":
      for (let i = 0; i < 7; i++) {
        const y = body.y + i * 52;
        c.rect(body.x, y, 180 + ((i * 41) % 120), 14, INK, 7);
        c.rect(body.x + 330, y - 4, 150, 22, soft, 6).rect(body.x + 340, y + 2, 130, 10, a, 5).rect(body.x + 340, y + 14, 130, 2, a);
        c.rect(body.x + 510, y, 200 - ((i * 29) % 90), 14, INK, 7);
      }
      break;
  }
  return c.png();
}
