// The read-only workflow viewer's model (README, "Workflow viewer"): from a
// package's payload/workflow.json and, if there, payload/workflow-meta.json
// it builds what the template page, the submit preview and the admin API
// show – the nodes at their positions with name, symbol and risk markings,
// the connections with their outputs' names, the For-each frames, every
// node's settings prepared for reading, a summary in plain language and the
// gaps the person importing it fills in.
//
// Everything in the package is untrusted: the graph is parsed leniently but
// limited (nodes, connections, coordinates, text lengths, depth), texts stay
// texts (the page and lib/workflow-svg.ts escape them), no address is ever
// fetched or linked – hosts are shown as text – and the risk markings come
// from the node types themselves; the meta can only add one. Client-safe.
import { z } from "zod";
import { translate, type Locale, type T } from "./i18n";
import type { MetaNode, WorkflowMeta } from "./workflow-meta";

export const VIEW_LIMITS = { nodes: 100, edges: 200, coordinate: 50_000, rows: 40, depth: 4, list: 30, text: 400, label: 60, loops: 20 } as const;
export const CARD = { w: 220, h: 76 } as const;

// ---- The graph, leniently ----

const finite = z.number().finite().catch(0);
const rawNodeSchema = z.object({
  id: z.string().min(1).max(40),
  type: z.string().min(1).max(60),
  label: z.string().catch(""),
  position: z.object({ x: finite, y: finite }).catch({ x: 0, y: 0 }),
  disabled: z.boolean().catch(false).default(false),
  config: z.record(z.string(), z.unknown()).catch({}).default({}),
  onError: z.object({ retry: z.number().int().min(0).max(10).catch(0).default(0), then: z.enum(["fail", "port", "continue"]).catch("fail").default("fail") }).optional().catch(undefined),
});
const rawEdgeSchema = z.object({
  from: z.object({ node: z.string().max(40), port: z.string().min(1).max(60).catch("out").default("out") }),
  to: z.object({ node: z.string().max(40) }),
});
type RawNode = z.infer<typeof rawNodeSchema>;
type RawEdge = z.infer<typeof rawEdgeSchema>;

// ---- What the viewer shows ----

// Text, a placeholder ({{…}}), or a gap (its label; shown with "wird bei dir festgelegt").
export type Part = { k: "t" | "ph" | "gap"; v: string };
export type Condition = { k: "cond"; field: Part[]; op: string; value: Part[] } | { k: "group"; join: string; rules: Condition[] };
export type SettingValue =
  | { k: "text"; parts: Part[]; long: boolean }
  | { k: "empty"; text: string }
  | { k: "plain"; text: string }
  | { k: "gap"; text: string; label: string }
  | { k: "list"; items: SettingValue[]; more: number }
  | { k: "map"; rows: SettingRow[]; more: number }
  | { k: "conditions"; join: string; rules: Condition[]; more: number };
export type SettingRow = { key: string; label: string; value: SettingValue };
export type Risk = { kind: "ai" | "email" | "external"; text: string };
export type ViewNode = {
  id: string;
  type: string;
  label: string;
  name: string;
  description: string;
  group: string;
  icon: string | null;
  x: number;
  y: number;
  trigger: boolean;
  disabled: boolean;
  host: string | null;
  risks: Risk[];
  // Output ports with connections, in drawing order.
  ports: { id: string; label: string }[];
  // The type's outputs as far as known (meta, else the graph format's own).
  knownPorts: string[];
  settings: SettingRow[];
  moreSettings: number;
  errorHandling: string | null;
  step: number | null;
};
export type ViewEdge = { from: string; to: string; port: string; label: string };
export type ViewLoop = { node: string; label: string; members: string[] };
export type WorkflowView = {
  locale: Locale;
  nodes: ViewNode[];
  edges: ViewEdge[];
  loops: ViewLoop[];
  summary: { lead: string; steps: string[]; notes: string[] };
  gaps: string[];
  // Shown of all (larger graphs are cut).
  shown: number;
  total: number;
  hasMeta: boolean;
  risks: { ai: boolean; email: boolean; external: boolean; hosts: string[] };
};

// ---- Fixed vocabulary of the graph format (Flowplan's catalogue) ----

const PORT_TEXT: Record<string, [string, string]> = {
  out: ["weiter", "next"],
  true: ["ja", "yes"],
  false: ["nein", "no"],
  error: ["Fehler", "Error"],
  item: ["Element", "Item"],
  done: ["fertig", "done"],
  default: ["sonst", "otherwise"],
  approved: ["genehmigt", "approved"],
  rejected: ["abgelehnt", "rejected"],
  timeout: ["Frist abgelaufen", "timed out"],
  unclear: ["unklar", "unclear"],
};
const KNOWN_PORTS: Record<string, string[]> = { "logic.if": ["true", "false"], "logic.foreach": ["item", "done"], "logic.approval": ["approved", "rejected"] };
const PORT_ORDER = ["out", "true", "item", "approved", "false", "done", "rejected", "unclear", "timeout", "default", "error"];
const portRank = (p: string) => (p.startsWith("case:") ? PORT_ORDER.indexOf("default") - 0.5 : PORT_ORDER.indexOf(p) === -1 ? 50 : PORT_ORDER.indexOf(p));

const groupOf = (type: string) =>
  type.startsWith("trigger.") ? "trigger" : type.startsWith("ai.") ? "ai" : type.startsWith("http.") ? "http" : type.startsWith("notify.") ? "notify" : type.startsWith("action.record.") ? "records" : type.startsWith("action.") ? "pages" : "logic";
const GROUPS = new Set(["trigger", "logic", "records", "pages", "notify", "ai", "http"]);
const EMAIL_TYPES = new Set(["notify.email", "trigger.mail.received"]);
const EXTERNAL_TYPES = new Set(["http.request", "notify.chat", "trigger.webhook"]);
export const isTrigger = (type: string) => type.startsWith("trigger.");
export const fixedHost = (url: string) => /^https?:\/\/([^/?#{}\\@\s]+)(?:[/?#]|$)/i.exec(url.trim())?.[1]?.toLowerCase() ?? null;

const OPERATORS: Record<string, [string, string]> = {
  contains: ["enthält", "contains"],
  not_contains: ["enthält nicht", "does not contain"],
  eq: ["ist", "is"],
  neq: ["ist nicht", "is not"],
  gt: ["größer als", "greater than"],
  gte: ["mindestens", "at least"],
  lt: ["kleiner als", "less than"],
  lte: ["höchstens", "at most"],
  starts_with: ["beginnt mit", "starts with"],
  ends_with: ["endet mit", "ends with"],
  before: ["vor", "before"],
  after: ["nach", "after"],
  on_or_before: ["am oder vor", "on or before"],
  on_or_after: ["am oder nach", "on or after"],
  empty: ["ist leer", "is empty"],
  notempty: ["ist nicht leer", "is not empty"],
  in_relative: ["liegt in", "is within"],
  not_in_relative: ["liegt nicht in", "is not within"],
  any_of: ["ist eines von", "is any of"],
  none_of: ["ist keines von", "is none of"],
  all_of: ["enthält alle", "contains all of"],
  between: ["liegt zwischen", "is between"],
  checked: ["ist angehakt", "is checked"],
  unchecked: ["ist nicht angehakt", "is not checked"],
  complete: ["ist erledigt", "is complete"],
  incomplete: ["ist nicht erledigt", "is not complete"],
};
const RELATIVE: Record<string, [string, string]> = {
  today: ["heute", "today"],
  yesterday: ["gestern", "yesterday"],
  tomorrow: ["morgen", "tomorrow"],
  this_week: ["dieser Woche", "this week"],
  last_week: ["letzter Woche", "last week"],
  next_week: ["nächster Woche", "next week"],
  this_month: ["diesem Monat", "this month"],
  last_month: ["letztem Monat", "last month"],
  next_month: ["nächstem Monat", "next month"],
  this_year: ["diesem Jahr", "this year"],
};
// Names of settings; others are shown as their key, split into words.
const KEYS: Record<string, [string, string]> = {
  address: ["E-Mail-Adresse", "E-mail address"],
  amount: ["Dauer", "Duration"],
  approvers: ["Genehmigende", "Approvers"],
  assignee: ["Zuständig", "Assignee"],
  blocks: ["Inhalt", "Content"],
  body: ["Inhalt der Anfrage", "Request body"],
  bodyKind: ["Art des Inhalts", "Body type"],
  categories: ["Kategorien", "Categories"],
  channels: ["Kanäle", "Channels"],
  condition: ["Bedingung", "Condition"],
  credential: ["Zugangsdaten", "Credential"],
  database: ["Datenbank", "Database"],
  day: ["Tag", "Day"],
  deadline: ["Frist", "Deadline"],
  depth: ["Tiefe", "Depth"],
  due: ["Fällig", "Due"],
  failOnStatus: ["Fehler bei HTTP-Fehlerstatus", "Fail on HTTP error status"],
  field: ["Eigenschaft", "Property"],
  fields: ["Eigenschaften", "Properties"],
  filter: ["Filter", "Filter"],
  format: ["Format", "Format"],
  freq: ["Häufigkeit", "Frequency"],
  headers: ["Kopfzeilen", "Headers"],
  heading: ["Überschrift", "Heading"],
  includeForm: ["Auch Formularantworten", "Include form answers"],
  interval: ["Abstand", "Interval"],
  kind: ["Art", "Kind"],
  kinds: ["Seitenarten", "Page kinds"],
  language: ["Sprache", "Language"],
  length: ["Länge", "Length"],
  limit: ["Höchstens", "Limit"],
  link: ["Link", "Link"],
  list: ["Liste", "List"],
  message: ["Nachricht", "Message"],
  method: ["Methode", "Method"],
  mode: ["Modus", "Mode"],
  multiple: ["Mehrere erlaubt", "Multiple allowed"],
  name: ["Name", "Name"],
  noDuplicate: ["Keine Doppelten", "No duplicates"],
  offsetDays: ["Tage davor/danach", "Days before/after"],
  onTimeout: ["Bei Fristablauf", "On timeout"],
  onlyEmpty: ["Nur wenn leer", "Only if empty"],
  page: ["Seite", "Page"],
  pageId: ["Seite", "Page"],
  parallel: ["Gleichzeitig", "In parallel"],
  parent: ["Elternseite", "Parent page"],
  prompt: ["Anweisung", "Prompt"],
  query: ["Abfrageparameter", "Query parameters"],
  record: ["Eintrag", "Record"],
  rules: ["Regeln", "Rules"],
  scope: ["Wo", "Where"],
  senders: ["Absender", "Senders"],
  sort: ["Sortierung", "Sort"],
  source: ["Quelle", "Source"],
  spaceId: ["Bereich", "Space"],
  subject: ["Betreff", "Subject"],
  system: ["Systemanweisung", "System prompt"],
  tags: ["Tags", "Tags"],
  target: ["Ziel", "Target"],
  template: ["Vorlage", "Template"],
  text: ["Text", "Text"],
  then: ["Danach", "Then"],
  time: ["Uhrzeit", "Time"],
  timeZone: ["Zeitzone", "Time zone"],
  timeoutSeconds: ["Zeitlimit (Sekunden)", "Timeout (seconds)"],
  title: ["Titel", "Title"],
  to: ["An", "To"],
  type: ["Typ", "Type"],
  unclear: ["Ausgang „unklar“", "“Unclear” output"],
  unit: ["Einheit", "Unit"],
  until: ["Bis", "Until"],
  url: ["Adresse", "Address"],
  value: ["Wert", "Value"],
  values: ["Werte", "Values"],
  webhook: ["Chat-Webhook", "Chat webhook"],
  weekday: ["Wochentag", "Weekday"],
  weekdays: ["Wochentage", "Weekdays"],
  where: ["Wo", "Where"],
  who: ["Wer", "Who"],
};

// Fixed choices of settings (not free text) in words.
const ENUM_KEYS = new Set(["kind", "freq", "depth", "mode", "length", "language", "channels", "unit", "kinds", "method", "link", "source", "target", "result", "then", "onTimeout", "bodyKind", "format", "sort"]);
const VALUES: Record<string, [string, string]> = {
  daily: ["täglich", "daily"],
  weekly: ["wöchentlich", "weekly"],
  monthly: ["monatlich", "monthly"],
  workspace: ["ganzer Arbeitsbereich", "whole workspace"],
  space: ["ein Bereich", "a space"],
  below: ["unter einer Seite", "below a page"],
  children: ["nur direkte Unterseiten", "direct children only"],
  all: ["alles darunter", "everything below"],
  end: ["am Ende", "at the end"],
  start: ["am Anfang", "at the start"],
  sentence: ["ein Satz", "one sentence"],
  short: ["kurz", "short"],
  bullets: ["Stichpunkte", "bullet points"],
  auto: ["automatisch", "automatic"],
  inbox: ["Posteingang", "inbox"],
  push: ["Push-Mitteilung", "push notification"],
  email: ["E-Mail", "e-mail"],
  messenger: ["Messenger", "messenger"],
  reached: ["erreicht", "reached"],
  overdue: ["überfällig", "overdue"],
  minutes: ["Minuten", "minutes"],
  hours: ["Stunden", "hours"],
  days: ["Tage", "days"],
  document: ["Dokument", "document"],
  database: ["Datenbank", "database"],
  workflow: ["Workflow", "workflow"],
  "language:workflow": ["Sprache des Workflows", "the workflow's language"],
  "language:auto": ["wie der Text", "same as the text"],
  trigger: ["auslösender Eintrag", "triggering record"],
  field: ["aus einer Eigenschaft", "from a property"],
  list: ["aus einer Liste", "from a list"],
  personal: ["eigene Aufgabenseite", "own task page"],
  page: ["Seite", "page"],
  succeeded: ["erfolgreich", "succeeded"],
  failed: ["als Fehler", "as failed"],
  fail: ["abbrechen", "stop"],
  continue: ["weiter", "carry on"],
  json: ["JSON", "JSON"],
  text: ["Text", "text"],
  form: ["Formular", "form"],
};

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const words = (key: string) => {
  const s = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return s ? s[0].toUpperCase() + s.slice(1) : key;
};
const quote = (t: T, s: string) => t(`„${s}“`, `“${s}”`);

// ---- Building it ----

export type ViewInput = { workflow: unknown; meta: WorkflowMeta | null; locale: Locale };

export function buildWorkflowView({ workflow, meta, locale }: ViewInput): WorkflowView | null {
  const t = translate(locale);
  const pick = (v: { de: string; en: string } | undefined) => (v ? (locale === "de" ? v.de || v.en : v.en || v.de) : "");
  const root = (workflow && typeof workflow === "object" ? workflow : {}) as { graph?: unknown; nodes?: unknown; edges?: unknown };
  const graph = (root.graph && typeof root.graph === "object" ? root.graph : root) as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return null;

  const all: RawNode[] = [];
  const ids = new Set<string>();
  for (const raw of graph.nodes.slice(0, 1000)) {
    const n = rawNodeSchema.safeParse(raw);
    if (!n.success || ids.has(n.data.id)) continue;
    ids.add(n.data.id);
    all.push(n.data);
  }
  const allEdges: RawEdge[] = [];
  for (const raw of graph.edges.slice(0, 2000)) {
    const e = rawEdgeSchema.safeParse(raw);
    if (e.success && ids.has(e.data.from.node) && ids.has(e.data.to.node) && e.data.from.node !== e.data.to.node) allEdges.push(e.data);
  }

  // Reading order: triggers first, then every node after the ones before it, left to right.
  const order = readingOrder(all, allEdges);
  const shownIds = new Set(order.slice(0, VIEW_LIMITS.nodes));
  const nodes = order.slice(0, VIEW_LIMITS.nodes).map((id) => all.find((n) => n.id === id)!);
  const edges = allEdges.filter((e) => shownIds.has(e.from.node) && shownIds.has(e.to.node)).slice(0, VIEW_LIMITS.edges);
  const labelOf = new Map(nodes.map((n) => [n.id, clip(n.label.trim() || n.type, VIEW_LIMITS.label)]));

  // Gaps: a gallery workflow's "$ask:<id>" tokens (labels from the meta),
  // and references by their id (a published workflow's databases, pages …).
  const gapLabels = new Map<string, string>();
  const refLabels = new Map<string, string>();
  for (const g of meta?.gaps ?? []) {
    const label = clip(pick(g.label) || g.id, 200);
    gapLabels.set(g.id, label);
    if (REFERENCE_ID.test(g.id)) refLabels.set(g.id, label);
  }
  const text = JSON.stringify(nodes.map((n) => n.config));
  const asked = new Set([...text.matchAll(/\$ask:([A-Za-z0-9_]{1,40})/g)].map((m) => m[1]));
  for (const id of asked) if (!gapLabels.has(id)) gapLabels.set(id, id);
  const usedGaps = [...new Set([...[...gapLabels].filter(([id]) => asked.has(id)).map(([, l]) => l), ...[...refLabels].filter(([id]) => text.includes(id)).map(([, l]) => l)])];

  const ctx: Ctx = { t, locale, gapLabels, refLabels, labelOf, rows: 0 };
  const reachable = reachableFrom(nodes.filter((n) => isTrigger(n.type)).map((n) => n.id), edges);
  let step = 0;
  const viewNodes: ViewNode[] = nodes.map((n) => {
    const m: MetaNode | undefined = meta?.nodes[n.type];
    const trigger = isTrigger(n.type);
    const url = typeof n.config.url === "string" ? n.config.url : "";
    const host = n.type === "http.request" ? (fixedHost(url) ?? t("Adresse mit Platzhalter", "address with a placeholder")) : null;
    const risks: Risk[] = [];
    if (n.type.startsWith("ai.") || m?.ai) risks.push({ kind: "ai", text: t("KI", "AI") });
    if (EMAIL_TYPES.has(n.type) || m?.email) risks.push({ kind: "email", text: t("E-Mail", "E-mail") });
    if (EXTERNAL_TYPES.has(n.type) || m?.external || host)
      risks.push({ kind: "external", text: host ?? (n.type === "trigger.webhook" ? t("Webhook von außen", "Webhook from outside") : n.type === "notify.chat" ? t("Chat-Dienst", "Chat service") : t("Externer Dienst", "External service")) });
    const used = [...new Set(edges.filter((e) => e.from.node === n.id).map((e) => e.from.port))].sort((a, b) => portRank(a) - portRank(b) || a.localeCompare(b));
    ctx.rows = 0;
    const settings = settingRows(n.config, ctx, 0);
    const errorHandling =
      n.onError && (n.onError.retry || n.onError.then !== "fail")
        ? [
            n.onError.retry ? t(`${n.onError.retry}× wiederholen`, `retry ${n.onError.retry}×`) : "",
            n.onError.then === "port" ? t("dann über den Ausgang „Fehler“", "then through the “Error” output") : n.onError.then === "continue" ? t("dann trotzdem weiter", "then carry on anyway") : t("dann abbrechen", "then stop"),
          ]
            .filter(Boolean)
            .join(", ")
        : null;
    return {
      id: n.id,
      type: n.type,
      label: labelOf.get(n.id)!,
      name: clip(pick(m?.name) || n.type, 80),
      description: clip(pick(m?.description), 400),
      group: m?.group && GROUPS.has(m.group) ? m.group : groupOf(n.type),
      icon: m?.icon ?? null,
      x: clamp(n.position.x),
      y: clamp(n.position.y),
      trigger,
      disabled: n.disabled,
      host,
      risks,
      ports: used.map((p) => ({ id: p, label: portLabel(p, n, m, t, pick) })),
      knownPorts: m && Object.keys(m.ports).length ? Object.keys(m.ports) : (KNOWN_PORTS[n.type] ?? []),
      settings: settings.rows,
      moreSettings: settings.more,
      errorHandling,
      step: trigger || !reachable.has(n.id) ? null : ++step,
    };
  });
  const viewEdges: ViewEdge[] = edges.map((e) => {
    const from = viewNodes.find((n) => n.id === e.from.node)!;
    return { from: e.from.node, to: e.to.node, port: e.from.port, label: from.ports.find((p) => p.id === e.from.port)?.label ?? e.from.port };
  });
  const loops = loopFrames(viewNodes, viewEdges).map((l) => ({ ...l, label: t(`Für jedes: ${quote(t, labelOf.get(l.node) ?? "")}`, `For each: ${quote(t, labelOf.get(l.node) ?? "")}`) }));
  const hosts = [...new Set(viewNodes.map((n) => n.host).filter((h): h is string => !!h))].sort();
  return {
    locale,
    nodes: viewNodes,
    edges: viewEdges,
    loops,
    summary: summarize(viewNodes, viewEdges, all.length, t),
    gaps: usedGaps,
    shown: viewNodes.length,
    total: all.length,
    hasMeta: !!meta,
    risks: { ai: viewNodes.some((n) => n.risks.some((r) => r.kind === "ai")), email: viewNodes.some((n) => n.risks.some((r) => r.kind === "email")), external: viewNodes.some((n) => n.risks.some((r) => r.kind === "external")), hosts },
  };
}

const clamp = (v: number) => Math.round(Math.max(-VIEW_LIMITS.coordinate, Math.min(VIEW_LIMITS.coordinate, v)));

function portLabel(port: string, node: RawNode, m: MetaNode | undefined, t: T, pick: (v: { de: string; en: string }) => string) {
  if (port.startsWith("case:")) {
    const cases = Array.isArray(node.config.cases) ? (node.config.cases as { id?: unknown; label?: unknown; value?: unknown }[]) : [];
    const c = cases.find((x) => x && `case:${String(x.id)}` === port);
    const label = c && typeof c.label === "string" && c.label.trim() ? c.label : c && typeof c.value === "string" && c.value.trim() ? c.value : "";
    return clip(label || t("Fall", "Case"), 30);
  }
  const fromMeta = m?.ports[port] ? pick(m.ports[port]) : "";
  if (fromMeta) return clip(fromMeta, 30);
  return PORT_TEXT[port] ? t(PORT_TEXT[port][0], PORT_TEXT[port][1]) : clip(port, 30);
}

function readingOrder(nodes: RawNode[], edges: RawEdge[]): string[] {
  const byPos = (a: RawNode, b: RawNode) => a.position.x - b.position.x || a.position.y - b.position.y || a.id.localeCompare(b.id);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  const done = new Set<string>();
  // Kahn's order with the leftmost ready node first: first what the
  // triggers reach, then the rest.
  const pass = (starts: RawNode[], within: Set<string>) => {
    const indegree = new Map<string, number>();
    for (const e of edges) if (within.has(e.from.node) && within.has(e.to.node) && !done.has(e.from.node)) indegree.set(e.to.node, (indegree.get(e.to.node) ?? 0) + 1);
    const queue = starts.filter((n) => !indegree.get(n.id)).sort(byPos);
    while (queue.length) {
      const n = queue.shift()!;
      if (done.has(n.id)) continue;
      done.add(n.id);
      out.push(n.id);
      for (const e of edges) {
        if (e.from.node !== n.id || !within.has(e.to.node)) continue;
        const left = (indegree.get(e.to.node) ?? 1) - 1;
        indegree.set(e.to.node, left);
        if (left <= 0 && !done.has(e.to.node)) queue.push(byId.get(e.to.node)!);
      }
      queue.sort(byPos);
    }
  };
  const triggers = nodes.filter((n) => isTrigger(n.type));
  pass(triggers, reachableFrom(triggers.map((n) => n.id), edges));
  const rest = nodes.filter((n) => !done.has(n.id));
  pass(rest, new Set(rest.map((n) => n.id)));
  // Cycles: by position.
  for (const n of [...nodes].sort(byPos)) if (!done.has(n.id)) out.push(n.id);
  return out;
}
function reachableFrom(starts: string[], edges: { from: { node: string } | string; to: { node: string } | string }[]) {
  const seen = new Set<string>();
  const stack = [...starts];
  const id = (x: { node: string } | string) => (typeof x === "string" ? x : x.node);
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const e of edges) if (id(e.from) === n) stack.push(id(e.to));
  }
  return seen;
}

// For-each bodies: what is reachable from the output "item".
function loopFrames(nodes: ViewNode[], edges: ViewEdge[]) {
  const out: { node: string; members: string[] }[] = [];
  for (const n of nodes) {
    if (n.type !== "logic.foreach" || out.length >= VIEW_LIMITS.loops) continue;
    const body = new Set<string>();
    const stack = edges.filter((e) => e.from === n.id && e.port === "item").map((e) => e.to);
    while (stack.length) {
      const id = stack.pop()!;
      if (body.has(id) || id === n.id) continue;
      body.add(id);
      for (const e of edges) if (e.from === id) stack.push(e.to);
    }
    if (body.size) out.push({ node: n.id, members: [...body] });
  }
  return out;
}

// ---- Settings, read-only ----

type Ctx = { t: T; locale: Locale; gapLabels: Map<string, string>; refLabels: Map<string, string>; labelOf: Map<string, string>; rows: number };
// A reference's id (not a word like "database"): has a digit, - or _.
const REFERENCE_ID = /^(?=.*[0-9_-])[A-Za-z0-9_-]{6,100}$/;
const TOKEN = /(\{\{[\s\S]{0,300}?\}\}|\$ask:[A-Za-z0-9_]{1,40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const WHOLE_GAP = /^(?:field:)?\$ask:([A-Za-z0-9_]{1,40})$/;

const gapText = (ctx: Ctx) => ctx.t("wird bei dir festgelegt", "set by you");
function gapOf(s: string, ctx: Ctx): string | null {
  const whole = WHOLE_GAP.exec(s.trim());
  if (whole) return ctx.gapLabels.get(whole[1]) ?? whole[1];
  const key = s.trim().replace(/^field:/, "");
  return ctx.refLabels.get(key) ?? null;
}
// A text with its placeholders and gaps marked; node ids in placeholders as the node's label.
export function textParts(s: string, ctx: Pick<Ctx, "gapLabels" | "refLabels" | "labelOf">): Part[] {
  const parts: Part[] = [];
  const value = clip(s, VIEW_LIMITS.text);
  let at = 0;
  for (const m of value.matchAll(TOKEN)) {
    if (m.index > at) parts.push({ k: "t", v: value.slice(at, m.index) });
    const token = m[0];
    if (token.startsWith("{{")) {
      const inner = token.slice(2, -2).trim();
      // A placeholder naming a gap ("…fields.$ask:status"): the property the person picks.
      const asked = /\$ask:([A-Za-z0-9_]{1,40})/.exec(inner);
      if (asked) {
        parts.push({ k: "gap", v: ctx.gapLabels.get(asked[1]) ?? asked[1] });
        at = m.index + token.length;
        continue;
      }
      const ref = /^(n_[A-Za-z0-9]+)([\s\S]*)$/.exec(inner);
      // Line breaks inside a placeholder (a filter's argument) as \n, so it stays one chip.
      const shown = (ref && ctx.labelOf.has(ref[1]) ? ctx.labelOf.get(ref[1]) + ref[2] : inner).replace(/\r?\n/g, "\\n");
      parts.push({ k: "ph", v: `{{${shown}}}` });
    } else if (token.startsWith("$ask:")) parts.push({ k: "gap", v: ctx.gapLabels.get(token.slice(5)) ?? token.slice(5) });
    else if (ctx.refLabels.has(token)) parts.push({ k: "gap", v: ctx.refLabels.get(token)! });
    else parts.push({ k: "t", v: token });
    at = m.index + token.length;
  }
  if (at < value.length) parts.push({ k: "t", v: value.slice(at) });
  return parts;
}

function settingRows(config: Record<string, unknown>, ctx: Ctx, depth: number): { rows: SettingRow[]; more: number } {
  const rows: SettingRow[] = [];
  let more = 0;
  for (const [key, value] of Object.entries(config)) {
    if (ctx.rows >= VIEW_LIMITS.rows) {
      more++;
      continue;
    }
    ctx.rows++;
    const keyGap = gapOf(key, ctx);
    const label = keyGap ? `${keyGap} (${gapText(ctx)})` : KEYS[key] ? ctx.t(KEYS[key][0], KEYS[key][1]) : clip(words(key), 60);
    rows.push({ key: clip(key, 60), label, value: settingValue(value, key, ctx, depth) });
  }
  return { rows, more };
}

function settingValue(value: unknown, key: string, ctx: Ctx, depth: number): SettingValue {
  const { t } = ctx;
  if (value === null || value === undefined || value === "") return { k: "empty", text: t("leer", "empty") };
  if (typeof value === "boolean") return { k: "plain", text: value ? t("ja", "yes") : t("nein", "no") };
  if (typeof value === "number") return { k: "plain", text: Number.isFinite(value) ? value.toLocaleString(ctx.locale === "de" ? "de-DE" : "en-GB") : "–" };
  if (typeof value === "string") {
    const gap = gapOf(value, ctx);
    if (gap !== null) return { k: "gap", text: gapText(ctx), label: gap };
    const fixed = ENUM_KEYS.has(key) ? (VALUES[`${key}:${value}`] ?? VALUES[value]) : undefined;
    if (fixed) return { k: "plain", text: t(fixed[0], fixed[1]) };
    return { k: "text", parts: textParts(value, ctx), long: value.length > 60 || value.includes("\n") };
  }
  if (depth >= VIEW_LIMITS.depth) return { k: "plain", text: "…" };
  if (Array.isArray(value)) {
    if (!value.length) return { k: "empty", text: t("keine", "none") };
    const items = value.slice(0, VIEW_LIMITS.list).map((v) => settingValue(v, key, ctx, depth + 1));
    return { k: "list", items, more: Math.max(0, value.length - VIEW_LIMITS.list) };
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (o.kind === "group" && Array.isArray(o.rules)) {
      const counter = { n: 0 };
      return { k: "conditions", join: joinText(o.join, t), rules: conditions(o.rules, ctx, 0, counter), more: Math.max(0, countRules(o.rules) - counter.n) };
    }
    // A scope ({kind: "below", pageId}) or a page position reads better as its parts.
    const { rows, more } = settingRows(o, ctx, depth + 1);
    if (!rows.length && !more) return { k: "empty", text: t("leer", "empty") };
    return { k: "map", rows, more };
  }
  return { k: "plain", text: "–" };
}
const joinText = (join: unknown, t: T) => (join === "or" ? t("oder", "or") : t("und", "and"));
const countRules = (rules: unknown[]): number => rules.reduce<number>((n, r) => n + (r && typeof r === "object" && Array.isArray((r as { rules?: unknown }).rules) ? countRules((r as { rules: unknown[] }).rules) : 1), 0);

function conditions(rules: unknown[], ctx: Ctx, depth: number, counter: { n: number }): Condition[] {
  const out: Condition[] = [];
  for (const raw of rules) {
    if (counter.n >= VIEW_LIMITS.list || !raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r.rules)) {
      if (depth < 2) out.push({ k: "group", join: joinText(r.join, ctx.t), rules: conditions(r.rules, ctx, depth + 1, counter) });
      continue;
    }
    counter.n++;
    const op = typeof r.op === "string" ? r.op : "";
    const asParts = (v: unknown): Part[] => {
      if (typeof v !== "string" || !v) return [];
      const gap = gapOf(v, ctx);
      if (gap !== null) return [{ k: "gap", v: gap }];
      if (RELATIVE[v]) return [{ k: "t", v: ctx.t(RELATIVE[v][0], RELATIVE[v][1]) }];
      return textParts(v, ctx);
    };
    let value: Part[] = Array.isArray(r.values) ? r.values.slice(0, 20).flatMap((v, i) => [...(i ? [{ k: "t" as const, v: ", " }] : []), ...asParts(v)]) : asParts(r.value);
    if (op === "between" && typeof r.to === "string") value = [...value, { k: "t", v: ctx.t(" und ", " and ") }, ...asParts(r.to)];
    if (typeof r.days === "number") value = [...value, { k: "t", v: ctx.t(` (${r.days} Tage)`, ` (${r.days} days)`) }];
    const field = asParts(r.left);
    out.push({ k: "cond", field: field.length ? field : [{ k: "t", v: "–" }], op: OPERATORS[op] ? ctx.t(OPERATORS[op][0], OPERATORS[op][1]) : clip(op, 30), value });
  }
  return out;
}

// ---- "What it does" ----

function summarize(nodes: ViewNode[], edges: ViewEdge[], total: number, t: T): WorkflowView["summary"] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const named = (n: ViewNode) => (n.name && n.name !== n.label && n.name !== n.type ? `${quote(t, n.label)} (${n.name})` : quote(t, n.label));
  const triggers = nodes.filter((n) => n.trigger);
  const stepRef = (id: string) => {
    const n = byId.get(id)!;
    return n.step ? t(`Schritt ${n.step}`, `step ${n.step}`) : quote(t, n.label);
  };
  const refs = (ids: string[]) => {
    const list = ids.map(stepRef);
    return list.length > 1 ? `${list.slice(0, -1).join(", ")} ${t("und", "and")} ${list[list.length - 1]}` : list[0];
  };
  const risk = (n: ViewNode) =>
    n.risks
      .map((r) =>
        r.kind === "ai"
          ? t("nutzt KI", "uses AI")
          : r.kind === "email"
            ? n.type === "trigger.mail.received"
              ? t("empfängt E-Mails", "receives e-mail")
              : t("verschickt eine E-Mail", "sends an e-mail")
            : n.host
              ? t(`ruft ${n.host} auf`, `calls ${n.host}`)
              : n.type === "trigger.webhook"
                ? t("wird von außen aufgerufen", "is called from outside")
                : t("spricht einen externen Dienst an", "talks to an external service"),
      )
      .join(", ");
  const flow = (n: ViewNode, index: number, ordered: ViewNode[]) => {
    const out = edges.filter((e) => e.from === n.id);
    if (!out.length) return "";
    const ports = n.ports.map((p) => ({ ...p, to: out.filter((e) => e.port === p.id).map((e) => e.to) })).filter((p) => p.to.length);
    if (ports.length === 1 && ports[0].id === "out") {
      const next = ordered[index + 1];
      return ports[0].to.length === 1 && next && ports[0].to[0] === next.id ? "" : t(`weiter mit ${refs(ports[0].to)}`, `then ${refs(ports[0].to)}`);
    }
    const later = ports.filter((p) => p.id === "out");
    const parts = ports
      .filter((p) => p.id !== "out")
      .map((p) =>
        p.id === "item"
          ? t(`für jedes Element ${refs(p.to)}`, `for each item ${refs(p.to)}`)
          : p.id === "done"
            ? t(`danach ${refs(p.to)}`, `afterwards ${refs(p.to)}`)
            : t(`bei ${quote(t, p.label)} weiter mit ${refs(p.to)}`, `on ${quote(t, p.label)} continue with ${refs(p.to)}`),
      );
    if (later.length) parts.push(t(`sonst mit ${refs(later[0].to)}`, `otherwise with ${refs(later[0].to)}`));
    // Outputs of the type left unconnected: there it ends.
    const open = n.knownPorts.filter((p) => p !== "error" && p !== "out" && !ports.some((x) => x.id === p));
    if (open.length && !later.length && !ports.some((p) => p.id === "item" || p.id === "done")) parts.push(t("sonst endet er hier", "otherwise it ends here"));
    return parts.join(", ");
  };

  let lead: string;
  if (!triggers.length) lead = t("Hat keinen Auslöser – startet nicht von selbst.", "Has no trigger – it never starts by itself.");
  else if (triggers.length === 1) {
    const d = triggers[0].description.replace(/\s+$/, "");
    lead = t(`Startet mit ${named(triggers[0])}${d ? `: ${d}` : "."}`, `Starts with ${named(triggers[0])}${d ? `: ${d}` : "."}`);
    const r = risk(triggers[0]);
    if (r) lead += ` ${t(`Er ${r}.`, `It ${r}.`)}`;
    const f = flow(triggers[0], -1, []);
    if (f && !/^(weiter mit|then) /.test(f)) lead += ` (${f})`;
  } else lead = t(`Startet mit ${triggers.map(named).join(" oder ")}.`, `Starts with ${triggers.map(named).join(" or ")}.`);

  const ordered = nodes.filter((n) => n.step !== null);
  const steps = ordered.map((n, i) => {
    const bits = [risk(n), flow(n, i, ordered)].filter(Boolean);
    return `${named(n)}${n.disabled ? t(" (abgeschaltet)", " (switched off)") : ""}${bits.length ? ` – ${bits.join("; ")}` : ""}`;
  });
  const notes: string[] = [];
  const loose = nodes.filter((n) => !n.trigger && n.step === null);
  if (loose.length) notes.push(t(`Nicht verbunden: ${loose.map((n) => quote(t, n.label)).join(", ")}.`, `Not connected: ${loose.map((n) => quote(t, n.label)).join(", ")}.`));
  if (total > nodes.length) notes.push(t(`Gezeigt werden die ersten ${nodes.length} von ${total} Schritten.`, `Showing the first ${nodes.length} of ${total} steps.`));
  return { lead, steps, notes };
}

// The summary as plain text (admin API).
export const summaryText = (s: WorkflowView["summary"]) => [s.lead, ...s.steps.map((x, i) => `${i + 1}. ${x}`), ...s.notes].join("\n");
