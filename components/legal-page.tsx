import { pageT } from "@/lib/page";
import { termsText } from "@/lib/legal";
import { parseMarkdown } from "@/lib/markdown";
import { Markdown } from "./markdown";

// The marketplace's own Nutzungsbedingungen (without MARKETPLACE_TERMS_URL).
export async function LegalPage() {
  const { t, locale } = await pageT();
  const { text, placeholder } = termsText(locale);
  return (
    <article className="narrow legal">
      {placeholder && <p className="notice warning">{t("Platzhalter – der Betreiber hat diesen Text noch nicht hinterlegt.", "Placeholder – the operator hasn't provided this text yet.")}</p>}
      {parseMarkdown(text).length ? <Markdown source={text} headingOffset={0} /> : null}
    </article>
  );
}
