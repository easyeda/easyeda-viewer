/**
 * FONT-document glyph outlines (#font-glyph).
 *
 * EasyEDA Pro keeps custom-font strings as *pre-vectorized outlines* in a
 * dedicated FONT document (DOCHEAD with docType/uuid "FONT") stored alongside
 * the board in the same record stream — one FONT record per placed STRING that
 * uses a non-default font:
 *
 *   id   = ["<text>", "<fontFamily>", <fontSize/10>, 8, 0, 0, 0, 0]
 *   data = { width, height, path: [[x0, y0, "L", x1, y1, ...], ...] }
 *
 * Each `path` subpath is a flat token array of x/y pairs with a single "L"
 * marker after the first pair (curves are pre-flattened to polylines). The
 * glyph space is y-UP with (0,0) at the text layout box's bottom-left and
 * 1 unit = GLYPH_UNIT (10) doc units: data.width/height are already in doc
 * units (height = fontSize x 1.3697 for the Latin display face, x 1.0 for
 * full-width CJK faces in the reference file). Hole subpaths wind opposite to
 * their outer contour, so all subpaths merged into ONE nonzero-filled Path
 * render counters (0, 4, ...) correctly — same trick as pour fills.
 */
import type { DocSegment } from '../types';

/** glyph path coordinates are 1/10 of the doc units the width/height fields
 *  use (黑体 480-wide box: raw x max 47.53; OTG 98.18-wide box: raw x max 9.5) */
export const GLYPH_UNIT = 10;

export interface FontGlyph {
  text: string;
  fontFamily: string;
  fontSize: number;
  /** advance width in doc units */
  width: number;
  /** layout box height in doc units */
  height: number;
  /** raw subpath token arrays, glyph space (y-up, 1 unit = GLYPH_UNIT doc units) */
  subs: any[][];
}

/** lookup key builder/extractor — NUL separator (via fromCharCode): font names may contain spaces */
const KEY_SEP = String.fromCharCode(0);
export function glyphKey(text: string, fontFamily: string, fontSize: number): string {
  return [text, fontFamily, fontSize].join(KEY_SEP);
}

/** index every FONT segment of the opened file: glyphKey -> glyph outline */
export function fontGlyphMap(libs: Map<string, DocSegment>): Map<string, FontGlyph> {
  const out = new Map<string, FontGlyph>();
  for (const seg of libs.values()) {
    if (seg.docType !== 'FONT' || seg.deleted) continue;
    for (const r of seg.recs) {
      if (r.type !== 'FONT') continue;
      const id = Array.isArray(r.idVal) ? (r.idVal as any[]) : null;
      const [text, fam, size10] = id ?? [];
      if (typeof text !== 'string' || typeof fam !== 'string') continue;
      const subs = Array.isArray(r.data?.path) ? r.data.path : [];
      if (!subs.length) continue;
      out.set(glyphKey(text, fam, Number(size10) * 10), {
        text,
        fontFamily: fam,
        fontSize: Number(size10) * 10,
        width: Number(r.data.width) || 0,
        height: Number(r.data.height) || 0,
        subs,
      });
    }
  }
  return out;
}

/**
 * All subpaths of a glyph as ONE SVG `d` string in caller-mapped coordinates
 * (`map` converts glyph px/py -> local units, e.g. screen-space points relative
 * to the text anchor). Points emit M for the first pair of a subpath and L for
 * the rest; every subpath closes with Z. Nonzero fill turns the opposite-
 * wound hole subpaths into counters.
 */
export function glyphPathD(subs: any[][], map: (px: number, py: number) => [number, number]): string {
  const parts: string[] = [];
  for (const sub of Array.isArray(subs[0]) ? subs : [subs]) {
    if (!Array.isArray(sub)) continue;
    let first = true;
    for (let i = 0; i < sub.length;) {
      if (typeof sub[i] === 'string') { i += 1; continue; } // "L" marker — coordinate pairs follow
      const [x, y] = map(Number(sub[i]), Number(sub[i + 1]));
      parts.push(`${first ? 'M' : 'L'}${x} ${y}`);
      first = false;
      i += 2;
    }
    if (!first) parts.push('Z');
  }
  return parts.join(' ');
}
