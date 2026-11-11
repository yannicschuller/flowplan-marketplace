"use client";
// "Melden": anyone can report a template, no account needed (rate-limited).
import { useState } from "react";
import { useT } from "./i18n";
import { REPORT_REASONS, reportReasonLabel } from "@/lib/report-reasons";
import { Flag } from "@phosphor-icons/react/dist/ssr/Flag";

export function ReportButton({ slug }: { slug: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "limited" | "error">("idle");

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    const r = await fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, reason, text }) }).catch(() => null);
    setState(r?.ok ? "sent" : r?.status === 429 ? "limited" : "error");
  }

  if (state === "sent") return <p className="notice success">{t("Danke! Wir sehen uns das an.", "Thanks! We'll take a look.")}</p>;
  if (!open)
    return (
      <button type="button" className="button ghost small report" onClick={() => setOpen(true)}>
        <Flag size={14} aria-hidden="true" />
        {t("Melden", "Report")}
      </button>
    );
  return (
    <form className="report-form" onSubmit={send}>
      <fieldset>
        <legend>{t("Was stimmt mit dieser Vorlage nicht?", "What's wrong with this template?")}</legend>
        {REPORT_REASONS.map((r) => (
          <label key={r} className="radio">
            <input type="radio" name="reason" value={r} checked={reason === r} onChange={() => setReason(r)} required />
            {reportReasonLabel(t, r)}
          </label>
        ))}
      </fieldset>
      <label htmlFor="report-text">{t("Details (optional)", "Details (optional)")}</label>
      <textarea id="report-text" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} rows={3} />
      {state === "limited" && <p className="field-error">{t("Zu viele Meldungen – bitte versuch es später.", "Too many reports – please try again later.")}</p>}
      {state === "error" && <p className="field-error">{t("Das hat nicht geklappt.", "That didn't work.")}</p>}
      <div className="row">
        <button type="submit" className="button primary small" disabled={!reason || state === "sending"}>
          {t("Meldung senden", "Send report")}
        </button>
        <button type="button" className="button ghost small" onClick={() => setOpen(false)}>
          {t("Abbrechen", "Cancel")}
        </button>
      </div>
    </form>
  );
}
