/**
 * Minimal ZIP reader with GBK filename support.
 * EasyEDA-pro exported .epro2 / zipped projects on Chinese Windows may carry
 * GBK-encoded entry names without the UTF-8 flag — fflate's own name decoding
 * would mangle them, so we parse the central directory manually.
 */
import { inflateSync } from 'fflate';

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const tdUtf8 = new TextDecoder('utf-8');
const tdUtf8Strict = new TextDecoder('utf-8', { fatal: true });
const tdGbk = new TextDecoder('gbk');

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function decodeName(raw: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return tdUtf8.decode(raw);
  try {
    return tdUtf8Strict.decode(raw);
  } catch {
    try {
      return tdGbk.decode(raw);
    } catch {
      return tdUtf8.decode(raw);
    }
  }
}

function findEOCD(b: Uint8Array): number {
  // End of central directory signature 0x06054b50; comment may be up to 65535 bytes.
  const min = Math.max(0, b.length - 22 - 65535);
  for (let i = b.length - 22; i >= min; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) return i;
  }
  return -1;
}

const dv = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Decompress a zip blob into a list of {name, data} entries (directories skipped). */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const eocd = findEOCD(bytes);
  if (eocd < 0) throw new Error('ZIP: EOCD not found — file may be truncated');
  const view = dv(bytes, 0);
  let cdOffset = view.getUint32(eocd + 16, true);
  const cdSize = view.getUint32(eocd + 12, true);
  void cdSize;
  const total = view.getUint16(eocd + 10, true);
  const out: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break; // central dir sig
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const csize = view.getUint32(p + 20, true);
    const usize = view.getUint32(p + 24, true);
    void usize;
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const lho = view.getUint32(p + 42, true);
    const nameRaw = bytes.subarray(p + 46, p + 46 + nameLen);
    const name = decodeName(nameRaw, (flags & 0x800) !== 0);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // directory entry
    // local header
    if (view.getUint32(lho, true) !== 0x04034b50) continue;
    const lName = view.getUint16(lho + 26, true);
    const lExtra = view.getUint16(lho + 28, true);
    const dataStart = lho + 30 + lName + lExtra;
    const comp = bytes.subarray(dataStart, dataStart + csize);
    try {
      const data = method === 0 ? comp.slice() : method === 8 ? inflateSync(comp) : null;
      if (data) out.push({ name: normalize(name), data });
    } catch {
      // corrupted / unsupported method — skip entry silently; diagnostics handle missing files
    }
  }
  void cdOffset;
  void p;
  return out;
}

function normalize(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Read a zip into a flat path→bytes map (used for zipped folders/projects). */
export function zipToFileMap(bytes: Uint8Array): Map<string, Uint8Array> {
  const m = new Map<string, Uint8Array>();
  for (const e of readZip(bytes)) m.set(e.name, e.data);
  return m;
}

export { inflateSync };
