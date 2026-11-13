"use client";
// /submit: receives a package from a Flowplan instance (contract §2) or from
// the upload field, checks it on the server (nothing stored yet), prefills
// the form and submits it. Sign-in can happen in between: the package waits
// in IndexedDB (components/pending-package.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "./i18n";
import { READY_MESSAGE, fromOpener, parsePackageMessage, MAX_PACKAGE_BYTES } from "@/lib/handover";
import { CATEGORIES, DEFAULT_LICENSE, KINDS, LANGUAGES, LICENSES, categoryLabel, kindLabel, languageLabel, licenseLabel, LICENSE_URLS } from "@/lib/catalog";
import { LIMITS } from "@/lib/limits";
import { formatBytes } from "@/lib/i18n";
import { clearPending, loadPending, savePending, type PendingPackage } from "./pending-package";
import { LoginOptions, type LoginConfig } from "./login-options";
import { UploadSimple } from "@phosphor-icons/react/dist/ssr/UploadSimple";
import { Warning } from "@phosphor-icons/react/dist/ssr/Warning";
import { Info } from "@phosphor-icons/react/dist/ssr/Info";
import { XCircle } from "@phosphor-icons/react/dist/ssr/XCircle";
import { CheckCircle } from "@phosphor-icons/react/dist/ssr/CheckCircle";
import { PaperPlaneTilt } from "@phosphor-icons/react/dist/ssr/PaperPlaneTilt";
import { WorkflowViewer } from "./workflow-viewer";
import { WorkflowSummary } from "./workflow-summary";
import type { ViewerData } from "@/lib/workflow-viewer";

export type Fields = {
  // The English title is required, the German one optional; the server
  // derives template.json `title` from them (lib/store.ts parseAuthorForm).
  titleDe: string;
  titleEn: string;
  summaryDe: string;
  summaryEn: string;
  descriptionDe: string;
  descriptionEn: string;
  category: string;
  tags: string;
  language: string;
  minVersion: string;
  license: string;
  rights: boolean;
  changelog: string;
};
export type SubmitMode =
  | { type: "new" }
  | { type: "version"; templateId: string; title: string; kind: string }
  | { type: "edit"; versionId: string; status: string; kind: string; number: number };
type Finding = { level: "error" | "warning" | "info"; code: string; de: string; en: string; at?: string };
type Inspection = {
  ok: boolean;
  manifest: { kind: string; title: string; titles?: { de?: string; en?: string }; summary: { de?: string; en?: string }; description?: { de?: string; en?: string }; category: string; tags: string[]; minVersion: string; language: string } | null;
  findings: Finding[];
  size: number;
  previews: { n: number; type: string; data: string }[];
  // A workflow's diagram and summary (lib/workflow-viewer.ts).
  viewer?: ViewerData | null;
};

const EMPTY: Fields = { titleDe: "", titleEn: "", summaryDe: "", summaryEn: "", descriptionDe: "", descriptionEn: "", category: "other", tags: "", language: "de", minVersion: "0.9.4", license: DEFAULT_LICENSE, rights: false, changelog: "" };

export function SubmitForm({ session, mode, initial, login, returnTo, englishRequired = false }: { session: { name: string; csrf: string } | null; mode: SubmitMode; initial: Fields | null; login: LoginConfig; returnTo: string; englishRequired?: boolean }) {
  const t = useT();
  const locale = t("de", "en") as "de" | "en";
  const [pkg, setPkg] = useState<PendingPackage | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [checking, setChecking] = useState(false);
  const [fields, setFields] = useState<Fields>(initial ?? EMPTY);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [handover, setHandover] = useState<"none" | "waiting" | "received" | "no-opener">("none");
  const [status, setStatus] = useState<{ kind: "idle" | "sending" } | { kind: "error"; text: string; findings?: Finding[]; fields?: string[] }>({ kind: "idle" });
  const prefilled = useRef(!!initial);

  const accept = useCallback(
    async (next: PendingPackage, save = true) => {
      setPkg(next);
      setInspection(null);
      setChecking(true);
      if (save) await savePending(next);
      try {
        const r = await fetch("/api/packages/inspect", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: next.bytes });
        const data = (await r.json()) as Inspection & { error?: string };
        if (!r.ok) throw new Error(data.error || String(r.status));
        setInspection(data);
        setPreviewUrls((old) => {
          old.forEach((u) => URL.revokeObjectURL(u));
          return data.previews.map((p) => URL.createObjectURL(new Blob([Uint8Array.from(atob(p.data), (c) => c.charCodeAt(0))], { type: p.type })));
        });
        const m = data.manifest;
        if (m && !prefilled.current) {
          prefilled.current = true;
          setFields((f) => ({
            ...f,
            // Only what the package says – no guessing from `title`.
            titleDe: m.titles?.de ?? "",
            titleEn: m.titles?.en ?? "",
            summaryDe: m.summary.de ?? "",
            summaryEn: m.summary.en ?? "",
            descriptionDe: m.description?.de ?? "",
            descriptionEn: m.description?.en ?? "",
            category: m.category,
            tags: m.tags.join(", "),
            language: m.language,
            minVersion: m.minVersion,
          }));
        } else if (m)
          // A new version or an edit keeps the stored details; titles that
          // are still missing come from the package.
          setFields((f) => ({ ...f, minVersion: m.minVersion, titleDe: f.titleDe || m.titles?.de || "", titleEn: f.titleEn || m.titles?.en || "" }));
      } catch {
        setInspection({ ok: false, manifest: null, findings: [{ level: "error", code: "inspect-failed", de: "Das Paket konnte nicht geprüft werden.", en: "The package could not be checked." }], size: next.bytes.byteLength, previews: [] });
      } finally {
        setChecking(false);
      }
    },
    [],
  );

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    let stop = () => {};
    if (params.get("handover") === "1") {
      const opener = window.opener as Window | null;
      if (!opener) setHandover("no-opener");
      else {
        setHandover("waiting");
        const onMessage = (event: MessageEvent) => {
          // Only the window that opened this page (§2.4).
          if (!fromOpener(event.source, window.opener)) return;
          const message = parsePackageMessage(event.data);
          if (!message) return;
          setHandover("received");
          void accept({ name: message.name, bytes: message.bytes, origin: event.origin, at: Date.now() });
        };
        window.addEventListener("message", onMessage);
        stop = () => window.removeEventListener("message", onMessage);
        // Nothing secret in it, so any origin may hear it (§2.2).
        opener.postMessage(READY_MESSAGE, "*");
      }
    }
    // Back from signing in (or a reload): the package that was waiting.
    if (params.get("handover") !== "1" || params.get("restore") === "1")
      void loadPending().then((saved) => {
        if (saved) void accept(saved, false);
      });
    return () => stop();
  }, [accept]);

  async function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_PACKAGE_BYTES) {
      setInspection({ ok: false, manifest: null, findings: [{ level: "error", code: "package-too-large", de: "Das Paket ist größer als 25 MB.", en: "The package is larger than 25 MB." }], size: file.size, previews: [] });
      return;
    }
    await accept({ name: file.name, bytes: await file.arrayBuffer(), origin: null, at: Date.now() });
  }

  const set = <K extends keyof Fields>(key: K, value: Fields[K]) => setFields((f) => ({ ...f, [key]: value }));
  const needsPackage = mode.type !== "edit";
  const kindMismatch = !!inspection?.manifest && mode.type !== "new" && inspection.manifest.kind !== mode.kind;
  const packageOk = pkg ? !!inspection?.ok && !kindMismatch : !needsPackage;
  const canSubmit = !!session && packageOk && fields.rights && (englishRequired ? fields.titleEn.trim().length >= 2 : fields.titleEn.trim().length !== 1 && (fields.titleEn.trim() || fields.titleDe.trim()).length >= 2) && fields.titleDe.trim().length !== 1 && !!(fields.summaryDe.trim() || fields.summaryEn.trim()) && status.kind !== "sending" && !checking;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!session || !canSubmit) return;
    setStatus({ kind: "sending" });
    const body = new FormData();
    body.set("csrf", session.csrf);
    body.set(
      "meta",
      JSON.stringify({
        ...fields,
        tags: fields.tags
          .split(/[,\n]/)
          .map((x) => x.trim().replace(/^#/, ""))
          .filter(Boolean),
      }),
    );
    if (pkg) body.set("package", new Blob([pkg.bytes], { type: "application/zip" }), pkg.name);
    const query = mode.type === "edit" ? `?edit=${mode.versionId}` : mode.type === "version" ? `?template=${mode.templateId}` : "";
    const r = await fetch(`/api/submissions${query}`, { method: "POST", body, headers: { "x-csrf-token": session.csrf } }).catch(() => null);
    const data = (await r?.json().catch(() => ({}))) as { error?: string; versionId?: string; findings?: Finding[]; fields?: string[] };
    if (r?.ok) {
      await clearPending();
      location.href = `/me?sent=${data.versionId}`;
      return;
    }
    const text =
      {
        package_invalid: t("Das Paket hat die Prüfung nicht bestanden.", "The package did not pass the checks."),
        invalid_form: data.fields?.includes("titleEn")
          ? t("Bitte gib einen englischen Titel an – jede neue Vorlage und jede neue Version braucht ihn.", "Please enter an English title – every new template and every new version needs one.")
          : t("Bitte prüfe die markierten Felder.", "Please check the highlighted fields."),
        pending_version: t("Eine Version dieser Vorlage wartet noch auf Prüfung.", "A version of this template is still waiting for review."),
        kind_mismatch: t("Eine neue Version muss dieselbe Art haben.", "A new version must be of the same kind."),
        rate_limited: t("Heute schon viele Einreichungen – bitte morgen weiter.", "Lots of submissions today already – please continue tomorrow."),
        signed_out: t("Du bist nicht mehr angemeldet.", "You are no longer signed in."),
        too_large: t("Das Paket ist größer als 25 MB.", "The package is larger than 25 MB."),
      }[data.error ?? ""] ?? t("Das hat nicht geklappt. Versuch es noch einmal.", "That didn't work. Please try again.");
    setStatus({ kind: "error", text, findings: data.findings, fields: data.fields });
  }

  const invalid = (field: string) => status.kind === "error" && !!status.fields?.includes(field);
  const findings = inspection?.findings ?? [];
  const order = { error: 0, warning: 1, info: 2 };
  const heading =
    mode.type === "edit"
      ? mode.status === "changes_requested"
        ? t("Überarbeiten und erneut einreichen", "Revise and resubmit")
        : t("Einreichung bearbeiten", "Edit submission")
      : mode.type === "version"
        ? t(`Neue Version von „${mode.title}“`, `New version of "${mode.title}"`)
        : t("Vorlage einreichen", "Submit a template");

  return (
    <div className="submit">
      <header className="page-head">
        <h1>{heading}</h1>
        <p className="lede">
          {t(
            "Wir prüfen jede Einreichung, bevor sie im Marketplace erscheint. Du siehst den Stand unter „Meine Einreichungen“.",
            'We review every submission before it appears in the marketplace. You can follow it under "My submissions".',
          )}
        </p>
      </header>

      <section className="step">
        <h2>
          <span className="step-n">1</span>
          {t("Paket", "Package")}
        </h2>
        {handover === "waiting" && !pkg && <p className="notice">{t("Warte auf das Paket aus Flowplan …", "Waiting for the package from Flowplan …")}</p>}
        {handover === "no-opener" && !pkg && (
          <p className="notice warning">
            {t("Das Fenster, aus dem du gekommen bist, ist nicht mehr verbunden. Lade die Datei stattdessen hoch.", "The window you came from is no longer connected. Upload the file instead.")}
          </p>
        )}
        {pkg && (
          <div className="package-line">
            <strong>{pkg.name}</strong>
            <span className="muted">{formatBytes(pkg.bytes.byteLength)}</span>
            {pkg.origin && <span className="muted">· {t("aus", "from")} {new URL(pkg.origin).host}</span>}
            {inspection?.manifest && (
              <span className="kind-badge">
                {(KINDS as readonly string[]).includes(inspection.manifest.kind) ? kindLabel(t, inspection.manifest.kind) : inspection.manifest.kind}
              </span>
            )}
          </div>
        )}
        <label className="upload">
          <UploadSimple size={18} aria-hidden="true" />
          <span>
            {pkg
              ? t("Andere Datei wählen", "Choose another file")
              : mode.type === "edit"
                ? t("Neues Paket hochladen (optional)", "Upload a new package (optional)")
                : t(".flowplan-template-Datei hochladen", "Upload a .flowplan-template file")}
          </span>
          <input type="file" accept=".flowplan-template,.zip,application/zip" onChange={pickFile} />
        </label>
        {!pkg && mode.type === "new" && (
          <p className="hint">
            {t(
              "Am einfachsten direkt aus Flowplan: im Vorlagen-, Workflow- oder Einstellungsmenü „Im Marketplace veröffentlichen…“.",
              'Easiest straight from Flowplan: "Publish in the marketplace…" in the template, workflow or settings menu.',
            )}
          </p>
        )}
        {checking && <p className="notice">{t("Prüfe das Paket …", "Checking the package …")}</p>}
        {kindMismatch && <p className="notice error">{t("Das Paket hat eine andere Art als die Vorlage.", "The package is of a different kind than the template.")}</p>}
        {findings.length > 0 && (
          <ul className="findings" aria-label={t("Ergebnis der Prüfung", "Check results")}>
            {[...findings]
              .sort((a, b) => order[a.level] - order[b.level])
              .map((f, i) => (
                <li key={i} className={`finding ${f.level}`}>
                  {f.level === "error" ? <XCircle size={16} aria-hidden="true" /> : f.level === "warning" ? <Warning size={16} aria-hidden="true" /> : <Info size={16} aria-hidden="true" />}
                  <span>
                    {locale === "de" ? f.de : f.en}
                    {f.at && <code>{f.at}</code>}
                  </span>
                </li>
              ))}
          </ul>
        )}
        {inspection?.ok && !kindMismatch && (
          <p className="notice success">
            <CheckCircle size={16} aria-hidden="true" /> {t("Paket in Ordnung.", "Package looks good.")}
          </p>
        )}
        {inspection?.viewer && (
          <div className="workflow-view submit-workflow">
            <h3>{t("So sieht der Ablauf aus", "This is the flow")}</h3>
            <WorkflowViewer data={inspection.viewer} />
            <WorkflowSummary view={inspection.viewer.view} t={t} />
          </div>
        )}
        {previewUrls.length > 0 && (
          <div className="preview-strip">
            {previewUrls.map((url, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={url} src={url} alt={t(`Vorschau ${i + 1}`, `Preview ${i + 1}`)} />
            ))}
          </div>
        )}
      </section>

      {!session ? (
        <section className="step">
          <h2>
            <span className="step-n">2</span>
            {t("Anmelden", "Sign in")}
          </h2>
          <p>{t("Zum Einreichen brauchst du ein Konto – ohne Passwort. Dein Paket bleibt dabei hier im Browser.", "You need an account to submit – no password. Your package stays here in the browser meanwhile.")}</p>
          <LoginOptions config={login} next={returnTo} />
        </section>
      ) : (
        <form className="step" onSubmit={submit}>
          <h2>
            <span className="step-n">2</span>
            {t("Angaben", "Details")}
          </h2>
          <p className="muted">{t(`Angemeldet als ${session.name}. Dein Name steht an der Vorlage.`, `Signed in as ${session.name}. Your name is shown on the template.`)}</p>
          <div className="fields">
            <label className="field">
              <span>{t("Titel (Deutsch, optional)", "Title (German, optional)")}</span>
              <input value={fields.titleDe} onChange={(e) => set("titleDe", e.target.value)} maxLength={LIMITS.title} minLength={2} lang="de" aria-invalid={invalid("titleDe") || undefined} />
            </label>
            <label className="field">
              <span>{t("Titel (Englisch)", "Title (English)")}</span>
              <input value={fields.titleEn} onChange={(e) => set("titleEn", e.target.value)} maxLength={LIMITS.title} required={englishRequired} minLength={2} lang="en" aria-invalid={invalid("titleEn") || undefined} aria-describedby="title-en-hint" />
              <small id="title-en-hint" className="field-hint">
                {englishRequired
                  ? t("Pflicht: Englische Seiten zeigen ihn, deutsche den deutschen Titel, wenn es einen gibt.", "Required: English pages show it, German pages the German title if there is one.")
                  : t("Bitte angeben: Englische Seiten zeigen ihn, deutsche den deutschen Titel. Bald ist er Pflicht.", "Please add it: English pages show it, German pages the German title. It will soon be required.")}
              </small>
            </label>
            <label className="field">
              <span>{t("Kurzbeschreibung (Deutsch)", "Summary (German)")}</span>
              <textarea value={fields.summaryDe} onChange={(e) => set("summaryDe", e.target.value)} maxLength={LIMITS.summary} rows={3} />
              <small>
                {fields.summaryDe.length}/{LIMITS.summary}
              </small>
            </label>
            <label className="field">
              <span>{t("Kurzbeschreibung (Englisch)", "Summary (English)")}</span>
              <textarea value={fields.summaryEn} onChange={(e) => set("summaryEn", e.target.value)} maxLength={LIMITS.summary} rows={3} />
              <small>
                {fields.summaryEn.length}/{LIMITS.summary}
              </small>
            </label>
            <label className="field">
              <span>{t("Beschreibung (Deutsch, Markdown)", "Description (German, Markdown)")}</span>
              <textarea value={fields.descriptionDe} onChange={(e) => set("descriptionDe", e.target.value)} maxLength={LIMITS.description} rows={7} />
            </label>
            <label className="field">
              <span>{t("Beschreibung (Englisch, Markdown)", "Description (English, Markdown)")}</span>
              <textarea value={fields.descriptionEn} onChange={(e) => set("descriptionEn", e.target.value)} maxLength={LIMITS.description} rows={7} />
            </label>
            <label className="field">
              <span>{t("Kategorie", "Category")}</span>
              <select value={fields.category} onChange={(e) => set("category", e.target.value)}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {categoryLabel(t, c)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("Sprache der Vorlage", "Language of the template")}</span>
              <select value={fields.language} onChange={(e) => set("language", e.target.value)}>
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {languageLabel(t, l)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("Schlagwörter (mit Komma getrennt, höchstens 10)", "Tags (comma-separated, at most 10)")}</span>
              <input value={fields.tags} onChange={(e) => set("tags", e.target.value)} maxLength={400} />
            </label>
            <label className="field">
              <span>{t("Benötigt Flowplan ab Version", "Requires Flowplan version")}</span>
              <input value={fields.minVersion} onChange={(e) => set("minVersion", e.target.value)} pattern="\d{1,4}\.\d{1,4}\.\d{1,4}" required />
            </label>
            {(mode.type === "version" || (mode.type === "edit" && mode.number > 1)) && (
              <label className="field wide">
                <span>{t("Was ist neu? (optional)", "What's new? (optional)")}</span>
                <textarea value={fields.changelog} onChange={(e) => set("changelog", e.target.value)} maxLength={LIMITS.changelog} rows={3} />
              </label>
            )}
          </div>

          <fieldset className="license">
            <legend>{t("Lizenz", "License")}</legend>
            {LICENSES.map((l) => (
              <label key={l} className="radio">
                <input type="radio" name="license" value={l} checked={fields.license === l} onChange={() => set("license", l)} />
                <span>
                  <strong>{licenseLabel(t, l)}</strong>{" "}
                  {
                    {
                      "CC-BY-4.0": t("– andere dürfen sie nutzen und anpassen, wenn sie dich nennen (Standard).", "– others may use and adapt it if they credit you (default)."),
                      "CC0-1.0": t("– ohne Bedingungen, du verzichtest auf deine Rechte.", "– no conditions, you waive your rights."),
                      MIT: t("– freizügig, mit Lizenzhinweis; üblich für Code und Workflows.", "– permissive, with the licence notice; common for code and workflows."),
                    }[l]
                  }{" "}
                  <a href={LICENSE_URLS[l]} target="_blank" rel="noopener noreferrer">
                    {t("Lizenztext", "License text")}
                  </a>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="checkbox">
            <input type="checkbox" checked={fields.rights} onChange={(e) => set("rights", e.target.checked)} required />
            <span>
              {t(
                "Ich habe die Rechte an Inhalt, Bildern und Schriften und veröffentliche sie unter der gewählten Lizenz. Es sind keine persönlichen Daten oder Zugangsdaten enthalten.",
                "I hold the rights to the content, images and fonts and publish them under the chosen licence. No personal data or credentials are included.",
              )}{" "}
              <a href="/nutzungsbedingungen" target="_blank">
                {t("Nutzungsbedingungen", "Terms of use")}
              </a>
            </span>
          </label>
          {status.kind === "error" && (
            <div className="notice error" role="alert">
              <p>{status.text}</p>
              {status.findings && (
                <ul>
                  {status.findings
                    .filter((f) => f.level === "error")
                    .map((f, i) => (
                      <li key={i}>{locale === "de" ? f.de : f.en}</li>
                    ))}
                </ul>
              )}
            </div>
          )}
          <button type="submit" className="button primary big" disabled={!canSubmit}>
            <PaperPlaneTilt size={18} weight="bold" aria-hidden="true" />
            {status.kind === "sending" ? t("Wird gesendet …", "Sending …") : mode.type === "edit" ? t("Änderungen einreichen", "Submit changes") : t("Zur Prüfung einreichen", "Submit for review")}
          </button>
          {!pkg && needsPackage && <p className="hint">{t("Zuerst ein Paket wählen.", "Choose a package first.")}</p>}
        </form>
      )}
    </div>
  );
}
