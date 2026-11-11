// Why a template can be reported (client-safe).
export const REPORT_REASONS = ["spam", "malicious", "copyright", "inappropriate", "broken", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

type T = (de: string, en: string) => string;
export const reportReasonLabel = (t: T, reason: string) =>
  ({
    spam: t("Spam oder Werbung", "Spam or advertising"),
    malicious: t("Schädlich oder gefährlich", "Harmful or dangerous"),
    copyright: t("Verletzt Rechte (Urheberrecht, Marke)", "Infringes rights (copyright, trademark)"),
    inappropriate: t("Unangemessener Inhalt", "Inappropriate content"),
    broken: t("Funktioniert nicht", "Doesn't work"),
    other: t("Etwas anderes", "Something else"),
  })[reason] ?? reason;

