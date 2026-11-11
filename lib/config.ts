// Settings from the environment. Read on every call (not at import time), so
// tests and the demo can set them before the first use.
import { resolve } from "node:path";

const text = (name: string) => (process.env[name] || "").trim();

// Impressum and privacy policy are the Flowplan website's; the marketplace
// links there. Nutzungsbedingungen have no default address: without
// MARKETPLACE_TERMS_URL the marketplace shows its own page (lib/legal.ts).
export const DEFAULT_IMPRESSUM_URL = "https://flowplan.org/impressum";
export const DEFAULT_PRIVACY_URL = "https://flowplan.org/datenschutz";

// An https address from the environment, or the fallback when unset. Anything
// else is a configuration error and fails loudly rather than linking nowhere.
function httpsUrl(name: string, fallback: string): string;
function httpsUrl(name: string, fallback: null): string | null;
function httpsUrl(name: string, fallback: string | null) {
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
  termsUrl: () => httpsUrl("MARKETPLACE_TERMS_URL", null),
  // Where the operator's Nutzungsbedingungen (Markdown) are read from when
  // MARKETPLACE_TERMS_URL is unset; default <data>/legal.
  legalDir: () => resolve(/*turbopackIgnore: true*/ text("MARKETPLACE_LEGAL_DIR") || resolve(/*turbopackIgnore: true*/ config.dataDir(), "legal")),
};

// Is the marketplace served over https (cookies get "Secure")?
export const httpsOrigin = () => config.publicUrl().startsWith("https://");
