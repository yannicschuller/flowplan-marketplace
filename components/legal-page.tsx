import { pageT } from "@/lib/page";
import { legalText, type LegalPage as Page } from "@/lib/legal";
import { parseMarkdown } from "@/lib/markdown";
import { Markdown } from "./markdown";

export async function LegalPage({ page }: { page: Page }) {
  const { t, locale } = await pageT();
  const { text, placeholder } = legalText(page, locale);
  return (
    <article className="narrow legal">
      {placeholder && <p className="notice warning">{t("Platzhalter – der Betreiber hat diesen Text noch nicht hinterlegt.", "Placeholder – the operator hasn't provided this text yet.")}</p>}
      {parseMarkdown(text).length ? <Markdown source={text} headingOffset={0} /> : null}
    </article>
  );
}
