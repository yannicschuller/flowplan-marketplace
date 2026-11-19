// Flashcard decks (README "Flashcard decks"): Flowplan adds
// `payload/study-meta.json` to every package of a database template with a
// card mapping – the deck's numbers and up to five sample cards – next to
// the unchanged payload/template.zip. Nothing of it is trusted: the schema
// is checked here, texts are length-limited and cleaned of control and
// invisible characters, unknown fields are dropped, masks must lie on the
// picture, and a sample's picture must be one of the template's own
// attachments (`files/<id>` in payload/template.zip) that really is a PNG,
// JPEG or WebP of at most 2 MB – otherwise the sample is shown without it.
// A broken file gives no preview (finding study-meta-invalid), the deck
// itself is unaffected. Never rendered as HTML: runs of text become React
// text, masks SVG shapes with numeric attributes.
import { z } from "zod";
import { readZip, type ZipLimits } from "./zip";
import { sniffImage, type ImageType } from "./images";

export const STUDY_META_PATH = "payload/study-meta.json";
export const STUDY_META_FORMAT = "flowplan.study-meta";
export const CARD_TYPES = ["basic", "cloze", "typed", "choice", "occlusion"] as const;
export type CardType = (typeof CARD_TYPES)[number];
export const STUDY_LIMITS = {
  bytes: 64 * 1024,
  samples: 5,
  runs: 40,
  run: 500,
  side: 1200,
  choices: 5,
  choice: 200,
  masks: 100,
  points: 64,
  label: 200,
  alt: 200,
  imageBytes: 2 * 1024 * 1024,
} as const;

export type StudyRun = { text: string; gap: boolean };
export type StudyMask =
  | { shape: "rect" | "ellipse"; x: number; y: number; w: number; h: number; label: string; asked: boolean }
  | { shape: "polygon"; x: number; y: number; w: number; h: number; points: [number, number][]; label: string; asked: boolean };
export type StudyImage = { file: string; alt: string; type: ImageType };
export type StudySample = { type: CardType; front: StudyRun[]; back: StudyRun[]; choices: string[]; image: StudyImage | null; masks: StudyMask[] };
export type StudyMeta = { records: number; cards: number; reverse: boolean; types: Partial<Record<CardType, number>>; samples: StudySample[] };
// What the review sees in the analysis.
export type StudyAnalysis = { records: number; cards: number; reverse: boolean; types: Partial<Record<CardType, number>>; samples: number; images: number };
export type StudyProblem = "format" | "sample" | "mask" | "image" | "too-many";

// Control characters (except line breaks), bidi overrides and invisible ones.
const INVISIBLE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;
export const cleanText = (value: string, max: number) => {
  const text = value.replace(INVISIBLE, "").replace(/\r\n?/g, "\n");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const count = z.number().int().min(0).max(1_000_000);
const fraction = z.number().finite().min(-0.01).max(1.01);
const clamp = (n: number) => Math.min(1, Math.max(0, Math.round(n * 10000) / 10000));
const runSchema = z.object({ text: z.string().max(10_000), gap: z.boolean().optional() });
const maskSchema = z.object({
  shape: z.enum(["rect", "ellipse", "polygon"]),
  x: fraction,
  y: fraction,
  w: z.number().finite().min(0).max(1.01),
  h: z.number().finite().min(0).max(1.01),
  points: z.array(z.tuple([fraction, fraction])).max(1000).optional(),
  label: z.string().max(10_000).optional(),
  asked: z.boolean().optional(),
});
const sampleSchema = z.object({
  type: z.enum(CARD_TYPES),
  front: z.array(z.unknown()).max(1000),
  back: z.array(z.unknown()).max(1000),
  choices: z.array(z.unknown()).max(1000).optional(),
  image: z.object({ file: z.string().max(100), alt: z.string().max(10_000).optional() }).optional(),
  masks: z.array(z.unknown()).max(1000).optional(),
});
const metaSchema = z.object({
  format: z.literal(STUDY_META_FORMAT),
  version: z.number().int().min(1),
  records: count,
  cards: count,
  reverse: z.boolean().optional(),
  types: z.record(z.string(), z.unknown()).optional(),
  samples: z.array(z.unknown()).max(100).default([]),
});

// A side: at most 40 runs, 500 characters each, 1,200 together.
function side(raw: unknown[], problems: Set<StudyProblem>): StudyRun[] {
  const out: StudyRun[] = [];
  let left: number = STUDY_LIMITS.side;
  for (const r of raw.slice(0, STUDY_LIMITS.runs)) {
    const run = runSchema.safeParse(r);
    if (!run.success) {
      problems.add("sample");
      continue;
    }
    if (left <= 0) break;
    const text = cleanText(run.data.text, Math.min(STUDY_LIMITS.run, left));
    if (!text) continue;
    left -= text.length;
    out.push({ text, gap: run.data.gap === true });
  }
  if (raw.length > STUDY_LIMITS.runs) problems.add("too-many");
  return out;
}

function mask(raw: unknown, problems: Set<StudyProblem>): StudyMask | null {
  const m = maskSchema.safeParse(raw);
  if (!m.success || m.data.w <= 0 || m.data.h <= 0) {
    problems.add("mask");
    return null;
  }
  const base = { x: clamp(m.data.x), y: clamp(m.data.y), w: clamp(m.data.w), h: clamp(m.data.h), label: cleanText(m.data.label ?? "", STUDY_LIMITS.label), asked: m.data.asked === true };
  if (m.data.shape !== "polygon") return { shape: m.data.shape, ...base };
  const points = (m.data.points ?? []).slice(0, STUDY_LIMITS.points).map(([x, y]) => [clamp(x), clamp(y)] as [number, number]);
  if (points.length < 3) {
    problems.add("mask");
    return null;
  }
  return { shape: "polygon", ...base, points };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type ParsedStudyMeta = { meta: StudyMeta | null; problems: StudyProblem[]; files: string[] };
// The checked meta. `files`: the attachments the samples name (checked
// against the template by withImages).
export function parseStudyMeta(raw: unknown): ParsedStudyMeta {
  const parsed = metaSchema.safeParse(raw);
  if (!parsed.success) return { meta: null, problems: ["format"], files: [] };
  const problems = new Set<StudyProblem>();
  const types: Partial<Record<CardType, number>> = {};
  for (const type of CARD_TYPES) {
    const n = count.safeParse(parsed.data.types?.[type]);
    if (n.success && n.data > 0) types[type] = n.data;
  }
  if (parsed.data.samples.length > STUDY_LIMITS.samples) problems.add("too-many");
  const samples: StudySample[] = [];
  for (const raw of parsed.data.samples.slice(0, STUDY_LIMITS.samples)) {
    const s = sampleSchema.safeParse(raw);
    if (!s.success) {
      problems.add("sample");
      continue;
    }
    const front = side(s.data.front, problems);
    const back = side(s.data.back, problems);
    const masks = s.data.type === "occlusion" ? (s.data.masks ?? []).slice(0, STUDY_LIMITS.masks).flatMap((m) => mask(m, problems) ?? []) : [];
    if ((s.data.masks?.length ?? 0) > STUDY_LIMITS.masks) problems.add("too-many");
    const choices =
      s.data.type === "choice"
        ? [...new Set((s.data.choices ?? []).slice(0, STUDY_LIMITS.choices).flatMap((c) => (typeof c === "string" && cleanText(c, STUDY_LIMITS.choice) ? [cleanText(c, STUDY_LIMITS.choice)] : [])))]
        : [];
    let image: StudySample["image"] = null;
    if (s.data.image && s.data.type === "occlusion") {
      if (UUID.test(s.data.image.file)) image = { file: s.data.image.file.toLowerCase(), alt: cleanText(s.data.image.alt ?? "", STUDY_LIMITS.alt), type: "png" };
      else problems.add("image");
    }
    // A card needs something to show.
    if (!front.length && !back.length && !masks.length) {
      problems.add("sample");
      continue;
    }
    samples.push({ type: s.data.type, front, back, choices, image, masks });
  }
  return {
    meta: { records: parsed.data.records, cards: parsed.data.cards, reverse: parsed.data.reverse === true, types, samples },
    problems: [...problems],
    files: samples.flatMap((s) => (s.image ? [s.image.file] : [])),
  };
}

export function readStudyMeta(bytes: Uint8Array | undefined): ParsedStudyMeta {
  if (!bytes) return { meta: null, problems: [], files: [] };
  if (bytes.length > STUDY_LIMITS.bytes) return { meta: null, problems: ["format"], files: [] };
  try {
    return parseStudyMeta(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    return { meta: null, problems: ["format"], files: [] };
  }
}

// The samples' pictures checked against the template's attachments (the
// nested ZIP's entries): kept only when they are there and really images.
export function withImages(parsed: ParsedStudyMeta, inner: Map<string, Buffer>): ParsedStudyMeta {
  if (!parsed.meta) return parsed;
  const problems = new Set(parsed.problems);
  const samples = parsed.meta.samples.map((s) => {
    if (!s.image) return s;
    const bytes = inner.get(`files/${s.image.file}`);
    const type = bytes && bytes.length <= STUDY_LIMITS.imageBytes ? sniffImage(bytes) : null;
    if (!type) {
      problems.add("image");
      return { ...s, image: null };
    }
    return { ...s, image: { ...s.image, type } };
  });
  return { meta: { ...parsed.meta, samples }, problems: [...problems], files: samples.flatMap((s) => (s.image ? [s.image.file] : [])) };
}

export const studyAnalysis = (meta: StudyMeta): StudyAnalysis => ({
  records: meta.records,
  cards: meta.cards,
  reverse: meta.reverse,
  types: meta.types,
  samples: meta.samples.length,
  images: meta.samples.filter((s) => s.image).length,
});

const NESTED: ZipLimits = { maxEntries: 202, maxEntryBytes: 25 * 1024 * 1024, maxTotalBytes: 60 * 1024 * 1024, maxRatio: 100 };
// From a package's entries: the checked meta and the pictures of its samples
// (by the sample's number, 1…).
export async function studyFromEntries(entries: Map<string, Buffer>, payloadPath: string): Promise<{ meta: StudyMeta; images: Map<number, { type: ImageType; bytes: Buffer }> } | null> {
  const parsed = readStudyMeta(entries.get(STUDY_META_PATH));
  if (!parsed.meta) return null;
  const payload = entries.get(payloadPath);
  let inner = new Map<string, Buffer>();
  try {
    if (payload) inner = await readZip(payload, NESTED);
  } catch {
    inner = new Map();
  }
  const checked = withImages(parsed, inner);
  const images = new Map<number, { type: ImageType; bytes: Buffer }>();
  checked.meta!.samples.forEach((s, i) => {
    if (s.image) images.set(i + 1, { type: s.image.type, bytes: inner.get(`files/${s.image.file}`)! });
  });
  return { meta: checked.meta!, images };
}
