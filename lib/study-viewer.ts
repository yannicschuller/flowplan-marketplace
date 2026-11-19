// The sample cards of a flashcard deck (lib/study-meta.ts) from a stored
// version's file: for the template page, its picture route and the admin
// API. The meta is kept for a while per version and package hash (a
// package never changes under the same hash); pictures are read from the
// package when asked for.
import { readZip, DEFAULT_ZIP_LIMITS } from "./zip";
import { readPackage } from "./storage";
import { parseJsonColumn } from "./store";
import { studyFromEntries, type StudyMeta } from "./study-meta";
import { IMAGE_MIME, type ImageType } from "./images";

type StoredVersion = { id: string; sha256: string; manifest: string };
const payloadOf = (version: StoredVersion) => parseJsonColumn<{ payload?: unknown; kind?: unknown }>(version.manifest, {});

async function fromVersion(version: StoredVersion) {
  const m = payloadOf(version);
  if (m.kind !== "database" || typeof m.payload !== "string") return null;
  try {
    return await studyFromEntries(await readZip(readPackage(version.id), DEFAULT_ZIP_LIMITS), m.payload);
  } catch {
    return null;
  }
}

const cache = new Map<string, StudyMeta | null>();
const CACHE_SIZE = 64;
export async function versionStudy(version: StoredVersion): Promise<StudyMeta | null> {
  const key = `${version.id}:${version.sha256}`;
  if (cache.has(key)) return cache.get(key)!;
  const meta = (await fromVersion(version))?.meta ?? null;
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
  cache.set(key, meta);
  return meta;
}

// The picture of sample n (1…), or null.
export async function versionStudyImage(version: StoredVersion, n: number): Promise<{ type: ImageType; bytes: Buffer } | null> {
  if (!Number.isInteger(n) || n < 1 || n > 5) return null;
  return (await fromVersion(version))?.images.get(n) ?? null;
}

export const imageResponse = (image: { type: ImageType; bytes: Buffer }, headers: Record<string, string>) =>
  new Response(new Uint8Array(image.bytes), {
    headers: { ...headers, "Content-Type": IMAGE_MIME[image.type], "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'" },
  });

// For flowplan-admin: the samples as on the template page, a picture by its
// admin URL (`imageUrl(n)`).
export async function adminStudy(version: StoredVersion, imageUrl: (n: number) => string) {
  const meta = await versionStudy(version);
  if (!meta) return null;
  return {
    records: meta.records,
    cards: meta.cards,
    reverse: meta.reverse,
    types: meta.types,
    samples: meta.samples.map((s, i) => ({ ...s, image: s.image ? { alt: s.image.alt, type: IMAGE_MIME[s.image.type], url: imageUrl(i + 1) } : null })),
  };
}
