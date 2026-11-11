"use client";
import { useState } from "react";
import { useT } from "./i18n";

export function WithdrawButton({ versionId, csrf, published }: { versionId: string; csrf: string; published: boolean }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  async function withdraw() {
    const question = published
      ? t("Vorlage aus dem Marketplace nehmen? Das kann nicht rückgängig gemacht werden.", "Take the template out of the marketplace? This can't be undone.")
      : t("Einreichung zurückziehen?", "Withdraw this submission?");
    if (!confirm(question)) return;
    setBusy(true);
    const r = await fetch(`/api/submissions/${versionId}/withdraw`, { method: "POST", headers: { "x-csrf-token": csrf } }).catch(() => null);
    if (r?.ok) location.reload();
    else setBusy(false);
  }
  return (
    <button type="button" className="button ghost small danger" onClick={withdraw} disabled={busy}>
      {t("Zurückziehen", "Withdraw")}
    </button>
  );
}
