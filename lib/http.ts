// Small helpers for route handlers. They work on the standard Request and
// Response, so the handlers can be tested without Next.js.
import { config } from "./config";
import { RateLimitError } from "./rate-limit";
import { TransitionError } from "./status";

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public extra: Record<string, unknown> = {}) {
    super(message ?? code);
  }
}

const SECURITY_HEADERS = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export function json(data: unknown, init: { status?: number; headers?: Record<string, string>; cors?: boolean } = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...SECURITY_HEADERS,
      ...(init.cors ? CORS_HEADERS : {}),
      ...init.headers,
    },
  });
}

// Runs a handler and turns known errors into JSON answers.
export async function handle(fn: () => Promise<Response> | Response, opts: { cors?: boolean } = {}): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.code, message: error.message, ...error.extra }, { status: error.status, cors: opts.cors });
    if (error instanceof RateLimitError)
      return json({ error: "rate_limited", retryAfter: error.retryAfter }, { status: 429, cors: opts.cors, headers: { "Retry-After": String(error.retryAfter) } });
    if (error instanceof TransitionError) return json({ error: "invalid_transition", message: error.message, status: error.from }, { status: 409, cors: opts.cors });
    console.error(error);
    return json({ error: "internal" }, { status: 500, cors: opts.cors });
  }
}

export function cookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
export function setCookie(name: string, value: string, opts: { maxAge?: number; httpOnly?: boolean; path?: string } = {}) {
  const secure = config.publicUrl().startsWith("https://");
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path ?? "/"}`,
    opts.maxAge !== undefined ? `Max-Age=${opts.maxAge}` : "",
    opts.httpOnly === false ? "" : "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

// The client's address: the first hop of X-Forwarded-For (Coolify's proxy
// sets it), else X-Real-IP. Only ever used through ipKey().
export function clientIp(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

// State-changing requests from browsers must come from the marketplace's own
// pages: Origin (or, without it, Sec-Fetch-Site) is checked. Together with
// SameSite cookies and the CSRF token of signed-in forms this stops CSRF.
export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const own = new URL(config.publicUrl()).origin;
  const requestOrigin = new URL(request.url).origin;
  if (origin) {
    if (origin === own || origin === requestOrigin) return;
    throw new HttpError(403, "cross_origin", "Cross-origin request refused.");
  }
  const site = request.headers.get("sec-fetch-site");
  if (site === "same-origin") return;
  throw new HttpError(403, "cross_origin", "Cross-origin request refused.");
}

// The body, at most `limit` bytes (also when Content-Length lies).
export async function readBody(request: Request, limit: number): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > limit) throw new HttpError(413, "too_large", "Request too large.");
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(413, "too_large", "Request too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
export async function readJson<T = Record<string, unknown>>(request: Request, limit = 64 * 1024): Promise<T> {
  const body = await readBody(request, limit);
  try {
    const value = JSON.parse(body.toString("utf8"));
    if (!value || typeof value !== "object") throw new Error();
    return value as T;
  } catch {
    throw new HttpError(400, "invalid_json", "Invalid JSON body.");
  }
}

// Only paths of this site after sign-in (no open redirects).
export function safeNext(next: unknown, fallback = "/me") {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || next.length > 500) return fallback;
  return next;
}
