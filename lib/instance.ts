// The visitor's Flowplan instance, as pure functions: which form the
// "In Flowplan öffnen" box shows, and the `#from=<origin>` fragment a Flowplan
// instance appends to its marketplace links. The fragment never reaches the
// server (browsers don't send it); it is read and removed in the browser.
// Client-safe: no Node APIs.
import { checkInstanceUrl } from "./handover";

// localStorage key of the saved instance origin.
export const INSTANCE_STORAGE_KEY = "flowplan-marketplace.instance";
// Window events between the fragment reader (layout) and the box (template page).
export const INSTANCE_CHANGED_EVENT = "flowplan-marketplace:instance-changed";
export const INSTANCE_EDIT_EVENT = "flowplan-marketplace:instance-edit";

// What the box shows:
// - "saved": an instance is saved → "In <host> öffnen" + "ändern"
// - "default": nothing saved, a default instance is configured → "In <default> öffnen" + "Eigene Instanz verwenden …"
// - "field": nothing saved and no default (or the visitor asked for the field) → the address field
export type BoxMode = "saved" | "default" | "field";
export function boxMode(saved: string | null, defaultInstance: string | null, editing: boolean): BoxMode {
  if (editing) return "field";
  if (saved && checkInstanceUrl(saved).ok) return "saved";
  return defaultInstance ? "default" : "field";
}

export const hostOf = (origin: string) => new URL(origin).host;

// `from=<url-encoded origin>` in a location.hash. Returns the instance origin
// (null when missing or not acceptable) and the hash without that part, so
// other fragments (`#browse`) survive. Only an explicit http(s) origin is
// accepted, with the same rules as the address field: https, http only for
// localhost and private networks.
export type FromFragment = { origin: string | null; rest: string };
export function parseFromFragment(hash: string): FromFragment | null {
  const raw = hash.replace(/^#/, "");
  if (!raw) return null;
  const parts = raw.split("&");
  const index = parts.findIndex((p) => p.startsWith("from="));
  if (index < 0) return null;
  const rest = parts.filter((_, i) => i !== index).join("&");
  return { origin: fromOrigin(parts[index].slice(5)), rest: rest ? `#${rest}` : "" };
}

function fromOrigin(encoded: string): string | null {
  let value: string;
  try {
    value = decodeURIComponent(encoded).trim();
  } catch {
    return null;
  }
  if (!/^https?:\/\/[^/?#]+\/?$/i.test(value) || value.length > 300) return null;
  const check = checkInstanceUrl(value);
  return check.ok ? check.origin : null;
}

// The saved instance in this browser (localStorage may be unavailable:
// private windows, blocked storage – then nothing is remembered).
export function readSavedInstance(): string | null {
  try {
    const saved = localStorage.getItem(INSTANCE_STORAGE_KEY);
    return saved && checkInstanceUrl(saved).ok ? saved : null;
  } catch {
    return null;
  }
}
// Saves (or with null forgets) the instance and tells the box on this page.
export function writeSavedInstance(origin: string | null) {
  try {
    if (origin) localStorage.setItem(INSTANCE_STORAGE_KEY, origin);
    else localStorage.removeItem(INSTANCE_STORAGE_KEY);
  } catch {}
  window.dispatchEvent(new CustomEvent(INSTANCE_CHANGED_EVENT, { detail: origin }));
}
