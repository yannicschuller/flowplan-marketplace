// Is a link rule's pattern safe to run in everybody's editor? (security
// scan, lib/security-scan.ts). Three looks:
//
//   1. A ReDoS heuristic on the pattern's text: a repeated group with an
//      unbounded quantifier inside ("(a+)+", "(\d*)*" – Flowplan refuses
//      these too, lib/auto-link.ts hasNestedQuantifier), a repeated group of
//      alternatives that overlap ("(a|ab)*", "(\w|\d)+", "(.|\s)*") and
//      adjacent unbounded quantifiers over the same characters ("\d+\d+").
//   2. A timed test in a worker thread: the pattern against adversarial
//      inputs (runs of the characters it matches followed by one that ends
//      the match) with a hard time limit – the worker is terminated, so a
//      catastrophic pattern never blocks the server.
//   3. Catch-alls: a pattern that matches the empty string or most ordinary
//      words would turn every text into links.
import { Worker } from "node:worker_threads";

export type RegexFlag =
  | { code: "regex-invalid"; severity: "block" }
  | { code: "regex-nested-quantifier"; severity: "block" }
  | { code: "regex-overlapping-alternation"; severity: "warn" }
  | { code: "regex-adjacent-quantifiers"; severity: "info" }
  | { code: "regex-timeout"; severity: "block"; ms: number }
  | { code: "regex-slow"; severity: "warn"; ms: number }
  | { code: "regex-empty-match"; severity: "block" }
  | { code: "regex-catch-all"; severity: "block"; share: number }
  | { code: "regex-broad"; severity: "warn"; share: number };

export function compile(pattern: string): RegExp | null {
  for (const flags of ["gu", "g"])
    try {
      return new RegExp(pattern, flags);
    } catch {}
  return null;
}

type Token = { text: string; group?: Token[][]; quant: string };

// A small tokenizer: atoms (escapes, classes, single characters, groups
// with their alternatives) and the quantifier after each.
function tokenize(p: string, start = 0, depth = 0): { alts: Token[][]; end: number } {
  const alts: Token[][] = [[]];
  let i = start;
  const quant = () => {
    const m = /^(?:[*+?]|\{\d+(?:,\d*)?\})[?+]?/.exec(p.slice(i));
    if (!m) return "";
    i += m[0].length;
    return m[0];
  };
  while (i < p.length) {
    const c = p[i];
    if (c === ")" && depth > 0) return { alts, end: i };
    if (c === "|") {
      alts.push([]);
      i++;
      continue;
    }
    let text = c;
    let group: Token[][] | undefined;
    if (c === "\\") {
      text = p.slice(i, i + 2);
      i += 2;
    } else if (c === "[") {
      let j = i + 1;
      if (p[j] === "^") j++;
      if (p[j] === "]") j++;
      for (; j < p.length && p[j] !== "]"; j++) if (p[j] === "\\") j++;
      text = p.slice(i, j + 1);
      i = j + 1;
    } else if (c === "(") {
      let j = i + 1;
      const prefix = /^\?(?::|=|!|<=|<!|<[A-Za-z_][A-Za-z0-9_]*>)?/.exec(p.slice(j));
      if (prefix) j += prefix[0].length;
      const inner = tokenize(p, j, depth + 1);
      group = inner.alts;
      text = p.slice(i, inner.end + 1);
      i = inner.end + 1;
    } else i++;
    alts[alts.length - 1].push({ text, group, quant: quant() });
  }
  return { alts, end: i };
}

const unbounded = (q: string) => /^[*+]|^\{\d+,\}/.test(q);
const repeated = (q: string) => unbounded(q) || /^\{\d+,\d+\}/.test(q);

// Characters an atom may match, as a coarse set of classes.
function classesOf(atom: string): Set<string> {
  const s = new Set<string>();
  const add = (...c: string[]) => c.forEach((x) => s.add(x));
  if (atom === "." || atom === "\\S" || atom === "\\W" || atom === "\\D") add("letter", "digit", "space", "punct");
  else if (atom === "\\w") add("letter", "digit");
  else if (atom === "\\d") add("digit");
  else if (atom === "\\s") add("space");
  else if (atom.startsWith("[")) {
    const body = atom.slice(1, -1);
    if (body.startsWith("^")) add("letter", "digit", "space", "punct");
    if (/[a-zA-Z]|\\w|\\p\{L/.test(body)) add("letter");
    if (/\d|\\d|\\w/.test(body)) add("digit");
    if (/ |\\s/.test(body)) add("space");
    if (/[^a-zA-Z0-9\s\\]/.test(body.replace(/-/g, ""))) add("punct");
  } else if (/^\\p\{/i.test(atom)) add("letter");
  else if (/^[a-zA-Z]$/.test(atom)) add(`char:${atom}`, "letter");
  else if (/^\d$/.test(atom)) add(`char:${atom}`, "digit");
  else if (atom === " ") add("space");
  else add(`char:${atom}`, "punct");
  return s;
}
const overlap = (a: Set<string>, b: Set<string>) => {
  for (const x of a) {
    if (b.has(x)) {
      // Two different single characters of the same class do not overlap.
      if ((x === "letter" || x === "digit" || x === "punct") && [...a].some((y) => y.startsWith("char:")) && [...b].some((y) => y.startsWith("char:"))) continue;
      return true;
    }
  }
  return false;
};
const firstOf = (alt: Token[]): Set<string> => (alt[0] ? (alt[0].group ? new Set(alt[0].group.flatMap((g) => [...firstOf(g)])) : classesOf(alt[0].text)) : new Set<string>());

// The structural ReDoS heuristic.
export function regexHeuristics(pattern: string): RegexFlag[] {
  const flags: RegexFlag[] = [];
  const { alts } = tokenize(pattern);
  let nested = false;
  let overlapping = false;
  let adjacent = false;
  const hasUnbounded = (ts: Token[][]): boolean => ts.some((alt) => alt.some((t) => unbounded(t.quant) || (t.group ? hasUnbounded(t.group) : false)));
  const walk = (ts: Token[][]) => {
    for (const alt of ts) {
      alt.forEach((t, i) => {
        if (t.group) {
          if (repeated(t.quant) && hasUnbounded(t.group)) nested = true;
          if (repeated(t.quant) && t.group.length > 1) {
            const firsts = t.group.map(firstOf);
            for (let a = 0; a < firsts.length; a++) for (let b = a + 1; b < firsts.length; b++) if (overlap(firsts[a], firsts[b])) overlapping = true;
          }
          walk(t.group);
        }
        const next = alt[i + 1];
        if (next && unbounded(t.quant) && unbounded(next.quant) && !t.group && !next.group && overlap(classesOf(t.text), classesOf(next.text))) adjacent = true;
      });
    }
  };
  walk(alts);
  if (nested) flags.push({ code: "regex-nested-quantifier", severity: "block" });
  if (overlapping) flags.push({ code: "regex-overlapping-alternation", severity: "warn" });
  if (adjacent) flags.push({ code: "regex-adjacent-quantifiers", severity: "info" });
  return flags;
}

// Inputs that make backtracking patterns slow: long runs of what the
// pattern matches, then something that makes the match fail at the end.
export function adversarialInputs(pattern: string): string[] {
  const chars = new Set<string>(["a", "1", " ", "-", "_", "."]);
  for (const m of pattern.matchAll(/\\([dws])|([A-Za-z0-9])|\\(.)/g)) {
    if (m[1] === "d") chars.add("7");
    else if (m[1] === "w") chars.add("x");
    else if (m[1] === "s") chars.add("\t");
    else if (m[2]) chars.add(m[2]);
    else if (m[3]) chars.add(m[3]);
    if (chars.size > 16) break;
  }
  const out: string[] = [];
  const enders = ["!", "\u0000", "\n"];
  for (const c of chars)
    for (const n of [28, 2500]) {
      out.push(c.repeat(n) + enders[out.length % enders.length]);
    }
  out.push("ab".repeat(1500) + "!", "a1".repeat(1500) + "!", "a ".repeat(1500) + "!", "ABC-".repeat(800) + "!");
  return out;
}

const WORKER = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", ({ i, pattern, inputs }) => {
  let re;
  try { re = new RegExp(pattern, "gu"); } catch { try { re = new RegExp(pattern, "g"); } catch { parentPort.postMessage({ i, ms: 0 }); return; } }
  const start = performance.now();
  for (const s of inputs) {
    re.lastIndex = 0;
    let n = 0;
    // The way the editors run it: every match of a text (bounded).
    while (re.exec(s) && n++ < 200) if (re.lastIndex === 0) break; else if (!re.global) break;
  }
  parentPort.postMessage({ i, ms: performance.now() - start });
});
`;

// Each pattern against its adversarial inputs in a worker; a pattern that
// takes longer than `limitMs` gets the worker terminated (and a fresh one
// for the rest). Answers the time per pattern, Infinity for a timeout.
export async function timedRegexTest(patterns: string[], limitMs = 250): Promise<number[]> {
  const times: number[] = new Array(patterns.length).fill(0);
  let next = 0;
  while (next < patterns.length) {
    const worker = new Worker(WORKER, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 } });
    worker.unref();
    try {
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | null = null;
        const send = () => {
          if (next >= patterns.length) return void resolve();
          const i = next;
          worker.postMessage({ i, pattern: patterns[i], inputs: adversarialInputs(patterns[i]) });
          timer = setTimeout(() => {
            times[i] = Infinity;
            next = i + 1;
            resolve();
          }, limitMs);
        };
        worker.on("message", ({ i, ms }: { i: number; ms: number }) => {
          if (timer) clearTimeout(timer);
          times[i] = ms;
          next = i + 1;
          send();
        });
        worker.on("error", () => {
          if (timer) clearTimeout(timer);
          times[next] = Infinity;
          next++;
          resolve();
        });
        send();
      });
    } finally {
      await worker.terminate();
    }
  }
  return times;
}

// Ordinary text a link rule should leave alone.
const CORPUS = ["Hallo", "Welt", "the", "and", "Projekt", "meeting", "notes", "a", "x", "Ich", "bin", "heute", "2026", "12", "Mai", "Kunde", "report", "Budget", "ok", "e-mail", "Seite", "done", "Plan", "Q3", "team"];

export function catchAll(re: RegExp): RegexFlag | null {
  for (const sample of ["", " ", "a"]) {
    re.lastIndex = 0;
    const m = re.exec(sample);
    if (m && m[0] === "") return { code: "regex-empty-match", severity: "block" };
  }
  let hit = 0;
  for (const w of CORPUS) {
    re.lastIndex = 0;
    if (re.test(w)) hit++;
  }
  const share = hit / CORPUS.length;
  if (share >= 0.6) return { code: "regex-catch-all", severity: "block", share };
  if (share >= 0.3) return { code: "regex-broad", severity: "warn", share };
  return null;
}

// Everything about a list of patterns.
export async function checkPatterns(patterns: string[], limitMs = 250): Promise<RegexFlag[][]> {
  const flags: RegexFlag[][] = patterns.map(() => []);
  const runnable: number[] = [];
  patterns.forEach((p, i) => {
    const re = compile(p);
    if (!re) return flags[i].push({ code: "regex-invalid", severity: "block" });
    flags[i].push(...regexHeuristics(p));
    const wide = catchAll(re);
    if (wide) flags[i].push(wide);
    runnable.push(i);
  });
  if (runnable.length) {
    const times = await timedRegexTest(runnable.map((i) => patterns[i]), limitMs);
    runnable.forEach((i, k) => {
      const ms = times[k];
      if (!Number.isFinite(ms)) flags[i].push({ code: "regex-timeout", severity: "block", ms: limitMs });
      else if (ms > limitMs / 3) flags[i].push({ code: "regex-slow", severity: "warn", ms: Math.round(ms) });
    });
  }
  return flags;
}
