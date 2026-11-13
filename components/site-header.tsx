import Link from "next/link";
import { BrandMark } from "./brand-mark";
import { pageBack, pageSession, pageT } from "@/lib/page";
import { LanguageSwitch } from "./language-switch";
import { Plus } from "@phosphor-icons/react/dist/ssr/Plus";
import { User } from "@phosphor-icons/react/dist/ssr/User";

export async function SiteHeader() {
  const [{ t, locale }, session, back] = await Promise.all([pageT(), pageSession(), pageBack()]);
  return (
    <header className="site-header">
      <div className="bar">
        <Link href="/" className="brand">
          <BrandMark />
          <span className="brand-name">Flowplan</span>
          <small>Marketplace</small>
        </Link>
        <nav className="nav" aria-label={t("Hauptnavigation", "Main navigation")}>
          <Link href="/#browse">{t("Entdecken", "Browse")}</Link>
          <Link href="/submit" className="nav-submit" title={t("Einreichen", "Submit")}>
            <Plus size={15} weight="bold" aria-hidden="true" />
            <span className="nav-label">{t("Einreichen", "Submit")}</span>
          </Link>
          {session ? (
            <Link href="/me" className="nav-me" title={session.user.name}>
              <User size={16} weight="bold" aria-hidden="true" />
              <span className="nav-label">{t("Meine Einreichungen", "My submissions")}</span>
            </Link>
          ) : (
            <Link href="/login">{t("Anmelden", "Sign in")}</Link>
          )}
        </nav>
        <LanguageSwitch locale={locale} back={back} t={t} />
      </div>
    </header>
  );
}
