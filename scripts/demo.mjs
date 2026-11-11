#!/usr/bin/env node
// npm run demo [-- --prod] [-- --fresh]: the marketplace with example data in
// ./data-demo (MARKETPLACE_DEMO=1: nine templates, three authors, a demo
// sign-in button, the admin token "demo-admin-token"). --prod serves the
// last `npm run build` with `next start` instead of the development server.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const port = process.env.PORT || "3000";
const dataDir = resolve(process.env.MARKETPLACE_DATA_DIR || "./data-demo");
if (args.includes("--fresh")) rmSync(dataDir, { recursive: true, force: true });
const env = {
  ...process.env,
  MARKETPLACE_DEMO: "1",
  MARKETPLACE_DATA_DIR: dataDir,
  MARKETPLACE_URL: process.env.MARKETPLACE_URL || `http://localhost:${port}`,
  NODE_OPTIONS: [process.env.NODE_OPTIONS, "--disable-warning=ExperimentalWarning"].filter(Boolean).join(" "),
};
const next = resolve("node_modules/.bin/next");
const command = args.includes("--prod") ? ["start", "--hostname", "127.0.0.1", "-p", port] : ["dev", "--hostname", "127.0.0.1", "-p", port];
console.log(`Flowplan Marketplace demo on ${env.MARKETPLACE_URL} (data: ${dataDir}, admin token: ${process.env.MARKETPLACE_ADMIN_TOKEN ? "from MARKETPLACE_ADMIN_TOKEN" : "demo-admin-token"})`);
const child = spawn(next, command, { env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
