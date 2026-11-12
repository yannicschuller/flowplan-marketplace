// The workflow viewer's data for a package (lib/workflow-view.ts,
// lib/workflow-svg.ts): from the entries of a package being checked (submit
// preview) or from a stored version's file (template page, admin API).
// Built per language and kept for a while per version and package hash –
// a package never changes under the same hash.
import { readZip, DEFAULT_ZIP_LIMITS } from "./zip";
import { readPackage } from "./storage";
import { parseJsonColumn } from "./store";
import type { Locale } from "./i18n";
import { readWorkflowMeta, WORKFLOW_META_PATH } from "./workflow-meta";
import { buildWorkflowView, summaryText, type WorkflowView } from "./workflow-view";
import { svgMarkup, workflowDiagram, type Bounds, type SvgEl } from "./workflow-svg";

export type ViewerData = { view: WorkflowView; tree: SvgEl; bounds: Bounds };
const WORKFLOW_BYTES = 2 * 1024 * 1024;

export function viewerFromEntries(entries: Map<string, Buffer> | [string, Buffer][], payloadPath: string, locale: Locale): ViewerData | null {
  const map = entries instanceof Map ? entries : new Map(entries);
  const bytes = map.get(payloadPath);
  if (!bytes || bytes.length > WORKFLOW_BYTES) return null;
  let workflow: unknown;
  try {
    workflow = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  const view = buildWorkflowView({ workflow, meta: readWorkflowMeta(map.get(WORKFLOW_META_PATH)).meta, locale });
  if (!view) return null;
  const { tree, bounds } = workflowDiagram(view);
  return { view, tree, bounds };
}

const cache = new Map<string, ViewerData | null>();
const CACHE_SIZE = 64;
type StoredVersion = { id: string; sha256: string; manifest: string };

export async function versionViewer(version: StoredVersion, locale: Locale): Promise<ViewerData | null> {
  const key = `${version.id}:${version.sha256}:${locale}`;
  if (cache.has(key)) return cache.get(key)!;
  let data: ViewerData | null = null;
  try {
    const payload = parseJsonColumn<{ payload?: unknown }>(version.manifest, {}).payload;
    if (typeof payload === "string") data = viewerFromEntries(await readZip(readPackage(version.id), DEFAULT_ZIP_LIMITS), payload, locale);
  } catch {
    data = null;
  }
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
  cache.set(key, data);
  return data;
}

// For flowplan-admin: the summary as text and everything the page shows, the diagram as SVG markup.
export async function adminWorkflowViewer(version: StoredVersion) {
  const out: Partial<Record<Locale, ViewerData>> = {};
  for (const locale of ["de", "en"] as const) {
    const data = await versionViewer(version, locale);
    if (!data) return null;
    out[locale] = data;
  }
  const one = (d: ViewerData) => ({ svg: svgMarkup(d.tree), bounds: d.bounds, ...d.view });
  return {
    summary: { de: summaryText(out.de!.view.summary), en: summaryText(out.en!.view.summary) },
    viewer: { de: one(out.de!), en: one(out.en!) },
  };
}
