// Every test file gets its own data directory and a known environment.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { closeDb } from "../lib/db";

export const BASE = "http://localhost:3000";
export const ADMIN_TOKEN = "test-admin-token-not-a-secret";

export function useTempData() {
  const dir = mkdtempSync(join(tmpdir(), "marketplace-test-"));
  process.env.MARKETPLACE_DATA_DIR = dir;
  process.env.MARKETPLACE_URL = BASE;
  process.env.MARKETPLACE_ADMIN_TOKEN = ADMIN_TOKEN;
  delete process.env.MARKETPLACE_DEMO;
  delete process.env.SMTP_HOST;
  delete process.env.GITHUB_CLIENT_ID;
  after(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

export const sameOrigin = { origin: BASE };
export function req(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return new Request(BASE + path, { ...init, headers, body });
}
