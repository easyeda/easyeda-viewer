/** Project model helpers: openables collection, lazy doc opening, bbox. */
import type { ProjectModel, TreeNode, OpenedDoc, DocSegment, Rec } from './types';
import { RENDERABLE, emptyReport } from './types';
import { getSegments } from './parse/records';
import { scalePourItems } from './render/geom';

export interface AttrEntry {
  key: string;
  value: string;
  source: 'instance' | 'lib';
}

/**
 * Resolve `={Key}` placeholders inside attribute values.
 * Recurses up to `depth` times to avoid cycles; missing keys become empty strings.
 */
export function resolveAttrRef(
  attrs: Record<string, string | undefined>,
  value: string | undefined,
  depth = 3,
): string | undefined {
  if (value == null) return value;
  // two placeholder forms: `={Key}` (whole/ref inside) and `=text {Key} text` /
  // bare `{Key}` mixes used by title-block table cells
  if (!value.includes('{')) return value;
  const refish = /(\{[^}]+\}|=\{[^}]+\})/.test(value) && (value.startsWith('=') || value.includes('={'));
  if (!refish) return value;
  let out = value.startsWith('=') ? value.slice(1) : value;
  for (let i = 0; i < depth; i++) {
    const next = out
      .replace(/=\{([^}]+)\}/g, (_, k) => attrs[k] ?? '')
      .replace(/\{([^}]+)\}/g, (_, k) => attrs[k] ?? '');
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Collect instance ATTR records (and inline `attrs`) for a record, then merge library/device defaults. */
export function collectAttrs(rec: Rec, opened: OpenedDoc): AttrEntry[] {
  const map = new Map<string, AttrEntry>();
  const set = (key: string, value: unknown, source: AttrEntry['source']) => {
    if (value == null) return;
    // object-valued attributes (e.g. pad specs) serialize as JSON so the props
    // panel can re-parse and show them as a hierarchy
    const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
    const empty = !s || s === '[]' || s === '{}';
    if (empty && source === 'lib') return; // don't let empty lib defaults wipe instance values
    if (!map.has(key)) map.set(key, { key, value: s, source });
  };
  // instance ATTR records parented to this object
  for (const r of opened.self.recs) {
    if (r.type === 'ATTR' && r.data.parentId === rec.id && typeof r.data.key === 'string' && r.data.key) {
      set(r.data.key, r.data.value, 'instance');
    }
  }
  // inline attrs object (used by some COMPONENT records)
  const inline = rec.data.attrs;
  if (inline && typeof inline === 'object') {
    for (const [k, v] of Object.entries(inline)) set(k, v, 'instance');
  }
  // library/device defaults for components
  if (rec.type === 'COMPONENT') {
    const devUuid = map.get('Device')?.value ?? rec.data.attrs?.Device;
    const symUuid = map.get('Symbol')?.value ?? rec.data.attrs?.Symbol;
    const fillDefaults = (seg: DocSegment | undefined) => {
      const defs = seg?.meta?.attributes;
      if (defs && typeof defs === 'object') {
        for (const [k, v] of Object.entries(defs)) set(k, v, 'lib');
      }
    };
    if (typeof devUuid === 'string' && devUuid) fillDefaults(opened.libs.get(devUuid));
    else if (typeof symUuid === 'string' && symUuid) fillDefaults(opened.libs.get(symUuid));
  }
  return [...map.values()];
}

/** Walk the tree and register every node that can be opened on the canvas. */
export function collectOpenables(model: ProjectModel): void {
  model.openables.clear();
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.fileKey && n.uuid && RENDERABLE.has(n.docType ?? '')) model.openables.set(n.id, n);
      if (n.children) walk(n.children);
    }
  };
  walk(model.tree);
}

/** open a tree node: returns its segment + sibling lib segments for reference resolution */
export function openDoc(model: ProjectModel, node: TreeNode): OpenedDoc {
  if (!node.fileKey || !node.uuid) throw new Error(`node ${node.id} is not openable`);
  const bytes = model.files.get(node.fileKey);
  if (!bytes) throw new Error(`missing file ${node.fileKey}`);
  const segs = getSegments(node.fileKey, bytes);
  const self = segs.find((s) => s.uuid === node.uuid) ?? segs.find((s) => s.docType === node.docType);
  if (!self) throw new Error(`segment ${node.uuid} not found in ${node.fileKey}`);
  const libs = new Map<string, DocSegment>();
  for (const s of segs) libs.set(s.uuid, s);
  // BLOB records carry base64 data-URL images (imported logos/screenshots) used by IMAGE primitives
  const blobs = new Map<string, string>();
  for (const s of segs)
    for (const r of s.recs)
      if (r.type === 'BLOB' && typeof r.data?.content === 'string' && r.data.content.startsWith('data:'))
        blobs.set(String(r.id ?? ''), r.data.content);
  const report = emptyReport();
  const bbox = computeBBox(self);
  return { self, libs, blobs, fileKey: node.fileKey, node, bbox, report };
}

/**
 * Resolve a lib segment to its drawable counterpart.
 * Embedded DEVICE segments are metadata-only (no geometry): the graphics live in the
 * SYMBOL / FOOTPRINT segment named by DEVICE.meta.attributes (uuid match within the file).
 */
export function resolveLibGraphics(
  libs: Map<string, DocSegment>,
  seg: DocSegment | undefined,
  kind: 'Symbol' | 'Footprint',
): DocSegment | undefined {
  if (!seg) return undefined;
  if (seg.docType === kind.toUpperCase()) return seg;
  if (seg.docType !== 'DEVICE') return undefined;
  const u = seg.meta?.attributes?.[kind];
  const hit = typeof u === 'string' ? libs.get(u) : undefined;
  return hit && hit.docType === kind.toUpperCase() ? hit : undefined;
}

/**
 * Bounding box (screen coords: y flipped, origin translated) over page-level geometry.
 * Component-attached symbol extents are small; included via component anchor points.
 */
export function computeBBox(seg: DocSegment): { minX: number; minY: number; maxX: number; maxY: number } {
  const ox = seg.canvas?.originX ?? 0;
  const oy = seg.canvas?.originY ?? 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => {
    const sx = x - ox, sy = -(y - oy);
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;
  };
  for (const r of seg.recs) {
    const d = r.data;
    switch (r.type) {
      case 'LINE': if (num(d.startX)) { add(d.startX, d.startY ?? 0); add(d.endX ?? d.startX, d.endY ?? d.startY ?? 0); } break;
      case 'ARC': if (num(d.startX)) { add(d.startX, d.startY ?? 0); add(d.endX ?? d.startX, d.endY ?? d.startY ?? 0); } break;
      case 'COMPONENT': if (num(d.x)) add(d.x, d.y ?? 0); break;
      case 'TEXT': case 'STRING': if (num(d.x)) add(d.x, d.y ?? 0); break;
      case 'PIN': if (num(d.x)) { add(d.x, d.y ?? 0); const a = ((d.rotation ?? 0) * Math.PI) / 180; add((d.x ?? 0) + (d.length ?? 0) * Math.cos(a), (d.y ?? 0) + (d.length ?? 0) * Math.sin(a)); } break;
      case 'RECT': if (num(d.dotX1)) { add(d.dotX1, d.dotY1 ?? 0); add(d.dotX2 ?? d.dotX1, d.dotY2 ?? d.dotY1 ?? 0); } break;
      case 'POLY': case 'FILL':
        if (Array.isArray(d.points)) for (const pt of d.points) add(pt.x ?? 0, pt.y ?? 0);
        else if (Array.isArray(d.path)) addPathPts(d.path, add);
        else if (Array.isArray(d.ploys) && Array.isArray(d.matrix)) {
          // panel shapes: rect tokens in unit space (local y-down) placed by row-major 2x3 matrix
          const m = d.matrix as number[];
          const my = (x: number, y: number): number => m[5] - m[3] * x - m[4] * y;
          for (const tk of d.ploys) {
            if (!Array.isArray(tk)) continue;
            if (tk[0] === 'R') {
              const x0 = mtxX(tk[1], tk[2], m), y0 = my(tk[1], tk[2]);
              const x1 = mtxX(tk[1] + tk[3], tk[2] + tk[4], m), y1 = my(tk[1] + tk[3], tk[2] + tk[4]);
              add(x0, y0); add(x1, y1);
            } else add(mtxX(tk[1] ?? 0, tk[2] ?? 0, m), my(tk[1] ?? 0, tk[2] ?? 0));
          }
        }
        break;
      // IMAGE (vector graphic): top-left corner at (startX, startY) like OBJ —
      // the body extends downward from it, which is -y on y-up docs (PCB) and
      // +y on y-down docs (SCH) (#image-anchor)
      case 'IMAGE': {
        if (!num(d.startX)) break;
        const down = seg.docType === 'SCH_PAGE' || seg.docType === 'SCH' || seg.docType === 'SIMULATION_SCH';
        const dy = down ? (d.height ?? 0) : -(d.height ?? 0);
        add(d.startX, d.startY); add(d.startX + (d.width ?? 0), d.startY + dy);
        break;
      }
      // OBJ (imported bitmap, blob: URI content): top-left corner at (startX, startY),
      // startY is the top edge; the body extends downward from it in DOC space —
      // which is -y on PCB docs (y-up) but +y on SCH docs (y-down) (#obj-bbox)
      case 'OBJ': {
        if (!num(d.startX)) break;
        const down = seg.docType === 'SCH_PAGE' || seg.docType === 'SCH' || seg.docType === 'SIMULATION_SCH';
        const dy = down ? (d.height ?? 0) : -(d.height ?? 0);
        add(d.startX, d.startY); add(d.startX + (d.width ?? 0), d.startY + dy);
        break;
      }
      case 'VIA': case 'PAD': if (num(d.centerX)) { add(d.centerX, d.centerY ?? 0); } break;
      case 'POURED': for (const pf of (d.pourFill ?? [])) for (const item of scalePourItems(pf.path)) addPathPts(item, add); break;
    }
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const pad = 20;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

function num(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v);
}

/** row-major 2x3 affine x-component: x'=a·x+b·y+c (ploys are panel-only; see my() for y) */
function mtxX(x: number, y: number, m: number[]): number {
  return m[0] * x + m[1] * y + m[2];
}

function normPathItems(path: any[]): any[][] {
  if (path.length && Array.isArray(path[0])) return path;
  return [path];
}

/**
 * Flat path item: [x0,y0, "L", x1,y1, x2,y2, "ARC", deg, ex,ey, "C", x1,y1,x2,y2,x3,y3, ...]
 * or special sub-arrays ["CIRCLE", cx, cy, r] / ["R", x, y, w, h, rot, ?].
 */
function addPathPts(item: any[], add: (x: number, y: number) => void): void {
  if (!Array.isArray(item) || item.length === 0) return;
  if (item[0] === 'CIRCLE') { add(Number(item[1]), Number(item[2])); return; }
  if (item[0] === 'R') {
    const [x, y, w, h] = [Number(item[1]), Number(item[2]), Number(item[3]), Number(item[4])];
    // R's y is the top edge (max-y, y-up doc space): rect spans y ∈ [y−h, y]
    add(x, y); add(x + w, y - h);
    return;
  }
  let i = 0;
  while (i < item.length) {
    const v = item[i];
    if (typeof v === 'string') {
      i += 1;
      if ((v === 'ARC' || v === 'CARC') && typeof item[i] === 'number') i += 1; // leading value is sweep angle
      continue;
    }
    add(Number(v), Number(item[i + 1]));
    i += 2;
  }
}

export function recLabel(r: Rec): string {
  const d = r.data;
  switch (r.type) {
    case 'COMPONENT': {
      const a = d.attrs && typeof d.attrs === 'object' ? d.attrs : null;
      const name = a?.['Designator'] ?? a?.['Name'] ?? '';
      return `COMPONENT ${r.id}${name ? ' (' + name + ')' : ''}`;
    }
    case 'TEXT': case 'STRING': return `${r.type} "${String(d.value ?? d.text ?? '').slice(0, 24)}"`;
    case 'NET': return `NET ${r.id}`;
    case 'LAYER': return `LAYER ${r.id} ${d.layerName ?? ''}`;
    default: return `${r.type} ${r.id}`;
  }
}
