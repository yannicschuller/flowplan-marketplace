"use client";
// The read-only workflow viewer (lib/workflow-view.ts, lib/workflow-svg.ts):
// the diagram, rendered on the server and moved here only through its
// viewBox (no style attributes – strict CSP), with pan (drag, arrow keys),
// zoom (buttons, Ctrl/⌘ + wheel or trackpad pinch, two-finger pinch, + and
// −) and "Einpassen"; Enter or a click on a node opens its settings, read
// only, in a side panel – a bottom sheet on phones. Nothing here is editable
// and nothing from the package is HTML.
import { createElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { useT } from "./i18n";
import type { SvgEl } from "@/lib/workflow-svg";
import type { Condition, Part, SettingRow, SettingValue, ViewNode, WorkflowView } from "@/lib/workflow-view";
import type { ViewerData } from "@/lib/workflow-viewer";
import { VIEWER_ICONS } from "@/lib/viewer-icons";
import { Plus } from "@phosphor-icons/react/dist/ssr/Plus";
import { Minus } from "@phosphor-icons/react/dist/ssr/Minus";
import { CornersOut } from "@phosphor-icons/react/dist/ssr/CornersOut";
import { X } from "@phosphor-icons/react/dist/ssr/X";

type Camera = { x: number; y: number; scale: number };

const MIN_SCALE = 0.2;
const MAX_SCALE = 2.5;
// Below this the cards' text gets too small: the first view rather pans.
const READABLE = 0.85;
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

// The builder's attribute names in React's spelling.
const reactName = (k: string) => (k === "class" ? "className" : k === "tabindex" ? "tabIndex" : k.startsWith("aria-") || k.startsWith("data-") ? k : k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()));
function toReact(node: SvgEl | string, key: string | number, selected: string | null): ReactNode {
  if (typeof node === "string") return node;
  const props: Record<string, unknown> = { key };
  for (const [k, v] of Object.entries(node.a ?? {})) if (k !== "style" && !/^on/i.test(k)) props[reactName(k)] = v;
  if (selected && node.a?.["data-node"] === selected) props.className = `${String(props.className ?? "")} wf-selected`;
  return createElement(node.t, props, ...(node.c ?? []).map((c, i) => toReact(c, i, selected)));
}

export function WorkflowViewer({ data }: { data: ViewerData }) {
  const t = useT();
  const { view, tree, bounds } = data;
  const stage = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [camera, setCamera] = useState<Camera | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: boolean; start: { x: number; y: number }; pinch: number | null }>({ moved: false, start: { x: 0, y: 0 }, pinch: null });
  const node = view.nodes.find((n) => n.id === selected) ?? null;

  // The first view: readable text, the start of the workflow in sight.
  const initial = useCallback(
    (w: number): { camera: Camera; h: number } => {
      const maxH = Math.max(240, Math.min(window.innerHeight * 0.68, 620));
      const scale = Math.max(Math.min(w / bounds.w, 1), Math.min(READABLE, 1));
      // Room for the side panel on wide screens, for the buttons on phones.
      const h = Math.round(Math.max(w > 640 ? 380 : 260, Math.min(maxH, bounds.h * scale)));
      const vw = w / scale;
      const vh = h / scale;
      return { camera: { x: vw >= bounds.w ? bounds.x - (vw - bounds.w) / 2 : bounds.x, y: vh >= bounds.h ? bounds.y - (vh - bounds.h) / 2 : bounds.y, scale }, h };
    },
    [bounds],
  );
  useIsoLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    let width = 0;
    const apply = () => {
      const w = el.clientWidth;
      if (!w || w === width) return;
      width = w;
      const first = initial(w);
      setSize({ w, h: first.h });
      setCamera(first.camera);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [initial]);

  const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  // Zoom by a factor around a point of the stage (in pixels).
  const zoomAt = useCallback(
    (factor: number, px?: number, py?: number) => {
      if (!size) return;
      setCamera((c) => {
        if (!c) return c;
        const scale = clampScale(c.scale * factor);
        const x0 = px ?? size.w / 2;
        const y0 = py ?? size.h / 2;
        const sx = c.x + x0 / c.scale;
        const sy = c.y + y0 / c.scale;
        return { scale, x: sx - x0 / scale, y: sy - y0 / scale };
      });
    },
    [size],
  );
  const pan = (dx: number, dy: number) => setCamera((c) => (c ? { ...c, x: c.x - dx / c.scale, y: c.y - dy / c.scale } : c));
  const fitAll = useCallback(() => {
    if (!size) return;
    const scale = clampScale(Math.min(size.w / bounds.w, size.h / bounds.h, 1.2));
    setCamera({ scale, x: bounds.x - (size.w / scale - bounds.w) / 2, y: bounds.y - (size.h / scale - bounds.h) / 2 });
  }, [size, bounds]);

  // Ctrl/⌘ + wheel (and the trackpad's pinch) zooms; the plain wheel scrolls the page.
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) {
        setHint(true);
        clearTimeout(timer);
        timer = setTimeout(() => setHint(false), 1400);
        return;
      }
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      clearTimeout(timer);
    };
  }, [zoomAt]);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size === 1) gesture.current = { moved: false, start: local(e), pinch: null };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current.pinch = Math.hypot(a.x - b.x, a.y - b.y);
      gesture.current.moved = true;
    }
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const before = pointers.current.get(e.pointerId);
    if (!before) return;
    const now = local(e);
    if (pointers.current.size >= 2 && gesture.current.pinch) {
      pointers.current.set(e.pointerId, now);
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt(distance / gesture.current.pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
      gesture.current.pinch = distance;
      return;
    }
    if (!gesture.current.moved && Math.hypot(now.x - gesture.current.start.x, now.y - gesture.current.start.y) > 5) {
      gesture.current.moved = true;
      svg.current?.setPointerCapture(e.pointerId);
    }
    if (gesture.current.moved) pan(now.x - before.x, now.y - before.y);
    pointers.current.set(e.pointerId, now);
  };
  const onPointerUp = (e: PointerEvent<SVGSVGElement>) => {
    const had = pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current.pinch = null;
    if (!had || gesture.current.moved || e.type === "pointercancel") return;
    const target = (e.target as Element).closest?.("[data-node]");
    const id = target?.getAttribute("data-node");
    if (id) open(id);
  };

  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const target = (e.target as Element).closest?.("[data-node]");
    const step = 60;
    if ((e.key === "Enter" || e.key === " ") && target) {
      e.preventDefault();
      open(target.getAttribute("data-node"));
    } else if (e.key === "ArrowLeft") pan(step, 0);
    else if (e.key === "ArrowRight") pan(-step, 0);
    else if (e.key === "ArrowUp") pan(0, step);
    else if (e.key === "ArrowDown") pan(0, -step);
    else if (e.key === "+" || e.key === "=") zoomAt(1.2);
    else if (e.key === "-" || e.key === "_") zoomAt(1 / 1.2);
    else if (e.key === "0") fitAll();
    else return;
    e.preventDefault();
  };
  // A node reached with Tab comes into view.
  const onFocus = (e: React.FocusEvent<SVGSVGElement>) => {
    const id = (e.target as Element).getAttribute?.("data-node");
    const n = id && view.nodes.find((x) => x.id === id);
    if (!n || !camera || !size) return;
    const vw = size.w / camera.scale;
    const vh = size.h / camera.scale;
    if (n.x >= camera.x && n.x + 220 <= camera.x + vw && n.y >= camera.y && n.y + 76 <= camera.y + vh) return;
    setCamera({ ...camera, x: n.x + 110 - vw / 2, y: n.y + 38 - vh / 2 });
  };

  // An opened node stays in sight beside the panel (on phones the sheet covers the lower part).
  const open = (id: string | null) => {
    setSelected(id);
    const n = id && view.nodes.find((x) => x.id === id);
    if (!n || !size) return;
    const wide = size.w > 640;
    setCamera((c) => {
      if (!c) return c;
      const visibleW = (wide ? size.w - 380 : size.w) / c.scale;
      const visibleH = size.h / c.scale;
      const inX = n.x >= c.x && n.x + 220 <= c.x + visibleW;
      const inY = n.y >= c.y && n.y + 76 <= c.y + visibleH;
      return inX && inY ? c : { ...c, x: n.x + 110 - visibleW / 2, y: inY ? c.y : n.y + 38 - visibleH / 2 };
    });
  };

  const close = useCallback(() => {
    const id = selected;
    setSelected(null);
    if (id) requestAnimationFrame(() => svg.current?.querySelector<SVGGElement>(`[data-node="${CSS.escape(id)}"]`)?.focus());
  }, [selected]);

  const viewBox = camera && size ? `${round(camera.x)} ${round(camera.y)} ${round(size.w / camera.scale)} ${round(size.h / camera.scale)}` : `${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`;
  const svgProps: Record<string, unknown> = {
    ref: svg,
    viewBox,
    ...(size ? { height: size.h } : {}),
    tabIndex: 0,
    "aria-describedby": "wf-keys",
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onKeyDown,
    onFocus,
  };
  const children = (tree.c ?? []).map((c, i) => toReact(c, i, selected));
  const rootProps: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(tree.a ?? {})) if (k !== "viewBox") rootProps[reactName(k)] = v;

  return (
    <div className={`wf-viewer${node ? " has-panel" : ""}`}>
      <div className="wf-stage" ref={stage}>
        {createElement("svg", { ...rootProps, ...svgProps }, ...children)}
        <div className="wf-controls" role="group" aria-label={t("Ansicht", "View")}>
          <button type="button" className="icon-button" onClick={() => zoomAt(1.25)} aria-label={t("Vergrößern", "Zoom in")} title={t("Vergrößern", "Zoom in")}>
            <Plus size={16} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button" onClick={() => zoomAt(0.8)} aria-label={t("Verkleinern", "Zoom out")} title={t("Verkleinern", "Zoom out")}>
            <Minus size={16} aria-hidden="true" />
          </button>
          <button type="button" className="wf-fit" onClick={fitAll}>
            <CornersOut size={16} aria-hidden="true" />
            {t("Einpassen", "Fit")}
          </button>
        </div>
        <p className={`wf-wheel-hint${hint ? " shown" : ""}`} aria-hidden="true">
          {t("Zum Zoomen Strg (⌘) + Mausrad", "Ctrl (⌘) + wheel to zoom")}
        </p>
        {node && <NodePanel node={node} onClose={close} />}
      </div>
      <p id="wf-keys" className="wf-keys">
        {t(
          "Ziehen oder Pfeiltasten verschieben, + und − zoomen, 0 passt ein. Tab wählt einen Knoten, Enter zeigt seine Einstellungen.",
          "Drag or use the arrow keys to move, + and − to zoom, 0 to fit. Tab picks a node, Enter shows its settings.",
        )}
      </p>
      <Legend view={view} />
      {view.total > view.shown && (
        <p className="note">{t(`Der Workflow ist groß: gezeigt werden ${view.shown} von ${view.total} Schritten.`, `This workflow is large: showing ${view.shown} of ${view.total} steps.`)}</p>
      )}
      {!view.hasMeta && <p className="muted wf-raw-note">{t("Dieses Paket beschreibt seine Schritte nicht – sie stehen mit ihrem technischen Typ da.", "This package does not describe its steps – they are shown by their technical type.")}</p>}
    </div>
  );
}
const round = (n: number) => Math.round(n * 10) / 10;

function Mark({ kind }: { kind: "ai" | "email" | "external" }) {
  return (
    <svg className={`wf-mark wf-mark-${kind}`} viewBox="0 0 256 256" width="14" height="14" aria-hidden="true">
      <path d={VIEWER_ICONS[kind]} />
    </svg>
  );
}

function Legend({ view }: { view: WorkflowView }) {
  const t = useT();
  const hasError = view.edges.some((e) => e.port === "error");
  const hasAlt = view.edges.some((e) => ["false", "rejected", "timeout", "unclear", "default"].includes(e.port));
  return (
    <ul className="wf-legend" aria-label={t("Legende", "Legend")}>
      <li>
        <span className="wf-swatch wf-swatch-trigger" aria-hidden="true" />
        {t("Auslöser", "Trigger")}
      </li>
      {view.risks.ai && (
        <li className="wf-legend-risk wf-legend-ai">
          <Mark kind="ai" />
          {t("KI – nutzt die KI-Einstellungen deiner Instanz", "AI – uses your instance's AI settings")}
        </li>
      )}
      {view.risks.email && (
        <li className="wf-legend-risk wf-legend-email">
          <Mark kind="email" />
          {t("E-Mail – verschickt oder empfängt E-Mails", "E-mail – sends or receives e-mail")}
        </li>
      )}
      {view.risks.external && (
        <li className="wf-legend-risk wf-legend-external">
          <Mark kind="external" />
          {t("Extern – spricht einen Dienst außerhalb von Flowplan an (Host als Text)", "External – talks to a service outside Flowplan (host as text)")}
        </li>
      )}
      {!view.risks.ai && !view.risks.email && !view.risks.external && <li>{t("Keine KI-, E-Mail- oder externen Schritte", "No AI, e-mail or external steps")}</li>}
      {hasAlt && (
        <li>
          <span className="wf-swatch wf-swatch-alt" aria-hidden="true" />
          {t("anderer Ausgang (nein, unklar …)", "other output (no, unclear …)")}
        </li>
      )}
      {hasError && (
        <li>
          <span className="wf-swatch wf-swatch-error" aria-hidden="true" />
          {t("Fehlerpfad (gestrichelt)", "Error path (dashed)")}
        </li>
      )}
      {view.loops.length > 0 && (
        <li>
          <span className="wf-swatch wf-swatch-loop" aria-hidden="true" />
          {t("Für jedes – Schritte im Rahmen laufen je Element", "For each – steps in the frame run per item")}
        </li>
      )}
    </ul>
  );
}

function NodePanel({ node, onClose }: { node: ViewNode; onClose: () => void }) {
  const t = useT();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [node.id]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <aside className={`wf-panel wf-cat-${node.group}`} role="dialog" aria-modal="false" aria-labelledby="wf-panel-title">
      <div className="wf-panel-head">
        <svg className="wf-panel-icon" viewBox="0 0 256 256" width="22" height="22" aria-hidden="true">
          <path d={node.icon ?? VIEWER_ICONS.generic} />
        </svg>
        <div>
          <h3 id="wf-panel-title" ref={heading} tabIndex={-1}>
            {node.label}
          </h3>
          <p className="wf-panel-type">
            {node.name !== node.type && <span>{node.name} · </span>}
            <code>{node.type}</code>
          </p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label={t("Schließen", "Close")} title={t("Schließen", "Close")}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="wf-panel-body">
        {node.description && <p>{node.description}</p>}
        {node.risks.length > 0 && (
          <ul className="wf-risks">
            {node.risks.map((r) => (
              <li key={r.kind} className={`wf-risk wf-risk-${r.kind}`}>
                <Mark kind={r.kind} />
                <span>
                  {r.kind === "ai"
                    ? t("Nutzt KI (die KI-Einstellungen deiner Instanz)", "Uses AI (your instance's AI settings)")
                    : r.kind === "email"
                      ? t("Verschickt oder empfängt E-Mails", "Sends or receives e-mail")
                      : node.host
                        ? t("Ruft diesen Host auf:", "Calls this host:")
                        : r.text}
                  {node.host && r.kind === "external" && (
                    <>
                      {" "}
                      <code>{node.host}</code>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {node.disabled && <p className="note">{t("Dieser Schritt ist abgeschaltet.", "This step is switched off.")}</p>}
        <h4>{t("Einstellungen", "Settings")}</h4>
        {node.settings.length ? <Rows rows={node.settings} /> : <p className="muted">{t("Keine Einstellungen.", "No settings.")}</p>}
        {node.moreSettings > 0 && <p className="muted">{t(`… und ${node.moreSettings} weitere`, `… and ${node.moreSettings} more`)}</p>}
        {node.errorHandling && (
          <>
            <h4>{t("Bei einem Fehler", "On an error")}</h4>
            <p>{node.errorHandling}</p>
          </>
        )}
        <p className="muted wf-readonly">{t("Nur zum Ansehen – nach dem Import änderst du alles in Flowplan.", "View only – after the import you change everything in Flowplan.")}</p>
      </div>
    </aside>
  );
}

function Rows({ rows }: { rows: SettingRow[] }) {
  return (
    <dl className="wf-settings">
      {rows.map((r, i) => (
        <div key={i}>
          <dt>{r.label}</dt>
          <dd>
            <Value value={r.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
function Parts({ parts }: { parts: Part[] }) {
  const t = useT();
  return (
    <>
      {parts.map((p, i) =>
        p.k === "ph" ? (
          <code key={i} className="wf-ph">
            {p.v}
          </code>
        ) : p.k === "gap" ? (
          <span key={i} className="wf-gap">
            {p.v} – {t("wird bei dir festgelegt", "set by you")}
          </span>
        ) : (
          <span key={i}>{p.v}</span>
        ),
      )}
    </>
  );
}
function Value({ value }: { value: SettingValue }) {
  const t = useT();
  switch (value.k) {
    case "text":
      return (
        <span className={value.long ? "wf-text long" : "wf-text"}>
          <Parts parts={value.parts} />
        </span>
      );
    case "empty":
      return <span className="muted">{value.text}</span>;
    case "plain":
      return <span>{value.text}</span>;
    case "gap":
      return (
        <span className="wf-gap">
          {value.label} – {value.text}
        </span>
      );
    case "list":
      return (
        <ul className="wf-list">
          {value.items.map((v, i) => (
            <li key={i}>
              <Value value={v} />
            </li>
          ))}
          {value.more > 0 && <li className="muted">{t(`… und ${value.more} weitere`, `… and ${value.more} more`)}</li>}
        </ul>
      );
    case "map":
      return (
        <>
          <Rows rows={value.rows} />
          {value.more > 0 && <span className="muted">{t(`… und ${value.more} weitere`, `… and ${value.more} more`)}</span>}
        </>
      );
    case "conditions":
      return (
        <>
          <Conditions join={value.join} rules={value.rules} />
          {value.more > 0 && <span className="muted">{t(`… und ${value.more} weitere`, `… and ${value.more} more`)}</span>}
        </>
      );
  }
}
function Conditions({ join, rules }: { join: string; rules: Condition[] }) {
  const t = useT();
  if (!rules.length) return <span className="muted">{t("keine Bedingung", "no condition")}</span>;
  return (
    <ul className="wf-conditions">
      {rules.map((r, i) => (
        <li key={i}>
          {i > 0 && <span className="wf-join">{join} </span>}
          {r.k === "group" ? (
            <Conditions join={r.join} rules={r.rules} />
          ) : (
            <span className="wf-cond">
              <span className="wf-cond-field">
                <Parts parts={r.field} />
              </span>
              <span className="wf-cond-sep" aria-hidden="true">
                {" – "}
              </span>
              <span className="wf-cond-op">{r.op}</span>
              {r.value.length > 0 && (
                <>
                  <span className="wf-cond-sep" aria-hidden="true">
                    {" – "}
                  </span>
                  <span className="wf-cond-value">
                    <Parts parts={r.value} />
                  </span>
                </>
              )}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
