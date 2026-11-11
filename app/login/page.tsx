import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { pageSession, pageT } from "@/lib/page";
import { config } from "@/lib/config";
import { mailConfigured } from "@/lib/mail";
import { safeNext } from "@/lib/http";
import { LoginOptions } from "@/components/login-options";

export const metadata: Metadata = { title: "Anmelden / Sign in", robots: { index: false } };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { t } = await pageT();
  const sp = await searchParams;
  const next = safeNext(sp.next);
  if (await pageSession()) redirect(next);
  const error = sp.error
    ? ({
        link_expired: t("Der Link ist abgelaufen. Fordere einfach einen neuen an.", "The link has expired. Just request a new one."),
        link_used: t("Der Link wurde schon benutzt. Fordere einen neuen an.", "The link was already used. Request a new one."),
        link_invalid: t("Der Link ist ungültig.", "The link is not valid."),
        github_state: t("Die Anmeldung mit GitHub wurde unterbrochen. Versuch es noch einmal.", "Signing in with GitHub was interrupted. Please try again."),
        blocked: t("Dieses Konto ist gesperrt.", "This account is blocked."),
      }[sp.error] ?? t("Die Anmeldung hat nicht geklappt.", "Signing in didn't work."))
    : null;
  return (
    <div className="narrow">
      <header className="page-head">
        <h1>{t("Anmelden", "Sign in")}</h1>
        <p className="lede">
          {t(
            "Zum Stöbern und Importieren brauchst du kein Konto – nur zum Einreichen. Kein Passwort: GitHub oder ein Link per E-Mail.",
            "You don't need an account to browse and import – only to submit. No password: GitHub or a link by e-mail.",
          )}
        </p>
      </header>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <LoginOptions config={{ github: !!config.github(), email: mailConfigured() || config.demo(), demo: config.demo() }} next={next} />
    </div>
  );
}
