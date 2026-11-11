import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, req, useTempData } from "./helpers";
useTempData();
import { REPORT_LIMITS, createReport } from "../lib/reports";
import { RateLimitError } from "../lib/rate-limit";
import { HttpError, handle } from "../lib/http";
import { reportRoute } from "../lib/routes";
import { decide } from "../lib/admin";
import { all } from "../lib/db";
import { docPackage } from "./fixtures";
import { author, submitVia } from "./flow";

const publish = async (title: string) => {
  const s = await submitVia(author(), docPackage(), { title });
  await decide(s.data.versionId, { decision: "publish" }, "test");
  return s.data.slug as string;
};

test("reports need no account, a reason, and a published template", async () => {
  const slug = await publish("Meldbar");
  const r = await handle(() => reportRoute(req("/api/reports", { method: "POST", json: { slug, reason: "malicious", text: "<b>x</b>\u0007" }, headers: { origin: BASE, "x-forwarded-for": "192.0.2.50" } })));
  assert.equal(r.status, 201);
  const rows = all<{ reason: string; text: string }>("SELECT reason, text FROM reports");
  assert.deepEqual({ ...rows[0] }, { reason: "malicious", text: "<b>x</b>" });
  assert.throws(() => createReport({ slug, reason: "because" }, "192.0.2.51"), (e: HttpError) => e.code === "invalid_reason");
  assert.throws(() => createReport({ slug: "nope", reason: "spam" }, "192.0.2.51"), (e: HttpError) => e.status === 404);
  const cross = await handle(() => reportRoute(req("/api/reports", { method: "POST", json: { slug, reason: "spam" }, headers: { origin: "https://evil.example" } })));
  assert.equal(cross.status, 403);
  // No IP address is stored anywhere.
  const dump = JSON.stringify(all("SELECT * FROM rate_limits")) + JSON.stringify(all("SELECT * FROM reports"));
  assert.doesNotMatch(dump, /192\.0\.2\.5/);
});

test("one report per template and visitor a day, five an hour", async () => {
  const slugs = await Promise.all(Array.from({ length: REPORT_LIMITS.perHour + 1 }, (_, i) => publish(`Limit ${i}`)));
  const at = Date.now();
  createReport({ slug: slugs[0], reason: "spam" }, "192.0.2.60", at);
  assert.throws(() => createReport({ slug: slugs[0], reason: "spam" }, "192.0.2.60", at + 1000), RateLimitError);
  // Another visitor may still report it.
  createReport({ slug: slugs[0], reason: "spam" }, "192.0.2.61", at);
  // The refused repeat counted against the hourly budget as well.
  for (let i = 1; i < REPORT_LIMITS.perHour - 1; i++) createReport({ slug: slugs[i], reason: "spam" }, "192.0.2.60", at + i);
  assert.throws(() => createReport({ slug: slugs[REPORT_LIMITS.perHour], reason: "spam" }, "192.0.2.60", at + 10), RateLimitError);
  // An hour later the hourly budget is back.
  createReport({ slug: slugs[REPORT_LIMITS.perHour], reason: "spam" }, "192.0.2.60", at + 3_600_001);
  const r = await handle(() => {
    throw new RateLimitError(42);
  });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get("retry-after"), "42");
});
