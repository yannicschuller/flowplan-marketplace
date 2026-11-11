// Reading untrusted ZIP files with hard limits, and writing small ones.
//
// Reading guards (zip bombs, path traversal): a cap on the number of entries,
// on each entry's and on all entries' uncompressed size, on the compression
// ratio of large entries; the real inflated size must match the declared one
// (yauzl validateEntrySizes, and we count while inflating); names must be
// relative, without "..", backslashes, drive letters or control characters;
// no duplicates, encrypted entries or symbolic links.
import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import { crc32, deflateRawSync } from "node:zlib";

export type ZipLimits = {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  // Entries above 1 MB may expand at most this many times.
  maxRatio: number;
};
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 300,
  maxEntryBytes: 25 * 1024 * 1024,
  maxTotalBytes: 60 * 1024 * 1024,
  maxRatio: 100,
};

export class ZipError extends Error {
  constructor(public code: "zip-invalid" | "zip-too-many" | "zip-too-large" | "zip-bomb" | "zip-path" | "zip-duplicate" | "zip-encrypted" | "zip-symlink", detail = "") {
    super(detail ? `${code}: ${detail}` : code);
  }
}

// Is this a safe relative path inside an archive?
export function safeEntryName(name: string) {
  if (!name || name.length > 200) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(name)) return false;
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return false;
  const parts = name.split("/");
  return parts.every((p, i) => (p === "" ? i === parts.length - 1 : p !== "." && p !== ".."));
}
// Junk some ZIP tools add; skipped silently.
const junk = (name: string) => /(^|\/)(__MACOSX|\.DS_Store)(\/|$)/.test(name);

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

export async function readZip(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<Map<string, Buffer>> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const zip = await new Promise<ZipFile>((resolve, reject) =>
    // decodeStrings stays on: yauzl then also refuses absolute and ".." names.
    fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, file) =>
      error || !file ? reject(new ZipError("zip-invalid", error?.message)) : resolve(file),
    ),
  );
  return new Promise((resolve, reject) => {
    const result = new Map<string, Buffer>();
    let count = 0;
    let total = 0;
    let done = false;
    const fail = (error: unknown) => {
      if (done) return;
      done = true;
      zip.close();
      reject(error instanceof ZipError ? error : new ZipError("zip-invalid", error instanceof Error ? error.message : ""));
    };
    zip.on("error", fail);
    zip.on("end", () => {
      if (done) return;
      done = true;
      resolve(result);
    });
    zip.on("entry", (entry: Entry) => {
      if (done) return;
      const name = entry.fileName;
      if (name.endsWith("/") || junk(name)) {
        if (!safeEntryName(name)) return fail(new ZipError("zip-path", name));
        zip.readEntry();
        return;
      }
      if (++count > limits.maxEntries) return fail(new ZipError("zip-too-many"));
      if (!safeEntryName(name)) return fail(new ZipError("zip-path", name));
      if (result.has(name)) return fail(new ZipError("zip-duplicate", name));
      if (entry.isEncrypted()) return fail(new ZipError("zip-encrypted", name));
      const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
      if ((mode & S_IFMT) === S_IFLNK) return fail(new ZipError("zip-symlink", name));
      const size = entry.uncompressedSize;
      if (size > limits.maxEntryBytes || total + size > limits.maxTotalBytes) return fail(new ZipError("zip-too-large", name));
      if (size > 1024 * 1024 && size > Math.max(1, entry.compressedSize) * limits.maxRatio) return fail(new ZipError("zip-bomb", name));
      total += size;
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) return fail(error ?? new ZipError("zip-invalid"));
        const chunks: Buffer[] = [];
        let read = 0;
        stream.on("data", (chunk: Buffer) => {
          read += chunk.length;
          // Never more than declared, whatever the stream says.
          if (read > size) {
            stream.destroy();
            fail(new ZipError("zip-bomb", name));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("error", fail);
        stream.on("end", () => {
          if (done) return;
          result.set(name, Buffer.concat(chunks));
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
}

// A ZIP of the given entries (deflated unless that makes them larger). Used
// for normalised packages, the demo packages and tests.
export function writeZip(entries: [string, Uint8Array][], at = new Date()): Buffer {
  const dosTime = ((at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2)) & 0xffff;
  const dosDate = (((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate()) & 0xffff;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, raw] of entries) {
    const data = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    const nameBytes = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data);
    const store = deflated.length >= data.length;
    const body = store ? data : deflated;
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by: Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
