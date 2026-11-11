"use client";
// Sign-in without passwords: GitHub, a one-time e-mail link, and in demo
// mode a button that signs in as the demo author.
import { useState } from "react";
import { useT } from "./i18n";
import { GithubLogo } from "@phosphor-icons/react/dist/ssr/GithubLogo";
import { EnvelopeSimple } from "@phosphor-icons/react/dist/ssr/EnvelopeSimple";

export type LoginConfig = { github: boolean; email: boolean; demo: boolean };

export function LoginOptions({ config, next }: { config: LoginConfig; next: string }) {
  const t = useT();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<{ step: "idle" | "sending" | "sent" | "error" | "limited"; demoLink?: string }>({ step: "idle" });

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    setState({ step: "sending" });
    const r = await fetch("/api/auth/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, next }) }).catch(() => null);
    const data = (await r?.json().catch(() => ({}))) as { demoLink?: string };
    if (r?.ok) setState({ step: "sent", demoLink: data.demoLink });
    else setState({ step: r?.status === 429 ? "limited" : "error" });
  }

  return (
    <div className="login-options">
      {config.github && (
        <a className="button big github" href={`/api/auth/github?next=${encodeURIComponent(next)}`}>
          <GithubLogo size={18} weight="bold" aria-hidden="true" />
          {t("Mit GitHub anmelden", "Sign in with GitHub")}
        </a>
      )}
      {config.email &&
        (state.step === "sent" ? (
          <div className="notice success" role="status">
            <p>{t(`Wir haben dir einen Link an ${email} geschickt. Er gilt 15 Minuten.`, `We sent a link to ${email}. It is valid for 15 minutes.`)}</p>
            {state.demoLink && (
              <p>
                {t("Demo ohne E-Mail-Versand:", "Demo without e-mail delivery:")} <a href={state.demoLink}>{t("Link öffnen", "Open the link")}</a>
              </p>
            )}
          </div>
        ) : (
          <form className="email-login" onSubmit={sendLink}>
            <label htmlFor="login-email">{t("Oder mit einem Link per E-Mail", "Or with a link by e-mail")}</label>
            <div className="row">
              <input id="login-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("du@beispiel.de", "you@example.org")} />
              <button type="submit" className="button" disabled={state.step === "sending"}>
                <EnvelopeSimple size={16} aria-hidden="true" />
                {t("Link senden", "Send link")}
              </button>
            </div>
            {state.step === "limited" && <p className="field-error">{t("Zu viele Versuche – bitte warte etwas.", "Too many attempts – please wait a bit.")}</p>}
            {state.step === "error" && <p className="field-error">{t("Das hat nicht geklappt. Stimmt die Adresse?", "That didn't work. Is the address right?")}</p>}
          </form>
        ))}
      {config.demo && (
        <form action="/api/auth/demo" method="post" className="demo-login">
          <input type="hidden" name="next" value={next} />
          <button type="submit" className="button ghost">
            {t("Demo: als Demo-Autorin anmelden", "Demo: sign in as the demo author")}
          </button>
        </form>
      )}
      {!config.github && !config.email && !config.demo && <p className="notice warning">{t("Anmelden ist auf diesem Server noch nicht eingerichtet.", "Signing in is not set up on this server yet.")}</p>}
    </div>
  );
}
