import Link from "next/link";
import { KindIcon } from "./kind-icon";
import { OfficialBadge } from "./official-badge";
import { kindLabel } from "@/lib/catalog";
import { localTitle, localized, type Locale, translate } from "@/lib/i18n";
import { parseJsonColumn, type PreviewInfo, type PublicRow } from "@/lib/store";
import { DownloadSimple } from "@phosphor-icons/react/dist/ssr/DownloadSimple";

// `r` (the package's SHA-256 prefix) changes when an admin edits the previews of a version in place.
export const previewSrc = (slug: string, version: { number: number; sha256: string }, n = 1) =>
  `/api/templates/${slug}/previews/${n}?version=${version.number}&r=${version.sha256.slice(0, 12)}`;

export function TemplateCard({ row, locale }: { row: PublicRow; locale: Locale }) {
  const t = translate(locale);
  const previews = parseJsonColumn<PreviewInfo[]>(row.previews, []);
  return (
    <article className="card">
      <Link href={`/t/${row.slug}`} className="card-link">
        <div className={`card-preview kind-${row.kind}`}>
          {previews.length ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewSrc(row.slug, row)} alt="" loading="lazy" width={480} height={300} />
          ) : (
            <span className="card-placeholder">
              <KindIcon kind={row.kind} size={40} />
            </span>
          )}
        </div>
        <div className="card-body">
          <span className="badges">
            <span className="kind-badge">
              <KindIcon kind={row.kind} size={14} />
              {kindLabel(t, row.kind)}
            </span>
            {!!row.official && <OfficialBadge t={t} />}
          </span>
          <h3>{localTitle(locale, row)}</h3>
          <p>{localized(locale, { de: row.summary_de, en: row.summary_en })}</p>
          <div className="card-meta">
            <span>{row.author_name}</span>
            <span className="card-count" title={t("Heruntergeladen oder in Flowplan geöffnet", "Downloaded or opened in Flowplan")}>
              <DownloadSimple size={13} aria-hidden="true" />
              {(row.t_downloads + row.opens).toLocaleString(locale === "de" ? "de-DE" : "en-GB")}
            </span>
          </div>
        </div>
      </Link>
    </article>
  );
}
