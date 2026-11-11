"use client";
import { useState } from "react";
import { useT } from "./i18n";

export function ProfileForm({ name, csrf }: { name: string; csrf: string }) {
  const t = useT();
  const [value, setValue] = useState(name);
  const [state, setState] = useState<"idle" | "saved" | "error">("idle");
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch("/api/me", { method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ name: value }) }).catch(() => null);
    setState(r?.ok ? "saved" : "error");
  }
  return (
    <form className="row profile" onSubmit={save}>
      <input value={value} onChange={(e) => setValue(e.target.value)} minLength={2} maxLength={60} aria-label={t("Name", "Name")} required />
      <button type="submit" className="button">
        {t("Speichern", "Save")}
      </button>
      {state === "saved" && <span className="muted">{t("Gespeichert. Gilt für neue Versionen deiner Pakete.", "Saved. Applies to new versions of your packages.")}</span>}
      {state === "error" && <span className="field-error">{t("Das hat nicht geklappt.", "That didn't work.")}</span>}
    </form>
  );
}
