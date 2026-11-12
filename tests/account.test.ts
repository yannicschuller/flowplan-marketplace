import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ADMIN_TOKEN, BASE, req, useTempData } from "./helpers";
const dir = useTempData();
import { adminRoute, decide, republish, unpublish } from "../lib/admin";
import { handle } from "../lib/http";
import { all, one, run } from "../lib/db";
import { outbox } from "../lib/mail";
import { publicTemplates, mySubmissions } from "../lib/store";
import { createReport } from "../lib/reports";
import { deleteAccountRoute } from "../lib/routes";
import { SESSION_COOKIE, createSession, createUser, csrfFor, githubUser, requestMagicLink } from "../lib/auth";
import { officialAuthor } from "../lib/official";
import { DELETED_ACCOUNT, deleteAccount } from "../lib/account";
import { cleanup, cleanupSometimes } from "../lib/cleanup";
import { hit } from "../lib/rate-limit";
import { docPackage, workflowPackage } from "./fixtures";
import { author, submitVia } from "./flow";

const admin = async (method: string, path: string, json?: unknown, headers: Record<string, string> = { authorization: `Bearer ${ADMIN_TOKEN}` }) => {
  const r = await handle(() => adminRoute(req(`/api/admin/${path}`, { method, json, headers }), path.split("/")));
  return { status: r.status, data: (await r.json()) as any };
};
const count = (table: string, where = "1=1", ...params: string[]) => one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...params)!.n;
const files = (versionId: string) => ({
  pkg: existsSync(join(dir, "packages", `${versionId}.flowplan-template`)),
  previews: existsSync(join(dir, "previews", versionId)),
});
const deleteForm = (a: ReturnType<typeof author>, fields: Record<string, string>) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const { "x-csrf-token": _csrf, ...headers } = a.headers;
  return handle(() => deleteAccountRoute(req("/api/me/delete", { method: "POST", body, headers })));
};

// An author with one published template (with a report and an audit trail),
// one pending submission and an open sign-in link.
async function richAuthor(name: string) {
  const a = author(name);
  const published = await submitVia(a, docPackage(), { title: `${name} Doc` });
  await admin("GET", `submissions/${published.data.versionId}`);
  await decide(published.data.versionId, { decision: "publish", message: `Danke, ${name}!` }, "admin");
  const pending = await submitVia(a, workflowPackage(), { title: `${name} Workflow` });
  createReport({ slug: published.data.slug, reason: "spam", text: "hm" }, "198.51.100.7");
  await requestMagicLink(a.user.email!, "/me", "198.51.100.8");
  return { a, published, pending, versions: [published.data.versionId as string, pending.data.versionId as string] };
}

test("self-service deletion needs the session, its CSRF token and the handle", async () => {
  const { a, versions } = await richAuthor("Selma");
  // No CSRF token: refused, nothing deleted.
  assert.equal((await deleteForm(a, { confirm: a.user.handle })).status, 403);
  // Another origin: refused.
  const body = new FormData();
  body.set("csrf", a.headers["x-csrf-token"]);
  body.set("confirm", a.user.handle);
  const cross = await handle(() => deleteAccountRoute(req("/api/me/delete", { method: "POST", body, headers: { cookie: a.headers.cookie, origin: "https://evil.example" } })));
  assert.equal(cross.status, 403);
  // Wrong handle: back to the confirmation with an error.
  const wrong = await deleteForm(a, { csrf: a.headers["x-csrf-token"], confirm: "someone-else" });
  assert.equal(wrong.status, 303);
  assert.equal(wrong.headers.get("location"), "/me?delete=1&error=confirm#delete");
  // Signed out: to the sign-in page.
  const out = await handle(() => deleteAccountRoute(req("/api/me/delete", { method: "POST", body: new FormData(), headers: { origin: BASE } })));
  assert.equal(out.headers.get("location"), "/login?next=/me");
  assert.equal(count("users", "id=?", a.user.id), 1);
  for (const v of versions) assert.deepEqual(files(v), { pkg: true, previews: true });
});

test("self-service deletion removes the account, its templates, files, reports and personal data", async () => {
  const { a, published, versions } = await richAuthor("Delia");
  const other = await richAuthor("Otto");
  const email = a.user.email!;
  assert.equal(publicTemplates().rows.filter((r) => r.author_handle === a.user.handle).length, 1);
  createSession(a.user.id); // a second device
  const before = outbox().length;

  const r = await deleteForm(a, { csrf: a.headers["x-csrf-token"], confirm: ` @${a.user.handle.toUpperCase()} ` });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/?account=deleted");
  assert.match(r.headers.get("set-cookie") || "", new RegExp(`^${SESSION_COOKIE}=;.*Max-Age=0`));

  assert.equal(count("users", "id=?", a.user.id), 0);
  assert.equal(count("sessions", "user_id=?", a.user.id), 0);
  assert.equal(count("magic_links", "email=?", email), 0);
  assert.equal(count("templates", "author_id=?", a.user.id), 0);
  assert.equal(count("versions", "template_id=?", published.data.templateId), 0);
  assert.equal(count("reports", "template_id=?", published.data.templateId), 0);
  assert.equal(count("rate_limits", "key=?", `submit:${a.user.id}`), 0);
  for (const v of versions) assert.deepEqual(files(v), { pkg: false, previews: false });
  // Gone from the marketplace at once.
  assert.ok(!publicTemplates().rows.some((row) => row.slug === published.data.slug));
  // The audit log keeps the entries, without name, handle or address.
  const auditText = all<{ actor: string; details: string; target: string }>("SELECT actor,details,target FROM audit").map((e) => `${e.actor} ${e.target} ${e.details}`).join("\n");
  assert.ok(!auditText.includes(email));
  assert.ok(!auditText.includes("Delia"));
  const decision = one<{ details: string }>("SELECT details FROM audit WHERE action='decision_publish' AND target=?", published.data.versionId)!;
  assert.equal(JSON.parse(decision.details).author, DELETED_ACCOUNT);
  assert.equal(JSON.parse(decision.details).message, `Danke, ${DELETED_ACCOUNT}!`);
  const entry = one<{ actor: string; details: string }>("SELECT actor,details FROM audit WHERE action='account_deleted' AND target=?", a.user.id)!;
  assert.equal(entry.actor, "author (self-service)");
  assert.deepEqual(JSON.parse(entry.details), { author: DELETED_ACCOUNT, templates: 2, published: 1, versions: 2, reports: 1 });
  // A confirmation went to the address before it was forgotten.
  const mail = outbox().slice(before).find((m) => m.to === email);
  assert.ok(mail && /gelöscht/.test(mail.subject) && /deleted/.test(mail.subject));
  // Other authors are untouched.
  assert.equal(count("users", "id=?", other.a.user.id), 1);
  for (const v of other.versions) assert.deepEqual(files(v), { pkg: true, previews: true });
  assert.equal(count("reports", "template_id=?", other.published.data.templateId), 1);
});

test("the built-in author Flowplan can't be deleted", async () => {
  const flowplan = officialAuthor();
  await assert.rejects(deleteAccount(flowplan, { actor: "x", audit: () => {} }), (e: any) => e.code === "system_account");
  for (const id of [flowplan.id, flowplan.handle]) {
    const r = await admin("POST", `users/${id}/delete`, { reason: "please" });
    assert.equal(r.status, 403);
    assert.equal(r.data.error, "system_account");
  }
  assert.equal(count("users", "id=?", flowplan.id), 1);
});

test("admin deletion: token, reason, audit", async () => {
  const { a, versions } = await richAuthor("Adam");
  assert.equal((await admin("POST", `users/${a.user.id}/delete`, { reason: "x" }, {})).status, 401);
  assert.equal((await admin("POST", `users/${a.user.id}/delete`, { reason: "x" }, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await admin("POST", `users/${a.user.id}/delete`, {})).status, 400);
  assert.equal((await admin("POST", "users/nobody/delete", { reason: "x" })).status, 404);
  assert.equal(count("users", "id=?", a.user.id), 1);
  const r = await admin("POST", `users/${a.user.handle}/delete`, { reason: "Wunsch per E-Mail" }, { authorization: `Bearer ${ADMIN_TOKEN}`, "x-admin-user": "Yannic" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.deleted, true);
  assert.equal(r.data.templates, 2);
  assert.equal(r.data.notified, false); // no SMTP in tests; the mail is in the outbox
  assert.equal(count("users", "id=?", a.user.id), 0);
  for (const v of versions) assert.deepEqual(files(v), { pkg: false, previews: false });
  const entry = (await admin("GET", "audit")).data.entries.find((e: any) => e.action === "account_deleted" && e.target === a.user.id);
  assert.equal(entry.actor, "flowplan-admin (Yannic)");
  assert.equal(entry.details.reason, "Wunsch per E-Mail");
  assert.equal(entry.details.author, DELETED_ACCOUNT);
  assert.equal((await admin("POST", `users/${a.user.id}/delete`, { reason: "again" })).status, 404);
});

test("unpublish and republish tell the author by e-mail, /me shows the reason", async () => {
  const a = author("Ulla");
  const s = await submitVia(a, docPackage(), { title: "Ullas Vorlage" });
  await decide(s.data.versionId, { decision: "publish" }, "admin");
  const before = outbox().length;
  const off = await admin("POST", `templates/${s.data.templateId}/unpublish`, { reason: "Enthält fremde Logos." });
  assert.equal(off.data.state, "unpublished");
  assert.equal(off.data.notified, false); // no SMTP: kept in the outbox
  const mail = outbox().slice(before).find((m) => m.to === a.user.email)!;
  assert.ok(mail, "unpublish mail");
  assert.ok(mail.text.includes("Enthält fremde Logos."));
  assert.ok(mail.text.includes(`${BASE}/me`));
  assert.match(mail.subject, /Ullas Vorlage/);
  assert.equal(mySubmissions(a.user)[0].template.unpublish_reason, "Enthält fremde Logos.");

  const back = await admin("POST", `templates/${s.data.slug}/republish`);
  assert.equal(back.data.state, "listed");
  const note = outbox().at(-1)!;
  assert.equal(note.to, a.user.email);
  assert.match(note.subject, /wieder im Marketplace/);
  assert.ok(note.text.includes(`${BASE}/t/${s.data.slug}`));
});

test("GitHub-only and official templates: no e-mail, the reason stays on /me", async () => {
  const user = githubUser({ id: "4242", login: "octo", name: "Octo" });
  const token = createSession(user.id);
  const a = { user, headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: BASE, "x-csrf-token": csrfFor(token) } };
  const s = await submitVia(a, docPackage(), { title: "Octo Doc" });
  await decide(s.data.versionId, { decision: "publish" }, "admin");
  const before = outbox().length;
  const off = await unpublish(s.data.templateId, { reason: "Kaputt mit Flowplan 3." }, "admin");
  assert.equal(off.notified, false);
  assert.equal(outbox().length, before);
  assert.equal(mySubmissions(user)[0].template.unpublish_reason, "Kaputt mit Flowplan 3.");
  await republish(s.data.templateId, "admin");
  assert.equal(outbox().length, before);
});

test("cleanup deletes expired sessions and old sign-in links, hourly", async () => {
  const user = createUser({ name: "Clean", email: "clean@example.org" });
  const at = Date.now();
  run("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES('old',?,?,?)", user.id, at - 40 * 86_400_000, at - 1);
  run("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES('live',?,?,?)", user.id, at, at + 86_400_000);
  run("INSERT INTO magic_links(token_hash,email,created_at,expires_at) VALUES('stale','clean@example.org',?,?)", at - 2 * 86_400_000, at - 86_400_000 - 1);
  run("INSERT INTO magic_links(token_hash,email,created_at,expires_at) VALUES('recent','clean@example.org',?,?)", at - 3_600_000, at - 3_000_000);
  run("INSERT INTO magic_links(token_hash,email,created_at,expires_at) VALUES('fresh','clean@example.org',?,?)", at, at + 900_000);
  const result = cleanup(at);
  assert.equal(result.sessions >= 1 && result.signInLinks >= 1, true);
  assert.deepEqual(all<{ token_hash: string }>("SELECT token_hash FROM sessions WHERE user_id=?", user.id).map((r) => r.token_hash), ["live"]);
  // Expired within the last day: still there, so a late click says "expired".
  assert.deepEqual(all<{ token_hash: string }>("SELECT token_hash FROM magic_links WHERE email='clean@example.org' ORDER BY token_hash").map((r) => r.token_hash), ["fresh", "recent"]);

  // At most once an hour, also without any sign-in: the timer calls cleanupSometimes().
  const later = at + 10 * 86_400_000;
  assert.ok(cleanupSometimes(later));
  assert.equal(cleanupSometimes(later + 60_000), null);
  assert.equal(count("magic_links", "email='clean@example.org'"), 0);
  // A new rate-limit window still triggers it too.
  run("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES('old2',?,?,?)", user.id, at, at + 1);
  hit("cleanup-test", 5, 60, later + 2 * 3_600_000);
  assert.equal(count("sessions", "token_hash='old2'"), 0);
});
