// What server components need about the request: the visitor's language
// and, if signed in, the user with the session's CSRF token.
import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, pickLocale, translate, type Locale } from "./i18n";
import { SESSION_COOKIE, csrfFor, userForSessionToken } from "./auth";

export async function pageLocale(): Promise<Locale> {
  const [c, h] = await Promise.all([cookies(), headers()]);
  return pickLocale(c.get(LOCALE_COOKIE)?.value, h.get("accept-language"));
}
export async function pageT() {
  const locale = await pageLocale();
  return { locale, t: translate(locale) };
}
export async function pageSession() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const user = userForSessionToken(token);
  return user && token ? { user, csrf: csrfFor(token) } : null;
}
