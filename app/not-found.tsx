import Link from "next/link";
import { pageT } from "@/lib/page";

export default async function NotFound() {
  const { t } = await pageT();
  return (
    <div className="narrow">
      <header className="page-head">
        <h1>{t("Nicht gefunden", "Not found")}</h1>
        <p className="lede">{t("Diese Seite oder Vorlage gibt es nicht (mehr).", "This page or template doesn't exist (any more).")}</p>
      </header>
      <Link href="/" className="button primary">
        {t("Zum Marketplace", "To the marketplace")}
      </Link>
    </div>
  );
}
