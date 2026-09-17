/** Geometry helpers shared by renderers: coordinate flip, path → SVG, colors. */
import type { CanvasInfo } from '../types';

export interface Xf {
  ox: number;
  oy: number;
  /** true = doc space is Y-UP (PCB records) → mirror to screen; false = already Y-DOWN (SCH sheets & symbols) */
  flip: boolean;
}

export function xfOf(canvas: CanvasInfo | null, flip = true): Xf {
  return { ox: canvas?.originX ?? 0, oy: canvas?.originY ?? 0, flip };
}

/** doc coord → screen coord */
export function X(x: number, xf: Xf): number { return x - xf.ox; }
export function Y(y: number, xf: Xf): number { return xf.flip ? -(y - xf.oy) : y - xf.oy; }
export function P(x: number, y: number, xf: Xf): [number, number] { return [x - xf.ox, Y(y, xf)]; }

/** EasyEDA doc angles are clockwise; Leafer/screen angles are clockwise too,
 *  but Math.cos/sin are CCW, so we always negate when converting a doc angle
 *  to a screen angle for trig and for Leafer's rotation property. */
export function ang(a: number, _xf?: Xf): number { return -a; }

/** scale numeric coords of a flat path item (keeps tokens, ARC angle degrees, R rotation) */
export function scalePathItem(item: any[], k: number): any[] {
  if (!Array.isArray(item) || !item.length) return [];
  if (item[0] === 'CIRCLE') return ['CIRCLE', Number(item[1]) * k, Number(item[2]) * k, Number(item[3]) * k, ...item.slice(4)];
  if (item[0] === 'R') return [item[0], Number(item[1]) * k, Number(item[2]) * k, Number(item[3]) * k, Number(item[4]) * k, ...item.slice(5)];
  const out: any[] = [];
  for (let i = 0; i < item.length; i++) {
    const v = item[i];
    if (typeof v === 'string') { out.push(v); continue; }
    if (out[out.length - 1] === 'ARC') { out.push(v); continue; } // degrees, not a coord
    out.push(Number(v) * k);
  }
  return out;
}

/** POURED pourFill paths live in 0.1× doc units; normalize items to doc space */
export function scalePourItems(path: any[] | undefined): any[][] {
  if (!Array.isArray(path)) return [];
  const items: any[][] = Array.isArray(path[0]) ? path : [path];
  return items.map((it) => scalePathItem(it, 10));
}

const normColor = (c: unknown, fallback: string): string => {
  if (typeof c !== 'string' || !c) return fallback;
  if (/^(none|transparent)$/i.test(c)) return fallback;
  if (c.startsWith('#')) return /^#[0-9a-fA-F]{3,}$/.test(c) ? c : fallback;
  const hex = '#' + c.replace(/[^0-9a-fA-F]/g, '');
  return hex.length >= 4 ? hex : fallback;
};

export function strokeOf(d: any, fb: string): string {
  return normColor(d.strokeColor ?? d.color ?? d.specialColor, fb);
}
/** solid fill color or null; never falls back to opaque black (empty string) */
export function fillOf(d: any, fb: string | null): string | null {
  if (d.fill === false) return null;
  if (d.fillStyle != null && d.fillStyle !== 'SOLID' && d.fill !== true) return null;
  const c = normColor(d.fillColor, '');
  return c || fb;
}
export function widthOf(d: any, fb: number): number {
  const w = Number(d.strokeWidth ?? d.width ?? d.lineWidth);
  return isFinite(w) && w > 0 ? w : fb;
}

/**
 * Convert a flat EasyEDA path (see model.ts docs) into an SVG `d` string.
 * Coordinates are transformed (Y-flip + origin). `closed` adds Z.
 */
export function pathToSvg(item: any[], xf: Xf, closed: boolean): string {
  if (!Array.isArray(item) || !item.length) return '';
  if (item[0] === 'CIRCLE') {
    const [cx, cy, r] = [X(Number(item[1]), xf), Y(Number(item[2]), xf), Number(item[3])];
    return `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0 Z`;
  }
  if (item[0] === 'R') {
    const x = X(Number(item[1]), xf), y = Y(Number(item[2]), xf);
    const w = Number(item[3]), h = Number(item[4]);
    // R's y is the TOP edge (max-y in y-up doc space): the rect always extends
    // downward by h in doc space, so on screen it extends down from the flipped point
    return `M ${x} ${y} h ${w} v ${h} h ${-w} Z`;
  }
  const parts: string[] = [];
  let i = 0;
  let firstPt: [number, number] | null = null;
  while (i < item.length) {
    const v = item[i];
    if (typeof v === 'string') {
      i += 1;
      if (v === 'L') continue; // line-to: subsequent number pairs handled below
      if (v === 'ARC' && typeof item[i] === 'number') {
        const deg = Number(item[i]);
        i += 1;
        const x = Number(item[i]), y = Number(item[i + 1]);
        i += 2;
        const [sx, sy] = firstPt ?? [0, 0];
        const [ex, ey] = P(x, y, xf);
        parts.push(arcSeg(sx, sy, ex, ey, deg, xf.flip));
        firstPt = [ex, ey];
        continue;
      }
      if (v === 'C' && typeof item[i] === 'number') {
        const x1 = Number(item[i]), y1 = Number(item[i + 1]);
        const x2 = Number(item[i + 2]), y2 = Number(item[i + 3]);
        const x = Number(item[i + 4]), y = Number(item[i + 5]);
        i += 6;
        const [ax, ay] = P(x1, y1, xf), [bx, by] = P(x2, y2, xf), [cx2, cy2] = P(x, y, xf);
        parts.push(`C ${ax} ${ay} ${bx} ${by} ${cx2} ${cy2}`);
        firstPt = [cx2, cy2];
        continue;
      }
      if (v === 'Q' && typeof item[i] === 'number') {
        const x1 = Number(item[i]), y1 = Number(item[i + 1]);
        const x = Number(item[i + 2]), y = Number(item[i + 3]);
        i += 4;
        const [ax, ay] = P(x1, y1, xf), [cx2, cy2] = P(x, y, xf);
        parts.push(`Q ${ax} ${ay} ${cx2} ${cy2}`);
        firstPt = [cx2, cy2];
        continue;
      }
      continue; // unknown token: skip
    }
    const x = Number(v), y = Number(item[i + 1]);
    i += 2;
    const [px, py] = P(x, y, xf);
    if (!firstPt) { parts.push(`M ${px} ${py}`); firstPt = [px, py]; }
    else parts.push(`L ${px} ${py}`);
  }
  let d = parts.join(' ');
  if (closed && d) d += ' Z';
  return d;
}

/** nested-or-flat path items → array of svg d strings */
export function multiPathToSvg(path: any[], xf: Xf, closed: boolean): string[] {
  if (path.length && Array.isArray(path[0])) {
    return (path as any[][]).map((it) => pathToSvg(it, xf, closed)).filter(Boolean);
  }
  const d = pathToSvg(path, xf, closed);
  return d ? [d] : [];
}

/** start → end arc with sweep angle deg (EasyEDA convention, tuned for Y-flip). */
export function arcSeg(sx: number, sy: number, ex: number, ey: number, deg: number, flip = true): string {
  const dx = ex - sx, dy = ey - sy;
  const chord = Math.hypot(dx, dy);
  const a = Math.abs(deg) > 359.9 ? 359.9 : Math.abs(deg);
  const rad = chord / (2 * Math.sin((a * Math.PI) / 360));
  const large = a > 180 ? 1 : 0;
  const sweep = flip ? (deg > 0 ? 0 : 1) : (deg > 0 ? 1 : 0); // Y inversion flips the sweep sense
  return `A ${rad} ${rad} 0 ${large} ${sweep} ${ex} ${ey}`;
}

/** three-point arc (start / on-arc reference / end) → svg `A` segment.
 *  All coords are already in screen space (y-down), so angles from atan2 line up
 *  with the svg sweep convention: sweep=1 = increasing atan2 angle. Falls back to
 *  a straight `L` when the points are collinear (degenerate circle). */
export function arc3Seg(sx: number, sy: number, rx: number, ry: number, ex: number, ey: number): string {
  const d = 2 * (sx * (ry - ey) + rx * (ey - sy) + ex * (sy - ry));
  if (!Number.isFinite(d) || Math.abs(d) < 1e-9) return `L ${ex} ${ey}`;
  const s2 = sx * sx + sy * sy, r2 = rx * rx + ry * ry, e2 = ex * ex + ey * ey;
  const cx = (s2 * (ry - ey) + r2 * (ey - sy) + e2 * (sy - ry)) / d;
  const cy = (s2 * (ex - rx) + r2 * (sx - ex) + e2 * (rx - sx)) / d;
  const rad = Math.hypot(sx - cx, sy - cy);
  if (!Number.isFinite(rad) || rad < 1e-9) return `L ${ex} ${ey}`;
  const norm = (a: number): number => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const a0 = Math.atan2(sy - cy, sx - cx);
  const dR = norm(Math.atan2(ry - cy, rx - cx) - a0); // start → refer
  const d1 = norm(Math.atan2(ey - cy, ex - cx) - a0); // start → end
  // the drawn arc is the one passing through the refer point
  const sweep = dR < d1 ? 1 : 0;
  const span = sweep === 1 ? d1 : Math.PI * 2 - d1;
  const large = span > Math.PI ? 1 : 0;
  return `A ${rad} ${rad} 0 ${large} ${sweep} ${ex} ${ey}`;
}

export interface BBox { minX: number; minY: number; maxX: number; maxY: number }

export function bboxFromPts(pts: [number, number][]): BBox | null {
  if (!pts.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

/** generic bbox of a record's coordinates, in screen space (before group transform) */
export function objBBox(r: { type: string; data: any }, xf: Xf, local = false): BBox | null {
  const d = r.data;
  const pt = (x: unknown, y: unknown): [number, number] => [Number(x ?? 0), Number(y ?? 0)];
  const raw: [number, number][] = [];
  switch (r.type) {
    case 'LINE': raw.push(pt(d.startX, d.startY), pt(d.endX ?? d.startX, d.endY ?? d.startY)); break;
    case 'ARC': raw.push(pt(d.startX, d.startY), pt(d.endX ?? d.startX, d.endY ?? d.startY)); break;
    case 'RECT': raw.push(pt(d.dotX1, d.dotY1), pt(d.dotX2, d.dotY2)); break;
    case 'POLY': case 'FILL':
      if (Array.isArray(d.points)) raw.push(...(d.points as any[]).map((p) => pt(p.x, p.y)));
      if (Array.isArray(d.path)) for (const it of Array.isArray(d.path[0]) ? d.path : [d.path]) collectPathPts(it, raw);
      if (Array.isArray(d.ploys) && Array.isArray(d.matrix)) {
        const m = d.matrix as number[];
        const my = (x: number, y: number): number => m[5] - m[3] * x - m[4] * y; // local y-down → doc y-up
        for (const tk of d.ploys) {
          if (!Array.isArray(tk) || tk[0] !== 'R') continue;
          raw.push([m[0] * tk[1] + m[1] * tk[2] + m[2], my(tk[1], tk[2])],
            [m[0] * (tk[1] + tk[3]) + m[1] * (tk[2] + tk[4]) + m[2], my(tk[1] + tk[3], tk[2] + tk[4])]);
        }
      }
      break;
    case 'IMAGE':
      if (typeof d.width === 'number' && isFinite(d.width)) {
        raw.push([Number(d.startX) - d.width / 2, Number(d.startY) - (Number(d.height) || 0) / 2]);
        raw.push([Number(d.startX) + d.width / 2, Number(d.startY) + (Number(d.height) || 0) / 2]);
      } else raw.push(pt(d.startX, d.startY));
      break;
    case 'OBJ': // imported bitmap, top-left corner at (startX, startY) — startY is the top edge
      if (typeof d.width === 'number' && isFinite(d.width)) {
        raw.push([Number(d.startX), Number(d.startY) - (Number(d.height) || 0)]);
        raw.push([Number(d.startX) + d.width, Number(d.startY)]);
      } else raw.push(pt(d.startX, d.startY));
      break;
    case 'PIN': {
      // Schematic angles are clockwise; PCB angles are also clockwise but the Y-flip
      // already reverses the sense, so keep the raw trig for PCB.
      const sign = xf.flip ? 1 : -1;
      const a = sign * ((d.rotation ?? 0) * Math.PI) / 180;
      raw.push(pt(d.x, d.y), pt((d.x ?? 0) + (d.length ?? 10) * Math.cos(a), (d.y ?? 0) + (d.length ?? 10) * Math.sin(a)));
      break;
    }
    case 'PAD': {
      const w = Number(d.defaultPad?.width ?? 10), h = Number(d.defaultPad?.height ?? 10);
      const c = P(Number(d.centerX ?? 0), Number(d.centerY ?? 0), xf);
      const b: BBox = { minX: c[0] - w / 2, minY: c[1] - h / 2, maxX: c[0] + w / 2, maxY: c[1] + h / 2 };
      return expand(rotateBox(b, Number(d.padAngle ?? 0)), 2);
    }
    case 'VIA': {
      const c = P(Number(d.centerX ?? 0), Number(d.centerY ?? 0), xf);
      const b = bboxFromPts([c])!;
      return expand(b, Number(d.viaDiameter ?? 20) / 2 + 2);
    }
    case 'TEXT': case 'STRING': {
      // pick bbox from measured text extents around the anchor (the old
      // char-count estimate was wildly oversized/undersized — #text-bbox)
      const v = String(d.value ?? d.text ?? '');
      if (!v.trim()) return null;
      const fs = Number(d.fontSize) || 10;
      const { w, h } = textExtent(v, fs);
      const [ax, ay] = P(Number(d.x ?? 0), Number(d.y ?? 0), xf);
      const s = String(d.origin ?? d.align ?? '').toUpperCase();
      const ha = s.includes('CENTER') ? 0.5 : s.includes('RIGHT') ? 1 : 0;
      const va = s.includes('TOP') ? 0 : s.includes('BOTTOM') ? 1 : 0.5;
      // corners around the anchor per alignment, rotated by the screen angle
      const rr = (-Number(d.rotation ?? d.angle ?? 0) * Math.PI) / 180;
      const cs = Math.cos(rr), sn = Math.sin(rr);
      const corners: [number, number][] = [[-ha, -va], [1 - ha, -va], [1 - ha, 1 - va], [-ha, 1 - va]]
        .map(([fx, fy]) => [fx * w, fy * h])
        .map(([dx, dy]) => [ax + dx * cs - dy * sn, ay + dx * sn + dy * cs] as [number, number]);
      return bboxFromPts(corners);
    }
    case 'POURED': for (const pf of d.pourFill ?? []) for (const it of scalePourItems(pf.path)) collectPathPts(it, raw); break;
    case 'POUR': case 'REGION': if (Array.isArray(d.path)) for (const it of Array.isArray(d.path[0]) ? d.path : [d.path]) collectPathPts(it, raw); break;
    case 'TEARDROP': if (Array.isArray(d.path)) for (const it of Array.isArray(d.path[0]) ? d.path : [d.path]) collectPathPts(it, raw); break;
    case 'COMPONENT': raw.push(pt(d.x, d.y)); break;
    case 'CIRCLE': case 'ELLIPSE': {
      const c = P(Number(d.centerX ?? 0), Number(d.centerY ?? 0), xf);
      const rad = Math.max(Math.abs(Number(d.radius ?? d.radiusX ?? 0)), Math.abs(Number(d.radius ?? d.radiusY ?? 0))) || 2;
      return expand(bboxFromPts([c])!, rad + 1);
    }
    case 'TABLE': {
      const tw = (d.colSizes ?? []).map(Number).reduce((a: number, b: number) => a + b, 0);
      const th = (d.rowSizes ?? []).map(Number).reduce((a: number, b: number) => a + b, 0);
      if (tw > 0 && th > 0) {
        const [x1, y1] = P(Number(d.startX ?? 0), Number(d.startY ?? 0), xf);
        const [x2, y2] = P(Number(d.startX ?? 0) + tw, Number(d.startY ?? 0) + th, xf);
        return bboxFromPts([[x1, y1], [x2, y2]]);
      }
      return null;
    }
    default: return null;
  }
  if (!raw.length) return null;
  const b = bboxFromPts(raw.map(([x, y]) => (local ? [x, y] as [number, number] : P(x, y, xf))));
  return b && expand(b, 3);
}

function collectPathPts(item: any[], raw: [number, number][]): void {
  if (item[0] === 'CIRCLE') { raw.push([Number(item[1]), Number(item[2])]); raw.push([Number(item[1]) + Number(item[3]), Number(item[2]) + Number(item[3])]); return; }
  // R's y is the top edge (max-y, y-up doc space): rect spans y ∈ [y−h, y]
  if (item[0] === 'R') { raw.push([Number(item[1]), Number(item[2])], [Number(item[1]) + Number(item[3]), Number(item[2]) - Number(item[4])]); return; }
  for (let i = 0; i < item.length; i++) {
    const v = item[i];
    if (typeof v === 'string') { if (v === 'ARC' && typeof item[i + 1] === 'number') i += 1; continue; }
    raw.push([Number(v), Number(item[i + 1])]);
    i += 1;
  }
}

/** AABB of a box rotated about its own center (padAngle is doc-degrees) */
let measureCtx: CanvasRenderingContext2D | null | undefined;
/** measured text extents via an offscreen 2D context (world units = px at the
 *  doc font size, since the camera applies the zoom) — #text-bbox */
function textExtent(value: string, fontSize: number): { w: number; h: number } {
  if (measureCtx === undefined) {
    try { measureCtx = document.createElement('canvas').getContext('2d'); }
    catch { measureCtx = null; }
  }
  if (measureCtx) measureCtx.font = `${fontSize}px sans-serif`;
  return {
    w: measureCtx ? measureCtx.measureText(value).width : value.length * fontSize * 0.6,
    h: fontSize * 1.1,
  };
}

function rotateBox(b: BBox, deg: number): BBox {
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const a = (-deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const hw = (b.maxX - b.minX) / 2, hh = (b.maxY - b.minY) / 2;
  const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => [x * c - y * s, x * s + y * c]);
  return bboxFromPts(corners.map(([x, y]) => [cx + x, cy + y])) ?? b;
}

function expand(b: BBox, m: number): BBox {
  return { minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m };
}

/** default palette (EasyEDA-like) */
export const COLORS = {
  schStroke: '#3b9b2c',
  schPin: '#127fca',
  schBody: '#333333',
  schText: '#000000',
  schComponent: '#a00000', // EasyEDA default symbol stroke
  net: '#3b9b2c',
  pad: '#c8a400',
  hole: '#f5f5dc',
  boardBg: '#000000',
  outline: '#e0e0e0',
};
