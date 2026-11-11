import type { Metadata } from "next";
import { pageSession, pageT } from "@/lib/page";
import { one } from "@/lib/db";
import { config } from "@/lib/config";
import { mailConfigured } from "@/lib/mail";
import { parseJsonColumn, type TemplateRow, type VersionRow } from "@/lib/store";
import { SubmitForm, type Fields, type SubmitMode } from "@/components/submit-form";

export const metadata: Metadata = { title: "Einreichen / Submit", robots: { index: false } };

const fieldsOf = (v: VersionRow): Fields => ({
  title: v.title,
  summaryDe: v.summary_de,
  summaryEn: v.summary_en,
  descriptionDe: v.description_de,
  descriptionEn: v.description_en,
  category: v.category,
  tags: parseJsonColumn<string[]>(v.tags, []).join(", "),
  language: v.language,
  minVersion: v.min_version,
  license: v.license,
  rights: false,
  changelog: v.changelog,
});

export default async function SubmitPage({ searchParams }: { searchParams: Promise<{ template?: string; edit?: string }> }) {
  await pageT();
  const session = await pageSession();
  const sp = await searchParams;
  let mode: SubmitMode = { type: "new" };
  let initial: Fields | null = null;
  if (session && sp.edit) {
    const v = one<VersionRow & { author_id: string; kind: string }>("SELECT v.*, t.author_id, t.kind FROM versions v JOIN templates t ON t.id=v.template_id WHERE v.id=?", sp.edit);
    if (v && v.author_id === session.user.id && (v.status === "submitted" || v.status === "changes_requested")) {
      mode = { type: "edit", versionId: v.id, status: v.status, kind: v.kind, number: v.number };
      initial = fieldsOf(v);
    }
  } else if (session && sp.template) {
    const tpl = one<TemplateRow>("SELECT * FROM templates WHERE id=?", sp.template);
    const v = tpl?.published_version_id ? one<VersionRow>("SELECT * FROM versions WHERE id=?", tpl.published_version_id) : undefined;
    if (tpl && v && tpl.author_id === session.user.id && !tpl.withdrawn_at) {
      mode = { type: "version", templateId: tpl.id, title: v.title, kind: tpl.kind };
      initial = { ...fieldsOf(v), changelog: "" };
    }
  }
  const query = new URLSearchParams({ restore: "1", ...(sp.template ? { template: sp.template } : {}), ...(sp.edit ? { edit: sp.edit } : {}) });
  return (
    <SubmitForm
      session={session ? { name: session.user.name, csrf: session.csrf } : null}
      mode={mode}
      initial={initial}
      login={{ github: !!config.github(), email: mailConfigured() || config.demo(), demo: config.demo() }}
      returnTo={`/submit?${query}`}
    />
  );
}
