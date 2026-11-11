import type { Metadata } from "next";
import { pageT } from "@/lib/page";

export const metadata: Metadata = { title: "Anmelden / Sign in", robots: { index: false }, referrer: "no-referrer" };

// The link from the e-mail lands here; only the button uses it up, so mail
// scanners that open links don't sign anyone in.
export default async function ConfirmPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { t } = await pageT();
  const token = (await searchParams).token ?? "";
  return (
    <div className="narrow">
      <header className="page-head">
        <h1>{t("Fast geschafft", "Almost there")}</h1>
        <p className="lede">{t("Bestätige, dass du dich beim Flowplan Marketplace anmelden möchtest.", "Confirm that you want to sign in to Flowplan Marketplace.")}</p>
      </header>
      <form action="/api/auth/email/confirm" method="post">
        <input type="hidden" name="token" value={token} />
        <button type="submit" className="button primary big">
          {t("Jetzt anmelden", "Sign in now")}
        </button>
      </form>
    </div>
  );
}
