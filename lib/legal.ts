// Legal pages. Impressum and privacy policy live on the Flowplan website
// (MARKETPLACE_IMPRESSUM_URL, MARKETPLACE_PRIVACY_URL); /impressum and
// /datenschutz here only redirect there. The Nutzungsbedingungen are the
// marketplace's own: a Markdown file the operator fills in
// (<MARKETPLACE_LEGAL_DIR or data/legal>/nutzungsbedingungen.<de|en>.md, else
// the placeholder in docs/legal/) – unless MARKETPLACE_TERMS_URL points
// elsewhere.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_IMPRESSUM_URL, DEFAULT_PRIVACY_URL, config } from "./config";
import { cookie } from "./http";
import { LOCALE_COOKIE, pickLocale, type Locale } from "./i18n";

export type LegalPage = "impressum" | "datenschutz" | "nutzungsbedingungen";

// The website has a fixed address per language (/de/…, /en/…, see
// flowplan-website proxy.ts), so visitors land in the language they read the
// marketplace in. Only for the default addresses; custom ones are used as given.
function localized(url: string, fallback: string, locale: Locale) {
  if (url !== fallback) return url;
  const u = new URL(url);
  u.pathname = `/${locale}${u.pathname}`;
  return u.href;
}

// Where a legal page is; null: the marketplace's own Nutzungsbedingungen page.
export function legalUrl(page: LegalPage, locale: Locale): string | null {
  if (page === "impressum") return localized(config.impressumUrl(), DEFAULT_IMPRESSUM_URL, locale);
  if (page === "datenschutz") return localized(config.privacyUrl(), DEFAULT_PRIVACY_URL, locale);
  return config.termsUrl();
}

// The address to link to: an external one or the local page.
export const legalHref = (page: LegalPage, locale: Locale) => legalUrl(page, locale) ?? `/${page}`;

// GET /impressum, /datenschutz: a permanent redirect to the website in the
// visitor's language. The target depends on the language, so the answer is
// not cached.
export function legalRedirect(page: "impressum" | "datenschutz", request: Request): Response {
  const url = legalUrl(page, pickLocale(cookie(request, LOCALE_COOKIE), request.headers.get("accept-language")))!;
  return new Response(null, { status: 308, headers: { Location: url, "Cache-Control": "no-store" } });
}

// The operator's Nutzungsbedingungen, else the placeholder.
export function termsText(locale: Locale): { text: string; placeholder: boolean } {
  const other: Locale = locale === "de" ? "en" : "de";
  for (const [dir, placeholder] of [
    [config.legalDir(), false],
    [resolve(/*turbopackIgnore: true*/ process.cwd(), "docs/legal"), true],
  ] as const)
    for (const l of [locale, other]) {
      const file = join(/*turbopackIgnore: true*/ dir, `nutzungsbedingungen.${l}.md`);
      if (existsSync(file)) return { text: readFileSync(file, "utf8").slice(0, 100_000), placeholder };
    }
  return { text: "", placeholder: true };
}
