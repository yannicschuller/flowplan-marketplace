"use client";
// A Flowplan instance links to the marketplace with `#from=<its origin>`.
// On any page: take that origin as the saved instance, remove the fragment
// from the address bar, and say so once when it changed. The fragment is
// never sent to the server – browsers don't send it, and nothing here logs
// or posts it anywhere.
import { useEffect, useState } from "react";
import { useT } from "./i18n";
import { INSTANCE_EDIT_EVENT, hostOf, parseFromFragment, readSavedInstance, writeSavedInstance } from "@/lib/instance";
import { InstanceForm } from "./instance-form";
import { X } from "@phosphor-icons/react/dist/ssr/X";

export function InstanceFromFragment() {
  const t = useT();
  const [taken, setTaken] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const read = () => {
      const from = parseFromFragment(location.hash);
      if (!from) return;
      // Leaves the path, the query (`?handover=1`) and other fragments alone.
      history.replaceState(null, "", location.pathname + location.search + from.rest);
      if (!from.origin) return;
      const before = readSavedInstance();
      writeSavedInstance(from.origin);
      if (before !== from.origin) {
        setTaken(from.origin);
        setEditing(false);
      }
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  if (!taken) return null;

  function change() {
    // The "In Flowplan öffnen" box on this page opens its own field when it
    // is there; elsewhere the field opens in the notice.
    const handled = !window.dispatchEvent(new CustomEvent(INSTANCE_EDIT_EVENT, { cancelable: true }));
    if (handled) setTaken(null);
    else setEditing(true);
  }

  return (
    <div className="instance-notice" role="status">
      <div className="instance-notice-bar">
        <p>
          {t("Instanz übernommen:", "Instance saved:")} <strong>{hostOf(taken)}</strong>
          {!editing && (
            <>
              <span aria-hidden="true"> · </span>
              <button type="button" className="link" onClick={change}>
                {t("ändern", "change")}
              </button>
            </>
          )}
        </p>
        <button type="button" className="icon-button" onClick={() => setTaken(null)} aria-label={t("Hinweis schließen", "Close notice")}>
          <X size={16} weight="bold" aria-hidden="true" />
        </button>
      </div>
      {editing && (
        <InstanceForm
          id="instance-notice"
          hint={t("Adresse deiner Flowplan-Instanz:", "Address of your Flowplan instance:")}
          initial={taken}
          focus
          onSave={(origin) => {
            writeSavedInstance(origin);
            setTaken(origin);
            setEditing(false);
          }}
        />
      )}
    </div>
  );
}
