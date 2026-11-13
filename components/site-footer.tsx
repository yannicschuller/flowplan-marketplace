import Link from "next/link";
import { pageBack, pageT } from "@/lib/page";
import { legalUrl } from "@/lib/legal";
import { switchLanguageHref, type Locale } from "@/lib/i18n";

export async function SiteFooter() {
  const [{ t, locale }, back] = await Promise.all([pageT(), pageBack()]);
  // Back to the page the visitor is on after switching the language.
  const switchTo = (l: Locale) => switchLanguageHref(l, back);
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <p className="footer-note">
          {t(
            "Der Flowplan Marketplace kennt deine Flowplan-Instanz nicht: Vorlagen gehen direkt aus deinem Browser dorthin. Keine Tracker, keine Werbung.",
            "Flowplan Marketplace never learns about your Flowplan instance: templates go there straight from your browser. No trackers, no ads.",
          )}
        </p>
        <nav className="footer-links" aria-label={t("Rechtliches", "Legal")}>
          <a href="https://flowplan.org">flowplan.org</a>
          <a href="https://docs.flowplan.org">{t("Dokumentation", "Docs")}</a>
          {/* Impressum and privacy policy are on the website. */}
          <a href={legalUrl("impressum", locale)}>{t("Impressum", "Legal notice")}</a>
          <a href={legalUrl("datenschutz", locale)}>{t("Datenschutz", "Privacy")}</a>
          <Link href="/nutzungsbedingungen">{t("Nutzungsbedingungen", "Terms of use")}</Link>
          <span className="lang-switch" aria-label={t("Sprache", "Language")}>
            {locale === "de" ? <strong>Deutsch</strong> : <a href={switchTo("de")} hrefLang="de">Deutsch</a>}
            {" · "}
            {locale === "en" ? <strong>English</strong> : <a href={switchTo("en")} hrefLang="en">English</a>}
          </span>
        </nav>
      </div>
    </footer>
  );
}
