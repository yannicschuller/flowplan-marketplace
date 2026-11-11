"use client";
// The package being submitted, kept in IndexedDB so it survives the sign-in
// redirect (GitHub or the e-mail link) – up to 25 MB, too big for
// sessionStorage. Dropped after a day or once submitted.
export type PendingPackage = { name: string; bytes: ArrayBuffer; origin: string | null; at: number };

const DB = "flowplan-marketplace";
const STORE = "pending";
const KEY = "package";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function savePending(pkg: PendingPackage) {
  try {
    await withStore("readwrite", (s) => s.put(pkg, KEY));
  } catch {}
}
export async function loadPending(): Promise<PendingPackage | null> {
  try {
    const pkg = (await withStore("readonly", (s) => s.get(KEY))) as PendingPackage | undefined;
    if (!pkg || !(pkg.bytes instanceof ArrayBuffer) || Date.now() - pkg.at > MAX_AGE_MS) return null;
    return pkg;
  } catch {
    return null;
  }
}
export async function clearPending() {
  try {
    await withStore("readwrite", (s) => s.delete(KEY));
  } catch {}
}
