import Link from "next/link";
import { pageT } from "@/lib/page";
import { headers } from "next/headers";
import { legalHref } from "@/lib/legal";

export async function SiteFooter() {
  const { t, locale } = await pageT();
  const h = await headers();
  // Back to the page the visitor is on after switching the language.
  const back = (() => {
    try {
      const url = new URL(h.get("x-url") || h.get("referer") || "/", "http://x");
      return url.pathname + url.search;
    } catch {
      return "/";
    }
  })();
  // Impressum and privacy policy are on the website; the terms may be local.
  const terms = legalHref("nutzungsbedingungen", locale);
  const switchTo = (l: "de" | "en") => `/lang/${l}?next=${encodeURIComponent(back)}`;
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
          <a href={legalHref("impressum", locale)}>{t("Impressum", "Legal notice")}</a>
          <a href={legalHref("datenschutz", locale)}>{t("Datenschutz", "Privacy")}</a>
          {terms.startsWith("/") ? <Link href={terms}>{t("Nutzungsbedingungen", "Terms of use")}</Link> : <a href={terms}>{t("Nutzungsbedingungen", "Terms of use")}</a>}
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
