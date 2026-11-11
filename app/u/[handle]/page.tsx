import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { pageT } from "@/lib/page";
import { userByHandle } from "@/lib/auth";
import { publicTemplates } from "@/lib/store";
import { formatDate } from "@/lib/i18n";
import { TemplateCard } from "@/components/template-card";

type Props = { params: Promise<{ handle: string }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const user = userByHandle((await params).handle);
  return user ? { title: user.name } : {};
}

export default async function AuthorPage({ params }: Props) {
  const { t, locale } = await pageT();
  const user = userByHandle((await params).handle);
  if (!user || user.blocked_at) notFound();
  const { rows } = publicTemplates({ author: user.handle, limit: 100 });
  return (
    <div>
      <header className="page-head">
        <p className="eyebrow">{t("Autor:in", "Author")}</p>
        <h1>{user.name}</h1>
        <p className="lede">
          {user.github_login && (
            <>
              <a href={`https://github.com/${encodeURIComponent(user.github_login)}`} rel="noopener noreferrer nofollow">
                GitHub @{user.github_login}
              </a>{" "}
              ·{" "}
            </>
          )}
          {t(`Dabei seit ${formatDate(locale, user.created_at)}`, `Member since ${formatDate(locale, user.created_at)}`)} · {rows.length === 1 ? t("1 Vorlage", "1 template") : t(`${rows.length} Vorlagen`, `${rows.length} templates`)}
        </p>
      </header>
      {rows.length ? (
        <div className="grid">
          {rows.map((row) => (
            <TemplateCard key={row.t_id} row={row} locale={locale} />
          ))}
        </div>
      ) : (
        <p className="empty">{t("Noch keine veröffentlichten Vorlagen.", "No published templates yet.")}</p>
      )}
    </div>
  );
}
