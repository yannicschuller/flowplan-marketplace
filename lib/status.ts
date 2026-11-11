// The life of a submission (one version of a template), contract §4:
//
//   submitted ──review──▶ in_review ──publish──▶ published ──unpublish──▶ unpublished
//       │                    │ └──request_changes──▶ changes_requested      │ ▲
//       │                    └──reject──▶ rejected        │               republish
//       │                                                 └──resubmit──▶ submitted
//   (author) withdraw from submitted, in_review, changes_requested, published ▶ withdrawn
//
// An admin may decide straight from "submitted" (the review starts
// implicitly). A new version of a published template is a new submission;
// the published one stays until the new one is published.
export const STATUSES = ["submitted", "in_review", "changes_requested", "published", "rejected", "unpublished", "withdrawn"] as const;
export type Status = (typeof STATUSES)[number];
export type Action = "review" | "publish" | "request_changes" | "reject" | "resubmit" | "edit" | "withdraw" | "unpublish" | "republish";
export type Actor = "admin" | "author";

const RULES: Record<Action, { actor: Actor; from: Status[]; to: Status | null }> = {
  review: { actor: "admin", from: ["submitted"], to: "in_review" },
  publish: { actor: "admin", from: ["submitted", "in_review"], to: "published" },
  request_changes: { actor: "admin", from: ["submitted", "in_review"], to: "changes_requested" },
  reject: { actor: "admin", from: ["submitted", "in_review"], to: "rejected" },
  // The author sends a changed package or metadata back.
  resubmit: { actor: "author", from: ["changes_requested"], to: "submitted" },
  // Changing a submission nobody looks at yet keeps it "submitted".
  edit: { actor: "author", from: ["submitted"], to: "submitted" },
  withdraw: { actor: "author", from: ["submitted", "in_review", "changes_requested", "published"], to: "withdrawn" },
  unpublish: { actor: "admin", from: ["published"], to: "unpublished" },
  republish: { actor: "admin", from: ["unpublished"], to: "published" },
};

export class TransitionError extends Error {
  constructor(public from: Status, public action: Action) {
    super(`Cannot ${action} a submission that is ${from}.`);
  }
}

export function transition(from: Status, action: Action, actor: Actor): Status {
  const rule = RULES[action];
  if (!rule || rule.actor !== actor || !rule.from.includes(from)) throw new TransitionError(from, action);
  return rule.to!;
}
export const canTransition = (from: Status, action: Action, actor: Actor) => {
  try {
    transition(from, action, actor);
    return true;
  } catch {
    return false;
  }
};
// Still waiting for a decision.
export const PENDING: Status[] = ["submitted", "in_review", "changes_requested"];
export const isStatus = (value: unknown): value is Status => typeof value === "string" && (STATUSES as readonly string[]).includes(value);

type T = (de: string, en: string) => string;
export const statusLabel = (t: T, status: string) =>
  ({
    submitted: t("Eingereicht", "Submitted"),
    in_review: t("In Prüfung", "In review"),
    changes_requested: t("Änderungen nötig", "Changes requested"),
    published: t("Veröffentlicht", "Published"),
    rejected: t("Abgelehnt", "Rejected"),
    unpublished: t("Zurückgezogen (Admin)", "Unpublished (admin)"),
    withdrawn: t("Von dir zurückgezogen", "Withdrawn by you"),
  })[status] ?? status;
