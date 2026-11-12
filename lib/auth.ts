// Accounts without passwords: GitHub OAuth or a one-time e-mail link.
// Sessions are random tokens in an httpOnly cookie; the database keeps only
// their SHA-256. Signed-in forms carry a CSRF token derived from the session.
import { all, newId, now, one, run, transaction } from "./db";
import { hmac, randomToken, safeEqual, sha256 } from "./secret";
import { HttpError, cookie, requireSameOrigin, setCookie } from "./http";
import { hit, ipKey } from "./rate-limit";
import { config } from "./config";
import { sendMail } from "./mail";

export const SESSION_COOKIE = "mp_session";
export const SESSION_DAYS = 30;
export const MAGIC_LINK_MINUTES = 15;

export type User = {
  id: string;
  handle: string;
  name: string;
  email: string | null;
  github_id: string | null;
  github_login: string | null;
  created_at: number;
  blocked_at: number | null;
  // 1 for the built-in author of the official templates: no sign-in.
  system?: number;
};

// The handle of the built-in author "Flowplan" (lib/official.ts); nobody
// else can get it, even before that author exists.
export const OFFICIAL_HANDLE = "flowplan";
const RESERVED_HANDLES = new Set([OFFICIAL_HANDLE]);

// ---- Users ----

export function slugify(input: string, max = 40) {
  const s = input
    .replace(/ä/gi, "ae")
    .replace(/ö/gi, "oe")
    .replace(/ü/gi, "ue")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return s || "x";
}
function uniqueHandle(base: string) {
  const root = slugify(base, 30);
  for (let i = 0; i < 1000; i++) {
    const handle = i ? `${root}-${i + 1}` : root;
    if (!RESERVED_HANDLES.has(handle) && !one("SELECT 1 FROM users WHERE handle=?", handle)) return handle;
  }
  return `${root}-${randomToken(4).toLowerCase()}`;
}
export const getUser = (id: string) => one<User>("SELECT * FROM users WHERE id=?", id) ?? null;
export const userByHandle = (handle: string) => one<User>("SELECT * FROM users WHERE handle=?", handle) ?? null;

export function createUser(input: { name: string; email?: string | null; githubId?: string | null; githubLogin?: string | null; handle?: string }): User {
  const id = newId();
  const name = cleanName(input.name) || "Flowplan-Fan";
  run(
    "INSERT INTO users(id,handle,name,email,github_id,github_login,created_at) VALUES(?,?,?,?,?,?,?)",
    id,
    uniqueHandle(input.handle || input.githubLogin || input.email?.split("@")[0] || name),
    name,
    input.email ?? null,
    input.githubId ?? null,
    input.githubLogin ?? null,
    now(),
  );
  return getUser(id)!;
}
export const cleanName = (name: string) => name.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 60);
export function renameUser(userId: string, name: string) {
  const clean = cleanName(name);
  if (clean.length < 2) throw new HttpError(400, "invalid_name", "Name too short.");
  run("UPDATE users SET name=? WHERE id=?", clean, userId);
}

// ---- Sessions ----

export function createSession(userId: string) {
  if (getUser(userId)?.system) throw new HttpError(403, "system_account", "This account can't sign in.");
  const token = randomToken();
  const at = now();
  run("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)", sha256(token), userId, at, at + SESSION_DAYS * 86_400_000);
  return token;
}
export const sessionCookie = (token: string) => setCookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86_400 });
export const clearSessionCookie = () => setCookie(SESSION_COOKIE, "", { maxAge: 0 });

export function userForSessionToken(token: string | undefined | null): User | null {
  if (!token || token.length > 100) return null;
  const row = one<User & { expires_at: number }>(
    "SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?",
    sha256(token),
  );
  if (!row || row.expires_at < now() || row.blocked_at || row.system) return null;
  const { expires_at: _expires, ...user } = row;
  return user;
}
export function destroySession(token: string | undefined) {
  if (token) run("DELETE FROM sessions WHERE token_hash=?", sha256(token));
}
export const csrfFor = (sessionToken: string) => hmac("csrf", sha256(sessionToken));

export function currentUser(request: Request) {
  return userForSessionToken(cookie(request, SESSION_COOKIE));
}
// A signed-in, state-changing request: same origin, a valid session and the
// session's CSRF token (header x-csrf-token or form field "csrf").
export function requireUser(request: Request, csrfFromForm?: string | null): User {
  requireSameOrigin(request);
  const token = cookie(request, SESSION_COOKIE);
  const user = userForSessionToken(token);
  if (!user || !token) throw new HttpError(401, "signed_out", "Please sign in.");
  const sent = request.headers.get("x-csrf-token") || csrfFromForm || "";
  if (!sent || !safeEqual(sent, csrfFor(token))) throw new HttpError(403, "csrf", "Invalid CSRF token.");
  return user;
}

// ---- E-mail links ----

export const normalizeEmail = (email: unknown) => {
  const value = typeof email === "string" ? email.trim().toLowerCase() : "";
  return value.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/.test(value) ? value : null;
};

// Sends a sign-in link (valid 15 minutes, once). Rate-limited per address
// and per (hashed) IP. In demo mode without SMTP the link is returned.
export async function requestMagicLink(emailInput: unknown, next: string, ip: string, at = now()) {
  const email = normalizeEmail(emailInput);
  if (!email) throw new HttpError(400, "invalid_email", "Invalid e-mail address.");
  hit(`login-ip:${ipKey(ip, at)}`, 10, 3600, at);
  hit(`login-mail:${sha256(email).slice(0, 24)}`, 3, 3600, at);
  const token = randomToken();
  run("INSERT INTO magic_links(token_hash,email,next,created_at,expires_at) VALUES(?,?,?,?,?)", sha256(token), email, next, at, at + MAGIC_LINK_MINUTES * 60_000);
  const link = `${config.publicUrl()}/login/confirm?token=${encodeURIComponent(token)}`;
  const delivered = await sendMail({
    to: email,
    subject: "Anmelden beim Flowplan Marketplace / Sign in to Flowplan Marketplace",
    text: [
      "Hallo,",
      "",
      `mit diesem Link meldest du dich beim Flowplan Marketplace an (gültig ${MAGIC_LINK_MINUTES} Minuten, nur einmal):`,
      link,
      "",
      "Wenn du das nicht warst, ignoriere diese E-Mail einfach.",
      "",
      "—",
      "",
      `Use this link to sign in to Flowplan Marketplace (valid for ${MAGIC_LINK_MINUTES} minutes, once):`,
      link,
      "",
      "If this wasn't you, just ignore this e-mail.",
    ].join("\n"),
  });
  return { delivered, demoLink: !delivered && config.demo() ? link : undefined };
}

export class MagicLinkError extends HttpError {
  constructor(reason: "invalid" | "expired" | "used") {
    super(400, `link_${reason}`, `Sign-in link ${reason}.`);
  }
}
// Uses the link up: exactly once, and only before it expires.
export function consumeMagicLink(token: unknown, at = now()): { user: User; next: string } {
  if (typeof token !== "string" || !token || token.length > 100) throw new MagicLinkError("invalid");
  const hash = sha256(token);
  return transaction(() => {
    const link = one<{ email: string; next: string; expires_at: number; used_at: number | null }>("SELECT email,next,expires_at,used_at FROM magic_links WHERE token_hash=?", hash);
    if (!link) throw new MagicLinkError("invalid");
    if (link.used_at) throw new MagicLinkError("used");
    if (link.expires_at < at) throw new MagicLinkError("expired");
    const changed = run("UPDATE magic_links SET used_at=? WHERE token_hash=? AND used_at IS NULL", at, hash).changes;
    if (Number(changed) !== 1) throw new MagicLinkError("used");
    const user = one<User>("SELECT * FROM users WHERE email=?", link.email) ?? createUser({ name: link.email.split("@")[0], email: link.email });
    if (user.blocked_at) throw new HttpError(403, "blocked", "This account is blocked.");
    return { user, next: link.next };
  });
}

// ---- GitHub ----

export const GITHUB_STATE_COOKIE = "mp_oauth";
export function githubAuthorizeUrl(state: string) {
  const github = config.github();
  if (!github) throw new HttpError(404, "github_off", "GitHub sign-in is not configured.");
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", github.clientId);
  url.searchParams.set("redirect_uri", `${config.publicUrl()}/api/auth/github/callback`);
  url.searchParams.set("state", state);
  // No scope: the public profile (id, login, name) is all we need.
  url.searchParams.set("allow_signup", "true");
  return url.toString();
}
export async function githubProfile(code: string, fetcher: typeof fetch = fetch) {
  const github = config.github();
  if (!github) throw new HttpError(404, "github_off", "GitHub sign-in is not configured.");
  const tokenResponse = await fetcher("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: github.clientId, client_secret: github.clientSecret, code, redirect_uri: `${config.publicUrl()}/api/auth/github/callback` }),
  });
  const tokenData = (await tokenResponse.json().catch(() => ({}))) as { access_token?: string };
  if (!tokenData.access_token) throw new HttpError(400, "github_failed", "GitHub sign-in failed.");
  const userResponse = await fetcher("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "flowplan-marketplace" },
  });
  const profile = (await userResponse.json().catch(() => ({}))) as { id?: number; login?: string; name?: string | null };
  if (!userResponse.ok || !profile.id || !profile.login) throw new HttpError(400, "github_failed", "GitHub sign-in failed.");
  return { id: String(profile.id), login: profile.login, name: profile.name || profile.login };
}
export function githubUser(profile: { id: string; login: string; name: string }): User {
  const existing = one<User>("SELECT * FROM users WHERE github_id=?", profile.id);
  if (existing) {
    if (existing.blocked_at) throw new HttpError(403, "blocked", "This account is blocked.");
    run("UPDATE users SET github_login=? WHERE id=?", profile.login, existing.id);
    return { ...existing, github_login: profile.login };
  }
  return createUser({ name: profile.name, githubId: profile.id, githubLogin: profile.login });
}

// Demo mode only: sign in as the demo author without any provider.
export function demoUser(): User {
  if (!config.demo()) throw new HttpError(404, "not_found");
  return one<User>("SELECT * FROM users WHERE handle='demo'") ?? createUser({ name: "Demo-Autorin", email: "demo@example.org", handle: "demo" });
}

export const userSessions = (userId: string) => all<{ created_at: number }>("SELECT created_at FROM sessions WHERE user_id=?", userId);
