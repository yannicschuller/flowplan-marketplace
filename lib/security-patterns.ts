// Text patterns of the security scan (lib/security-scan.ts): credentials,
// personal data, addresses and Unicode tricks. Pure functions over strings,
// no I/O. Every pattern is linear (no nested quantifiers) because it runs on
// untrusted text.

// ---- Credentials ----

export type SecretHit = { kind: string; severity: "block" | "warn"; sample: string };

// [kind, pattern, severity]. "warn" for things that are often examples or
// test values (test keys, JWTs); everything that works as it stands blocks.
const SECRETS: [string, RegExp, "block" | "warn"][] = [
  ["aws-access-key", /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/, "block"],
  ["aws-secret-key", /\baws_?secret_?access_?key["'\s:=]{1,5}[A-Za-z0-9/+]{40}\b/i, "block"],
  ["gcp-service-account", /"type"\s*:\s*"service_account"/, "block"],
  ["gcp-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/, "block"],
  ["google-oauth-token", /\bya29\.[0-9A-Za-z_-]{20,}/, "block"],
  ["azure-storage-key", /\bAccountKey=[A-Za-z0-9+/]{80,}={0,2}/, "block"],
  ["azure-sas-token", /[?&]sv=\d{4}-\d{2}-\d{2}&[^\s"']{0,300}?\bsig=[A-Za-z0-9%+/]{20,}/, "block"],
  ["azure-connection-string", /\bDefaultEndpointsProtocol=https?;AccountName=[^;\s]{1,100};AccountKey=/, "block"],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/, "block"],
  ["slack-webhook", /\bhttps:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{20,}/, "block"],
  ["discord-webhook", /\bhttps:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,}\/[A-Za-z0-9_-]{30,}/, "block"],
  ["telegram-bot-token", /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/, "block"],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{36,}/, "block"],
  ["github-pat", /\bgithub_pat_[A-Za-z0-9_]{40,}/, "block"],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}/, "block"],
  ["stripe-live-key", /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/, "block"],
  ["stripe-test-key", /\b(?:sk|rk)_test_[A-Za-z0-9]{20,}/, "warn"],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/, "block"],
  ["openai-key", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/, "block"],
  ["sendgrid-key", /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/, "block"],
  ["twilio-key", /\bSK[0-9a-f]{32}\b/, "warn"],
  ["private-key", /-----BEGIN (?:[A-Z]{2,10} )?PRIVATE KEY(?: BLOCK)?-----/, "block"],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{10,}/, "warn"],
  ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/, "block"],
];

// Values that are clearly placeholders: workflow templates ({{…}}, $ask:),
// "xxx", "<your key>", "example", "changeme" …
const PLACEHOLDER = /\{\{|\$ask:|x{4,}|X{4,}|\*{4,}|<[^>]{1,40}>|\b(?:example|placeholder|changeme|your[_-]?(?:key|token|secret|password)|dummy|redacted)\b/i;

export const mask = (s: string) => (s.length <= 8 ? "…" : `${s.slice(0, 4)}…${s.slice(-2)}`);

export function findSecrets(value: string): SecretHit[] {
  if (value.length < 16) return [];
  const hits: SecretHit[] = [];
  for (const [kind, re, severity] of SECRETS) {
    const m = re.exec(value);
    if (!m) continue;
    if (PLACEHOLDER.test(m[0])) continue;
    // A Bearer line that is a template (Bearer {{token}}) is fine.
    hits.push({ kind, severity, sample: mask(m[0]) });
  }
  // Basic auth in an address: https://user:password@host
  for (const m of value.matchAll(/\b(?:https?|ftp|wss?):\/\/([^\s/@:"'<>]{1,64}):([^\s/@"'<>]{1,128})@[a-z0-9.-]{1,253}/gi)) {
    if (PLACEHOLDER.test(m[2]) || /^\{|^\$/.test(m[2])) continue;
    hits.push({ kind: "url-credentials", severity: "block", sample: `${m[1]}:…@` });
    break;
  }
  // Passwords and keys in a query string or a key=value text.
  for (const m of value.matchAll(/[?&;\s](password|passwd|pwd|pass|secret|client_secret|api_?key|apikey|access_token|auth_token|token|key)=([^&\s#"'{}]{6,})/gi)) {
    if (PLACEHOLDER.test(m[2]) || /^(?:true|false|null|undefined|\d{1,5})$/i.test(m[2])) continue;
    hits.push({ kind: "query-parameter", severity: "block", sample: `${m[1]}=${mask(m[2])}` });
    break;
  }
  return hits;
}

// ---- Personal data ----

export type PersonalHit = { kind: "email" | "phone" | "iban"; sample: string };

// Addresses that are no one's: documentation domains, test addresses.
const NOBODY = /@(?:(?:[a-z0-9-]+\.)*example\.(?:com|org|net)|example\.de|(?:[a-z0-9-]+\.)*(?:test|invalid|localhost|example)|test\.de|muster(?:firma|mann)?\.de|beispiel\.(?:de|com))$/i;
const ROLE = /^(?:noreply|no-reply|donotreply|info|support|hello|kontakt|contact|team|office|admin|webmaster|postmaster)@/i;

function ibanValid(raw: string) {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rest = 0;
  for (const c of moved) {
    const v = c >= "A" ? String(c.charCodeAt(0) - 55) : c;
    for (const d of v) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

export function findPersonal(value: string): PersonalHit[] {
  const hits: PersonalHit[] = [];
  if (value.length < 6) return hits;
  for (const m of value.matchAll(/(?<![\w.+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,5}\.[A-Za-z]{2,24}\b/g)) {
    const address = m[0];
    if (NOBODY.test(address) || ROLE.test(address)) continue;
    hits.push({ kind: "email", sample: `${address[0]}…@${address.split("@")[1]}` });
  }
  // Phone numbers: international (+49 …) or national with a leading 0, at
  // least 9 digits, the usual separators. Dates, versions and ids don't
  // look like this (no "+"/leading zero with grouped digits).
  for (const m of value.matchAll(/(?<![\w+])(?:\+[1-9]\d{0,2}|00[1-9]\d{0,2}|0)[ /().-]{0,2}\d{2,5}(?:[ /.-]{0,2}\d{2,8}){1,4}(?![\w])/g)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 9 || digits.length > 15) continue;
    if (!/[ /().-]/.test(m[0]) && !m[0].startsWith("+")) continue;
    if (/^0+$/.test(digits.slice(1))) continue;
    hits.push({ kind: "phone", sample: `${m[0].slice(0, 4)}…` });
  }
  for (const m of value.matchAll(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g)) {
    if (ibanValid(m[0])) hits.push({ kind: "iban", sample: `${m[0].slice(0, 4)}…` });
  }
  return hits;
}

// ---- Addresses ----

export type UrlHit = {
  url: string;
  scheme: string;
  host: string | null;
  kind: "dangerous-scheme" | "data" | "shortener" | "ip-literal" | "private" | "tracker" | "http" | "plain";
};

const SHORTENERS = new Set(
  "bit.ly bitly.com tinyurl.com t.co goo.gl ow.ly is.gd buff.ly rebrand.ly cutt.ly shorturl.at tiny.cc rb.gy s.id t.ly bit.do lnkd.in v.gd soo.gd shorte.st adf.ly bl.ink tr.im x.co qr.ae u.to clck.ru".split(" "),
);
const TRACKERS = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "connect.facebook.net",
  "facebook.com/tr",
  "pixel.facebook.com",
  "analytics.tiktok.com",
  "px.ads.linkedin.com",
  "snap.licdn.com",
  "bat.bing.com",
  "clarity.ms",
  "hotjar.com",
  "mixpanel.com",
  "segment.io",
  "segment.com",
  "mc.yandex.ru",
  "amplitude.com",
  "fullstory.com",
  "quantserve.com",
  "scorecardresearch.com",
  "pixel.wp.com",
  "stats.wp.com",
  "mailtrack.io",
  "list-manage.com/track",
  "sendgrid.net/wf/open",
  "mandrillapp.com/track",
];

export function isTrackerUrl(url: string) {
  const u = url.toLowerCase().replace(/^[a-z]+:\/\//, "");
  return TRACKERS.some((t) => u.startsWith(t) || u.includes(`.${t}`) || u.startsWith(`www.${t}`)) || /^[^/]*\/(?:pixel|track(?:ing)?|beacon|open)\.(?:gif|png|php)\b/i.test(u);
}

// IPv4 / IPv6 literal, and whether it is a private, loopback, link-local
// or otherwise internal address (also by name: localhost, *.local …).
export function hostClass(host: string): "ip-private" | "ip" | "name-private" | "name" {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const internal = a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    return internal ? "ip-private" : "ip";
  }
  // Decimal, octal or hex forms of an IPv4 address (http://2130706433/).
  if (/^(?:0x[0-9a-f]{1,8}|\d{8,10}|0[0-7]{1,11})$/.test(h)) return "ip-private";
  if (h.includes(":")) {
    const internal = h === "::1" || h === "::" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || /^::ffff:/.test(h);
    return internal ? "ip-private" : "ip";
  }
  if (h === "localhost" || /\.(?:local|localhost|internal|intranet|lan|home|corp|home\.arpa)$/.test(h) || h === "metadata.google.internal" || !h.includes(".")) return "name-private";
  return "name";
}

// Every address in a string (absolute URLs and the dangerous schemes).
export function findUrls(value: string): UrlHit[] {
  const hits: UrlHit[] = [];
  if (!/[:]/.test(value)) return hits;
  // javascript:, vbscript:, data: – also with whitespace or entities in between
  // (what browsers tolerate: "java\tscript:", "&#106;avascript:").
  const decoded = value.replace(/&#x?0*([0-9a-f]{2,4});?/gi, (_, n: string) => {
    const code = /^[0-9]+$/.test(n) ? Number(n) : parseInt(n, 16);
    return code > 0 && code < 0x10000 ? String.fromCharCode(code) : "";
  });
  const squeezed = decoded.replace(/[\u0000- ­]+/g, "");
  for (const m of squeezed.matchAll(/(?:^|[^a-z0-9+.-])(javascript|vbscript|livescript):/gi))
    hits.push({ url: squeezed.slice(m.index ?? 0, (m.index ?? 0) + 60), scheme: m[1].toLowerCase(), host: null, kind: "dangerous-scheme" });
  for (const m of decoded.matchAll(/\bdata:([a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,60})?[;,]/gi)) {
    const type = (m[1] || "text/plain").toLowerCase();
    hits.push({ url: decoded.slice(m.index ?? 0, (m.index ?? 0) + 60), scheme: "data", host: type, kind: /^image\/(?:png|jpe?g|gif|webp|avif)$/.test(type) ? "data" : "dangerous-scheme" });
  }
  for (const m of value.matchAll(/\b(https?|ftp|wss?):\/\/([^\s/?#"'<>()\\]{1,300})([^\s"'<>]{0,1000})/gi)) {
    const scheme = m[1].toLowerCase();
    const authority = m[2];
    const host = authority.replace(/^[^@]*@/, "").replace(/:\d{1,5}$/, "").toLowerCase();
    if (!host || /[{}$]/.test(host)) continue;
    const url = m[0];
    const cls = hostClass(host);
    const kind: UrlHit["kind"] = SHORTENERS.has(host.replace(/^www\./, ""))
      ? "shortener"
      : cls === "ip-private" || cls === "name-private"
        ? "private"
        : cls === "ip"
          ? "ip-literal"
          : isTrackerUrl(url)
            ? "tracker"
            : scheme === "http" || scheme === "ftp" || scheme === "ws"
              ? "http"
              : "plain";
    hits.push({ url: url.slice(0, 200), scheme, host, kind });
  }
  return hits;
}

// ---- Unicode ----

// Bidi overrides and isolates (Trojan Source), invisible format characters.
export const BIDI = /[‪-‮⁦-⁩‎‏؜]/;
export const INVISIBLE = /[​-‍⁠-⁤﻿­᠎ㅤﾠ]/;

// A word that mixes Latin with Cyrillic or Greek letters ("Pаypal" with a
// Cyrillic "а") – the usual homoglyph trick. Returns how many words do it.
export function mixedScriptWords(value: string): number {
  let n = 0;
  for (const word of value.split(/[^\p{L}\p{M}]+/u)) {
    if (word.length < 3) continue;
    const latin = /\p{Script=Latin}/u.test(word);
    const other = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}]/u.test(word);
    if (latin && other) n++;
  }
  return n;
}
// Letters from scripts that look like Latin, in an otherwise Latin text.
export function confusableShare(value: string): number {
  const letters = [...value].filter((c) => /\p{L}/u.test(c));
  if (letters.length < 4) return 0;
  const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length;
  if (latin < letters.length / 3) return 0;
  const lookalike = letters.filter((c) => /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(c) || /[\u{1d400}-\u{1d7ff}Ａ-ｚ]/u.test(c)).length;
  return lookalike / letters.length;
}

// ---- AI prompts ----

const INJECTION = [
  /\bignore (?:all |any )?(?:the )?(?:previous|prior|above|earlier) (?:instructions|prompts|rules|messages)/i,
  /\bdisregard (?:all |any )?(?:the )?(?:previous|prior|above|system) (?:instructions|prompt|rules)/i,
  /\bforget (?:all |everything |your )?(?:previous |prior )?(?:instructions|rules)/i,
  /\bignoriere (?:alle )?(?:vorherigen|bisherigen|obigen) (?:anweisungen|regeln)/i,
  /\byou are now (?:in )?(?:developer|dan|jailbreak|god) mode/i,
  /\bdo anything now\b/i,
  /\b(?:reveal|print|show|repeat|output) (?:me )?(?:your|the) (?:system prompt|instructions|hidden prompt)/i,
  /\boverride (?:your|the) (?:safety|system|security)/i,
  /<\|?(?:im_start|system|endoftext)\|?>/i,
];
const EXFILTRATION = [
  /!\[[^\]]{0,80}\]\(https?:\/\/[^)\s]{1,200}[?&][a-z0-9_]{1,20}=\{\{/i,
  /\b(?:send|post|upload|forward|exfiltrate|leak|schick|sende)\b[^.\n]{0,80}\b(?:to|an|nach)\b[^.\n]{0,40}(?:https?:\/\/|@[a-z0-9-]+\.[a-z]{2,})/i,
  /\b(?:all|every|alle)\b[^.\n]{0,40}\b(?:passwords?|api keys?|tokens?|secrets?|credentials|zugangsdaten|passw(?:ö|oe)rter)\b/i,
  /\bwithout (?:telling|informing|notifying) (?:the )?user\b|\bohne (?:dass )?(?:der|die) (?:nutzer|benutzer)/i,
];

export function promptRisks(value: string): ("prompt-injection" | "prompt-exfiltration")[] {
  const out: ("prompt-injection" | "prompt-exfiltration")[] = [];
  if (INJECTION.some((re) => re.test(value))) out.push("prompt-injection");
  if (EXFILTRATION.some((re) => re.test(value))) out.push("prompt-exfiltration");
  return out;
}
