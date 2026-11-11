// Legal pages. Impressum and privacy policy live on the Flowplan website
// (MARKETPLACE_IMPRESSUM_URL, MARKETPLACE_PRIVACY_URL); /impressum and
// /datenschutz here only redirect there. The Nutzungsbedingungen are the
// marketplace's own fixed text, shipped with it in content/legal/.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_IMPRESSUM_URL, DEFAULT_PRIVACY_URL, config } from "./config";
import { cookie } from "./http";
import { LOCALE_COOKIE, pickLocale, type Locale } from "./i18n";

export type ExternalLegalPage = "impressum" | "datenschutz";

// The website has a fixed address per language (/de/…, /en/…, see
// flowplan-website proxy.ts), so visitors land in the language they read the
// marketplace in. Only for the default addresses; custom ones are used as given.
function localized(url: string, fallback: string, locale: Locale) {
  if (url !== fallback) return url;
  const u = new URL(url);
  u.pathname = `/${locale}${u.pathname}`;
  return u.href;
}

// Where the Impressum or the privacy policy is, in the visitor's language.
export function legalUrl(page: ExternalLegalPage, locale: Locale): string {
  return page === "impressum"
    ? localized(config.impressumUrl(), DEFAULT_IMPRESSUM_URL, locale)
    : localized(config.privacyUrl(), DEFAULT_PRIVACY_URL, locale);
}

// GET /impressum, /datenschutz: a permanent redirect to the website in the
// visitor's language. The target depends on the language, so the answer is
// not cached.
export function legalRedirect(page: ExternalLegalPage, request: Request): Response {
  const url = legalUrl(page, pickLocale(cookie(request, LOCALE_COOKIE), request.headers.get("accept-language")));
  return new Response(null, { status: 308, headers: { Location: url, "Cache-Control": "no-store" } });
}

// The Nutzungsbedingungen (Markdown) in the visitor's language.
const terms = new Map<Locale, string>();
export function termsText(locale: Locale): string {
  let text = terms.get(locale);
  if (text === undefined) {
    text = readFileSync(join(/*turbopackIgnore: true*/ process.cwd(), "content/legal", `nutzungsbedingungen.${locale}.md`), "utf8");
    terms.set(locale, text);
  }
  return text;
}
