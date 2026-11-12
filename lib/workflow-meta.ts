// payload/workflow-meta.json (contract: README, "Workflow viewer"): what
// Flowplan tells about the node types a workflow uses – names and
// descriptions in German and English, the category, the symbol as SVG path
// data, the outputs' names – and the gaps the person importing it fills in.
//
// It comes with the package, so it is as untrusted as the rest: every text
// is length-limited, unknown fields are stripped, a symbol that is not plain
// path data (letters of the path commands, numbers, separators) is dropped,
// and the risk flags here can only add a marking – the viewer derives AI,
// e-mail and external steps from the node types itself (lib/workflow-view.ts).
// Client-safe.
import { z } from "zod";

export const WORKFLOW_META_PATH = "payload/workflow-meta.json";
export const WORKFLOW_META_FORMAT = "flowplan.workflow-meta";
export const META_LIMITS = { bytes: 512 * 1024, types: 150, gaps: 100, icon: 4000, name: 80, description: 400, label: 200, ports: 40 } as const;

// Path data only: commands, numbers, separators. No markup, no url(), no entities.
export const ICON_PATH = /^[MmZzLlHhVvCcSsQqTtAa0-9.,\s+eE-]+$/;
export const isIconPath = (value: unknown): value is string =>
  typeof value === "string" && value.length <= META_LIMITS.icon && /^\s*[Mm]/.test(value) && ICON_PATH.test(value);

const text = (max: number) =>
  z
    .object({ de: z.string().max(max).optional().catch(undefined), en: z.string().max(max).optional().catch(undefined) })
    .catch({})
    .transform((v) => ({ de: v.de?.trim() || "", en: v.en?.trim() || "" }));
export type MetaText = { de: string; en: string };

const nodeSchema = z.object({
  name: text(META_LIMITS.name),
  description: text(META_LIMITS.description).optional().catch(undefined),
  group: z.string().regex(/^[a-z][a-z0-9-]{0,19}$/).optional().catch(undefined),
  icon: z.string().optional().catch(undefined),
  ports: z.record(z.string().max(60), text(META_LIMITS.name)).optional().catch(undefined),
  external: z.boolean().optional().catch(undefined),
  ai: z.boolean().optional().catch(undefined),
  email: z.boolean().optional().catch(undefined),
});
const gapSchema = z.object({
  id: z.string().min(1).max(100),
  label: text(META_LIMITS.label),
  kind: z.string().max(20).catch(""),
  optional: z.boolean().optional().catch(undefined),
});
const metaSchema = z.object({
  format: z.literal(WORKFLOW_META_FORMAT),
  version: z.number().int().min(1),
  nodes: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,59}$/), z.unknown()).default({}),
  gaps: z.array(z.unknown()).max(1000).default([]),
});

export type MetaNode = { name: MetaText; description: MetaText; group: string | null; icon: string | null; ports: Record<string, MetaText>; external: boolean; ai: boolean; email: boolean };
export type MetaGap = { id: string; label: MetaText; kind: string; optional: boolean };
export type WorkflowMeta = { nodes: Record<string, MetaNode>; gaps: MetaGap[] };
// What was dropped (for the review findings).
export type MetaProblem = "format" | "icon" | "node" | "gap" | "too-many";
export type ParsedMeta = { meta: WorkflowMeta | null; problems: MetaProblem[] };

export function parseWorkflowMeta(input: unknown): ParsedMeta {
  const problems = new Set<MetaProblem>();
  const parsed = metaSchema.safeParse(input);
  if (!parsed.success || parsed.data.version > 1) return { meta: null, problems: ["format"] };
  // Type keys start with a letter: no __proto__.
  const nodes: Record<string, MetaNode> = {};
  const entries = Object.entries(parsed.data.nodes);
  if (entries.length > META_LIMITS.types) problems.add("too-many");
  for (const [type, raw] of entries.slice(0, META_LIMITS.types)) {
    const node = nodeSchema.safeParse(raw);
    if (!node.success) {
      problems.add("node");
      continue;
    }
    const n = node.data;
    let icon: string | null = null;
    if (n.icon !== undefined) {
      if (isIconPath(n.icon)) icon = n.icon.trim();
      else problems.add("icon");
    }
    const ports: Record<string, MetaText> = {};
    for (const [port, label] of Object.entries(n.ports ?? {}).slice(0, META_LIMITS.ports)) if (label.de || label.en) ports[port] = label;
    nodes[type] = {
      name: n.name,
      description: n.description ?? { de: "", en: "" },
      group: n.group ?? null,
      icon,
      ports,
      external: n.external === true,
      ai: n.ai === true,
      email: n.email === true,
    };
  }
  const gaps: MetaGap[] = [];
  const seen = new Set<string>();
  if (parsed.data.gaps.length > META_LIMITS.gaps) problems.add("too-many");
  for (const raw of parsed.data.gaps.slice(0, META_LIMITS.gaps)) {
    const gap = gapSchema.safeParse(raw);
    if (!gap.success || seen.has(gap.data.id)) {
      problems.add("gap");
      continue;
    }
    seen.add(gap.data.id);
    gaps.push({ id: gap.data.id, label: gap.data.label, kind: gap.data.kind, optional: gap.data.optional === true });
  }
  return { meta: { nodes, gaps }, problems: [...problems] };
}

// From the package's bytes (missing or broken: no meta, the viewer falls back to the raw types).
export function readWorkflowMeta(bytes: Uint8Array | undefined): ParsedMeta {
  if (!bytes) return { meta: null, problems: [] };
  if (bytes.length > META_LIMITS.bytes) return { meta: null, problems: ["format"] };
  try {
    return parseWorkflowMeta(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return { meta: null, problems: ["format"] };
  }
}
