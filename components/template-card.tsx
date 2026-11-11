import Link from "next/link";
import { KindIcon } from "./kind-icon";
import { kindLabel } from "@/lib/catalog";
import { localized, type Locale, translate } from "@/lib/i18n";
import { parseJsonColumn, type PreviewInfo, type PublicRow } from "@/lib/store";
import { DownloadSimple } from "@phosphor-icons/react/dist/ssr/DownloadSimple";

export const previewSrc = (slug: string, version: number, n = 1) => `/api/templates/${slug}/previews/${n}?version=${version}`;

export function TemplateCard({ row, locale }: { row: PublicRow; locale: Locale }) {
  const t = translate(locale);
  const previews = parseJsonColumn<PreviewInfo[]>(row.previews, []);
  return (
    <article className="card">
      <Link href={`/t/${row.slug}`} className="card-link">
        <div className={`card-preview kind-${row.kind}`}>
          {previews.length ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewSrc(row.slug, row.number)} alt="" loading="lazy" width={480} height={300} />
          ) : (
            <span className="card-placeholder">
              <KindIcon kind={row.kind} size={40} />
            </span>
          )}
        </div>
        <div className="card-body">
          <span className="kind-badge">
            <KindIcon kind={row.kind} size={14} />
            {kindLabel(t, row.kind)}
          </span>
          <h3>{row.title}</h3>
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
