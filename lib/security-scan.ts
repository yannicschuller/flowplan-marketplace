// The security scan of a package for the review (flowplan-admin): every
// check with a severity – block, warn or info –, a code, the place in the
// package and an explanation in German and English, and a verdict:
//
//   clean   "unbedenklich"  no block or warn finding
//   review  "prüfen"        at least one warn finding
//   block   "blockieren"    at least one block finding: the admin API refuses
//                           to publish unless the reviewer overrides it with
//                           a reason (audited, lib/security-store.ts)
//
// It complements inspectPackage() (lib/package.ts, the checks an author sees
// on upload) and reads the package on its own, leniently: a ZIP the normal
// reader refuses is still listed entry by entry, so the reviewer sees why.
// Nothing is run, rendered or fetched; link-rule patterns are only run in a
// worker with a time limit (lib/regex-safety.ts).
//
// SCANNER_VERSION goes up whenever a check changes; stored scans of an older
// version are run again (on start and on "Erneut prüfen").
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { TextDecoder } from "node:util";
import { BIDI, INVISIBLE, confusableShare, findPersonal, findSecrets, findUrls, hostClass, mixedScriptWords, promptRisks } from "./security-patterns";
import { ARCHIVES, EXECUTABLES, EXECUTABLE_NAME, LEGACY_OFFICE_NAME, MACRO_NAME, imageSize, inspectFont, pdfRisks, sniffFile, svgRisks, zipNames } from "./security-files";
import { checkPatterns, type RegexFlag } from "./regex-safety";

export const SCANNER_VERSION = "1.0.0";

export type SecuritySeverity = "block" | "warn" | "info";
export type SecurityFinding = {
  severity: SecuritySeverity;
  code: string;
  // The entry, and inside JSON the path: "payload/workflow.json#/graph/nodes/2/config/url".
  at: string;
  de: string;
  en: string;
  // How often it was found in this entry (one finding per code and entry).
  count?: number;
};
export type Verdict = "clean" | "review" | "block";
export const VERDICT_LABELS: Record<Verdict, { de: string; en: string }> = {
  clean: { de: "unbedenklich", en: "no concerns" },
  review: { de: "prüfen", en: "review" },
  block: { de: "blockieren", en: "block" },
};
export type SecurityReport = {
  verdict: Verdict;
  label: { de: string; en: string };
  counts: Record<SecuritySeverity, number>;
  findings: SecurityFinding[];
  scannedAt: string;
  scannerVersion: string;
  sha256: string;
  kind: string | null;
};

export const SCAN_LIMITS = {
  entries: 400,
  entryBytes: 25 * 1024 * 1024,
  largeEntry: 10 * 1024 * 1024,
  totalBytes: 80 * 1024 * 1024,
  ratio: 100,
  findings: 300,
  strings: 200_000,
  fontBytes: 5 * 1024 * 1024,
};

// The node types Flowplan knows (lib/workflows/catalog.ts of the Flowplan
// server). A package with any other type is blocked: it was not made by
// Flowplan and its import would fail or do something unexpected.
export const KNOWN_NODE_TYPES = new Set(
  (
    "action.page.append action.page.create action.page.move action.page.tag action.record.create action.record.find action.record.template action.record.update action.task.create " +
    "ai.classify ai.extract ai.prompt ai.summarize http.request logic.approval logic.foreach logic.if logic.set logic.stop logic.switch logic.wait " +
    "notify.chat notify.email notify.person trigger.comment.created trigger.form.submitted trigger.journal.day trigger.mail.received trigger.manual trigger.mention " +
    "trigger.page.changed trigger.page.created trigger.page.moved trigger.page.tagged trigger.record.changed trigger.record.created trigger.record.date trigger.record.done trigger.schedule trigger.webhook"
  ).split(" "),
);

// ---- Findings ----

class Findings {
  private readonly byKey = new Map<string, SecurityFinding & { samples: string[] }>();
  add(severity: SecuritySeverity, code: string, at: string, de: string, en: string, sample?: string) {
    const entry = at.split("#")[0];
    const key = `${code}\u0000${entry}`;
    const hit = this.byKey.get(key);
    if (hit) {
      hit.count = (hit.count ?? 1) + 1;
      if (sample && hit.samples.length < 3 && !hit.samples.includes(sample)) hit.samples.push(sample);
      if (rank[severity] < rank[hit.severity]) hit.severity = severity;
      return;
    }
    if (this.byKey.size >= SCAN_LIMITS.findings) return;
    this.byKey.set(key, { severity, code, at, de, en, samples: sample ? [sample] : [] });
  }
  list(): SecurityFinding[] {
    return [...this.byKey.values()]
      .map(({ samples, ...f }) => {
        const more = f.count && f.count > 1 ? ` (${f.count}×)` : "";
        const eg = samples.length ? `: ${samples.join(", ")}` : "";
        return { ...f, de: `${f.de}${more}${eg}`, en: `${f.en}${more}${eg}` };
      })
      .sort((a, b) => rank[a.severity] - rank[b.severity] || a.at.localeCompare(b.at));
  }
}
const rank: Record<SecuritySeverity, number> = { block: 0, warn: 1, info: 2 };

// ---- A lenient ZIP reader ----

type RawEntry = { name: string; data: Buffer | null; size: number; compressed: number; encrypted: boolean; symlink: boolean; error?: string };

// Lists every entry of the central directory and inflates it within the
// limits. Unlike lib/zip.ts it never throws for a bad entry: the entry is
// reported with what is wrong.
function readEntries(b: Buffer, at: string, f: Findings): RawEntry[] | null {
  const from = Math.max(0, b.length - 65557);
  let eocd = -1;
  for (let i = b.length - 22; i >= from; i--)
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) {
    f.add("block", "zip-unreadable", at, "Keine lesbare ZIP-Datei.", "Not a readable ZIP file.");
    return null;
  }
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  if (count > SCAN_LIMITS.entries) f.add("block", "zip-too-many", at, `Zu viele Einträge im Archiv (${count}).`, `Too many entries in the archive (${count}).`);
  const out: RawEntry[] = [];
  let total = 0;
  for (let i = 0; i < Math.min(count, SCAN_LIMITS.entries); i++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) {
      f.add("block", "zip-unreadable", at, "Das Inhaltsverzeichnis des Archivs ist beschädigt.", "The archive's directory is damaged.");
      break;
    }
    const madeBy = b.readUInt16LE(p + 4) >> 8;
    const flags = b.readUInt16LE(p + 8);
    const method = b.readUInt16LE(p + 10);
    const compressed = b.readUInt32LE(p + 20);
    const size = b.readUInt32LE(p + 24);
    const nameLength = b.readUInt16LE(p + 28);
    const extra = b.readUInt16LE(p + 30);
    const comment = b.readUInt16LE(p + 32);
    const attrs = b.readUInt32LE(p + 38);
    const offset = b.readUInt32LE(p + 42);
    const nameBytes = b.subarray(p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extra + comment;
    const utf8 = !!(flags & 0x0800);
    const name = utf8 ? nameBytes.toString("utf8") : nameBytes.toString("latin1");
    const mode = (attrs >>> 16) & 0xffff;
    const entry: RawEntry = { name, data: null, size, compressed, encrypted: !!(flags & 1), symlink: madeBy === 3 && (mode & 0o170000) === 0o120000 };
    out.push(entry);
    if (name.endsWith("/")) continue;
    if (entry.encrypted || entry.symlink) continue;
    if (size > SCAN_LIMITS.entryBytes || total + size > SCAN_LIMITS.totalBytes) {
      entry.error = "too-large";
      continue;
    }
    if (size > 1024 * 1024 && size > Math.max(1, compressed) * SCAN_LIMITS.ratio) {
      entry.error = "ratio";
      continue;
    }
    try {
      if (offset + 30 > b.length || b.readUInt32LE(offset) !== 0x04034b50) throw new Error("local header");
      const start = offset + 30 + b.readUInt16LE(offset + 26) + b.readUInt16LE(offset + 28);
      const body = b.subarray(start, start + compressed);
      const data = method === 0 ? Buffer.from(body) : method === 8 ? inflateRawSync(body, { maxOutputLength: Math.max(1, size) }) : null;
      if (!data) throw new Error("method");
      if (data.length !== size) entry.error = "size-mismatch";
      entry.data = data;
      total += data.length;
    } catch (error) {
      entry.error = /maxOutputLength|buffer|size/i.test(String((error as Error)?.message)) ? "size-mismatch" : "unreadable";
    }
  }
  return out;
}

const safeName = (name: string) =>
  !!name && name.length <= 200 && !/[\u0000-\u001f\u007f\\]/.test(name) && !name.startsWith("/") && !/^[a-zA-Z]:/.test(name) && name.split("/").every((s, i, all) => (s === "" ? i === all.length - 1 : s !== "." && s !== ".."));

// The checks every archive (the package, a nested template) gets per entry.
function checkEntries(entries: RawEntry[], at: string, f: Findings) {
  const seen = new Set<string>();
  for (const e of entries) {
    const where = at ? `${at}!${e.name}` : e.name;
    if (!safeName(e.name)) f.add("block", "entry-path", where, "Unzulässiger Dateipfad (absolut, „..“, Backslash oder Steuerzeichen).", "Unsafe file path (absolute, “..”, backslash or control characters).");
    if (seen.has(e.name)) f.add("block", "entry-duplicate", where, "Doppelter Eintrag: zwei Dateien mit demselben Namen.", "Duplicate entry: two files with the same name.");
    seen.add(e.name);
    if (e.symlink) f.add("block", "entry-symlink", where, "Symbolischer Link im Archiv – kann beim Entpacken auf fremde Dateien zeigen.", "Symbolic link in the archive – may point at other files when unpacked.");
    if (e.encrypted) f.add("block", "entry-encrypted", where, "Verschlüsselter Eintrag – der Inhalt lässt sich nicht prüfen.", "Encrypted entry – its content can't be checked.");
    if (e.name.split("/").some((s) => s.startsWith(".") && s.length > 1) || /(^|\/)__MACOSX(\/|$)/.test(e.name))
      f.add("warn", "entry-hidden", where, "Versteckte Datei (Punktdatei oder __MACOSX) – gehört nicht in eine Vorlage.", "Hidden file (dot file or __MACOSX) – does not belong in a template.");
    if (e.error === "too-large") f.add("block", "entry-too-large", where, "Eintrag ist entpackt größer als 25 MB.", "Entry is larger than 25 MB unpacked.");
    else if (e.error === "ratio") f.add("block", "zip-bomb", where, "Verdächtig stark komprimiert (ZIP-Bombe).", "Suspiciously high compression (zip bomb).");
    else if (e.error === "size-mismatch") f.add("block", "entry-size-mismatch", where, "Die entpackte Größe stimmt nicht mit der angegebenen überein.", "The unpacked size does not match the declared one.");
    else if (e.error) f.add("block", "entry-unreadable", where, "Eintrag lässt sich nicht entpacken.", "Entry can't be unpacked.");
    else if (e.size > SCAN_LIMITS.largeEntry) f.add("warn", "entry-large", where, `Sehr große Datei (${Math.round(e.size / 1024 / 1024)} MB).`, `Very large file (${Math.round(e.size / 1024 / 1024)} MB).`);
  }
}

// ---- What a file is ----

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function decodeJson(data: Buffer, where: string, f: Findings): unknown {
  if (data.length >= 2 && ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff))) {
    f.add("block", "json-encoding", where, "JSON ist nicht UTF-8 (UTF-16).", "JSON is not UTF-8 (UTF-16).");
    return undefined;
  }
  let text: string;
  try {
    text = decoder.decode(data);
  } catch {
    f.add("block", "json-encoding", where, "JSON ist kein gültiges UTF-8.", "JSON is not valid UTF-8.");
    return undefined;
  }
  if (text.startsWith("﻿")) {
    f.add("info", "json-bom", where, "JSON beginnt mit einer Byte-Order-Mark.", "JSON starts with a byte order mark.");
    text = text.slice(1);
  }
  try {
    return JSON.parse(text);
  } catch {
    f.add("warn", "json-invalid", where, "Kein gültiges JSON.", "Not valid JSON.");
    return undefined;
  }
}

// One file's content by its bytes. `expected`: the kinds of file that
// belong at this place (anything else is a warning).
function checkFile(data: Buffer, name: string, where: string, f: Findings, opts: { archiveOk?: boolean; expected?: string[]; mime?: string } = {}) {
  const kind = sniffFile(data);
  if (EXECUTABLES.has(kind) || EXECUTABLE_NAME.test(name))
    return f.add("block", "file-executable", where, `Ausführbare Datei (${kind === "unknown" || kind === "text" ? name.split(".").pop() : kind}).`, `Executable file (${kind === "unknown" || kind === "text" ? name.split(".").pop() : kind}).`);
  if (ARCHIVES.has(kind) && !opts.archiveOk) {
    const names = kind === "zip" ? zipNames(data) : null;
    if (names?.some((n) => /(^|\/)vbaProject\.bin$/i.test(n)) || MACRO_NAME.test(name))
      return f.add("block", "office-macro", where, "Office-Datei mit Makros (vbaProject.bin).", "Office file with macros (vbaProject.bin).");
    if (names && names.includes("[Content_Types].xml"))
      return f.add("info", "office-document", where, "Office-Dokument (ohne Makros).", "Office document (without macros).");
    return f.add("block", "nested-archive", where, `Verschachteltes Archiv (${kind}) – sein Inhalt wird beim Import nicht geprüft.`, `Nested archive (${kind}) – its content is not checked on import.`);
  }
  if (MACRO_NAME.test(name)) f.add("block", "office-macro", where, "Office-Datei mit Makros (Dateiendung).", "Office file with macros (file extension).");
  if (kind === "ole" || LEGACY_OFFICE_NAME.test(name))
    f.add("warn", "office-legacy", where, "Altes Office-Format (OLE) – kann Makros enthalten.", "Legacy Office format (OLE) – may contain macros.");
  if (kind === "html") f.add("warn", "file-html", where, "HTML-Datei als Anhang – kann Skripte enthalten.", "HTML file as attachment – may contain scripts.");
  if (kind === "svg" || /\.svg$/i.test(name)) for (const r of svgRisks(data.toString("utf8"))) f.add(r.severity, r.code, where, r.de, r.en);
  if (kind === "pdf") for (const r of pdfRisks(data)) f.add(r.severity, r.code, where, r.de, r.en);
  if (kind === "png" || kind === "gif" || kind === "jpeg" || kind === "webp") {
    const size = imageSize(data);
    if (size && size.w <= 2 && size.h <= 2) f.add("warn", "tracking-pixel", where, `Bild mit ${size.w}×${size.h} Pixeln – typisch für Zählpixel.`, `Image of ${size.w}×${size.h} pixels – typical for tracking pixels.`);
  }
  if (opts.mime) {
    const declared = opts.mime.toLowerCase();
    const looks = mimeOf(kind);
    if (looks && !declared.startsWith(looks.split("/")[0]) && declared !== looks)
      f.add("warn", "file-type-mismatch", where, `Angegebener Typ „${declared}“ passt nicht zum Inhalt (${kind}).`, `Declared type “${declared}” does not match the content (${kind}).`);
  }
  if (opts.expected && !opts.expected.includes(kind))
    f.add("warn", "file-unexpected-type", where, `Unerwarteter Dateityp an dieser Stelle (${kind}).`, `Unexpected file type at this place (${kind}).`);
  return kind;
}
const mimeOf = (kind: string) =>
  ({ png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf", zip: "application/zip", html: "text/html" })[kind] ?? null;

// ---- HTML in strings ----

const HTML_RULES: [RegExp, SecuritySeverity, string, string, string][] = [
  [/<script[\s>/]/i, "block", "html-script", "HTML enthält <script>.", "HTML contains <script>."],
  [/<[a-z][^>]*\son[a-z]{3,30}\s*=/i, "block", "html-event-handler", "HTML enthält Event-Handler (on…=).", "HTML contains event handlers (on…=)."],
  [/<meta[^>]*http-equiv/i, "block", "html-meta-refresh", "HTML enthält <meta http-equiv> (Weiterleitung, CSP).", "HTML contains <meta http-equiv> (redirect, CSP)."],
  [/<base[\s>/]/i, "block", "html-base", "HTML enthält <base> (ändert alle Links).", "HTML contains <base> (changes every link)."],
  [/\ssrcdoc\s*=/i, "block", "html-srcdoc", "HTML enthält srcdoc (eingebettetes Dokument).", "HTML contains srcdoc (embedded document)."],
  [/<(?:iframe|frame|frameset)[\s>/]/i, "warn", "html-iframe", "HTML enthält <iframe> (Flowplan entfernt es beim Import).", "HTML contains <iframe> (Flowplan removes it on import)."],
  [/<(?:object|embed|applet)[\s>/]/i, "warn", "html-object", "HTML enthält <object>/<embed>.", "HTML contains <object>/<embed>."],
  [/<style[\s>/]/i, "warn", "html-style", "HTML enthält <style> (Flowplan entfernt es).", "HTML contains <style> (Flowplan removes it)."],
  [/<link[^>]*rel\s*=\s*["']?(?:stylesheet|import|preload|prefetch)/i, "warn", "html-link", "HTML lädt Dateien per <link>.", "HTML loads files with <link>."],
  [/<(?:form|button|textarea|select)[\s>/]|<input\b(?![^>]*\stype\s*=\s*["']?checkbox)/i, "warn", "html-form", "HTML enthält Formular-Elemente (Flowplan entfernt sie).", "HTML contains form elements (Flowplan removes them)."],
  [/\sstyle\s*=\s*["'][^"']*(?:expression\(|url\(|behavior:|-moz-binding)/i, "block", "html-style-active", "Inline-Stil mit aktivem Inhalt (url(), expression()).", "Inline style with active content (url(), expression())."],
];
const hostOfUrl = (u: string) => /^(?:https?:)?\/\/([^/?#:\s"'<>]+)/i.exec(u.trim())?.[1]?.toLowerCase() ?? null;

function checkHtml(value: string, where: string, f: Findings) {
  if (!value.includes("<")) return;
  for (const [re, sev, code, de, en] of HTML_RULES) if (re.test(value)) f.add(sev, code, where, de, en);
  // Embeds and their hosts (Flowplan's embed blocks keep the address in
  // data-src / data-url; iframes in src).
  for (const m of value.matchAll(/<(?:iframe|embed|object|video|audio|div|figure)[^>]*\s(?:src|data-src|data-url|data-embed|data)\s*=\s*["']([^"']{1,500})["']/gi)) {
    const host = hostOfUrl(m[1]);
    if (host) f.add("info", "embed-host", where, "Eingebetteter Inhalt von", "Embedded content from", host);
  }
  // Pictures from the net load when the page opens (the other side learns who
  // looked when). Tiny ones are tracking pixels.
  for (const m of value.matchAll(/<img\b([^>]*)>/gi)) {
    const src = /\ssrc\s*=\s*["']([^"']{1,1000})["']/i.exec(m[1])?.[1] ?? "";
    const host = hostOfUrl(src);
    if (!host) continue;
    const w = /\swidth\s*=\s*["']?(\d+)/i.exec(m[1])?.[1];
    const h = /\sheight\s*=\s*["']?(\d+)/i.exec(m[1])?.[1];
    if ((w && Number(w) <= 2) || (h && Number(h) <= 2))
      f.add("warn", "tracking-pixel", where, "Bild mit 1×1 Pixel aus dem Netz – typisch für Zählpixel.", "1×1 picture from the net – typical for tracking pixels.", host);
    else f.add("warn", "external-image", where, "Bild aus dem Netz – wird beim Öffnen geladen (Datenschutz)", "Picture from the net – loaded when opened (privacy)", host);
  }
}

// ---- Strings everywhere ----

type Walked = { value: string; path: string; key: string };
function strings(value: unknown, path = "", key = "", out: Walked[] = [], depth = 0): Walked[] {
  if (out.length >= SCAN_LIMITS.strings || depth > 60) return out;
  if (typeof value === "string") out.push({ value, path, key });
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}/${i}`, key, out, depth + 1));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      if (k.length > 0 && (BIDI.test(k) || INVISIBLE.test(k))) out.push({ value: k, path: `${path}/${k}`, key: "@key" });
      strings(v, `${path}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`, k, out, depth + 1);
    }
  return out;
}

function checkStrings(value: unknown, entry: string, f: Findings, opts: { html?: boolean; hosts?: Set<string> } = {}) {
  for (const s of strings(value)) {
    const where = `${entry}#${s.path || "/"}`;
    for (const hit of findSecrets(s.value))
      f.add(hit.severity, `secret-${hit.kind}`, where, `Sieht aus wie Zugangsdaten (${hit.kind}) – vor dem Veröffentlichen entfernen`, `Looks like credentials (${hit.kind}) – remove before publishing`, hit.sample);
    for (const hit of findPersonal(s.value)) {
      const [de, en] = {
        email: ["E-Mail-Adresse – Vorlagen sollten keine persönlichen Daten enthalten", "E-mail address – templates should not ship personal data"],
        phone: ["Telefonnummer – Vorlagen sollten keine persönlichen Daten enthalten", "Phone number – templates should not ship personal data"],
        iban: ["IBAN – Vorlagen sollten keine Bankdaten enthalten", "IBAN – templates should not ship bank details"],
      }[hit.kind];
      f.add("warn", `personal-${hit.kind}`, where, de, en, hit.sample);
    }
    for (const u of findUrls(s.value)) {
      if (u.kind === "dangerous-scheme") f.add("block", "url-dangerous-scheme", where, `Gefährliche Adresse (${u.scheme}:${u.scheme === "data" ? ` ${u.host}` : ""})`, `Dangerous address (${u.scheme}:${u.scheme === "data" ? ` ${u.host}` : ""})`);
      else if (u.kind === "data") f.add("info", "url-data-image", where, "Eingebettetes Bild als data:-Adresse", "Embedded picture as data: address");
      else if (u.kind === "shortener") f.add("warn", "url-shortener", where, "Kurzlink – das eigentliche Ziel ist nicht zu sehen", "Short link – the real target can't be seen", u.host ?? "");
      else if (u.kind === "private") f.add("warn", "url-private", where, "Adresse im internen Netz oder localhost", "Address in a private network or localhost", u.host ?? "");
      else if (u.kind === "ip-literal") f.add("warn", "url-ip-literal", where, "Adresse mit IP statt Namen", "Address with an IP instead of a name", u.host ?? "");
      else if (u.kind === "tracker") f.add("warn", "url-tracker", where, "Bekannter Tracking-Dienst", "Known tracking service", u.host ?? "");
      else if (u.kind === "http") f.add("info", "url-insecure", where, "Unverschlüsselte Adresse (http)", "Unencrypted address (http)", u.host ?? "");
      if (u.host && u.scheme !== "data") opts.hosts?.add(u.host);
    }
    if (BIDI.test(s.value)) f.add("warn", "unicode-bidi", where, "Unsichtbare Steuerzeichen für die Schreibrichtung (Bidi-Override) – Text sieht anders aus, als er ist.", "Invisible bidi control characters – the text looks different from what it is.");
    if (opts.html) checkHtml(s.value, where, f);
  }
}

// Title, summary, tags: what the marketplace shows as the template's name.
function checkManifest(m: Record<string, unknown>, f: Findings) {
  const visible: [string, unknown][] = [
    ["title", m.title],
    ...(m.titles && typeof m.titles === "object" ? Object.entries(m.titles).map(([lang, v]) => [`titles/${lang}`, v] as [string, unknown]) : []),
    ["tags", Array.isArray(m.tags) ? m.tags.join(" ") : ""],
    ["summary", m.summary && typeof m.summary === "object" ? Object.values(m.summary).join(" ") : ""],
  ];
  for (const [field, raw] of visible) {
    if (typeof raw !== "string" || !raw) continue;
    const where = `template.json#/${field}`;
    if (INVISIBLE.test(raw)) f.add("warn", "unicode-invisible", where, "Unsichtbare Zeichen (Zero-Width) im angezeigten Text.", "Invisible (zero-width) characters in the shown text.");
    const mixed = mixedScriptWords(raw);
    const share = confusableShare(raw);
    if ((field === "title" || field.startsWith("titles/")) && (mixed || share > 0.15))
      f.add("warn", "unicode-homoglyph", where, "Titel mischt lateinische mit kyrillischen/griechischen Buchstaben (Verwechslungsgefahr).", "Title mixes Latin with Cyrillic/Greek letters (look-alike characters).");
  }
  // marketplace {id, slug, version, url}: written by the marketplace itself.
  const { marketplace: _own, ...authored } = m;
  void _own;
  checkStrings(authored, "template.json", f, { html: false });
}

// ---- Kinds ----

type Context = { f: Findings; entries: Map<string, Buffer>; manifest: Record<string, unknown>; payload: string; regexLimitMs: number };

const FORMULA_EXTERNAL = /\b(?:WEBSERVICE|IMPORTXML|IMPORTDATA|IMPORTHTML|IMPORTFEED|IMPORTRANGE|IMAGE|FETCH|HTTP|URL|HYPERLINK|FILTERXML|ENCODEURL|CALL|REGISTER|EXEC|SHELL)\s*\(/i;

async function scanTemplateZip(ctx: Context, data: Buffer) {
  const { f } = ctx;
  const zipAt = ctx.payload;
  const inner = readEntries(data, zipAt, f);
  if (!inner) return;
  checkEntries(inner, zipAt, f);
  const byName = new Map(inner.filter((e) => e.data).map((e) => [e.name, e.data!] as [string, Buffer]));
  const raw = byName.get("template.json");
  if (!raw) return f.add("block", "template-missing", `${zipAt}!template.json`, "Die Vorlage enthält kein template.json.", "The template contains no template.json.");
  const t = decodeJson(raw, `${zipAt}!template.json`, f) as { payload?: unknown; files?: unknown; kind?: unknown } | undefined;
  if (!t || typeof t !== "object") return;
  const { payload: content, ...rest } = t;
  checkStrings(rest, `${zipAt}!template.json`, f, { html: true });
  let parsed: unknown;
  if (typeof content === "string") {
    try {
      parsed = JSON.parse(content);
    } catch {
      f.add("warn", "json-invalid", `${zipAt}!template.json#/payload`, "Der Vorlageninhalt ist kein gültiges JSON.", "The template content is not valid JSON.");
    }
  }
  if (parsed) {
    checkStrings(parsed, `${zipAt}!template.json#payload`, f, { html: true });
    // Formulas: Flowplan's formulas have no network functions; spreadsheet
    // functions that fetch from the net point at a template made elsewhere.
    const fields = (parsed as { database?: { fields?: unknown } }).database?.fields;
    if (Array.isArray(fields))
      fields.forEach((field: { type?: unknown; formula?: unknown; expression?: unknown }, i) => {
        const formula = [field?.formula, field?.expression].find((x) => typeof x === "string") as string | undefined;
        if (formula && FORMULA_EXTERNAL.test(formula))
          f.add("warn", "formula-external", `${zipAt}!template.json#payload/database/fields/${i}`, "Formel ruft eine Funktion auf, die Daten aus dem Netz holen würde (Flowplan kennt keine solche Funktion).", "Formula calls a function that would fetch data from the net (Flowplan has no such function).");
      });
  }
  // Attachments: listed in files[], stored as files/<id>.
  const listed = Array.isArray(t.files) ? (t.files as { id?: unknown; name?: unknown; mime?: unknown }[]) : [];
  const listedIds = new Set(listed.map((x) => String(x?.id ?? "")));
  for (const file of listed) {
    const id = String(file?.id ?? "");
    const data = byName.get(`files/${id}`);
    if (!data) continue;
    checkFile(data, String(file?.name ?? id), `${zipAt}!files/${id}`, f, { mime: typeof file?.mime === "string" ? file.mime : undefined });
  }
  for (const [name, data] of byName) {
    if (name === "template.json") continue;
    const id = name.startsWith("files/") ? name.slice(6) : null;
    if (id && listedIds.has(id)) continue;
    f.add("warn", "file-unlisted", `${zipAt}!${name}`, "Datei in der Vorlage, die in keiner Anhangsliste steht.", "File in the template that no list of attachments names.");
    checkFile(data, name, `${zipAt}!${name}`, f);
  }
}

const SECRET_HEADER = /^(authorization|proxy-authorization|x-api-key|api-key|apikey|x-auth-token|x-access-token|cookie|private-token|x-gitlab-token|x-github-token)$/i;
const isTemplated = (s: string) => /\{\{[^}]*\}\}|\$ask:/.test(s);

function scanWorkflow(ctx: Context, data: unknown) {
  const { f } = ctx;
  const at = ctx.payload;
  const root = (data ?? {}) as { graph?: { nodes?: unknown; edges?: unknown }; nodes?: unknown; edges?: unknown };
  const graph = (root.graph && typeof root.graph === "object" ? root.graph : root) as { nodes?: unknown; edges?: unknown };
  const nodes = Array.isArray(graph.nodes) ? (graph.nodes as { id?: unknown; type?: unknown; config?: unknown }[]) : [];
  const edges = Array.isArray(graph.edges) ? (graph.edges as { from?: unknown; to?: unknown; source?: unknown; target?: unknown }[]) : [];
  // An edge end is a node id or {node, port}.
  const end = (x: unknown) => (x && typeof x === "object" ? String((x as { node?: unknown }).node ?? "") : x == null ? "" : String(x));
  const graphPath = root.graph && typeof root.graph === "object" ? "/graph" : "";
  checkStrings(data, at, f, { html: true });
  const hosts = new Map<string, Set<string>>();
  nodes.forEach((node, i) => {
    const type = typeof node?.type === "string" ? node.type.slice(0, 80) : "";
    const where = `${at}#${graphPath}/nodes/${i}`;
    const config = (node?.config && typeof node.config === "object" ? node.config : {}) as Record<string, unknown>;
    if (!KNOWN_NODE_TYPES.has(type))
      f.add("block", "node-unknown", where, "Unbekannter Schritt-Typ – nicht von Flowplan", "Unknown step type – not one of Flowplan's", type || "(leer)");
    if (/delete|remove|trash|purge|destroy|permission|grant|share|member|role|admin/i.test(type))
      f.add("warn", "node-destructive", where, "Schritt löscht Daten oder ändert Berechtigungen", "Step deletes data or changes permissions", type);
    if (type === "http.request") {
      const url = typeof config.url === "string" ? config.url.trim() : "";
      const method = typeof config.method === "string" ? config.method.toUpperCase() : "GET";
      const host = /^[a-z]+:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^/?#:]+)/i.exec(url)?.[1]?.toLowerCase() ?? null;
      if (!host || /[{}$]/.test(host)) f.add("warn", "http-dynamic-host", `${where}/config/url`, "HTTP-Schritt mit veränderlichem Ziel – die Adresse steht erst beim Ausführen fest.", "HTTP step with a variable target – the address is only known when it runs.");
      else {
        const cls = hostClass(host);
        if (cls === "ip-private" || cls === "name-private")
          f.add("block", "http-private-host", `${where}/config/url`, "HTTP-Schritt ruft eine interne Adresse auf (localhost, privates Netz, Metadaten-Dienst)", "HTTP step calls an internal address (localhost, private network, metadata service)", host);
        else if (cls === "ip") f.add("block", "http-ip-host", `${where}/config/url`, "HTTP-Schritt ruft eine IP-Adresse statt eines Namens auf", "HTTP step calls an IP address instead of a name", host);
        if (!hosts.has(host)) hosts.set(host, new Set());
        hosts.get(host)!.add(method);
      }
      if (/^http:\/\//i.test(url)) f.add("warn", "http-insecure", `${where}/config/url`, "HTTP-Schritt ohne Verschlüsselung (http://).", "HTTP step without encryption (http://).");
      if (/^[a-z]+:\/\/[^/@?#\s]+:[^/@?#\s]+@/i.test(url)) f.add("block", "http-credentials", `${where}/config/url`, "Zugangsdaten in der Adresse des HTTP-Schritts.", "Credentials in the HTTP step's address.");
      for (const key of ["headers", "query"])
        if (Array.isArray(config[key]))
          (config[key] as { name?: unknown; value?: unknown }[]).forEach((h, k) => {
            if (typeof h?.name === "string" && SECRET_HEADER.test(h.name) && typeof h.value === "string" && h.value.trim() && !isTemplated(h.value))
              f.add("block", "http-secret-header", `${where}/config/${key}/${k}`, `Fester Wert im Kopf „${h.name}“ – Zugangsdaten gehören in die Zugangsdaten des Workflows`, `Fixed value in the “${h.name}” header – credentials belong in the workflow's credentials`);
          });
    }
    if (type === "notify.email") {
      const to = Array.isArray(config.to) ? config.to : [];
      for (const r of to)
        if (typeof r === "string" && /^[^\s@{}]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(r.trim()) && !isTemplated(r) && !/@(?:example\.(?:com|org|net)|[a-z0-9-]+\.(?:test|invalid))$/i.test(r.trim()))
          f.add("warn", "email-fixed-recipient", `${where}/config/to`, "E-Mail-Schritt schickt an eine feste Adresse außerhalb des Arbeitsbereichs", "E-mail step sends to a fixed address outside the workspace", r.replace(/^(.).*@/, "$1…@"));
    }
    if (type === "trigger.webhook") {
      f.add("info", "webhook-trigger", where, "Startet über einen eingehenden Webhook (öffentlich erreichbar).", "Starts from an incoming webhook (publicly reachable).");
      if (config.mode === "token") f.add("warn", "webhook-unsigned", `${where}/config/mode`, "Webhook nur mit Token statt Signatur.", "Webhook with a token only, no signature.");
    }
    if (type === "trigger.mail.received") {
      f.add("info", "mail-trigger", where, "Startet bei eingehenden E-Mails.", "Starts on incoming e-mail.");
      if (config.senders === "any") f.add("warn", "mail-any-sender", `${where}/config/senders`, "Nimmt E-Mails jedes Absenders an (auch ungeprüfte).", "Accepts e-mail from any sender (also unverified).");
    }
    if (type === "trigger.form.submitted") f.add("info", "form-trigger", where, "Startet, wenn ein Formular abgeschickt wird.", "Starts when a form is submitted.");
    if (type.startsWith("ai.")) {
      f.add("info", "ai-node", where, "KI-Schritt", "AI step", type);
      for (const s of strings(config)) {
        for (const risk of promptRisks(s.value))
          f.add(
            "warn",
            risk,
            `${where}/config${s.path}`,
            risk === "prompt-injection" ? "Anweisung im Prompt, die frühere Anweisungen aushebeln will (Prompt-Injection)." : "Prompt verlangt, Daten nach außen zu geben (Exfiltration).",
            risk === "prompt-injection" ? "Instruction in the prompt that tries to override earlier ones (prompt injection)." : "Prompt asks to send data elsewhere (exfiltration).",
          );
      }
    }
    if (type === "trigger.schedule") {
      const freq = config.freq ?? "daily";
      const extra = ["cron", "minutes", "seconds", "every", "intervalMinutes", "rrule"].find((k) => k in config);
      if (!["daily", "weekly", "monthly"].includes(String(freq)))
        f.add("block", "schedule-invalid", `${where}/config/freq`, `Zeitplan mit Takt, den Flowplan nicht kennt („${String(freq).slice(0, 30)}“) – Flowplan plant höchstens täglich.`, `Schedule with a rhythm Flowplan doesn't know (“${String(freq).slice(0, 30)}”) – Flowplan schedules at most daily.`);
      else if (extra)
        f.add("warn", "schedule-unknown-field", `${where}/config/${extra}`, `Zeitplan-Angabe „${extra}“, die Flowplan nicht kennt – läuft stattdessen ${freq === "daily" ? "täglich" : freq === "weekly" ? "wöchentlich" : "monatlich"}.`, `Schedule setting “${extra}” Flowplan doesn't know – runs ${freq} instead.`);
      else if (freq === "daily" && Number(config.interval ?? 1) === 1) f.add("info", "schedule-daily", where, "Läuft jeden Tag.", "Runs every day.");
    }
    if (type === "logic.foreach") {
      const limit = Number(config.limit ?? 100);
      if (!Number.isFinite(limit) || limit > 1000) f.add("block", "loop-unbounded", `${where}/config/limit`, "Schleife ohne gültige Obergrenze (Flowplan erlaubt höchstens 1000).", "Loop without a valid limit (Flowplan allows at most 1000).");
      else if (limit > 500) f.add("warn", "loop-large", `${where}/config/limit`, `Schleife über bis zu ${limit} Einträge.`, `Loop over up to ${limit} items.`);
    }
    if (type === "action.page.move") f.add("info", "node-moves-pages", where, "Verschiebt Seiten.", "Moves pages.");
  });
  for (const [host, methods] of hosts) f.add("info", "http-host", `${at}#${graphPath}/nodes`, "HTTP-Schritt spricht an", "HTTP step talks to", `${[...methods].join("/")} ${host}`);
  // A loop through the edges (Flowplan runs graphs without cycles; logic.foreach is the loop).
  const next = new Map<string, string[]>();
  for (const e of edges) {
    const from = end(e?.from ?? e?.source);
    const to = end(e?.to ?? e?.target);
    if (!from || !to) continue;
    (next.get(from) ?? next.set(from, []).get(from)!).push(to);
  }
  const state = new Map<string, 1 | 2>();
  let cycle = false;
  const visit = (id: string, depth: number) => {
    if (cycle || depth > 500) return;
    state.set(id, 1);
    for (const n of next.get(id) ?? []) {
      if (state.get(n) === 1) cycle = true;
      else if (!state.has(n)) visit(n, depth + 1);
    }
    state.set(id, 2);
  };
  for (const id of next.keys()) if (!state.has(id)) visit(id, 0);
  if (cycle) f.add("warn", "graph-cycle", `${at}#${graphPath}/edges`, "Die Verbindungen bilden einen Kreis – eine Schleife ohne Obergrenze.", "The connections form a circle – a loop without a limit.");
}

function scanWhiteboard(ctx: Context, data: unknown) {
  const { f } = ctx;
  const at = ctx.payload;
  checkStrings(data, at, f, { html: true });
  const items = Array.isArray(data) ? data : Array.isArray((data as { items?: unknown })?.items) ? (data as { items: unknown[] }).items : [];
  const base = Array.isArray(data) ? "" : "/items";
  items.forEach((raw, i) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const where = `${at}#${base}/${i}`;
    const type = String(item.type ?? item.kind ?? "");
    for (const key of ["src", "image", "imageUrl", "url", "href", "link", "embed"]) {
      const v = item[key] ?? (item.data as Record<string, unknown> | undefined)?.[key];
      if (typeof v !== "string") continue;
      const host = hostOfUrl(v);
      if (!host) continue;
      if (/image|picture|sticker/i.test(type) || key === "src" || key === "image" || key === "imageUrl")
        f.add("warn", "external-image", `${where}/${key}`, "Bild aus dem Netz – wird beim Öffnen geladen (Datenschutz)", "Picture from the net – loaded when opened (privacy)", host);
      else if (/embed|frame|video/i.test(type) || key === "embed") f.add("info", "embed-host", `${where}/${key}`, "Eingebetteter Inhalt von", "Embedded content from", host);
      else f.add("info", "link-host", `${where}/${key}`, "Link nach", "Link to", host);
    }
  });
}

const THEME_KEYS = new Set(["accent", "background", "fonts"]);
const LOOK_KEYS = new Set(["format", "version", "theme", "fonts"]);
const FONT_SLOTS = new Set(["ui", "display", "mono"]);
const BACKGROUNDS = new Set(["standard", "neutral", "cool", "sepia"]);
const CSS_LIKE = /[{};<>]|url\s*\(|expression\s*\(|@import|\/\*|javascript:|\\[0-9a-f]{2}/i;

function scanAppearance(ctx: Context, data: unknown) {
  const { f, entries } = ctx;
  const at = ctx.payload;
  checkStrings(data, at, f);
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const look = data as Record<string, unknown>;
  const wrapped = "theme" in look;
  const theme = (wrapped ? look.theme : look) as Record<string, unknown> | null;
  if (wrapped) for (const k of Object.keys(look)) if (!LOOK_KEYS.has(k)) f.add("warn", "theme-unknown-field", `${at}#/${k}`, "Unbekanntes Feld im Erscheinungsbild (wird nicht übernommen)", "Unknown field in the appearance (not taken over)", k);
  if (!theme || typeof theme !== "object") return f.add("block", "theme-invalid", at, "Erscheinungsbild ohne gültiges Thema.", "Appearance without a valid theme.");
  const tp = wrapped ? "/theme" : "";
  for (const [k, v] of Object.entries(theme)) {
    const where = `${at}#${tp}/${k}`;
    for (const s of strings(v)) if (CSS_LIKE.test(s.value)) f.add("block", "theme-raw-css", `${where}${s.path}`, "Wert sieht aus wie CSS/Markup – das Thema darf nur Farben und Namen enthalten.", "Value looks like CSS/markup – the theme may only hold colours and names.");
    if (!THEME_KEYS.has(k)) {
      f.add(/css|style|html|script/i.test(k) ? "block" : "warn", "theme-unknown-field", where, "Unbekanntes Feld im Thema – Flowplan nimmt nur Akzentfarbe, Hintergrund und Schriften", "Unknown field in the theme – Flowplan only takes accent, background and typefaces", k);
      continue;
    }
    if (k === "accent" && v != null && !(typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v))) f.add("block", "theme-value", where, "Akzentfarbe ist keine Hex-Farbe (#rrggbb).", "Accent colour is not a hex colour (#rrggbb).");
    if (k === "background" && v != null && !(typeof v === "string" && BACKGROUNDS.has(v))) f.add("warn", "theme-value", where, "Unbekannter Hintergrund (Flowplan nimmt den Standard).", "Unknown background (Flowplan uses the standard one).");
    if (k === "fonts" && v && typeof v === "object")
      for (const [slot, ref] of Object.entries(v as Record<string, unknown>)) {
        if (!FONT_SLOTS.has(slot)) f.add("warn", "theme-unknown-field", `${where}/${slot}`, "Unbekannte Schriftrolle", "Unknown typeface slot", slot);
        if (typeof ref !== "string" || !/^(?:[a-z0-9-]{1,60}|custom:[0-9a-f-]{36})$/i.test(ref)) f.add("block", "theme-value", `${where}/${slot}`, "Ungültiger Schriftverweis (nur Name oder custom:<id>).", "Invalid typeface reference (only a name or custom:<id>).");
      }
  }
  // Font files: listed, or every font file under payload/.
  const listed = Array.isArray(look.fonts) ? (look.fonts as { file?: unknown }[]).map((x) => String(x?.file ?? "")) : [];
  const files = new Set([...listed.filter((x) => x.startsWith("payload/")), ...[...entries.keys()].filter((n) => n.startsWith("payload/") && /\.(woff2?|ttf|otf)$/i.test(n))]);
  for (const name of files) {
    const bytes = entries.get(name);
    if (!bytes) {
      f.add("warn", "font-missing", name, "Schrift steht in der Liste, fehlt aber im Paket.", "Typeface is listed but missing from the package.");
      continue;
    }
    if (bytes.length > SCAN_LIMITS.fontBytes) f.add("block", "font-too-large", name, "Schriftdatei größer als 5 MB.", "Font file larger than 5 MB.");
    const report = inspectFont(bytes);
    const kind = sniffFile(bytes);
    if (!report.ok)
      f.add("block", "font-invalid", name, `Schriftdatei ist beschädigt oder keine Schrift (${report.problems.slice(0, 3).join(", ")}).`, `Font file is damaged or not a font (${report.problems.slice(0, 3).join(", ")}).`);
    const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
    if (report.ok && ext && ext !== kind && !(ext === "ttf" && kind === "otf") && !(ext === "otf" && kind === "ttf")) f.add("warn", "font-extension", name, `Dateiendung .${ext} passt nicht zum Inhalt (${kind}).`, `File extension .${ext} does not match the content (${kind}).`);
    if (report.svgScript) f.add("block", "font-svg-script", name, "Die SVG-Glyphen der Schrift enthalten ein Skript.", "The font's SVG glyphs contain a script.");
    else if (report.svgGlyphs) f.add("info", "font-svg-glyphs", name, "Schrift mit SVG-Glyphen (Farbschrift).", "Font with SVG glyphs (colour font).");
    if (report.variable) f.add("info", "font-variable", name, "Variable Schrift (fvar).", "Variable font (fvar).");
    if (kind === "woff2") f.add("info", "font-woff2", name, "WOFF2: nur Kopf und Größe geprüft (Tabellen sind komprimiert).", "WOFF2: only the header and size are checked (tables are compressed).");
  }
}

async function scanLinkRules(ctx: Context, data: unknown) {
  const { f } = ctx;
  const at = ctx.payload;
  checkStrings(data, at, f);
  const rules = Array.isArray(data) ? data : Array.isArray((data as { rules?: unknown })?.rules) ? (data as { rules: unknown[] }).rules : [];
  const base = Array.isArray(data) ? "" : "/rules";
  const patterns: { i: number; pattern: string }[] = [];
  rules.slice(0, 50).forEach((raw, i) => {
    const rule = (raw ?? {}) as { pattern?: unknown; template?: unknown };
    const where = `${at}#${base}/${i}`;
    if (typeof rule.pattern === "string" && rule.pattern.length <= 200) patterns.push({ i, pattern: rule.pattern });
    else f.add("block", "rule-pattern-missing", `${where}/pattern`, "Linkregel ohne gültiges Muster (höchstens 200 Zeichen).", "Link rule without a valid pattern (at most 200 characters).");
    const template = typeof rule.template === "string" ? rule.template.trim() : "";
    const squeezed = template.replace(/[\u0000- ]+/g, "").toLowerCase();
    if (/^(?:javascript|vbscript|data|file|blob):/.test(squeezed)) f.add("block", "rule-template-scheme", `${where}/template`, "Linkziel mit gefährlichem Schema (javascript:, data:, file: …).", "Link target with a dangerous scheme (javascript:, data:, file: …).");
    else if (/^http:\/\//.test(squeezed)) f.add("warn", "rule-template-insecure", `${where}/template`, "Linkziel unverschlüsselt (http://) – bitte https.", "Link target unencrypted (http://) – please use https.");
    else if (/^mailto:/.test(squeezed)) f.add("info", "rule-template-mailto", `${where}/template`, "Linkziel ist eine E-Mail-Adresse (mailto:).", "Link target is an e-mail address (mailto:).");
    else if (!/^https:\/\/[^\s/]/.test(squeezed)) f.add("warn", "rule-template-scheme", `${where}/template`, "Linkziel ist keine https-Adresse.", "Link target is not an https address.");
    const host = /^https?:\/\/([^/?#:{}$\s]+)/i.exec(template)?.[1]?.toLowerCase();
    if (host) {
      const cls = hostClass(host);
      if (cls !== "name") f.add("warn", "rule-template-host", `${where}/template`, "Linkziel zeigt auf eine IP oder ein internes Netz", "Link target points at an IP or a private network", host);
      else f.add("info", "rule-target-host", at, "Linkregeln führen zu", "Link rules lead to", host);
    }
  });
  const results = await checkPatterns(patterns.map((p) => p.pattern), ctx.regexLimitMs);
  const texts: Record<RegexFlag["code"], [string, string]> = {
    "regex-invalid": ["Muster lässt sich nicht übersetzen.", "Pattern does not compile."],
    "regex-nested-quantifier": ["Verschachtelte Wiederholung („(a+)+“) – katastrophales Backtracking möglich (ReDoS).", "Nested repetition (“(a+)+”) – catastrophic backtracking possible (ReDoS)."],
    "regex-overlapping-alternation": ["Wiederholte Alternativen, die sich überschneiden („(a|ab)*“) – kann sehr langsam werden.", "Repeated alternatives that overlap (“(a|ab)*”) – can get very slow."],
    "regex-adjacent-quantifiers": ["Zwei offene Wiederholungen über dieselben Zeichen hintereinander („\\d+\\d+“).", "Two open repetitions over the same characters in a row (“\\d+\\d+”)."],
    "regex-timeout": ["Muster braucht bei ungünstiger Eingabe zu lange (Zeitlimit im Test überschritten) – ReDoS.", "Pattern takes too long on adversarial input (time limit of the test exceeded) – ReDoS."],
    "regex-slow": ["Muster ist bei ungünstiger Eingabe langsam.", "Pattern is slow on adversarial input."],
    "regex-empty-match": ["Muster passt auf leeren Text – würde überall Links setzen.", "Pattern matches empty text – would put links everywhere."],
    "regex-catch-all": ["Muster passt auf fast jedes Wort – würde alles verlinken.", "Pattern matches almost every word – would linkify everything."],
    "regex-broad": ["Muster passt auf viele gewöhnliche Wörter.", "Pattern matches many ordinary words."],
  };
  results.forEach((flags, k) => {
    const { i, pattern } = patterns[k];
    for (const flag of flags) {
      const [de, en] = texts[flag.code];
      const extra = "ms" in flag ? ` (${flag.ms} ms)` : "share" in flag ? ` (${Math.round(flag.share * 100)} %)` : "";
      f.add(flag.severity, flag.code, `${at}#${base}/${i}/pattern`, `${de}${extra}`, `${en}${extra}`, pattern.slice(0, 40));
    }
  });
}

// ---- The scan ----

export function verdictOf(findings: { severity: SecuritySeverity }[]): Verdict {
  if (findings.some((x) => x.severity === "block")) return "block";
  if (findings.some((x) => x.severity === "warn")) return "review";
  return "clean";
}

export async function scanPackage(input: Uint8Array, options: { regexLimitMs?: number; now?: number } = {}): Promise<SecurityReport> {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const f = new Findings();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let kind: string | null = null;
  const done = (): SecurityReport => {
    const findings = f.list();
    const verdict = verdictOf(findings);
    return {
      verdict,
      label: VERDICT_LABELS[verdict],
      counts: { block: findings.filter((x) => x.severity === "block").length, warn: findings.filter((x) => x.severity === "warn").length, info: findings.filter((x) => x.severity === "info").length },
      findings,
      scannedAt: new Date(options.now ?? Date.now()).toISOString(),
      scannerVersion: SCANNER_VERSION,
      sha256,
      kind,
    };
  };
  if (bytes.length > 25 * 1024 * 1024) {
    f.add("block", "package-too-large", "package", "Das Paket ist größer als 25 MB.", "The package is larger than 25 MB.");
    return done();
  }
  const raw = readEntries(bytes, "package", f);
  if (!raw) return done();
  checkEntries(raw, "", f);
  const entries = new Map<string, Buffer>();
  for (const e of raw) if (e.data && !entries.has(e.name)) entries.set(e.name, e.data);
  const manifestBytes = entries.get("template.json");
  if (!manifestBytes) {
    f.add("block", "manifest-missing", "template.json", "template.json fehlt.", "template.json is missing.");
    return done();
  }
  const manifest = decodeJson(manifestBytes, "template.json", f);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return done();
  const m = manifest as Record<string, unknown>;
  kind = typeof m.kind === "string" ? m.kind : null;
  const payload = typeof m.payload === "string" ? m.payload : "";
  checkManifest(m, f);
  const ctx: Context = { f, entries, manifest: m, payload, regexLimitMs: options.regexLimitMs ?? 250 };

  // Every other entry: where it is and what it is.
  const expectedArchive = (name: string) => name === payload && (kind === "document" || kind === "database" || (kind === "appearance" && /\.zip$/i.test(name)));
  for (const [name, data] of entries) {
    if (name === "template.json") continue;
    if (/^preview\/[1-9]\.(?:webp|png|jpe?g)$/i.test(name)) {
      checkFile(data, name, name, f, { expected: ["webp", "png", "jpeg"] });
      continue;
    }
    if (!name.startsWith("payload/")) {
      f.add("warn", "entry-unexpected", name, "Datei außerhalb von payload/ und preview/ (wird nicht übernommen).", "File outside payload/ and preview/ (left out).");
      checkFile(data, name, name, f);
      continue;
    }
    if (/\.json$/i.test(name) && name !== payload) {
      const json = decodeJson(data, name, f);
      if (json !== undefined) checkStrings(json, name, f);
      continue;
    }
    if (name === payload && !expectedArchive(name)) continue;
    const expected =
      kind === "appearance" ? ["woff", "woff2", "ttf", "otf", "json", "zip"] : kind === "document" || kind === "database" ? ["zip"] : ["json", "text"];
    checkFile(data, name, name, f, { archiveOk: expectedArchive(name), expected });
  }
  const payloadBytes = entries.get(payload);
  if (!payloadBytes) {
    f.add("block", "payload-missing", "template.json#/payload", "Der Inhalt fehlt im Paket.", "The payload is missing from the package.");
    return done();
  }
  switch (kind) {
    case "document":
    case "database":
      await scanTemplateZip(ctx, payloadBytes);
      break;
    case "workflow": {
      const data = decodeJson(payloadBytes, payload, f);
      if (data !== undefined) scanWorkflow(ctx, data);
      break;
    }
    case "whiteboard": {
      const data = decodeJson(payloadBytes, payload, f);
      if (data !== undefined) scanWhiteboard(ctx, data);
      break;
    }
    case "appearance": {
      if (/\.zip$/i.test(payload)) {
        f.add("info", "theme-archive", payload, "Erscheinungsbild als ZIP – Inhalt einzeln geprüft.", "Appearance as a ZIP – its content checked one by one.");
        const inner = readEntries(payloadBytes, payload, f);
        if (inner) {
          checkEntries(inner, payload, f);
          for (const e of inner) if (e.data) entries.set(`payload/${e.name}`, e.data);
          const theme = inner.find((e) => /(^|\/)theme\.json$/.test(e.name) && e.data);
          if (theme?.data) {
            const data = decodeJson(theme.data, `${payload}!${theme.name}`, f);
            if (data !== undefined) scanAppearance({ ...ctx, payload: `${payload}!${theme.name}` }, data);
          }
        }
      } else {
        const data = decodeJson(payloadBytes, payload, f);
        if (data !== undefined) scanAppearance(ctx, data);
      }
      break;
    }
    case "link-rules": {
      const data = decodeJson(payloadBytes, payload, f);
      if (data !== undefined) await scanLinkRules(ctx, data);
      break;
    }
    default:
      f.add("block", "kind-unknown", "template.json#/kind", "Unbekannte Vorlagenart.", "Unknown kind of template.");
  }
  return done();
}
