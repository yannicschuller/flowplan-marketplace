// The *.flowplan-template package (contract §1): a ZIP with template.json,
// the kind's own exchange format under payload/ and up to four previews.
// inspectPackage() runs every automatic check of §4 and returns findings;
// any finding of level "error" keeps the package from being submitted.
// The marketplace never converts payloads – it checks the envelope, the
// limits and that the payload is what its kind says.
import { z } from "zod";
import { createHash } from "node:crypto";
import { CATEGORIES, KINDS, LANGUAGES, type Kind } from "./catalog";
import { DEFAULT_ZIP_LIMITS, ZipError, readZip, writeZip } from "./zip";
import { IMAGE_MIME, claimedImageType, sniffFont, sniffImage, type ImageType } from "./images";
import { containsHtml } from "./markdown";
import { LIMITS } from "./limits";
import { readWorkflowMeta, WORKFLOW_META_PATH } from "./workflow-meta";

export const PACKAGE_FORMAT = "flowplan-marketplace-1";
export const PACKAGE_EXTENSION = ".flowplan-template";
export { LIMITS };

export type Finding = {
  level: "error" | "warning" | "info";
  code: string;
  de: string;
  en: string;
  // The entry or field the finding is about.
  at?: string;
};
const finding = (level: Finding["level"], code: string, de: string, en: string, at?: string): Finding => ({ level, code, de, en, ...(at ? { at } : {}) });

const localized = (max: number) =>
  z
    .object({ de: z.string().max(max).optional(), en: z.string().max(max).optional() })
    .strict();
export const versionPattern = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
export const manifestSchema = z.object({
  format: z.literal(PACKAGE_FORMAT),
  kind: z.enum(KINDS),
  title: z.string().trim().min(1).max(LIMITS.title),
  summary: localized(LIMITS.summary).refine((s) => !!(s.de?.trim() || s.en?.trim()), "summary needs de or en"),
  description: localized(LIMITS.description).optional(),
  category: z.enum(CATEGORIES),
  tags: z.array(z.string().trim().min(1).max(LIMITS.tag)).max(LIMITS.tags).default([]),
  minVersion: z.string().regex(versionPattern),
  language: z.enum(LANGUAGES),
  payload: z.string().min(1).max(200),
});
export type Manifest = z.infer<typeof manifestSchema>;

export type WorkflowAnalysis = {
  nodeCount: number;
  nodeTypes: Record<string, number>;
  triggers: string[];
  hosts: string[];
  ai: boolean;
  email: boolean;
  webhooks: boolean;
  secretWarnings: number;
  // payload/workflow-meta.json present and readable (names and symbols for the viewer).
  meta?: boolean;
};
export type Analysis = {
  kind?: Kind;
  payloadBytes?: number;
  files?: number;
  fields?: number;
  views?: number;
  rows?: number;
  items?: number;
  fonts?: number;
  rules?: number;
  workflow?: WorkflowAnalysis;
};
export type Preview = { n: number; type: ImageType; bytes: Buffer };
export type Inspection = {
  ok: boolean;
  manifest: Manifest | null;
  // template.json as it came (for the review).
  rawManifest: unknown;
  findings: Finding[];
  previews: Preview[];
  // Kept entries (template.json excluded): payload files.
  payloadEntries: [string, Buffer][];
  analysis: Analysis;
  size: number;
  sha256: string;
};

const zipFinding = (error: unknown, where: string): Finding => {
  const code = error instanceof ZipError ? error.code : "zip-invalid";
  const texts: Record<string, [string, string]> = {
    "zip-invalid": ["Keine gültige ZIP-Datei.", "Not a valid ZIP file."],
    "zip-too-many": ["Zu viele Dateien im Archiv.", "Too many files in the archive."],
    "zip-too-large": ["Entpackt zu groß.", "Too large when unpacked."],
    "zip-bomb": ["Verdächtig stark komprimiert (ZIP-Bombe).", "Suspiciously high compression (zip bomb)."],
    "zip-path": ["Unzulässiger Dateipfad im Archiv.", "Unsafe file path in the archive."],
    "zip-duplicate": ["Doppelter Eintrag im Archiv.", "Duplicate entry in the archive."],
    "zip-encrypted": ["Verschlüsselte Einträge sind nicht erlaubt.", "Encrypted entries are not allowed."],
    "zip-symlink": ["Symbolische Links sind nicht erlaubt.", "Symbolic links are not allowed."],
  };
  const [de, en] = texts[code] ?? texts["zip-invalid"];
  return finding("error", code, de, en, where);
};

const parseJson = (bytes: Buffer): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    return { ok: false };
  }
};

export async function inspectPackage(input: Uint8Array): Promise<Inspection> {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const findings: Finding[] = [];
  const result: Inspection = {
    ok: false,
    manifest: null,
    rawManifest: null,
    findings,
    previews: [],
    payloadEntries: [],
    analysis: {},
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  if (bytes.length > LIMITS.packageBytes) {
    findings.push(finding("error", "package-too-large", "Das Paket ist größer als 25 MB.", "The package is larger than 25 MB."));
    return result;
  }
  let entries: Map<string, Buffer>;
  try {
    entries = await readZip(bytes, { ...DEFAULT_ZIP_LIMITS, maxEntries: 300 });
  } catch (error) {
    findings.push(zipFinding(error, "package"));
    return result;
  }
  const raw = entries.get("template.json");
  if (!raw) {
    findings.push(finding("error", "manifest-missing", "template.json fehlt.", "template.json is missing."));
    return result;
  }
  if (raw.length > LIMITS.manifestBytes) {
    findings.push(finding("error", "manifest-too-large", "template.json ist größer als 64 KB.", "template.json is larger than 64 KB."));
    return result;
  }
  const json = parseJson(raw);
  if (!json.ok) {
    findings.push(finding("error", "manifest-json", "template.json ist kein gültiges JSON.", "template.json is not valid JSON."));
    return result;
  }
  result.rawManifest = json.value;
  const parsed = manifestSchema.safeParse(json.value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 20)) {
      const at = issue.path.join(".") || "template.json";
      findings.push(finding("error", "manifest-schema", `Ungültiges Feld „${at}“: ${issue.message}`, `Invalid field "${at}": ${issue.message}`, at));
    }
    return result;
  }
  const manifest = parsed.data;
  result.manifest = manifest;
  result.analysis.kind = manifest.kind;

  // Which entries are allowed.
  const previewNames = new Map<number, string>();
  for (const [name, data] of entries) {
    if (name === "template.json") continue;
    if (name.startsWith("payload/")) {
      result.payloadEntries.push([name, data]);
      continue;
    }
    const preview = /^preview\/([1-9])\.(webp|png|jpe?g)$/i.exec(name);
    if (preview) {
      const n = Number(preview[1]);
      if (n > LIMITS.previews) findings.push(finding("error", "preview-count", "Höchstens 4 Vorschaubilder (preview/1 … preview/4).", "At most 4 previews (preview/1 … preview/4).", name));
      else if (previewNames.has(n)) findings.push(finding("error", "preview-duplicate", "Vorschaubild doppelt.", "Duplicate preview.", name));
      else previewNames.set(n, name);
      continue;
    }
    findings.push(finding("warning", "entry-ignored", "Unbekannte Datei wird nicht übernommen.", "Unknown file is left out.", name));
  }
  for (const [n, name] of [...previewNames].sort((a, b) => a[0] - b[0])) {
    const data = entries.get(name)!;
    const type = sniffImage(data);
    if (data.length > LIMITS.previewBytes) findings.push(finding("error", "preview-too-large", "Vorschaubild größer als 1 MB.", "Preview larger than 1 MB.", name));
    else if (!type) findings.push(finding("error", "preview-type", "Vorschaubild ist kein WebP-, PNG- oder JPEG-Bild.", "Preview is not a WebP, PNG or JPEG image.", name));
    else {
      if (type !== claimedImageType(name))
        findings.push(finding("warning", "preview-extension", `Dateiendung passt nicht zum Inhalt (${type}).`, `File extension does not match the content (${type}).`, name));
      result.previews.push({ n, type, bytes: data });
    }
  }
  // Renumbered 1… in order, so gaps don't matter.
  result.previews = result.previews.map((p, i) => ({ ...p, n: i + 1 }));

  if (!manifest.payload.startsWith("payload/") || !entries.has(manifest.payload)) {
    findings.push(finding("error", "payload-missing", `Inhalt „${manifest.payload}“ fehlt im Paket.`, `Payload "${manifest.payload}" is missing from the package.`, "payload"));
  } else {
    const payload = entries.get(manifest.payload)!;
    result.analysis.payloadBytes = payload.length;
    await checkPayload(manifest, payload, entries, findings, result.analysis);
  }
  for (const [field, value] of [
    ["summary", manifest.summary],
    ["description", manifest.description],
  ] as const)
    if (value && Object.values(value).some((v) => typeof v === "string" && containsHtml(v)))
      findings.push(finding("warning", "html-stripped", "HTML im Text wird nicht angezeigt (nur Markdown).", "HTML in the text is not shown (Markdown only).", field));
  if (!manifest.summary.de?.trim() || !manifest.summary.en?.trim())
    findings.push(finding("info", "summary-one-language", "Kurzbeschreibung nur in einer Sprache.", "Summary in one language only.", "summary"));
  if (!result.previews.length) findings.push(finding("info", "no-previews", "Keine Vorschaubilder.", "No previews.", "preview"));
  result.ok = !findings.some((f) => f.level === "error");
  return result;
}

// ---- Kind payloads ----

const NESTED_LIMITS = { maxEntries: 202, maxEntryBytes: 25 * 1024 * 1024, maxTotalBytes: 60 * 1024 * 1024, maxRatio: 100 };

async function checkPayload(manifest: Manifest, payload: Buffer, entries: Map<string, Buffer>, findings: Finding[], analysis: Analysis) {
  const at = manifest.payload;
  const bad = (code: string, de: string, en: string) => findings.push(finding("error", code, de, en, at));
  switch (manifest.kind) {
    case "document":
    case "database": {
      let inner: Map<string, Buffer>;
      try {
        inner = await readZip(payload, NESTED_LIMITS);
      } catch (error) {
        findings.push(zipFinding(error, at));
        return;
      }
      const raw = inner.get("template.json");
      const parsed = raw ? parseJson(raw) : ({ ok: false } as const);
      const t = parsed.ok ? (parsed.value as Record<string, unknown>) : null;
      if (!t || t.format !== "flowplan-template-1")
        return bad("payload-format", "Inhalt ist keine Flowplan-Vorlage (flowplan-template-1).", "Payload is not a Flowplan template (flowplan-template-1).");
      if (t.kind !== manifest.kind)
        return bad("payload-kind", `Vorlagenart passt nicht („${String(t.kind)}“).`, `Template kind does not match ("${String(t.kind)}").`);
      if (typeof t.name !== "string" || !t.name.trim()) bad("payload-name", "Vorlage ohne Namen.", "Template without a name.");
      if (typeof t.payload !== "string") return bad("payload-content", "Vorlageninhalt fehlt.", "Template content is missing.");
      let content: Record<string, unknown> | null = null;
      try {
        content = JSON.parse(t.payload) as Record<string, unknown>;
      } catch {}
      if (!content || typeof content !== "object") return bad("payload-content", "Vorlageninhalt ist beschädigt.", "Template content is damaged.");
      if (manifest.kind === "document") {
        if (typeof content.html !== "string") bad("payload-content", "Dokumentvorlage ohne Inhalt (html).", "Document template without content (html).");
        else if (/<script\b|\son[a-z]+\s*=|javascript:/i.test(content.html))
          findings.push(finding("warning", "payload-script", "Inhalt enthält Skript-ähnliches HTML (Flowplan entfernt es beim Import).", "Content contains script-like HTML (Flowplan removes it on import).", at));
      } else {
        const database = content.database as { fields?: unknown; views?: unknown } | undefined;
        if (!database || !Array.isArray(database.fields) || !database.fields.length || !Array.isArray(database.views) || !database.views.length)
          bad("payload-content", "Datenbankvorlage ohne Eigenschaften oder Ansichten.", "Database template without properties or views.");
        else {
          analysis.fields = database.fields.length;
          analysis.views = database.views.length;
          analysis.rows = Array.isArray(content.rows) ? content.rows.length : 0;
        }
      }
      const files = Array.isArray(t.files) ? (t.files as { id?: unknown; sha256?: unknown; name?: unknown }[]) : [];
      if (!Array.isArray(t.files)) bad("payload-files", "Anhangsliste fehlt.", "List of attachments is missing.");
      analysis.files = files.length;
      for (const file of files) {
        const data = typeof file.id === "string" ? inner.get(`files/${file.id}`) : undefined;
        if (!data || createHash("sha256").update(data).digest("hex") !== file.sha256)
          bad("payload-file", `Anhang „${String(file.name ?? file.id)}“ fehlt oder ist beschädigt.`, `Attachment "${String(file.name ?? file.id)}" is missing or damaged.`);
      }
      return;
    }
    case "workflow": {
      if (payload.length > 2 * 1024 * 1024) return bad("payload-too-large", "Workflow größer als 2 MB.", "Workflow larger than 2 MB.");
      const parsed = parseJson(payload);
      if (!parsed.ok) return bad("payload-json", "Workflow ist kein gültiges JSON.", "Workflow is not valid JSON.");
      const data = parsed.value as Record<string, unknown> | null;
      if (!data || data.format !== "flowplan.workflow") return bad("payload-format", "Kein Flowplan-Workflow (flowplan.workflow).", "Not a Flowplan workflow (flowplan.workflow).");
      const graph = (data.graph && typeof data.graph === "object" ? data.graph : data) as { nodes?: unknown; edges?: unknown };
      if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return bad("payload-graph", "Workflow ohne Knoten oder Verbindungen.", "Workflow without nodes or edges.");
      const workflow = analyzeWorkflow(graph.nodes as unknown[], data);
      analysis.workflow = workflow;
      // The viewer's names and symbols (optional; older packages have none).
      const metaBytes = entries.get(WORKFLOW_META_PATH);
      if (metaBytes) {
        const meta = readWorkflowMeta(metaBytes);
        workflow.meta = !!meta.meta;
        const metaJson = parseJson(metaBytes);
        if (metaJson.ok) workflow.secretWarnings += analyzeWorkflow([], metaJson.value).secretWarnings;
        if (!meta.meta)
          findings.push(finding("warning", "workflow-meta-invalid", "workflow-meta.json ist ungültig – die Vorschau zeigt die technischen Schritt-Typen.", "workflow-meta.json is invalid – the preview shows the technical step types.", WORKFLOW_META_PATH));
        else if (meta.problems.includes("icon"))
          findings.push(finding("warning", "workflow-meta-icon", "Ein Symbol in workflow-meta.json ist kein reiner SVG-Pfad und wird nicht gezeigt.", "A symbol in workflow-meta.json is not plain SVG path data and is not shown.", WORKFLOW_META_PATH));
        else if (meta.problems.length)
          findings.push(finding("warning", "workflow-meta-partial", "Teile von workflow-meta.json sind ungültig und werden nicht gezeigt.", "Parts of workflow-meta.json are invalid and are not shown.", WORKFLOW_META_PATH));
      } else workflow.meta = false;
      if (!workflow.nodeCount) bad("payload-graph", "Workflow ist leer.", "Workflow is empty.");
      if (workflow.secretWarnings)
        findings.push(finding("warning", "secret-like", `${workflow.secretWarnings} Wert(e) sehen aus wie Zugangsdaten – bitte entfernen.`, `${workflow.secretWarnings} value(s) look like credentials – please remove them.`, at));
      if (workflow.hosts.length)
        findings.push(finding("info", "external-hosts", `Spricht externe Dienste an: ${workflow.hosts.join(", ")}`, `Talks to external services: ${workflow.hosts.join(", ")}`, at));
      if (workflow.ai) findings.push(finding("info", "uses-ai", "Nutzt KI-Schritte.", "Uses AI steps.", at));
      if (workflow.email) findings.push(finding("info", "uses-email", "Verschickt oder empfängt E-Mails.", "Sends or receives e-mail.", at));
      if (workflow.webhooks) findings.push(finding("info", "uses-webhook", "Startet über einen Webhook.", "Starts from a webhook.", at));
      return;
    }
    case "whiteboard": {
      const parsed = parseJson(payload);
      if (!parsed.ok) return bad("payload-json", "Whiteboard-Vorlage ist kein gültiges JSON.", "Whiteboard template is not valid JSON.");
      const data = parsed.value as { items?: unknown } | unknown[] | null;
      const items = Array.isArray(data) ? data : data && Array.isArray((data as { items?: unknown }).items) ? ((data as { items: unknown[] }).items) : null;
      if (!items) return bad("payload-content", "Whiteboard-Vorlage ohne Elemente.", "Whiteboard template without items.");
      analysis.items = items.length;
      return;
    }
    case "appearance": {
      let files: Map<string, Buffer> = entries;
      let themeBytes = payload;
      if (/\.zip$/i.test(at)) {
        try {
          files = await readZip(payload, NESTED_LIMITS);
        } catch (error) {
          findings.push(zipFinding(error, at));
          return;
        }
        const theme = [...files.keys()].find((n) => /(^|\/)theme\.json$/.test(n)) ?? [...files.keys()].find((n) => n.endsWith(".json"));
        if (!theme) return bad("payload-content", "Erscheinungsbild ohne theme.json.", "Appearance without theme.json.");
        themeBytes = files.get(theme)!;
      }
      const parsed = parseJson(themeBytes);
      if (!parsed.ok || !parsed.value || typeof parsed.value !== "object")
        return bad("payload-json", "Erscheinungsbild ist kein gültiges JSON.", "Appearance is not valid JSON.");
      const theme = ((parsed.value as { theme?: unknown }).theme ?? parsed.value) as { accent?: unknown };
      if (theme.accent != null && !(typeof theme.accent === "string" && /^#[0-9a-f]{6}$/i.test(theme.accent)))
        bad("payload-content", "Akzentfarbe ist keine Hex-Farbe.", "Accent colour is not a hex colour.");
      let fonts = 0;
      for (const [name, data] of files) {
        if (!/\.(woff2?|ttf|otf)$/i.test(name)) continue;
        if (!name.startsWith(files === entries ? "payload/" : "")) continue;
        if (!sniffFont(data)) bad("payload-font", "Schriftdatei ist keine Schrift.", "Font file is not a font.");
        else fonts++;
      }
      analysis.fonts = fonts;
      return;
    }
    case "link-rules": {
      const parsed = parseJson(payload);
      if (!parsed.ok) return bad("payload-json", "Linkregeln sind kein gültiges JSON.", "Link rules are not valid JSON.");
      const value = parsed.value as unknown;
      const rules = Array.isArray(value) ? value : value && Array.isArray((value as { rules?: unknown }).rules) ? (value as { rules: unknown[] }).rules : null;
      if (!rules || !rules.length) return bad("payload-content", "Keine Linkregeln enthalten.", "No link rules included.");
      if (rules.length > 50) return bad("payload-content", "Höchstens 50 Linkregeln.", "At most 50 link rules.");
      analysis.rules = rules.length;
      for (const rule of rules as { pattern?: unknown; template?: unknown }[]) {
        if (typeof rule?.pattern !== "string" || typeof rule.template !== "string" || rule.pattern.length > 200 || rule.template.length > 500) {
          bad("payload-rule", "Linkregel unvollständig oder zu lang.", "Link rule incomplete or too long.");
          continue;
        }
        try {
          // Only compiled, never run against anything here.
          new RegExp(rule.pattern, "u");
        } catch {
          bad("payload-rule", `Ungültiges Muster: ${rule.pattern.slice(0, 60)}`, `Invalid pattern: ${rule.pattern.slice(0, 60)}`);
          continue;
        }
        if (!/^(https?:\/\/|\/)/i.test(rule.template.trim()))
          findings.push(finding("warning", "rule-target", `Linkziel ist keine http(s)-Adresse: ${rule.template.slice(0, 60)}`, `Link target is not an http(s) address: ${rule.template.slice(0, 60)}`, at));
      }
      return;
    }
  }
}

// Strings that look like credentials (warning only; the author removes them).
const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/,
  /\b(?:api[_-]?key|token|secret|password|passwd)=[^&\s{]{8,}/i,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];
const SECRET_HEADER = /^(authorization|x-api-key|api-key|apikey|x-auth-token|cookie|private-token)$/i;

export function looksSecret(value: string) {
  return SECRET_PATTERNS.some((p) => p.test(value));
}
const fixedHost = (url: string) => /^https?:\/\/([^/?#{}\\@\s]+)(?:[/?#]|$)/i.exec(url.trim())?.[1]?.toLowerCase() ?? null;

export function analyzeWorkflow(nodes: unknown[], whole: unknown): WorkflowAnalysis {
  const nodeTypes: Record<string, number> = {};
  const hosts = new Set<string>();
  const triggers: string[] = [];
  let secretWarnings = 0;
  for (const raw of nodes) {
    const node = (raw ?? {}) as { type?: unknown; config?: Record<string, unknown> };
    const type = typeof node.type === "string" ? node.type.slice(0, 60) : "unknown";
    nodeTypes[type] = (nodeTypes[type] ?? 0) + 1;
    if (type.startsWith("trigger.")) triggers.push(type);
    const config = node.config && typeof node.config === "object" ? node.config : {};
    if (type === "http.request" && typeof config.url === "string") {
      const host = fixedHost(config.url);
      if (host) hosts.add(host);
    }
    for (const key of ["headers", "query"])
      if (Array.isArray(config[key]))
        for (const h of config[key] as { name?: unknown; value?: unknown }[])
          if (typeof h?.name === "string" && SECRET_HEADER.test(h.name) && typeof h.value === "string" && h.value.trim() && !/^\{\{[^}]*\}\}$/.test(h.value.trim()))
            secretWarnings++;
  }
  // Every string anywhere in the file.
  const walk = (v: unknown, depth: number) => {
    if (depth > 40) return;
    if (typeof v === "string") {
      if (looksSecret(v)) secretWarnings++;
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (v && typeof v === "object") Object.values(v).forEach((x) => walk(x, depth + 1));
  };
  walk(whole, 0);
  const types = Object.keys(nodeTypes);
  return {
    nodeCount: nodes.length,
    nodeTypes,
    triggers,
    hosts: [...hosts].sort(),
    ai: types.some((t) => t.startsWith("ai.")),
    email: types.some((t) => t === "notify.email" || t === "trigger.mail.received"),
    webhooks: types.includes("trigger.webhook"),
    secretWarnings,
  };
}

// ---- Writing the stored package ----

export type StoredMeta = {
  title: string;
  summary: { de: string; en: string };
  description: { de: string; en: string };
  category: string;
  tags: string[];
  minVersion: string;
  language: string;
  license: string;
  author: { name: string; handle: string };
  marketplace: { id: string; slug: string; version: number; url: string };
};
// The package as the marketplace hands it out: the checked payload and
// previews, template.json with the reviewed metadata (contract fields plus
// the optional author, license and marketplace fields).
export function buildPackage(inspection: Inspection, meta: StoredMeta): Buffer {
  const m = inspection.manifest!;
  const drop = (o: { de: string; en: string }) => Object.fromEntries(Object.entries(o).filter(([, v]) => v.trim()));
  const manifest = {
    format: PACKAGE_FORMAT,
    kind: m.kind,
    title: meta.title,
    summary: drop(meta.summary),
    ...(meta.description.de.trim() || meta.description.en.trim() ? { description: drop(meta.description) } : {}),
    category: meta.category,
    tags: meta.tags,
    minVersion: meta.minVersion,
    language: meta.language,
    payload: m.payload,
    license: meta.license,
    author: meta.author,
    marketplace: meta.marketplace,
  };
  return writeZip([
    ["template.json", Buffer.from(JSON.stringify(manifest, null, 2))],
    ...inspection.payloadEntries,
    ...inspection.previews.map((p) => [`preview/${p.n}.${p.type === "jpeg" ? "jpg" : p.type}`, p.bytes] as [string, Buffer]),
  ]);
}
export const previewMime = (type: ImageType) => IMAGE_MIME[type];
