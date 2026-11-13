// The logic of the public, author and sign-in endpoints, on plain Request
// and Response (app/api/** only forwards to these, tests call them directly).
import { config } from "./config";
import { CORS_HEADERS, HttpError, clientIp, cookie, json, readBody, readJson, requireSameOrigin, safeNext, setCookie } from "./http";
import { countDownload, downloadable, editSubmission, movedSlug, parseJsonColumn, publicTemplate, publicTemplates, submit, templateDetail, templateSummary, withdraw, type PreviewInfo } from "./store";
import { readPackage, readPreview } from "./storage";
import { IMAGE_MIME } from "./images";
import { createReport } from "./reports";
import { hit, ipKey } from "./rate-limit";
import { inspectPackage, LIMITS } from "./package";
import { viewerFromEntries } from "./workflow-viewer";
import { countable, firstToday } from "./download-count";
import { LOCALE_COOKIE, pickLocale } from "./i18n";
import {
  GITHUB_STATE_COOKIE,
  consumeMagicLink,
  createSession,
  currentUser,
  demoUser,
  destroySession,
  githubAuthorizeUrl,
  githubProfile,
  githubUser,
  renameUser,
  requestMagicLink,
  requireUser,
  sessionCookie,
  clearSessionCookie,
  SESSION_COOKIE,
} from "./auth";
import { randomToken, safeEqual } from "./secret";
import { KINDS, CATEGORIES } from "./catalog";
import { deleteAccount } from "./account";
import { audit } from "./admin";

// ---- Public API (CORS * for GET) ----

export const corsPreflight = () => new Response(null, { status: 204, headers: CORS_HEADERS });

export function listTemplatesRoute(request: Request) {
  const p = new URL(request.url).searchParams;
  const kind = p.get("kind") || undefined;
  const category = p.get("category") || undefined;
  if (kind && !(KINDS as readonly string[]).includes(kind)) throw new HttpError(400, "invalid_kind", `kind must be one of ${KINDS.join(", ")}`);
  if (category && !(CATEGORIES as readonly string[]).includes(category)) throw new HttpError(400, "invalid_category", `category must be one of ${CATEGORIES.join(", ")}`);
  const sort = p.get("sort") || "newest";
  if (!["newest", "popular", "updated", "title", "featured"].includes(sort)) throw new HttpError(400, "invalid_sort", "sort must be newest, popular, updated, title or featured");
  const { rows, total } = publicTemplates({
    kind,
    category,
    q: p.get("q") || undefined,
    lang: p.get("lang") || undefined,
    sort,
    featured: sort === "featured",
    author: p.get("author") || undefined,
    official: p.get("official") === "1" || p.get("official") === "true",
    limit: Number(p.get("limit") || 24),
    offset: Number(p.get("offset") || 0),
  });
  return json({ templates: rows.map(templateSummary), total }, { cors: true, headers: { "Cache-Control": "public, max-age=60" } });
}

// A renamed template (lib/admin-edit.ts): the old address answers 308 with
// the same path and query under the new slug.
function moved(request: Request | null, slug: string, rest = ""): Response | null {
  const to = movedSlug(slug);
  if (!to) return null;
  const search = request ? new URL(request.url).search : "";
  return new Response(null, { status: 308, headers: { ...CORS_HEADERS, Location: `/api/templates/${encodeURIComponent(to)}${rest}${search}`, "Cache-Control": "no-store" } });
}

export function templateRoute(slug: string, request: Request | null = null) {
  const row = publicTemplate(slug);
  if (!row) {
    const redirect = moved(request, slug);
    if (redirect) return redirect;
    throw new HttpError(404, "not_found", "Template not found.");
  }
  return json({ template: templateDetail(row) }, { cors: true, headers: { "Cache-Control": "public, max-age=60" } });
}

// The package bytes. ?via=open counts an "opened in Flowplan" instead of a
// download (the template page fetches the bytes for the hand-over).
export function downloadRoute(request: Request, slug: string) {
  const p = new URL(request.url).searchParams;
  const number = p.get("version") ? Number(p.get("version")) : null;
  if (number !== null && (!Number.isInteger(number) || number < 1)) throw new HttpError(400, "invalid_version", "version must be a positive number.");
  const found = downloadable(slug, number);
  if (!found) {
    const redirect = moved(request, slug, "/download");
    if (redirect) return redirect;
    throw new HttpError(404, "not_found", "Template or version not found.");
  }
  const bytes = readPackage(found.version.id);
  const via = p.get("via") === "open" ? "open" : "download";
  // Counted: a GET by a person (no crawler or link preview), once per
  // visitor, version and day (lib/download-count.ts).
  if (request.method === "GET") {
    try {
      if (countable(request, via) && firstToday(request, via, found.version.id)) countDownload(found.template.t_id, found.version.id, via);
    } catch {}
  }
  return new Response(request.method === "HEAD" ? null : new Uint8Array(bytes), {
    headers: {
      ...CORS_HEADERS,
      "Access-Control-Expose-Headers": "Content-Disposition, X-Template-Sha256, X-Template-Version",
      "Content-Type": "application/zip",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename="${slug}-v${found.version.number}.flowplan-template"`,
      "X-Content-Type-Options": "nosniff",
      "X-Template-Sha256": found.version.sha256,
      "X-Template-Version": String(found.version.number),
      "Cache-Control": "no-store",
    },
  });
}

export function previewRoute(request: Request, slug: string, n: number) {
  const p = new URL(request.url).searchParams;
  const found = downloadable(slug, p.get("version") ? Number(p.get("version")) : null);
  const preview = found && parseJsonColumn<PreviewInfo[]>(found.version.previews, []).find((x) => x.n === n);
  if (!found) {
    const redirect = moved(request, slug, `/previews/${Math.trunc(n)}`);
    if (redirect) return redirect;
  }
  if (!found || !preview) throw new HttpError(404, "not_found", "Preview not found.");
  return new Response(new Uint8Array(readPreview(found.version.id, n, preview.type)), {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": IMAGE_MIME[preview.type],
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
      "Cache-Control": "public, max-age=86400, immutable",
    },
  });
}

export async function reportRoute(request: Request) {
  requireSameOrigin(request);
  const body = await readJson(request, 8 * 1024);
  return json(createReport(body, clientIp(request)), { status: 201 });
}

// Checks a package without storing anything (the submit form shows the
// result and prefills itself). No account needed: the hand-over arrives
// before sign-in.
export async function inspectRoute(request: Request) {
  requireSameOrigin(request);
  hit(`inspect:${ipKey(clientIp(request))}`, 60, 3600);
  const bytes = await readBody(request, LIMITS.packageBytes + 1024);
  const inspection = await inspectPackage(bytes);
  // A workflow's diagram and summary in the visitor's language (the submit preview).
  const viewer =
    inspection.manifest?.kind === "workflow" && inspection.analysis.workflow
      ? viewerFromEntries(inspection.payloadEntries, inspection.manifest.payload, pickLocale(cookie(request, LOCALE_COOKIE), request.headers.get("accept-language")))
      : null;
  return json({
    ok: inspection.ok,
    manifest: inspection.manifest,
    findings: inspection.findings,
    analysis: inspection.analysis,
    viewer,
    size: inspection.size,
    previews: inspection.previews.map((p) => ({ n: p.n, type: IMAGE_MIME[p.type], data: p.bytes.toString("base64") })),
  });
}

// ---- Authors ----

export async function submitRoute(request: Request) {
  requireSameOrigin(request);
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > LIMITS.packageBytes + 256 * 1024) throw new HttpError(413, "too_large", "The package is larger than 25 MB.");
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, "invalid_form", "Expected multipart form data.");
  }
  const user = requireUser(request, typeof form.get("csrf") === "string" ? (form.get("csrf") as string) : null);
  let meta: unknown;
  try {
    meta = JSON.parse(String(form.get("meta") ?? ""));
  } catch {
    throw new HttpError(400, "invalid_form", "meta must be JSON.");
  }
  const file = form.get("package");
  let bytes: Uint8Array | null = null;
  if (file && typeof file === "object" && "arrayBuffer" in file) {
    if (file.size > LIMITS.packageBytes) throw new HttpError(413, "too_large", "The package is larger than 25 MB.");
    bytes = new Uint8Array(await file.arrayBuffer());
  }
  const p = new URL(request.url).searchParams;
  const edit = p.get("edit");
  if (edit) return json(await editSubmission(user, edit, bytes, meta));
  if (!bytes) throw new HttpError(400, "package_missing", "Please add the package.");
  return json(await submit(user, bytes, meta, { templateId: p.get("template") }), { status: 201 });
}
export function withdrawRoute(request: Request, versionId: string) {
  const user = requireUser(request);
  return json(withdraw(user, versionId));
}
export async function profileRoute(request: Request) {
  const user = requireUser(request);
  const body = await readJson(request, 4096);
  renameUser(user.id, String(body.name ?? ""));
  return json({ ok: true });
}

// "Konto löschen" on /me: a plain form POST (no script needed) with the
// session's CSRF token and the handle typed again as confirmation. The
// session is checked again here; on success the cookie is cleared.
export async function deleteAccountRoute(request: Request) {
  requireSameOrigin(request);
  const form = await request.formData().catch(() => null);
  const field = (name: string) => (typeof form?.get(name) === "string" ? (form!.get(name) as string) : "");
  let user;
  try {
    user = requireUser(request, field("csrf"));
  } catch (error) {
    if (error instanceof HttpError && error.code === "signed_out") return redirect("/login?next=/me");
    throw error;
  }
  const typed = field("confirm").trim().replace(/^@/, "").toLowerCase();
  if (typed !== user.handle.toLowerCase()) return redirect("/me?delete=1&error=confirm#delete");
  await deleteAccount(user, { actor: "author (self-service)", audit });
  return redirect("/?account=deleted", [clearSessionCookie()]);
}

// ---- Sign-in ----

const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 303, headers });
};

export async function emailLoginRoute(request: Request) {
  requireSameOrigin(request);
  const body = await readJson(request, 4096);
  const result = await requestMagicLink(body.email, safeNext(body.next), clientIp(request));
  return json({ ok: true, ...result });
}
// The link in the e-mail opens /login/confirm, whose button posts here: a
// mail scanner following the link does not use it up.
export async function emailConfirmRoute(request: Request) {
  requireSameOrigin(request);
  const form = await request.formData();
  try {
    const { user, next } = consumeMagicLink(form.get("token"));
    return redirect(safeNext(next), [sessionCookie(createSession(user.id))]);
  } catch (error) {
    const code = error instanceof HttpError ? error.code : "link_invalid";
    return redirect(`/login?error=${encodeURIComponent(code)}`);
  }
}

export function githubStartRoute(request: Request) {
  const next = safeNext(new URL(request.url).searchParams.get("next"));
  const state = randomToken(24);
  return redirect(githubAuthorizeUrl(state), [setCookie(GITHUB_STATE_COOKIE, `${state}|${next}`, { maxAge: 600, path: "/api/auth/github" })]);
}
export async function githubCallbackRoute(request: Request, fetcher: typeof fetch = fetch) {
  const p = new URL(request.url).searchParams;
  const saved = cookie(request, GITHUB_STATE_COOKIE) || "";
  const [state, next] = [saved.slice(0, saved.indexOf("|")), saved.slice(saved.indexOf("|") + 1)];
  const clear = setCookie(GITHUB_STATE_COOKIE, "", { maxAge: 0, path: "/api/auth/github" });
  const sent = p.get("state") || "";
  const code = p.get("code") || "";
  if (!state || !sent || !safeEqual(state, sent) || !code) return redirect("/login?error=github_state", [clear]);
  try {
    hit(`github:${ipKey(clientIp(request))}`, 30, 3600);
    const user = githubUser(await githubProfile(code, fetcher));
    return redirect(safeNext(next), [clear, sessionCookie(createSession(user.id))]);
  } catch (error) {
    const reason = error instanceof HttpError ? error.code : "github_failed";
    return redirect(`/login?error=${encodeURIComponent(reason)}`, [clear]);
  }
}
export async function demoLoginRoute(request: Request) {
  requireSameOrigin(request);
  const user = demoUser();
  const form = await request.formData().catch(() => null);
  return redirect(safeNext(form?.get("next")), [sessionCookie(createSession(user.id))]);
}
export async function logoutRoute(request: Request) {
  requireSameOrigin(request);
  destroySession(cookie(request, SESSION_COOKIE));
  return redirect("/", [clearSessionCookie()]);
}
export const whoAmI = (request: Request) => {
  const user = currentUser(request);
  return json({ user: user ? { name: user.name, handle: user.handle } : null, github: !!config.github() });
};
