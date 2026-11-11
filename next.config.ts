import type { NextConfig } from "next";

// Headers for every answer; the Content Security Policy with its per-request
// nonce is set in proxy.ts. No Cross-Origin-Opener-Policy on purpose: both
// hand-overs (contract §2, §3) need window.opener between the marketplace and
// a Flowplan instance on another origin.
const security = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const config: NextConfig = {
  // The CI checks types; image builds set FLOWPLAN_SKIP_TYPECHECK=1.
  typescript: { ignoreBuildErrors: process.env.FLOWPLAN_SKIP_TYPECHECK === "1" },
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["node:sqlite", "nodemailer", "yauzl"],
  turbopack: { root: process.cwd() },
  ...(process.env.MARKETPLACE_DIST_DIR ? { distDir: process.env.MARKETPLACE_DIST_DIR } : {}),
  async headers() {
    return [{ source: "/:path*", headers: security }];
  },
};
export default config;
