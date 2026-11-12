// What a file in a package really is, from its bytes – for the security
// scan (lib/security-scan.ts): executables, archives, Office files with
// macros, SVG with scripts, PDF with actions, fonts with broken tables,
// tracking pixels. Signature checks only; nothing is run or rendered.
import { inflateSync } from "node:zlib";

export type FileKind =
  | "png"
  | "jpeg"
  | "gif"
  | "webp"
  | "svg"
  | "pdf"
  | "zip"
  | "gzip"
  | "7z"
  | "rar"
  | "tar"
  | "bzip2"
  | "xz"
  | "cab"
  | "ole"
  | "pe"
  | "elf"
  | "macho"
  | "script"
  | "html"
  | "woff"
  | "woff2"
  | "ttf"
  | "otf"
  | "json"
  | "text"
  | "unknown";

const startsWith = (b: Buffer, ...bytes: number[]) => b.length >= bytes.length && bytes.every((x, i) => b[i] === x);

export function sniffFile(b: Buffer): FileKind {
  if (startsWith(b, 0x89, 0x50, 0x4e, 0x47)) return "png";
  if (startsWith(b, 0xff, 0xd8, 0xff)) return "jpeg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) return "gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (startsWith(b, 0x25, 0x50, 0x44, 0x46)) return "pdf";
  if (startsWith(b, 0x50, 0x4b, 0x03, 0x04) || startsWith(b, 0x50, 0x4b, 0x05, 0x06)) return "zip";
  if (startsWith(b, 0x1f, 0x8b)) return "gzip";
  if (startsWith(b, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return "7z";
  if (startsWith(b, 0x52, 0x61, 0x72, 0x21, 0x1a, 0x07)) return "rar";
  if (startsWith(b, 0x42, 0x5a, 0x68)) return "bzip2";
  if (startsWith(b, 0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return "xz";
  if (startsWith(b, 0x4d, 0x53, 0x43, 0x46)) return "cab";
  if (b.length > 262 && b.subarray(257, 262).toString("latin1") === "ustar") return "tar";
  if (startsWith(b, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return "ole";
  if (startsWith(b, 0x4d, 0x5a)) return "pe";
  if (startsWith(b, 0x7f, 0x45, 0x4c, 0x46)) return "elf";
  if (startsWith(b, 0xfe, 0xed, 0xfa, 0xce) || startsWith(b, 0xfe, 0xed, 0xfa, 0xcf) || startsWith(b, 0xcf, 0xfa, 0xed, 0xfe) || startsWith(b, 0xce, 0xfa, 0xed, 0xfe) || startsWith(b, 0xca, 0xfe, 0xba, 0xbe))
    return "macho";
  const tag = b.subarray(0, 4).toString("latin1");
  if (tag === "wOFF") return "woff";
  if (tag === "wOF2") return "woff2";
  if (tag === "OTTO") return "otf";
  if (startsWith(b, 0, 1, 0, 0) || tag === "true") return "ttf";
  if (startsWith(b, 0x23, 0x21)) return "script";
  const head = b.subarray(0, 1024).toString("utf8").replace(/^﻿/, "").trimStart().toLowerCase();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!doctype svg[^>]*>\s*)?<svg[\s>]/.test(head)) return "svg";
  if (/^<!doctype html|^<html[\s>]|^<head[\s>]|^<script[\s>]/.test(head)) return "html";
  if (/^[{[]/.test(head)) return "json";
  // Mostly printable: text.
  const sample = b.subarray(0, 512);
  let printable = 0;
  for (const c of sample) if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 128) printable++;
  return sample.length && printable / sample.length > 0.95 ? "text" : "unknown";
}

export const ARCHIVES = new Set<FileKind>(["zip", "gzip", "7z", "rar", "tar", "bzip2", "xz", "cab"]);
export const EXECUTABLES = new Set<FileKind>(["pe", "elf", "macho", "script"]);
// File names that run on a double click, whatever the bytes say.
export const EXECUTABLE_NAME = /\.(?:exe|dll|com|scr|pif|msi|msp|bat|cmd|ps1|psm1|vbs|vbe|jse?|wsf|wsh|hta|cpl|jar|apk|app|dmg|pkg|deb|rpm|sh|bash|zsh|command|run|bin|elf|so|dylib|lnk|reg|inf|iso|img|vhdx?|appx|msix|xpi|crx)$/i;
// Office formats with macros (by name) and the macro part of OOXML.
export const MACRO_NAME = /\.(?:docm|dotm|xlsm|xltm|xlam|xlsb|pptm|potm|ppam|ppsm|sldm)$/i;
export const LEGACY_OFFICE_NAME = /\.(?:doc|dot|xls|xlt|xla|ppt|pot|pps|mdb|accdb)$/i;

// Central directory names of a ZIP without inflating anything (for OOXML:
// does it carry vbaProject.bin?).
export function zipNames(b: Buffer, max = 2000): string[] | null {
  const from = Math.max(0, b.length - 65557);
  let eocd = -1;
  for (let i = b.length - 22; i >= from; i--)
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) return null;
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < Math.min(count, max); i++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) return names;
    const n = b.readUInt16LE(p + 28);
    const extra = b.readUInt16LE(p + 30);
    const comment = b.readUInt16LE(p + 32);
    names.push(b.subarray(p + 46, p + 46 + n).toString("utf8"));
    p += 46 + n + extra + comment;
  }
  return names;
}

export type FileRisk = { code: string; severity: "block" | "warn" | "info"; de: string; en: string };

// SVG: scripts, foreignObject (HTML inside), event handlers, external
// references (load from the net when shown), entity tricks.
export function svgRisks(text: string): FileRisk[] {
  const out: FileRisk[] = [];
  const t = text.slice(0, 2_000_000);
  if (/<script[\s>/]/i.test(t)) out.push({ code: "svg-script", severity: "block", de: "SVG enthält ein Skript.", en: "SVG contains a script." });
  if (/<foreignObject[\s>/]/i.test(t)) out.push({ code: "svg-foreign-object", severity: "block", de: "SVG enthält foreignObject (eingebettetes HTML).", en: "SVG contains foreignObject (embedded HTML)." });
  if (/\son[a-z]{3,30}\s*=/i.test(t)) out.push({ code: "svg-event-handler", severity: "block", de: "SVG enthält Event-Handler (on…=).", en: "SVG contains event handlers (on…=)." });
  if (/(?:href|src)\s*=\s*["']\s*(?:javascript|data:text\/html)/i.test(t)) out.push({ code: "svg-script-link", severity: "block", de: "SVG enthält einen javascript:-Link.", en: "SVG contains a javascript: link." });
  if (/(?:xlink:)?href\s*=\s*["']\s*(?:https?:)?\/\//i.test(t) || /url\(\s*["']?\s*(?:https?:)?\/\//i.test(t) || /@import/i.test(t))
    out.push({ code: "svg-external", severity: "warn", de: "SVG lädt Inhalte aus dem Netz (externe Referenz).", en: "SVG loads content from the net (external reference)." });
  if (/<!ENTITY/i.test(t)) out.push({ code: "svg-entity", severity: "block", de: "SVG definiert XML-Entities (XXE/Billion Laughs).", en: "SVG defines XML entities (XXE/billion laughs)." });
  return out;
}

// PDF: JavaScript, launch actions, embedded files, forms that submit –
// by the names in the file (also hex-escaped: /J#61vaScript).
export function pdfRisks(b: Buffer): FileRisk[] {
  const out: FileRisk[] = [];
  const t = b.subarray(0, 30 * 1024 * 1024).toString("latin1").replace(/#([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  if (/\/(?:JavaScript|JS)\b/.test(t)) out.push({ code: "pdf-javascript", severity: "block", de: "PDF enthält JavaScript.", en: "PDF contains JavaScript." });
  if (/\/Launch\b/.test(t)) out.push({ code: "pdf-launch", severity: "block", de: "PDF startet Programme (/Launch).", en: "PDF launches programs (/Launch)." });
  if (/\/EmbeddedFiles?\b/.test(t)) out.push({ code: "pdf-embedded-file", severity: "warn", de: "PDF enthält eingebettete Dateien.", en: "PDF contains embedded files." });
  if (/\/(?:RichMedia|XFA)\b/.test(t)) out.push({ code: "pdf-rich-media", severity: "warn", de: "PDF enthält RichMedia oder XFA-Formulare.", en: "PDF contains RichMedia or XFA forms." });
  if (/\/SubmitForm\b/.test(t)) out.push({ code: "pdf-submit-form", severity: "warn", de: "PDF-Formular sendet Daten an eine Adresse.", en: "PDF form submits data to an address." });
  if (/\/OpenAction\b|\/AA\b/.test(t) && !out.some((x) => x.severity === "block"))
    out.push({ code: "pdf-auto-action", severity: "info", de: "PDF führt beim Öffnen eine Aktion aus.", en: "PDF runs an action when opened." });
  return out;
}

// Width and height of an image from its header (PNG, GIF, JPEG, WebP).
export function imageSize(b: Buffer): { w: number; h: number } | null {
  const kind = sniffFile(b);
  try {
    if (kind === "png" && b.length >= 24) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (kind === "gif" && b.length >= 10) return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (kind === "webp" && b.length >= 30) {
      const chunk = b.subarray(12, 16).toString("latin1");
      if (chunk === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
      if (chunk === "VP8 " && b.length >= 30) return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (chunk === "VP8L" && b.length >= 25) {
        const v = b.readUInt32LE(21);
        return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 };
      }
    }
    if (kind === "jpeg") {
      let p = 2;
      while (p + 9 < b.length && b[p] === 0xff) {
        const marker = b[p + 1];
        const len = b.readUInt16BE(p + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { h: b.readUInt16BE(p + 5), w: b.readUInt16BE(p + 7) };
        p += 2 + len;
      }
    }
  } catch {}
  return null;
}

// ---- Fonts ----

export type FontReport = { ok: boolean; problems: string[]; tables: string[]; variable: boolean; svgScript: boolean; svgGlyphs: boolean };

// The table directory of a TrueType/OpenType font (or a WOFF wrapper):
// every table inside the file, tags printable, a sane number of tables.
// The SVG table (colour glyphs) is searched for scripts. WOFF2 tables are
// Brotli-compressed with a transformed directory: only its header is checked.
export function inspectFont(b: Buffer): FontReport {
  const report: FontReport = { ok: true, problems: [], tables: [], variable: false, svgScript: false, svgGlyphs: false };
  const bad = (p: string) => {
    report.ok = false;
    report.problems.push(p);
  };
  const kind = sniffFile(b);
  const printable = (tag: string) => /^[\x20-\x7e]{4}$/.test(tag);
  try {
    if (kind === "ttf" || kind === "otf") {
      if (b.length < 12) return bad("too-short"), report;
      const n = b.readUInt16BE(4);
      if (!n || n > 100) bad("table-count");
      if (12 + n * 16 > b.length) return bad("directory-truncated"), report;
      for (let i = 0; i < Math.min(n, 100); i++) {
        const p = 12 + i * 16;
        const tag = b.subarray(p, p + 4).toString("latin1");
        const offset = b.readUInt32BE(p + 8);
        const length = b.readUInt32BE(p + 12);
        if (!printable(tag)) bad("table-tag");
        if (offset + length > b.length) bad(`table-outside:${tag.trim()}`);
        report.tables.push(tag);
        if (tag === "SVG " && offset + length <= b.length) {
          report.svgGlyphs = true;
          if (/<script|\son[a-z]+\s*=|javascript:/i.test(b.subarray(offset, offset + length).toString("latin1"))) report.svgScript = true;
        }
      }
    } else if (kind === "woff") {
      if (b.length < 44) return bad("too-short"), report;
      if (b.readUInt32BE(8) !== b.length) bad("length-mismatch");
      const n = b.readUInt16BE(12);
      if (!n || n > 100) bad("table-count");
      if (44 + n * 20 > b.length) return bad("directory-truncated"), report;
      for (let i = 0; i < Math.min(n, 100); i++) {
        const p = 44 + i * 20;
        const tag = b.subarray(p, p + 4).toString("latin1");
        const offset = b.readUInt32BE(p + 4);
        const compLength = b.readUInt32BE(p + 8);
        const origLength = b.readUInt32BE(p + 12);
        if (!printable(tag)) bad("table-tag");
        if (offset + compLength > b.length) bad(`table-outside:${tag.trim()}`);
        if (origLength > 64 * 1024 * 1024 || (compLength && origLength / compLength > 200)) bad(`table-ratio:${tag.trim()}`);
        report.tables.push(tag);
        if (tag === "SVG " && offset + compLength <= b.length) {
          report.svgGlyphs = true;
          const raw = b.subarray(offset, offset + compLength);
          let data: Buffer = raw;
          if (compLength < origLength) {
            try {
              data = inflateSync(raw, { maxOutputLength: Math.min(origLength, 16 * 1024 * 1024) });
            } catch {
              bad("table-inflate:SVG");
            }
          }
          if (/<script|\son[a-z]+\s*=|javascript:/i.test(data.toString("latin1"))) report.svgScript = true;
        }
      }
    } else if (kind === "woff2") {
      if (b.length < 48) return bad("too-short"), report;
      if (b.readUInt32BE(8) !== b.length) bad("length-mismatch");
      const n = b.readUInt16BE(12);
      if (!n || n > 100) bad("table-count");
      const total = b.readUInt32BE(16);
      if (total > 64 * 1024 * 1024) bad("total-size");
    } else bad("not-a-font");
  } catch {
    bad("unreadable");
  }
  report.variable = report.tables.includes("fvar");
  return report;
}
