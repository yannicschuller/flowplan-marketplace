// The two browser hand-overs between a Flowplan instance and the marketplace
// (contract §2 and §3), as pure functions: checking messages and instance
// addresses, comparing versions. The DOM parts live in components/handover-*.
// Client-safe: no Node APIs.
export const MAX_PACKAGE_BYTES = 25 * 1024 * 1024;

// §2: Flowplan → marketplace
export const READY_MESSAGE = { type: "flowplan-marketplace-ready" } as const;
export type PackageMessage = { type: "flowplan-marketplace-package"; name: string; bytes: ArrayBuffer };

// Accepts only {type, name, bytes: ArrayBuffer} within the size limit.
export function parsePackageMessage(data: unknown): PackageMessage | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.type !== "flowplan-marketplace-package") return null;
  if (!(m.bytes instanceof ArrayBuffer) || m.bytes.byteLength === 0 || m.bytes.byteLength > MAX_PACKAGE_BYTES) return null;
  const name = typeof m.name === "string" ? cleanFileName(m.name) : "";
  return { type: m.type, name: name || "template.flowplan-template", bytes: m.bytes };
}
export const cleanFileName = (name: string) =>
  name
    .replace(/[\u0000-\u001f\u007f/\\<>:"|?*]/g, "")
    .trim()
    .slice(0, 120);

// Is the message from the window that opened us? (§2.4)
export const fromOpener = (source: unknown, opener: unknown) => !!opener && source === opener;

// §3: marketplace → Flowplan
export type InstanceReady = { type: "flowplan-instance-ready"; version: string };
export function parseInstanceReady(data: unknown): InstanceReady | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.type !== "flowplan-instance-ready") return null;
  const version = typeof m.version === "string" ? m.version.trim().slice(0, 40) : "";
  return { type: m.type, version };
}
export type TemplateMessage = {
  type: "flowplan-marketplace-template";
  id: string;
  version: number;
  bytes: ArrayBuffer;
  sha256: string;
  // Optional extras (CONTRACT-CHANGES): for the instance's preview dialog.
  slug?: string;
  title?: string;
  kind?: string;
  author?: string;
  license?: string;
  url?: string;
};
export function templateMessage(input: Omit<TemplateMessage, "type">): TemplateMessage {
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error("sha256 must be 64 hex characters");
  if (!(input.bytes instanceof ArrayBuffer) || input.bytes.byteLength > MAX_PACKAGE_BYTES) throw new Error("bytes must be an ArrayBuffer within the limit");
  return { type: "flowplan-marketplace-template", ...input };
}

// Private and local hosts may use http (with a warning).
export function isPrivateHost(hostname: string) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(":")) return h === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(h) || h.startsWith("fe80:");
  return false;
}

export type InstanceCheck =
  | { ok: true; origin: string; warning: null | "http-private" }
  | { ok: false; error: "empty" | "invalid" | "scheme" | "http-public" | "credentials" };
// The visitor's instance address (§3.1): an https URL; http only for
// localhost and private networks. Only the origin is kept.
export function checkInstanceUrl(input: string): InstanceCheck {
  let value = input.trim();
  if (!value) return { ok: false, error: "empty" };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "invalid" };
  }
  if (url.username || url.password) return { ok: false, error: "credentials" };
  if (url.protocol === "https:") return { ok: true, origin: url.origin, warning: null };
  if (url.protocol === "http:") return isPrivateHost(url.hostname) ? { ok: true, origin: url.origin, warning: "http-private" } : { ok: false, error: "http-public" };
  return { ok: false, error: "scheme" };
}
export const importAddress = (origin: string) => `${origin}/#marketplace-import`;

// Compares dotted versions ("0.9.4", "1.2.0-beta.1"); pre-releases count as
// their release. Unknown or empty versions return null.
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => {
    const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
// Should the visitor be warned that their instance is too old? Unknown
// versions warn as well (we cannot tell).
export const instanceTooOld = (instanceVersion: string, minVersion: string) => {
  const c = compareVersions(instanceVersion, minVersion);
  return c === null ? "unknown" : c < 0 ? "older" : "ok";
};
