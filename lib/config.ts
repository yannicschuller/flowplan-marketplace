// Settings from the environment. Read on every call (not at import time), so
// tests and the demo can set them before the first use.
import { resolve } from "node:path";

const text = (name: string) => (process.env[name] || "").trim();

// Impressum and privacy policy are the Flowplan website's; the marketplace
// links there. The Nutzungsbedingungen are its own page (lib/legal.ts).
export const DEFAULT_IMPRESSUM_URL = "https://flowplan.org/impressum";
export const DEFAULT_PRIVACY_URL = "https://flowplan.org/datenschutz";

// An https address from the environment, or the fallback when unset. Anything
// else is a configuration error and fails loudly rather than linking nowhere.
function httpsUrl(name: string, fallback: string) {
  const value = text(name);
  if (!value) return fallback;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL: ${value}`);
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw new Error(`${name} must be an https:// URL: ${value}`);
  return url.href;
}

// The hosted Flowplan the "In Flowplan öffnen" box offers before the visitor
// has saved an instance of their own.
export const DEFAULT_INSTANCE = "https://app.flowplan.org";

// MARKETPLACE_DEFAULT_INSTANCE: an https origin, or empty/"off" for none
// (the box then asks for the address as before). Unset: DEFAULT_INSTANCE.
function defaultInstance(): string | null {
  const name = "MARKETPLACE_DEFAULT_INSTANCE";
  if (process.env[name] === undefined) return DEFAULT_INSTANCE;
  const value = text(name);
  if (!value || value.toLowerCase() === "off") return null;
  const href = httpsUrl(name, DEFAULT_INSTANCE);
  const url = new URL(href);
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new Error(`${name} must be an origin without a path: ${value}`);
  return url.origin;
}

export const config = {
  // Where the database, the packages and the previews live (one volume).
  dataDir: () => resolve(/*turbopackIgnore: true*/ text("MARKETPLACE_DATA_DIR") || "./data"),
  // The public address of the marketplace, without a trailing slash; links in
  // e-mails and the GitHub callback are built from it.
  publicUrl: () => (text("MARKETPLACE_URL") || "http://localhost:3000").replace(/\/+$/, ""),
  demo: () => text("MARKETPLACE_DEMO") === "1",
  // Bearer token for flowplan-admin (§4 admin API). Unset: the admin API is off.
  // In demo mode a fixed dummy token works when none is set.
  adminToken: () => text("MARKETPLACE_ADMIN_TOKEN") || (config.demo() ? "demo-admin-token" : ""),
  // Who the token stands for in the audit log.
  adminTokenLabel: () => text("MARKETPLACE_ADMIN_TOKEN_LABEL") || "flowplan-admin",
  github: () => {
    const clientId = text("GITHUB_CLIENT_ID");
    const clientSecret = text("GITHUB_CLIENT_SECRET");
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  },
  smtp: () => {
    const host = text("SMTP_HOST");
    const from = text("SMTP_FROM");
    if (!host || !from) return null;
    const port = Number(text("SMTP_PORT") || 587);
    return {
      host,
      port: Number.isFinite(port) ? port : 587,
      // "true": TLS from the start (port 465); otherwise STARTTLS when offered.
      secure: text("SMTP_SECURE") === "true" || port === 465,
      user: text("SMTP_USER"),
      password: text("SMTP_PASSWORD"),
      from,
    };
  },
  // Legal pages (validated https addresses).
  impressumUrl: () => httpsUrl("MARKETPLACE_IMPRESSUM_URL", DEFAULT_IMPRESSUM_URL),
  privacyUrl: () => httpsUrl("MARKETPLACE_PRIVACY_URL", DEFAULT_PRIVACY_URL),
  // Preselected instance of the "In Flowplan öffnen" box (null = none).
  defaultInstance,
};

// Is the marketplace served over https (cookies get "Secure")?
export const httpsOrigin = () => config.publicUrl().startsWith("https://");

// MARKETPLACE_REQUIRE_ENGLISH_TITLE=on: a new template or version without
// an English title is refused. Off (the default) until a Flowplan release
// whose publish dialog asks for one is out – until then a missing English
// title is only a warning and the German (or single) title stands in.
export const requireEnglishTitle = () => ["1", "on", "true", "yes"].includes(text("MARKETPLACE_REQUIRE_ENGLISH_TITLE").toLowerCase());
