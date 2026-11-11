// What an image really is, from its first bytes – never from its name or a
// declared type. Only WebP, PNG and JPEG are accepted as previews.
export type ImageType = "webp" | "png" | "jpeg";
export const IMAGE_MIME: Record<ImageType, string> = { webp: "image/webp", png: "image/png", jpeg: "image/jpeg" };

export function sniffImage(bytes: Uint8Array): ImageType | null {
  const b = bytes;
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return "webp";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a)
    return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  return null;
}
// The type a file name claims.
export function claimedImageType(name: string): ImageType | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (ext === "webp") return "webp";
  if (ext === "png") return "png";
  if (ext === "jpg" || ext === "jpeg") return "jpeg";
  return null;
}
// Font files an appearance package may bring.
export function sniffFont(b: Uint8Array): "woff2" | "woff" | "ttf" | "otf" | null {
  if (b.length < 4) return null;
  const tag = String.fromCharCode(b[0], b[1], b[2], b[3]);
  if (tag === "wOF2") return "woff2";
  if (tag === "wOFF") return "woff";
  if (tag === "OTTO") return "otf";
  if (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) return "ttf";
  return null;
}
