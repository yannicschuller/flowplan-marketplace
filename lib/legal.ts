// Legal texts (Impressum, Datenschutz, Nutzungsbedingungen) as Markdown
// files the operator fills in: <MARKETPLACE_LEGAL_DIR or data/legal>/<page>.<de|en>.md.
// Without them the placeholders in docs/legal/ are shown.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "./config";
import type { Locale } from "./i18n";

export const LEGAL_PAGES = ["impressum", "datenschutz", "nutzungsbedingungen"] as const;
export type LegalPage = (typeof LEGAL_PAGES)[number];

export function legalText(page: LegalPage, locale: Locale): { text: string; placeholder: boolean } {
  const other: Locale = locale === "de" ? "en" : "de";
  for (const [dir, placeholder] of [
    [config.legalDir(), false],
    [resolve(process.cwd(), "docs/legal"), true],
  ] as const)
    for (const l of [locale, other]) {
      const file = join(dir, `${page}.${l}.md`);
      if (existsSync(file)) return { text: readFileSync(file, "utf8").slice(0, 100_000), placeholder };
    }
  return { text: "", placeholder: true };
}
