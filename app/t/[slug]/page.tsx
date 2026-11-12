import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { pageT } from "@/lib/page";
import { config } from "@/lib/config";
import { parseJsonColumn, publicTemplate, publishedVersions, type PreviewInfo } from "@/lib/store";
import { LICENSE_URLS, categoryLabel, kindLabel, languageLabel, licenseLabel, type License } from "@/lib/catalog";
import { formatBytes, formatDate, localized } from "@/lib/i18n";
import type { Analysis } from "@/lib/package";
import { Markdown } from "@/components/markdown";
import { KindIcon } from "@/components/kind-icon";
import { OfficialBadge } from "@/components/official-badge";
import { OpenInFlowplan } from "@/components/open-in-flowplan";
import { ReportButton } from "@/components/report-button";
import { previewSrc } from "@/components/template-card";
import { DownloadSimple } from "@phosphor-icons/react/dist/ssr/DownloadSimple";
import { ArrowLeft } from "@phosphor-icons/react/dist/ssr/ArrowLeft";
import { Globe } from "@phosphor-icons/react/dist/ssr/Globe";
import { Robot } from "@phosphor-icons/react/dist/ssr/Robot";
import { EnvelopeSimple } from "@phosphor-icons/react/dist/ssr/EnvelopeSimple";
import { Lock } from "@phosphor-icons/react/dist/ssr/Lock";
import { versionViewer } from "@/lib/workflow-viewer";
import { WorkflowViewer } from "@/components/workflow-viewer";
import { WorkflowSummary } from "@/components/workflow-summary";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await pageT();
  const row = publicTemplate((await params).slug);
  if (!row) return {};
  return { title: row.title, description: localized(locale, { de: row.summary_de, en: row.summary_en }) };
}

export default async function TemplatePage({ params }: Props) {
  const { t, locale } = await pageT();
  const row = publicTemplate((await params).slug);
  if (!row) notFound();
  const previews = parseJsonColumn<PreviewInfo[]>(row.previews, []);
  const tags = parseJsonColumn<string[]>(row.tags, []);
  const analysis = parseJsonColumn<Analysis>(row.analysis, {});
  const versions = publishedVersions(row.t_id);
  const wanted = locale === "de" ? row.description_de : row.description_en;
  const description = wanted || row.description_de || row.description_en;
  const otherLanguage = !wanted && !!description;
  const wf = analysis.workflow;
  const viewer = row.kind === "workflow" ? await versionViewer(row, locale) : null;
  const number = (n: number) => n.toLocaleString(locale === "de" ? "de-DE" : "en-GB");

  return (
    <article className="template">
      <Link href="/#browse" className="back">
        <ArrowLeft size={14} aria-hidden="true" /> {t("Alle Vorlagen", "All templates")}
      </Link>
      <header className="template-head">
        <div className="template-title">
          <span className="badges">
            <span className="kind-badge">
              <KindIcon kind={row.kind} size={14} />
              {kindLabel(t, row.kind)}
            </span>
            {!!row.official && <OfficialBadge t={t} />}
          </span>
          <h1>{row.title}</h1>
          <p className="lede">{localized(locale, { de: row.summary_de, en: row.summary_en })}</p>
          <p className="byline">
            {t("von", "by")} <Link href={`/u/${row.author_handle}`}>{row.author_name}</Link>
            <span aria-hidden="true"> · </span>
            {t(`Version ${row.number}`, `Version ${row.number}`)}
            <span aria-hidden="true"> · </span>
            {formatDate(locale, row.published_at ?? row.t_published_at)}
          </p>
        </div>
        <div className="template-actions">
          <OpenInFlowplan
            template={{
              id: row.t_id,
              slug: row.slug,
              version: row.number,
              minVersion: row.min_version,
              sha256: row.sha256,
              title: row.title,
              kind: row.kind,
              author: row.author_name,
              license: row.license,
            }}
            defaultInstance={config.defaultInstance()}
          />
          <a className="button" href={`/api/templates/${row.slug}/download`} download>
            <DownloadSimple size={16} aria-hidden="true" />
            {t("Herunterladen", "Download")}
            <span className="muted">{formatBytes(row.size)}</span>
          </a>
          <p className="counts">
            {t(`${number(row.t_downloads)} Downloads · ${number(row.opens)}× in Flowplan geöffnet`, `${number(row.t_downloads)} downloads · opened ${number(row.opens)}× in Flowplan`)}
          </p>
        </div>
      </header>

      {!!previews.length && (
        <div className={`gallery count-${previews.length}`}>
          {previews.map((p, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={p.n} src={previewSrc(row.slug, row.number, p.n)} alt={t(`Vorschau ${i + 1} von „${row.title}“`, `Preview ${i + 1} of "${row.title}"`)} width={960} height={600} />
          ))}
        </div>
      )}

      {viewer && (
        <section className="workflow-view" aria-labelledby="workflow-view-title">
          <h2 id="workflow-view-title">{t("Ablauf ansehen", "Look at the flow")}</h2>
          <WorkflowViewer data={viewer} />
        </section>
      )}

      <div className="template-body">
        <div className="template-main">
          {description ? (
            <>
              {otherLanguage && <p className="note">{t("Nur auf Englisch beschrieben.", "Only described in German.")}</p>}
              <Markdown source={description} />
            </>
          ) : (
            <p className="muted">{t("Keine ausführliche Beschreibung.", "No detailed description.")}</p>
          )}

          {wf && (
            <section className="box">
              <h2>{t("Was dieser Workflow tut", "What this workflow does")}</h2>
              {viewer && <WorkflowSummary view={viewer.view} t={t} />}
              <ul className="facts">
                {!viewer && (
                  <li className="plain">
                    {t(`${wf.nodeCount} Schritte`, `${wf.nodeCount} steps`)}
                    {wf.triggers.length ? ` · ${t("startet bei", "starts on")} ${wf.triggers.map((x) => x.replace(/^trigger\./, "")).join(", ")}` : ""}
                  </li>
                )}
                {wf.hosts.length > 0 && (
                  <li>
                    <Globe size={15} aria-hidden="true" />
                    <span>
                      {t("Spricht externe Dienste an:", "Talks to external services:")} <code>{wf.hosts.join(", ")}</code>
                    </span>
                  </li>
                )}
                {wf.ai && (
                  <li>
                    <Robot size={15} aria-hidden="true" />
                    <span>{t("Nutzt KI-Schritte (deine KI-Einstellungen)", "Uses AI steps (your AI settings)")}</span>
                  </li>
                )}
                {wf.email && (
                  <li>
                    <EnvelopeSimple size={15} aria-hidden="true" />
                    <span>{t("Verschickt oder empfängt E-Mails", "Sends or receives e-mail")}</span>
                  </li>
                )}
                <li>
                  <Lock size={15} aria-hidden="true" />
                    <span>{t("Kommt pausiert an, ohne Zugangsdaten – du prüfst und aktivierst ihn selbst.", "Arrives paused, without credentials – you review and activate it yourself.")}</span>
                </li>
              </ul>
            </section>
          )}
          {analysis.fields !== undefined && (
            <section className="box">
              <h2>{t("Inhalt", "Contents")}</h2>
              <p>{t(`${analysis.fields} Eigenschaften, ${analysis.views} Ansichten, ${analysis.rows ?? 0} Beispieleinträge`, `${analysis.fields} properties, ${analysis.views} views, ${analysis.rows ?? 0} example rows`)}</p>
            </section>
          )}

          {versions.length > 0 && (
            <section className="versions">
              <h2>{t("Versionen", "Versions")}</h2>
              <ol>
                {versions.map((v) => (
                  <li key={v.id}>
                    <div>
                      <strong>{t(`Version ${v.number}`, `Version ${v.number}`)}</strong>
                      <span className="muted"> · {formatDate(locale, v.published_at ?? v.submitted_at)} · Flowplan ≥ {v.min_version}</span>
                      {v.changelog && <p>{v.changelog}</p>}
                    </div>
                    <a href={`/api/templates/${row.slug}/download?version=${v.number}`} download>
                      {t("Herunterladen", "Download")}
                    </a>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>

        <aside className="template-side">
          <dl className="meta">
            <dt>{t("Kategorie", "Category")}</dt>
            <dd>
              <Link href={`/?category=${row.category}#browse`}>{categoryLabel(t, row.category)}</Link>
            </dd>
            <dt>{t("Sprache", "Language")}</dt>
            <dd>{languageLabel(t, row.language)}</dd>
            <dt>{t("Benötigt", "Requires")}</dt>
            <dd>Flowplan {row.min_version}+</dd>
            <dt>{t("Lizenz", "License")}</dt>
            <dd>
              <a href={LICENSE_URLS[row.license as License] ?? "#"} rel="noopener noreferrer license">
                {licenseLabel(t, row.license)}
              </a>
            </dd>
            <dt>{t("Größe", "Size")}</dt>
            <dd>{formatBytes(row.size)}</dd>
          </dl>
          {tags.length > 0 && (
            <ul className="tags" aria-label={t("Schlagwörter", "Tags")}>
              {tags.map((tag) => (
                <li key={tag}>
                  <Link href={`/?q=${encodeURIComponent(tag)}#browse`}>#{tag}</Link>
                </li>
              ))}
            </ul>
          )}
          <p className="checksum">
            SHA-256 <code>{row.sha256.slice(0, 16)}…</code>
          </p>
          <ReportButton slug={row.slug} />
        </aside>
      </div>
    </article>
  );
}
