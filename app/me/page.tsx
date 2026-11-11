import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { pageSession, pageT } from "@/lib/page";
import { findingsOf, mySubmissions } from "@/lib/store";
import { canTransition, statusLabel } from "@/lib/status";
import { kindLabel } from "@/lib/catalog";
import { formatDate } from "@/lib/i18n";
import { KindIcon } from "@/components/kind-icon";
import { WithdrawButton } from "@/components/withdraw-button";
import { ProfileForm } from "@/components/profile-form";
import { Plus } from "@phosphor-icons/react/dist/ssr/Plus";
import { SignOut } from "@phosphor-icons/react/dist/ssr/SignOut";

export const metadata: Metadata = { title: "Meine Einreichungen / My submissions", robots: { index: false } };

export default async function MePage({ searchParams }: { searchParams: Promise<{ sent?: string }> }) {
  const { t, locale } = await pageT();
  const session = await pageSession();
  if (!session) redirect("/login?next=/me");
  const sent = (await searchParams).sent;
  const items = mySubmissions(session.user);
  return (
    <div className="me">
      <header className="page-head with-actions">
        <div>
          <h1>{t("Meine Einreichungen", "My submissions")}</h1>
          <p className="lede">
            {t("Angemeldet als", "Signed in as")} <strong>{session.user.name}</strong>
            {session.user.github_login ? ` · GitHub @${session.user.github_login}` : session.user.email ? ` · ${session.user.email}` : ""} ·{" "}
            <Link href={`/u/${session.user.handle}`}>{t("Dein Profil", "Your profile")}</Link>
          </p>
        </div>
        <div className="row">
          <Link href="/submit" className="button primary">
            <Plus size={15} weight="bold" aria-hidden="true" /> {t("Neue Vorlage", "New template")}
          </Link>
          <form action="/api/auth/logout" method="post">
            <button type="submit" className="button ghost">
              <SignOut size={15} aria-hidden="true" /> {t("Abmelden", "Sign out")}
            </button>
          </form>
        </div>
      </header>
      {sent && (
        <p className="notice success" role="status">
          {t("Eingereicht! Wir melden uns, sobald wir es geprüft haben.", "Submitted! We'll get back to you once we've reviewed it.")}
        </p>
      )}
      {items.length === 0 ? (
        <p className="empty">
          {t("Noch nichts eingereicht.", "Nothing submitted yet.")} <Link href="/submit">{t("Erste Vorlage einreichen", "Submit your first template")}</Link>
        </p>
      ) : (
        <ul className="submissions">
          {items.map(({ template, versions }) => {
            const listed = !!template.published_version_id && !template.unpublished_at && !template.withdrawn_at;
            const pending = versions.some((v) => ["submitted", "in_review", "changes_requested"].includes(v.status));
            return (
              <li key={template.id} className="submission">
                <div className="submission-head">
                  <span className="kind-badge">
                    <KindIcon kind={template.kind} size={14} />
                    {kindLabel(t, template.kind)}
                  </span>
                  <h2>{listed ? <Link href={`/t/${template.slug}`}>{versions.find((v) => v.id === template.published_version_id)?.title ?? versions[0].title}</Link> : versions[0].title}</h2>
                  {template.unpublished_at && <span className="status unpublished">{t("Vom Team zurückgezogen", "Taken down by the team")}</span>}
                  {template.withdrawn_at && <span className="status withdrawn">{t("Zurückgezogen", "Withdrawn")}</span>}
                  {listed && !pending && (
                    <Link href={`/submit?template=${template.id}`} className="button small">
                      {t("Neue Version", "New version")}
                    </Link>
                  )}
                </div>
                {template.unpublish_reason && <p className="review-message">{template.unpublish_reason}</p>}
                <ol className="version-list">
                  {versions.map((v) => {
                    const findings = findingsOf(v).filter((f) => f.level !== "info");
                    return (
                      <li key={v.id} id={`v-${v.id}`} className={sent === v.id ? "highlight" : ""}>
                        <div className="version-line">
                          <span>
                            {t("Version", "Version")} {v.number}
                          </span>
                          <span className={`status ${v.status}`}>{statusLabel(t, v.status)}</span>
                          <span className="muted">{formatDate(locale, v.updated_at)}</span>
                          <span className="spacer" />
                          {canTransition(v.status, v.status === "changes_requested" ? "resubmit" : "edit", "author") && (
                            <Link href={`/submit?edit=${v.id}`} className="button small">
                              {v.status === "changes_requested" ? t("Überarbeiten", "Revise") : t("Bearbeiten", "Edit")}
                            </Link>
                          )}
                          {canTransition(v.status, "withdraw", "author") && <WithdrawButton versionId={v.id} csrf={session.csrf} published={v.status === "published"} />}
                        </div>
                        {v.review_message && (
                          <p className="review-message">
                            <strong>{t("Nachricht vom Prüfteam:", "Message from the review team:")}</strong> {v.review_message}
                          </p>
                        )}
                        {findings.length > 0 && (
                          <ul className="findings compact">
                            {findings.map((f, i) => (
                              <li key={i} className={`finding ${f.level}`}>
                                {locale === "de" ? f.de : f.en}
                                {f.at && <code>{f.at}</code>}
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </li>
            );
          })}
        </ul>
      )}
      <section className="section">
        <h2>{t("Name an deinen Vorlagen", "Name on your templates")}</h2>
        <ProfileForm name={session.user.name} csrf={session.csrf} />
      </section>
    </div>
  );
}
