// Reports about published templates: anyone may send one (no account),
// rate-limited per hashed IP; admins see and resolve them (lib/admin.ts).
import { newId, now, run } from "./db";
import { HttpError } from "./http";
import { hit, ipKey } from "./rate-limit";
import { publicTemplate } from "./store";
import { REPORT_REASONS, type ReportReason } from "./report-reasons";

export { REPORT_REASONS };

export const REPORT_LIMITS = { perHour: 5, perTemplatePerDay: 1 };

export function createReport(input: { slug?: unknown; reason?: unknown; text?: unknown }, ip: string, at = now()) {
  const reason = typeof input.reason === "string" && (REPORT_REASONS as readonly string[]).includes(input.reason) ? (input.reason as ReportReason) : null;
  if (!reason) throw new HttpError(400, "invalid_reason", "Please choose a reason.");
  const text = typeof input.text === "string" ? input.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, 2000) : "";
  const template = typeof input.slug === "string" ? publicTemplate(input.slug) : null;
  if (!template) throw new HttpError(404, "not_found", "Template not found.");
  const key = ipKey(ip, at);
  hit(`report:${key}`, REPORT_LIMITS.perHour, 3600, at);
  hit(`report:${key}:${template.t_id}`, REPORT_LIMITS.perTemplatePerDay, 86_400, at);
  const id = newId();
  run("INSERT INTO reports(id,template_id,version_id,reason,text,created_at) VALUES(?,?,?,?,?,?)", id, template.t_id, template.id, reason, text, at);
  return { id };
}
