// Admin edits as the author sees them (e-mail, /me) – lib/admin-edit.ts.

// One entry of versions.admin_edits. `notify`: the author was meant to hear
// about it (e-mail if there is an address; /me shows it either way).
export type AdminEdit = { at: number; by: string; fields: string[]; message?: string; notify: boolean; notified?: boolean };

// Field names for the author's e-mail and /me.
export const FIELD_LABELS: Record<string, [string, string]> = {
  title: ["Titel", "title"],
  "title.de": ["Titel (Deutsch)", "title (German)"],
  "title.en": ["Titel (Englisch)", "title (English)"],
  "summary.de": ["Kurzbeschreibung (Deutsch)", "summary (German)"],
  "summary.en": ["Kurzbeschreibung (Englisch)", "summary (English)"],
  "description.de": ["Beschreibung (Deutsch)", "description (German)"],
  "description.en": ["Beschreibung (Englisch)", "description (English)"],
  category: ["Kategorie", "category"],
  tags: ["Schlagwörter", "tags"],
  language: ["Sprache", "language"],
  minVersion: ["Mindestversion von Flowplan", "minimum Flowplan version"],
  slug: ["Adresse", "address"],
  previews: ["Vorschaubilder", "previews"],
  package: ["Paket", "package"],
};
export const fieldLabels = (fields: string[], lang: "de" | "en") => fields.map((f) => FIELD_LABELS[f]?.[lang === "de" ? 0 : 1] ?? f).join(", ");

