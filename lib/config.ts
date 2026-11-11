// Settings from the environment. Read on every call (not at import time), so
// tests and the demo can set them before the first use.
import { resolve } from "node:path";

const text = (name: string) => (process.env[name] || "").trim();

export const config = {
  // Where the database, the packages and the previews live (one volume).
  dataDir: () => resolve(text("MARKETPLACE_DATA_DIR") || "./data"),
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
  // Where the legal texts (Markdown) are read from; default <data>/legal.
  legalDir: () => resolve(text("MARKETPLACE_LEGAL_DIR") || resolve(config.dataDir(), "legal")),
};

// Is the marketplace served over https (cookies get "Secure")?
export const httpsOrigin = () => config.publicUrl().startsWith("https://");
