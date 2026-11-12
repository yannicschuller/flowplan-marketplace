// Package and preview files in the data directory:
//   <data>/packages/<version id>.flowplan-template
//   <data>/previews/<version id>/<n>.<webp|png|jpg>
// Names are built only from ids and numbers we generated, never from input.
import { mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import type { ImageType } from "./images";

const ID = /^[0-9a-f-]{36}$/;
const checkId = (id: string) => {
  if (!ID.test(id)) throw new Error("bad id");
  return id;
};
const dir = (...parts: string[]) => join(/*turbopackIgnore: true*/ config.dataDir(), ...parts);
const ext = (type: ImageType) => (type === "jpeg" ? "jpg" : type);

function writeAtomic(path: string, data: Uint8Array) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
export function savePackage(versionId: string, bytes: Uint8Array) {
  mkdirSync(dir("packages"), { recursive: true });
  writeAtomic(dir("packages", `${checkId(versionId)}.flowplan-template`), bytes);
}
export const readPackage = (versionId: string) => readFileSync(dir("packages", `${checkId(versionId)}.flowplan-template`));

export function savePreviews(versionId: string, previews: { n: number; type: ImageType; bytes: Uint8Array }[]) {
  const folder = dir("previews", checkId(versionId));
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  for (const p of previews) writeAtomic(join(/*turbopackIgnore: true*/ folder, `${p.n}.${ext(p.type)}`), p.bytes);
}
export const readPreview = (versionId: string, n: number, type: ImageType) =>
  readFileSync(dir("previews", checkId(versionId), `${Math.trunc(n)}.${ext(type)}`));

// Both files of a version (package and previews); missing ones are fine.
export function removeVersionFiles(versionId: string) {
  rmSync(dir("packages", `${checkId(versionId)}.flowplan-template`), { force: true });
  rmSync(dir("previews", checkId(versionId)), { recursive: true, force: true });
}
