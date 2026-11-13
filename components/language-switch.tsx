// The compact language switch in the site header: "DE / EN" as two links to
// /lang/<locale> (app/lang/[locale]/route.ts, which only sets the language
// cookie and goes back), the current language marked with aria-current.
// Plain links: keyboard accessible, no script, no style attributes.
import { switchLanguageHref, type Locale, type T } from "@/lib/i18n";

const LANGUAGES: { locale: Locale; short: string; name: string }[] = [
  { locale: "de", short: "DE", name: "Deutsch" },
  { locale: "en", short: "EN", name: "English" },
];

export function LanguageSwitch({ locale, back, t }: { locale: Locale; back: string; t: T }) {
  return (
    <nav className="header-lang" aria-label={t("Sprache", "Language")}>
      {LANGUAGES.map((l) => (
        <a
          key={l.locale}
          href={switchLanguageHref(l.locale, back)}
          hrefLang={l.locale}
          lang={l.locale}
          // The name contains the visible "DE"/"EN" (label in name).
          aria-label={l.name}
          title={l.name}
          aria-current={l.locale === locale ? "true" : undefined}
        >
          {l.short}
        </a>
      ))}
    </nav>
  );
}
