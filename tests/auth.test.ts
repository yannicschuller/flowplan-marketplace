import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, req, useTempData } from "./helpers";
useTempData();
import { MAGIC_LINK_MINUTES, SESSION_COOKIE, consumeMagicLink, createSession, createUser, csrfFor, requestMagicLink, requireUser, slugify } from "../lib/auth";
import { outbox } from "../lib/mail";
import { RateLimitError } from "../lib/rate-limit";
import { HttpError, safeNext } from "../lib/http";
import { emailConfirmRoute, githubCallbackRoute } from "../lib/routes";

const tokenFromMail = () => /token=([A-Za-z0-9_-]+)/.exec(outbox().at(-1)!.text)![1];

test("an e-mail link signs in once", async () => {
  await requestMagicLink("Anna@Example.org", "/submit?restore=1", "203.0.113.1");
  const token = tokenFromMail();
  assert.ok(outbox().at(-1)!.text.includes(`${BASE}/login/confirm?token=`));
  const { user, next } = consumeMagicLink(token);
  assert.equal(user.email, "anna@example.org");
  assert.equal(next, "/submit?restore=1");
  assert.throws(() => consumeMagicLink(token), (e: HttpError) => e.code === "link_used");
  // The same address signs in to the same account.
  await requestMagicLink("anna@example.org", "/", "203.0.113.1");
  assert.equal(consumeMagicLink(tokenFromMail()).user.id, user.id);
});

test("an e-mail link expires after 15 minutes", async () => {
  const at = Date.now();
  await requestMagicLink("late@example.org", "/", "203.0.113.2", at);
  const token = tokenFromMail();
  assert.throws(() => consumeMagicLink(token, at + MAGIC_LINK_MINUTES * 60_000 + 1), (e: HttpError) => e.code === "link_expired");
  // Still valid just before.
  await requestMagicLink("late@example.org", "/", "203.0.113.2", at);
  assert.ok(consumeMagicLink(tokenFromMail(), at + MAGIC_LINK_MINUTES * 60_000 - 1).user);
  assert.throws(() => consumeMagicLink("made-up"), (e: HttpError) => e.code === "link_invalid");
  assert.throws(() => consumeMagicLink(undefined), (e: HttpError) => e.code === "link_invalid");
});

test("e-mail links are rate-limited per address", async () => {
  const at = Date.now() + 10_000_000;
  for (let i = 0; i < 3; i++) await requestMagicLink("busy@example.org", "/", `198.51.100.${i}`, at);
  await assert.rejects(requestMagicLink("busy@example.org", "/", "198.51.100.9", at), RateLimitError);
  await assert.rejects(requestMagicLink("not-an-address", "/", "198.51.100.9", at), (e: HttpError) => e.code === "invalid_email");
});

test("the confirm button uses the link and sets the session cookie", async () => {
  await requestMagicLink("form@example.org", "/me", "203.0.113.3");
  const body = new FormData();
  body.set("token", tokenFromMail());
  const r = await emailConfirmRoute(req("/api/auth/email/confirm", { method: "POST", body, headers: { origin: BASE } }));
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/me");
  assert.match(r.headers.get("set-cookie")!, new RegExp(`^${SESSION_COOKIE}=.+HttpOnly; SameSite=Lax`));
  const again = await emailConfirmRoute(req("/api/auth/email/confirm", { method: "POST", body, headers: { origin: BASE } }));
  assert.equal(again.headers.get("location"), "/login?error=link_used");
});

test("signed-in writes need the same origin and the session's CSRF token", () => {
  const user = createUser({ name: "Csrf Test", email: "csrf@example.org" });
  const token = createSession(user.id);
  const cookie = `${SESSION_COOKIE}=${token}`;
  assert.equal(requireUser(req("/x", { method: "POST", headers: { cookie, origin: BASE, "x-csrf-token": csrfFor(token) } })).id, user.id);
  assert.throws(() => requireUser(req("/x", { method: "POST", headers: { cookie, origin: BASE } })), (e: HttpError) => e.code === "csrf");
  assert.throws(() => requireUser(req("/x", { method: "POST", headers: { cookie, origin: BASE, "x-csrf-token": "wrong" } })), (e: HttpError) => e.code === "csrf");
  assert.throws(() => requireUser(req("/x", { method: "POST", headers: { cookie, origin: "https://evil.example", "x-csrf-token": csrfFor(token) } })), (e: HttpError) => e.code === "cross_origin");
  assert.throws(() => requireUser(req("/x", { method: "POST", headers: { origin: BASE, "x-csrf-token": csrfFor(token) } })), (e: HttpError) => e.code === "signed_out");
  // Another session's token does not fit.
  const other = createSession(user.id);
  assert.throws(() => requireUser(req("/x", { method: "POST", headers: { cookie, origin: BASE, "x-csrf-token": csrfFor(other) } })), (e: HttpError) => e.code === "csrf");
});

test("GitHub callback checks the state and creates the account once", async () => {
  process.env.GITHUB_CLIENT_ID = "dummy-client-id";
  process.env.GITHUB_CLIENT_SECRET = "dummy-client-secret";
  const fetcher = (async (url: string) =>
    String(url).includes("access_token")
      ? new Response(JSON.stringify({ access_token: "dummy-access" }))
      : new Response(JSON.stringify({ id: 4242, login: "octo", name: "Octo Cat" }))) as typeof fetch;
  const bad = await githubCallbackRoute(req("/api/auth/github/callback?code=c&state=forged", { headers: { cookie: "mp_oauth=real|/me" } }), fetcher);
  assert.equal(bad.headers.get("location"), "/login?error=github_state");
  const ok = await githubCallbackRoute(req("/api/auth/github/callback?code=c&state=real", { headers: { cookie: "mp_oauth=real|/submit?restore=1" } }), fetcher);
  assert.equal(ok.headers.get("location"), "/submit?restore=1");
  assert.ok(ok.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`)));
  await githubCallbackRoute(req("/api/auth/github/callback?code=c&state=real", { headers: { cookie: "mp_oauth=real|/" } }), fetcher);
  const { all } = await import("../lib/db");
  assert.equal(all("SELECT * FROM users WHERE github_id='4242'").length, 1);
  delete process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_CLIENT_SECRET;
});

test("redirects stay on this site; handles are slugs", () => {
  assert.equal(safeNext("//evil.example"), "/me");
  assert.equal(safeNext("https://evil.example"), "/me");
  assert.equal(safeNext("/\\evil.example"), "/me");
  assert.equal(safeNext("/submit?restore=1"), "/submit?restore=1");
  assert.equal(slugify("Größe & Übersicht!"), "groesse-uebersicht");
});
