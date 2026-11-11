import { pageT } from "@/lib/page";
import { termsText } from "@/lib/legal";
import { Markdown } from "./markdown";

// The marketplace's Nutzungsbedingungen (content/legal/).
export async function LegalPage() {
  const { locale } = await pageT();
  return (
    <article className="narrow legal">
      <Markdown source={termsText(locale)} headingOffset={0} />
    </article>
  );
}
