// A tiny PNG painter for the demo previews: filled rectangles and lines on
// an RGB canvas, encoded without dependencies.
import { crc32, deflateSync } from "node:zlib";

export type Rgb = [number, number, number];
export const hex = (h: string): Rgb => {
  const n = parseInt(h.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export class Canvas {
  data: Buffer;
  constructor(public width: number, public height: number, background: Rgb) {
    this.data = Buffer.alloc(width * height * 3);
    this.rect(0, 0, width, height, background);
  }
  rect(x: number, y: number, w: number, h: number, color: Rgb, radius = 0) {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let py = y0; py < y1; py++)
      for (let px = x0; px < x1; px++) {
        if (radius) {
          const dx = px < x0 + radius ? x0 + radius - px : px >= x1 - radius ? px - (x1 - radius - 1) : 0;
          const dy = py < y0 + radius ? y0 + radius - py : py >= y1 - radius ? py - (y1 - radius - 1) : 0;
          if (dx * dx + dy * dy > radius * radius) continue;
        }
        const i = (py * this.width + px) * 3;
        this.data[i] = color[0];
        this.data[i + 1] = color[1];
        this.data[i + 2] = color[2];
      }
    return this;
  }
  line(x0: number, y0: number, x1: number, y1: number, color: Rgb, width = 3) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let s = 0; s <= steps; s++) {
      const x = x0 + ((x1 - x0) * s) / steps;
      const y = y0 + ((y1 - y0) * s) / steps;
      this.rect(x - width / 2, y - width / 2, width, width, color);
    }
    return this;
  }
  png(): Buffer {
    const raw = Buffer.alloc((this.width * 3 + 1) * this.height);
    for (let y = 0; y < this.height; y++) {
      raw[y * (this.width * 3 + 1)] = 0;
      this.data.copy(raw, y * (this.width * 3 + 1) + 1, y * this.width * 3, (y + 1) * this.width * 3);
    }
    const chunk = (type: string, body: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length);
      const tb = Buffer.concat([Buffer.from(type, "ascii"), body]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(tb) >>> 0);
      return Buffer.concat([len, tb, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // RGB
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
  }
}
