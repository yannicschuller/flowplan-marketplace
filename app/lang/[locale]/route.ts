import { LOCALE_COOKIE, isLocale } from "@/lib/i18n";
import { safeNext, setCookie } from "@/lib/http";

// The language switch in the footer: remembers the choice (the only cookie a
// visitor gets, and only when they ask for it) and goes back.
export async function GET(request: Request, ctx: { params: Promise<{ locale: string }> }) {
  const { locale } = await ctx.params;
  const next = safeNext(new URL(request.url).searchParams.get("next"), "/");
  const headers = new Headers({ Location: next, "Cache-Control": "no-store" });
  if (isLocale(locale)) headers.append("Set-Cookie", setCookie(LOCALE_COOKIE, locale, { maxAge: 365 * 86_400 }));
  return new Response(null, { status: 303, headers });
}
