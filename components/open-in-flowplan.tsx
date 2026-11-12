"use client";
// "In Flowplan öffnen" (contract §3): opens <instance>/#marketplace-import,
// waits for {type: "flowplan-instance-ready", version} from exactly that
// window and origin, warns if the instance is older than the template's
// minVersion, then posts the package bytes to that origin only. The instance
// address stays in this browser (localStorage); the marketplace never learns it.
// Before an instance is saved, the configured default instance
// (MARKETPLACE_DEFAULT_INSTANCE, app.flowplan.org) is offered as one button.
import { useEffect, useRef, useState } from "react";
import { useT } from "./i18n";
import { checkInstanceUrl, importAddress, instanceTooOld, parseInstanceReady, templateMessage } from "@/lib/handover";
import { INSTANCE_CHANGED_EVENT, INSTANCE_EDIT_EVENT, boxMode, hostOf, readSavedInstance, writeSavedInstance } from "@/lib/instance";
import { InstanceForm } from "./instance-form";
import { ArrowSquareOut } from "@phosphor-icons/react/dist/ssr/ArrowSquareOut";
import { Warning } from "@phosphor-icons/react/dist/ssr/Warning";
import { CheckCircle } from "@phosphor-icons/react/dist/ssr/CheckCircle";

const ANSWER_TIMEOUT_MS = 90_000;

type TemplateInfo = { id: string; slug: string; version: number; minVersion: string; sha256: string; title: string; kind: string; author: string; license: string };
type State =
  | { step: "idle" }
  | { step: "waiting" }
  | { step: "older"; version: string }
  | { step: "sent" }
  | { step: "error"; reason: "popup" | "timeout" | "download" | "checksum" | "closed" };

async function sha256Hex(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function OpenInFlowplan({ template, defaultInstance }: { template: TemplateInfo; defaultInstance: string | null }) {
  const t = useT();
  const [saved, setSaved] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [state, setState] = useState<State>({ step: "idle" });
  const box = useRef<HTMLDivElement>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const proceed = useRef<(() => void) | null>(null);

  useEffect(() => {
    setSaved(readSavedInstance());
    // Another part of the page (the "Instanz übernommen" notice) changed or
    // wants to change the instance.
    const onChanged = (e: Event) => {
      setSaved((e as CustomEvent<string | null>).detail);
      setEditing(false);
    };
    const onEdit = (e: Event) => {
      e.preventDefault();
      setEditing(true);
      box.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    };
    window.addEventListener(INSTANCE_CHANGED_EVENT, onChanged);
    window.addEventListener(INSTANCE_EDIT_EVENT, onEdit);
    return () => {
      window.removeEventListener(INSTANCE_CHANGED_EVENT, onChanged);
      window.removeEventListener(INSTANCE_EDIT_EVENT, onEdit);
      cleanup.current?.();
    };
  }, []);

  const mode = boxMode(saved, defaultInstance, editing);
  const target = mode === "saved" ? saved : mode === "default" ? defaultInstance : null;
  const targetCheck = target ? checkInstanceUrl(target) : null;
  const defaultHost = defaultInstance ? hostOf(defaultInstance) : null;

  function open() {
    if (!targetCheck?.ok) {
      setEditing(true);
      return;
    }
    // The default instance counts as chosen from now on: next time the box
    // shows the compact "In <host> öffnen · ändern".
    if (mode === "default") {
      writeSavedInstance(targetCheck.origin);
      setSaved(targetCheck.origin);
    }
    cleanup.current?.();
    const origin = targetCheck.origin;
    // Opened right in the click (popup blockers); the window must keep its
    // opener, so no "noopener".
    const win = window.open(importAddress(origin), "_blank");
    if (!win) {
      setState({ step: "error", reason: "popup" });
      return;
    }
    setState({ step: "waiting" });
    const bytes = fetch(`/api/templates/${encodeURIComponent(template.slug)}/download?version=${template.version}&via=open`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error("download"))))
      .then(async (buffer) => {
        if ((await sha256Hex(buffer)) !== template.sha256) throw new Error("checksum");
        return buffer;
      });
    bytes.catch(() => {});
    let sent = false;
    const send = async () => {
      if (sent) return;
      sent = true;
      try {
        const buffer = await bytes;
        const message = templateMessage({
          id: template.id,
          version: template.version,
          bytes: buffer,
          sha256: template.sha256,
          slug: template.slug,
          title: template.title,
          kind: template.kind,
          author: template.author,
          license: template.license,
          url: `${location.origin}/t/${template.slug}`,
        });
        win.postMessage(message, origin, [buffer]);
        setState({ step: "sent" });
      } catch (error) {
        setState({ step: "error", reason: error instanceof Error && error.message === "checksum" ? "checksum" : "download" });
      }
      stop();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== win || event.origin !== origin) return;
      const ready = parseInstanceReady(event.data);
      if (!ready || sent) return;
      if (instanceTooOld(ready.version, template.minVersion) === "older") {
        proceed.current = send;
        setState({ step: "older", version: ready.version });
        return;
      }
      void send();
    };
    const timer = window.setTimeout(() => {
      if (!sent) setState({ step: "error", reason: "timeout" });
      stop();
    }, ANSWER_TIMEOUT_MS);
    const closed = window.setInterval(() => {
      if (win.closed && !sent) {
        setState({ step: "error", reason: "closed" });
        stop();
      }
    }, 1000);
    const stop = () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      window.clearInterval(closed);
      cleanup.current = null;
    };
    window.addEventListener("message", onMessage);
    cleanup.current = stop;
  }

  const errorText = (reason: string) =>
    ({
      popup: t("Dein Browser hat das neue Fenster blockiert. Erlaube Pop-ups für diese Seite und versuch es noch einmal.", "Your browser blocked the new window. Allow pop-ups for this site and try again."),
      timeout: t(
        "Deine Flowplan-Instanz hat nicht geantwortet. Stimmt die Adresse, und ist dort der Marketplace eingeschaltet (ab Flowplan 0.9.4)?",
        "Your Flowplan instance didn't answer. Is the address right, and is the marketplace switched on there (Flowplan 0.9.4 or later)?",
      ),
      closed: t("Das Flowplan-Fenster wurde geschlossen.", "The Flowplan window was closed."),
      download: t("Die Vorlage konnte nicht geladen werden. Versuch es gleich noch einmal.", "Couldn't load the template. Please try again in a moment."),
      checksum: t("Die geladene Datei stimmt nicht mit der Prüfsumme überein – abgebrochen.", "The downloaded file does not match its checksum – cancelled."),
    })[reason] ?? reason;

  const openLabel = (host: string) => (state.step === "waiting" ? t("Warte auf Flowplan …", "Waiting for Flowplan …") : t(`In ${host} öffnen`, `Open in ${host}`));

  return (
    <div className="open-flowplan" ref={box}>
      {mode === "field" ? (
        <InstanceForm
          key={saved ?? ""}
          id="instance"
          title={t("In Flowplan öffnen", "Open in Flowplan")}
          hint={t("Gib einmal die Adresse deiner Flowplan-Instanz an:", "Enter the address of your Flowplan instance once:")}
          initial={saved ?? ""}
          focus={editing}
          onSave={(origin) => {
            writeSavedInstance(origin);
            setSaved(origin);
            setEditing(false);
          }}
        >
          {editing && (
            <p className="instance-line">
              {defaultInstance && saved !== defaultInstance ? (
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    // Back to the preselected instance: forget the own one.
                    if (saved) writeSavedInstance(null);
                    setSaved(null);
                    setEditing(false);
                  }}
                >
                  {saved ? t(`Stattdessen ${defaultHost} verwenden`, `Use ${defaultHost} instead`) : t(`Zurück zu ${defaultHost}`, `Back to ${defaultHost}`)}
                </button>
              ) : null}
              {saved && defaultInstance && saved !== defaultInstance && <span aria-hidden="true"> · </span>}
              {saved && (
                <button type="button" className="link" onClick={() => setEditing(false)}>
                  {t("Abbrechen", "Cancel")}
                </button>
              )}
              {saved && !defaultInstance && (
                <>
                  <span aria-hidden="true"> · </span>
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      writeSavedInstance(null);
                      setSaved(null);
                      setEditing(false);
                    }}
                  >
                    {t("Adresse vergessen", "Forget address")}
                  </button>
                </>
              )}
            </p>
          )}
        </InstanceForm>
      ) : (
        <>
          <button type="button" className="button primary big" onClick={open} disabled={state.step === "waiting"}>
            <ArrowSquareOut size={18} weight="bold" aria-hidden="true" />
            {openLabel(target ? hostOf(target) : "Flowplan")}
          </button>
          <p className="instance-line">
            {mode === "saved" ? (
              <button type="button" className="link" onClick={() => setEditing(true)}>
                {t("Instanz ändern", "Change instance")}
              </button>
            ) : (
              <button type="button" className="link" onClick={() => setEditing(true)}>
                {t("Eigene Instanz verwenden …", "Use your own instance …")}
              </button>
            )}
          </p>
          {targetCheck?.ok && targetCheck.warning && (
            <p className="field-warning">
              <Warning size={14} aria-hidden="true" /> {t("Unverschlüsselte Verbindung (http).", "Unencrypted connection (http).")}
            </p>
          )}
        </>
      )}
      {state.step === "older" && (
        <div className="notice warning" role="alert">
          <p>
            {t(
              `Deine Instanz läuft mit Flowplan ${state.version || "?"}, diese Vorlage braucht ${template.minVersion} oder neuer. Der Import kann fehlschlagen.`,
              `Your instance runs Flowplan ${state.version || "?"}, this template needs ${template.minVersion} or later. The import may fail.`,
            )}
          </p>
          <div className="row">
            <button type="button" className="button" onClick={() => proceed.current?.()}>
              {t("Trotzdem senden", "Send anyway")}
            </button>
            <button
              type="button"
              className="button ghost"
              onClick={() => {
                cleanup.current?.();
                setState({ step: "idle" });
              }}
            >
              {t("Abbrechen", "Cancel")}
            </button>
          </div>
        </div>
      )}
      {state.step === "sent" && (
        <p className="notice success" role="status">
          <CheckCircle size={16} aria-hidden="true" /> {t("An Flowplan übergeben – dort geht es weiter.", "Handed over to Flowplan – continue there.")}
        </p>
      )}
      {state.step === "error" && (
        <p className="notice error" role="alert">
          {errorText(state.reason)}
        </p>
      )}
    </div>
  );
}
