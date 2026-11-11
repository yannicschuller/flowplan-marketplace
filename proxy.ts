import { NextResponse, type NextRequest } from "next/server";

// A strict Content Security Policy for every page: scripts only with this
// request's nonce (Next.js adds it to its own scripts), no inline scripts or
// event handlers, no framing, no plug-ins, forms only to this site. Images
// may be blob:/data: (previews of a package being submitted). Styles come
// from our stylesheets; the development server needs inline styles.
export function contentSecurityPolicy(nonce: string, dev: boolean, https: boolean) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    dev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "frame-src 'none'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https && !dev ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const dev = process.env.NODE_ENV === "development";
  const https = (process.env.MARKETPLACE_URL || "").startsWith("https://");
  const policy = contentSecurityPolicy(nonce, dev, https);
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  // The address of the page, for the language switch in the footer.
  headers.set("x-url", request.nextUrl.pathname + request.nextUrl.search);
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api/|_next/static|_next/image|fonts/|icons/|fonts\\.css|icon\\.svg|favicon\\.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
