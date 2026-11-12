"use client";
// The address field for the visitor's own Flowplan instance (§3.1), shared by
// the "In Flowplan öffnen" box and the "Instanz übernommen" notice.
import { useEffect, useRef, useState } from "react";
import { useT } from "./i18n";
import { checkInstanceUrl } from "@/lib/handover";
import { Warning } from "@phosphor-icons/react/dist/ssr/Warning";

export function InstanceForm({
  id,
  title,
  hint,
  initial,
  focus,
  onSave,
  children,
}: {
  id: string;
  title?: string;
  hint: string;
  initial: string;
  focus?: boolean;
  onSave: (origin: string) => void;
  children?: React.ReactNode;
}) {
  const t = useT();
  const [draft, setDraft] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const check = draft ? checkInstanceUrl(draft) : null;

  useEffect(() => {
    if (focus) input.current?.focus();
  }, [focus]);

  function save(e: React.FormEvent) {
    e.preventDefault();
    const result = checkInstanceUrl(draft);
    if (result.ok) onSave(result.origin);
  }

  return (
    // noValidate: our own check accepts a bare host ("flowplan.example.org"),
    // which the browser's type="url" check would block.
    <form className="instance-form" onSubmit={save} noValidate>
      {title && <label htmlFor={id}>{title}</label>}
      <p className="hint">{hint}</p>
      <div className="row">
        <input ref={input} id={id} type="url" inputMode="url" placeholder="https://flowplan.example.org" value={draft} onChange={(e) => setDraft(e.target.value)} autoComplete="url" required aria-label={title ? undefined : t("Adresse deiner Flowplan-Instanz", "Address of your Flowplan instance")} />
        <button type="submit" className="button primary" disabled={!check?.ok}>
          {t("Speichern", "Save")}
        </button>
      </div>
      {check && !check.ok && draft.length > 3 && (
        <p className="field-error">
          {check.error === "http-public"
            ? t("Bitte eine https-Adresse – http nur für localhost und private Netze.", "Please use an https address – http only for localhost and private networks.")
            : t("Das ist keine gültige Adresse.", "That's not a valid address.")}
        </p>
      )}
      {check?.ok && check.warning && (
        <p className="field-warning">
          <Warning size={14} aria-hidden="true" /> {t("Unverschlüsselte Verbindung (http) – nur im eigenen Netz verwenden.", "Unencrypted connection (http) – only use this on your own network.")}
        </p>
      )}
      <p className="hint">{t("Bleibt nur in diesem Browser gespeichert – der Marketplace erfährt sie nie.", "Only stored in this browser – the marketplace never learns it.")}</p>
      {children}
    </form>
  );
}
