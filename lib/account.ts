// Deleting an account – by the author on /me (POST /api/me/delete) or by an
// admin on request (POST /api/admin/users/:id/delete). Everything that is the
// author's goes: the user row, sessions, sign-in links, rate-limit keys, all
// templates with every version, their package and preview files, their
// download/open counters and the reports about them (a report about a
// template that no longer exists has nothing left to act on). The audit log
// keeps its entries, but the author's name, handle and e-mail address in them
// become "gelöschtes Konto". The built-in author "Flowplan" can't be deleted.
import { all, one, run, transaction } from "./db";
import { HttpError } from "./http";
import { sha256 } from "./secret";
import { removeVersionFiles } from "./storage";
import { sendMail } from "./mail";
import { parseJsonColumn } from "./store";
import type { User } from "./auth";

export const DELETED_ACCOUNT = "gelöschtes Konto";

export type DeletionSummary = { templates: number; published: number; versions: number; reports: number };

// Every string in a JSON value with the given words replaced.
function scrub(value: unknown, words: string[]): unknown {
  if (typeof value === "string") return words.reduce((s, w) => s.split(w).join(DELETED_ACCOUNT), value);
  if (Array.isArray(value)) return value.map((v) => scrub(v, words));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, words)]));
  return value;
}

export function requireDeletableUser(idOrHandle: string): User {
  const user = one<User>("SELECT * FROM users WHERE id=? OR handle=?", idOrHandle, idOrHandle);
  if (!user) throw new HttpError(404, "not_found", "User not found.");
  if (user.system) throw new HttpError(403, "system_account", "The built-in author of the official templates can't be deleted.");
  return user;
}

// Deletes the account and returns what went. `audit` writes the one entry
// about the deletion (lib/admin.ts passes its audit(); it is called inside
// the transaction, after the old entries were made anonymous).
export async function deleteAccount(
  user: User,
  opts: { actor: string; reason?: string; audit: (actor: string, action: string, target: string, details: Record<string, unknown>) => void },
): Promise<{ deleted: true; notified: boolean } & DeletionSummary> {
  const fresh = requireDeletableUser(user.id);
  const email = fresh.email;
  const templates = all<{ id: string; published_version_id: string | null; unpublished_at: number | null; withdrawn_at: number | null }>(
    "SELECT id,published_version_id,unpublished_at,withdrawn_at FROM templates WHERE author_id=?",
    fresh.id,
  );
  const templateIds = templates.map((t) => t.id);
  const versionIds = templateIds.flatMap((id) => all<{ id: string }>("SELECT id FROM versions WHERE template_id=?", id).map((v) => v.id));
  const summary: DeletionSummary = {
    templates: templates.length,
    published: templates.filter((t) => t.published_version_id && !t.unpublished_at && !t.withdrawn_at).length,
    versions: versionIds.length,
    reports: 0,
  };
  const words = [fresh.email, fresh.name, fresh.github_login, fresh.handle].filter((w): w is string => !!w && w.length >= 3);
  const targets = new Set([fresh.id, ...templateIds, ...versionIds]);

  transaction(() => {
    // Audit: entries about the account, its templates and versions keep
    // their action and time; the author's identity in them is replaced. The
    // e-mail address is replaced in every entry.
    for (const e of all<{ id: number; target: string; details: string }>("SELECT id,target,details FROM audit")) {
      const related = targets.has(e.target);
      const mentionsEmail = !!email && e.details.includes(email);
      if (!related && !mentionsEmail) continue;
      const details = scrub(parseJsonColumn<Record<string, unknown>>(e.details, {}), related ? words : [email!]) as Record<string, unknown>;
      if (related) details.author = DELETED_ACCOUNT;
      run("UPDATE audit SET details=? WHERE id=?", JSON.stringify(details), e.id);
    }
    for (const id of templateIds) summary.reports += Number(run("DELETE FROM reports WHERE template_id=?", id).changes);
    for (const id of templateIds) run("DELETE FROM versions WHERE template_id=?", id);
    run("DELETE FROM templates WHERE author_id=?", fresh.id);
    run("DELETE FROM sessions WHERE user_id=?", fresh.id);
    if (email) {
      run("DELETE FROM magic_links WHERE email=?", email);
      run("DELETE FROM rate_limits WHERE key=?", `login-mail:${sha256(email).slice(0, 24)}`);
    }
    run("DELETE FROM rate_limits WHERE key=?", `submit:${fresh.id}`);
    run("DELETE FROM users WHERE id=?", fresh.id);
    opts.audit(opts.actor, "account_deleted", fresh.id, { author: DELETED_ACCOUNT, ...(opts.reason ? { reason: opts.reason } : {}), ...summary });
  });
  // The files after the commit: a failed transaction leaves them in place.
  for (const id of versionIds) {
    try {
      removeVersionFiles(id);
    } catch (error) {
      console.error("could not remove files of version", id, error);
    }
  }

  // The address only lives on in this message; it is not stored anywhere.
  let notified = false;
  if (email) {
    const lines = (de: boolean) =>
      de
        ? [
            `Hallo ${fresh.name},`,
            "",
            "dein Konto beim Flowplan Marketplace ist gelöscht.",
            `Entfernt: dein Konto mit Name und Anmeldedaten, ${summary.templates} Vorlage(n) mit ${summary.versions} Version(en) samt Paketen und Vorschaubildern. Veröffentlichte Vorlagen sind nicht mehr im Marketplace.`,
            "Kopien, die andere schon heruntergeladen haben, bleiben bei ihnen und dürfen nach ihrer Lizenz weiter genutzt werden.",
            "",
            "Wenn du das nicht warst, antworte bitte auf diese E-Mail.",
          ]
        : [
            `Hi ${fresh.name},`,
            "",
            "your Flowplan Marketplace account has been deleted.",
            `Removed: your account with its name and sign-in details, ${summary.templates} template(s) with ${summary.versions} version(s) including packages and preview images. Published templates are no longer in the marketplace.`,
            "Copies others have already downloaded stay with them and may still be used under their licence.",
            "",
            "If this wasn't you, please reply to this e-mail.",
          ];
    notified = await sendMail({
      to: email,
      subject: "Dein Konto ist gelöscht / Your account has been deleted",
      text: [...lines(true), "", "—", "", ...lines(false)].join("\n"),
    });
  }
  return { deleted: true, notified, ...summary };
}
