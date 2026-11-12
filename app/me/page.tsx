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
import { Trash } from "@phosphor-icons/react/dist/ssr/Trash";
import type { VersionRow } from "@/lib/store";
import type { T } from "@/lib/i18n";

export const metadata: Metadata = { title: "Meine Einreichungen / My submissions", robots: { index: false } };

// What the review team's message on a version means, by its status.
const messageLabel = (t: T, v: VersionRow) =>
  ({
    changes_requested: t("Bitte ändern – Nachricht vom Prüfteam:", "Please change – message from the review team:"),
    rejected: t("Abgelehnt – Begründung vom Prüfteam:", "Rejected – reason from the review team:"),
  })[v.status as string] ?? t("Nachricht vom Prüfteam:", "Message from the review team:");

export default async function MePage({ searchParams }: { searchParams: Promise<{ sent?: string; delete?: string; error?: string }> }) {
  const { t, locale } = await pageT();
  const session = await pageSession();
  if (!session) redirect("/login?next=/me");
  const sp = await searchParams;
  const sent = sp.sent;
  const confirmDelete = sp.delete === "1";
  const items = mySubmissions(session.user);
  const listedCount = items.filter(({ template: x }) => x.published_version_id && !x.unpublished_at && !x.withdrawn_at).length;
  const versionCount = items.reduce((n, i) => n + i.versions.length, 0);
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
      {!session.user.email && (
        <p className="notice">
          {t(
            "Dein Konto hat keine E-Mail-Adresse. Entscheidungen des Prüfteams – veröffentlicht, Änderungen nötig, abgelehnt oder aus dem Marketplace genommen – findest du deshalb nur hier, jeweils mit der Nachricht des Teams.",
            "Your account has no e-mail address, so the review team's decisions – published, changes requested, rejected or taken down – are shown only here, each with the team's message.",
          )}
        </p>
      )}
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
                {template.unpublished_at && (
                  <p className="review-message decision rejected">
                    <strong>
                      {t("Vom Prüfteam aus dem Marketplace genommen am", "Taken out of the marketplace by the review team on")} {formatDate(locale, template.unpublished_at)}. {t("Grund:", "Reason:")}
                    </strong>{" "}
                    {template.unpublish_reason || t("(kein Grund angegeben)", "(no reason given)")}
                  </p>
                )}
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
                          <p className={`review-message decision ${v.status}`}>
                            <strong>{messageLabel(t, v)}</strong>
                            {v.decided_at ? <span className="muted"> ({formatDate(locale, v.decided_at)})</span> : null} {v.review_message}
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
      <section className="section danger-zone" id="delete" aria-labelledby="delete-title">
        <h2 id="delete-title">{t("Konto löschen", "Delete account")}</h2>
        <p>
          {t(
            "Löscht dein Konto mit Name, E-Mail-Adresse bzw. GitHub-Verknüpfung und Anmeldungen, dazu alle deine Vorlagen mit allen Versionen, Paketen und Vorschaubildern. Veröffentlichte Vorlagen verschwinden sofort aus dem Marketplace. Kopien, die andere schon heruntergeladen haben, bleiben bei ihnen und dürfen nach ihrer Lizenz weiter genutzt werden.",
            "Deletes your account with its name, e-mail address or GitHub link and sign-ins, and all your templates with every version, package and preview image. Published templates disappear from the marketplace at once. Copies others have already downloaded stay with them and may still be used under their licence.",
          )}
        </p>
        {!confirmDelete ? (
          <Link href="/me?delete=1#delete" className="button danger">
            <Trash size={15} aria-hidden="true" /> {t("Konto löschen …", "Delete account …")}
          </Link>
        ) : (
          <form className="delete-confirm" action="/api/me/delete" method="post">
            <p className="notice error" role={sp.error ? "alert" : undefined}>
              {sp.error === "confirm"
                ? t("Das war nicht dein Handle. Nichts wurde gelöscht – gib ihn genau so ein, wie er unten steht.", "That wasn't your handle. Nothing was deleted – type it exactly as shown below.")
                : t(
                    `Das kann nicht rückgängig gemacht werden. Gelöscht werden ${items.length} Vorlage(n) mit ${versionCount} Version(en), davon ${listedCount} veröffentlicht.`,
                    `This can't be undone. ${items.length} template(s) with ${versionCount} version(s) will be deleted, ${listedCount} of them published.`,
                  )}
            </p>
            <input type="hidden" name="csrf" value={session.csrf} />
            <label className="field">
              <span>
                {t("Gib zur Bestätigung deinen Handle ein:", "Type your handle to confirm:")} <code>{session.user.handle}</code>
              </span>
              <input name="confirm" required autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={60} autoFocus />
            </label>
            {session.user.email && (
              <p className="muted">{t(`Wir schicken eine Bestätigung an ${session.user.email}, danach ist die Adresse gelöscht.`, `We'll send a confirmation to ${session.user.email}; after that the address is deleted.`)}</p>
            )}
            <div className="row">
              <button type="submit" className="button danger-solid">
                <Trash size={15} aria-hidden="true" /> {t("Konto endgültig löschen", "Delete my account for good")}
              </button>
              <Link href="/me" className="button ghost">
                {t("Abbrechen", "Cancel")}
              </Link>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
