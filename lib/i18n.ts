// Two languages: German and English. Texts sit next to each other in the
// code as t("Deutsch", "English"), like in Flowplan. Client-safe.
export type Locale = "de" | "en";
export const LOCALE_COOKIE = "mp_lang";
export const isLocale = (v: unknown): v is Locale => v === "de" || v === "en";

// The visitor's choice (footer switch) wins, else the browser's languages in order.
export function pickLocale(cookie: string | undefined | null, acceptLanguage: string | null | undefined): Locale {
  if (isLocale(cookie)) return cookie;
  const ranked = (acceptLanguage || "")
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => /^q=([\d.]+)$/.exec(p.trim())?.[1]).find(Boolean);
      return { lang: tag.toLowerCase().split("-")[0], q: q ? Number(q) : 1 };
    })
    .filter((x) => x.lang && x.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { lang } of ranked) if (isLocale(lang)) return lang;
  return "en";
}
export type T = (de: string, en: string) => string;
export const translate = (locale: Locale): T => (de, en) => (locale === "de" ? de : en);

// A text in the visitor's language, else the other one.
export const localized = (locale: Locale, value: { de?: string; en?: string }) =>
  (locale === "de" ? value.de || value.en : value.en || value.de) || "";

export function formatDate(locale: Locale, at: number) {
  return new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-GB", { day: "numeric", month: "short", year: "numeric" }).format(at);
}
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
