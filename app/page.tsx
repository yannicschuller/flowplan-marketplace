import Link from "next/link";
import { pageT } from "@/lib/page";
import { categoryCounts, kindCounts, publicTemplates } from "@/lib/store";
import { CATEGORIES, KINDS, categoryLabel, kindLabel } from "@/lib/catalog";
import { TemplateCard } from "@/components/template-card";
import { KindIcon } from "@/components/kind-icon";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/ssr/MagnifyingGlass";
import { SealCheck } from "@phosphor-icons/react/dist/ssr/SealCheck";

type Search = { q?: string; kind?: string; category?: string; sort?: string; lang?: string; official?: string };

export default async function Home({ searchParams }: { searchParams: Promise<Search> }) {
  const { t, locale } = await pageT();
  const sp = await searchParams;
  const kind = (KINDS as readonly string[]).includes(sp.kind ?? "") ? sp.kind : undefined;
  const category = (CATEGORIES as readonly string[]).includes(sp.category ?? "") ? sp.category : undefined;
  const q = (sp.q ?? "").slice(0, 100);
  const sort = ["newest", "popular", "title"].includes(sp.sort ?? "") ? sp.sort : "newest";
  // "Official only": the templates built into Flowplan (lib/official.ts).
  const official = sp.official === "1" ? "1" : undefined;
  const filtering = !!(q || kind || category || sp.sort || official);
  const officialCount = publicTemplates({ official: true, limit: 1 }).total;
  const kinds = new Map(kindCounts().map((k) => [k.kind, k.n]));
  const categories = new Map(categoryCounts().map((c) => [c.category, c.n]));
  const link = (change: Partial<Search>) => {
    const p = new URLSearchParams();
    const next = { q, kind, category, sort: sp.sort, official, ...change };
    for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/?${s}#browse` : "/#browse";
  };

  const results = filtering ? publicTemplates({ q, kind, category, sort, official: !!official, limit: 60 }) : null;
  const featured = filtering ? null : publicTemplates({ featured: true, limit: 6 }).rows;
  const newest = filtering ? null : publicTemplates({ sort: "newest", limit: 6 }).rows;
  const popular = filtering ? null : publicTemplates({ sort: "popular", limit: 6 }).rows;

  return (
    <>
      <section className="hero">
        <p className="eyebrow">Flowplan Marketplace</p>
        <h1>{t("Vorlagen, die andere schon ausprobiert haben.", "Templates others have already tried out.")}</h1>
        <p className="lede">
          {t(
            "Dokumente, Datenbanken, Workflows, Whiteboards und Erscheinungsbilder für Flowplan – geteilt von der Community, vor der Veröffentlichung geprüft. Mit einem Klick in deiner eigenen Instanz.",
            "Documents, databases, workflows, whiteboards and looks for Flowplan – shared by the community, reviewed before they go live. One click and they're in your own instance.",
          )}
        </p>
        <form className="search" action="/" method="get" role="search">
          <MagnifyingGlass size={18} aria-hidden="true" />
          <input type="search" name="q" defaultValue={q} placeholder={t("Vorlagen suchen …", "Search templates …")} aria-label={t("Vorlagen suchen", "Search templates")} maxLength={100} />
          {kind && <input type="hidden" name="kind" value={kind} />}
          {category && <input type="hidden" name="category" value={category} />}
          {official && <input type="hidden" name="official" value={official} />}
          <button type="submit" className="button primary">
            {t("Suchen", "Search")}
          </button>
        </form>
      </section>

      <section id="browse" className="browse">
        <div className="chips" aria-label={t("Art", "Kind")}>
          <Link href={link({ kind: undefined })} className={`chip${!kind ? " active" : ""}`}>
            {t("Alle", "All")}
          </Link>
          {KINDS.map((k) => (
            <Link key={k} href={link({ kind: kind === k ? undefined : k })} className={`chip${kind === k ? " active" : ""}`}>
              <KindIcon kind={k} size={15} />
              {kindLabel(t, k)}
              <span className="chip-count">{kinds.get(k) ?? 0}</span>
            </Link>
          ))}
          {officialCount > 0 && (
            <Link href={link({ official: official ? undefined : "1" })} className={`chip chip-official${official ? " active" : ""}`}>
              <SealCheck size={15} weight="fill" aria-hidden="true" />
              {t("Nur offizielle", "Official only")}
              <span className="chip-count">{officialCount}</span>
            </Link>
          )}
        </div>

        {results ? (
          <>
            <div className="results-head">
              <h2>
                {results.total === 1 ? t("1 Vorlage", "1 template") : t(`${results.total} Vorlagen`, `${results.total} templates`)}
                {category && <span className="muted"> · {categoryLabel(t, category)}</span>}
              </h2>
              <div className="sort">
                {(["newest", "popular", "title"] as const).map((s) => (
                  <Link key={s} href={link({ sort: s })} className={sort === s ? "active" : ""}>
                    {{ newest: t("Neueste", "Newest"), popular: t("Beliebt", "Popular"), title: t("A–Z", "A–Z") }[s]}
                  </Link>
                ))}
                <Link href="/#browse" className="reset">
                  {t("Filter zurücksetzen", "Clear filters")}
                </Link>
              </div>
            </div>
            {results.rows.length ? (
              <div className="grid">
                {results.rows.map((row) => (
                  <TemplateCard key={row.t_id} row={row} locale={locale} />
                ))}
              </div>
            ) : (
              <p className="empty">{t("Nichts gefunden. Versuch es mit einem anderen Wort.", "Nothing found. Try another word.")}</p>
            )}
          </>
        ) : (
          <>
            {!!featured?.length && (
              <Section title={t("Empfohlen", "Featured")} more={link({ sort: "popular" })} moreLabel={t("Alle beliebten", "All popular")}>
                {featured.map((row) => (
                  <TemplateCard key={row.t_id} row={row} locale={locale} />
                ))}
              </Section>
            )}
            <Section title={t("Neu im Marketplace", "New in the marketplace")} more={link({ sort: "newest" })} moreLabel={t("Alle neuen", "All new")}>
              {newest!.map((row) => (
                <TemplateCard key={row.t_id} row={row} locale={locale} />
              ))}
            </Section>
            <section className="section">
              <h2>{t("Kategorien", "Categories")}</h2>
              <div className="categories">
                {CATEGORIES.map((c) => (
                  <Link key={c} href={link({ category: c })} className="category">
                    <span>{categoryLabel(t, c)}</span>
                    <span className="muted">{categories.get(c) ?? 0}</span>
                  </Link>
                ))}
              </div>
            </section>
            <Section title={t("Beliebt", "Popular")} more={link({ sort: "popular" })} moreLabel={t("Mehr", "More")}>
              {popular!.map((row) => (
                <TemplateCard key={row.t_id} row={row} locale={locale} />
              ))}
            </Section>
            <section className="section share">
              <div>
                <h2>{t("Teile deine Vorlage", "Share your template")}</h2>
                <p>
                  {t(
                    "In Flowplan: Vorlagenmenü → „Im Marketplace veröffentlichen…“. Oder lade eine .flowplan-template-Datei hoch. Wir prüfen jede Einreichung, bevor sie erscheint.",
                    'In Flowplan: template menu → "Publish in the marketplace…". Or upload a .flowplan-template file. We review every submission before it appears.',
                  )}
                </p>
              </div>
              <Link href="/submit" className="button primary">
                {t("Vorlage einreichen", "Submit a template")}
              </Link>
            </section>
          </>
        )}
      </section>
    </>
  );
}

function Section({ title, more, moreLabel, children }: { title: string; more: string; moreLabel: string; children: React.ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <h2>{title}</h2>
        <Link href={more}>{moreLabel} →</Link>
      </div>
      <div className="grid">{children}</div>
    </section>
  );
}
