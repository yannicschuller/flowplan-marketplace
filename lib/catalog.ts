// The fixed lists of the marketplace: kinds, categories (the ids of
// Flowplan's lib/template-categories.ts), languages and licences.
export const KINDS = ["document", "database", "workflow", "whiteboard", "appearance", "link-rules"] as const;
export type Kind = (typeof KINDS)[number];

export const CATEGORIES = ["projects", "meetings", "knowledge", "planning", "personal", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export const LANGUAGES = ["de", "en", "fr", "zh", "multi"] as const;
export type TemplateLanguage = (typeof LANGUAGES)[number];

export const LICENSES = ["CC-BY-4.0", "CC0-1.0", "MIT"] as const;
export type License = (typeof LICENSES)[number];
export const DEFAULT_LICENSE: License = "CC-BY-4.0";
export const LICENSE_URLS: Record<License, string> = {
  "CC-BY-4.0": "https://creativecommons.org/licenses/by/4.0/",
  "CC0-1.0": "https://creativecommons.org/publicdomain/zero/1.0/",
  MIT: "https://opensource.org/license/mit",
};

type T = (de: string, en: string) => string;
export const kindLabel = (t: T, kind: string) =>
  ({
    document: t("Dokument", "Document"),
    database: t("Datenbank", "Database"),
    workflow: t("Workflow", "Workflow"),
    whiteboard: t("Whiteboard", "Whiteboard"),
    appearance: t("Erscheinungsbild", "Appearance"),
    "link-rules": t("Automatische Links", "Automatic links"),
  })[kind] ?? kind;
export const categoryLabel = (t: T, category: string) =>
  ({
    projects: t("Projekte", "Projects"),
    meetings: t("Meetings", "Meetings"),
    knowledge: t("Wissen & Dokumentation", "Knowledge & documentation"),
    planning: t("Planung & Ziele", "Planning & goals"),
    personal: t("Persönlich", "Personal"),
    other: t("Sonstiges", "Other"),
  })[category] ?? category;
export const languageLabel = (t: T, language: string) =>
  ({
    de: "Deutsch",
    en: "English",
    fr: "Français",
    zh: "中文",
    multi: t("Mehrsprachig", "Multilingual"),
  })[language] ?? language;
export const licenseLabel = (t: T, license: string) =>
  ({
    "CC-BY-4.0": "CC BY 4.0",
    "CC0-1.0": t("CC0 (gemeinfrei)", "CC0 (public domain)"),
    MIT: "MIT",
  })[license] ?? license;
