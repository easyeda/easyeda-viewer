/** Schematic page renderer (SCH_PAGE / SIMULATION docs). */
import { Group, Line, Rect, Path, Text, Ellipse } from 'leafer-ui';
import type { OpenedDoc, Rec, DocSegment } from '../types';
import type { RenderApi, RenderObject } from './layers';
import { X, Y, P, ang, strokeOf, fillOf, widthOf, xfOf, objBBox, bboxFromPts, COLORS, type Xf, type BBox } from './geom';
import { resolveLibGraphics } from '../model';

export function renderSch(opened: OpenedDoc, api: RenderApi): void {
  const seg = opened.self;
  const xf = xfOf(seg.canvas);
  const page = new Group({ name: 'page' });
  const byParent = indexAttrs(seg.recs);

  // ---- embedded symbol renderer ----
  function drawSymbolPart(target: Group, sym: DocSegment, partId: string, sx: number, sy: number, rotation: number, mirror: boolean): void {
    const sxf = xfOf(sym.canvas);
    const g = new Group({ name: `sym:${sym.uuid}` });
    g.x = sx; g.y = sy;
    g.rotation = ang(rotation);
    const inner = new Group({ scaleX: 1, scaleY: mirror ? -1 : 1 });
    g.add(inner);
    target.add(g);
    for (const r of sortZ(sym.recs)) {
      const rp = r.data.partId;
      if (rp != null && rp !== '' && partId && rp !== partId) continue;
      const local = new Group();
      let made = false;
      switch (r.type) {
        case 'POLY': case 'FILL': {
          const pts = (r.data.points ?? []).flatMap((pt: any) => [X(pt.x ?? 0, sxf), Y(pt.y ?? 0, sxf)]);
          if (pts.length >= 4) {
            const closed = r.type === 'FILL' ? true : !!r.data.closed;
            local.add(new Line({
              points: pts, closed,
              stroke: strokeOf(r.data, COLORS.schStroke),
              strokeWidth: widthOf(r.data, 1),
              fill: fillOf(r.data, r.data.fillStyle ? '#88cccc88' : null),
            }));
            made = true;
          }
          break;
        }
        case 'RECT': {
          const [x1, y1] = P(r.data.dotX1 ?? 0, r.data.dotY1 ?? 0, sxf);
          const [x2, y2] = P(r.data.dotX2 ?? r.data.dotX1 ?? 0, r.data.dotY2 ?? r.data.dotY1 ?? 0, sxf);
          local.add(new Rect({
            x: Math.min(x1, x2), y: Math.min(y1, y2),
            width: Math.abs(x2 - x1), height: Math.abs(y2 - y1),
            stroke: strokeOf(r.data, COLORS.schBody), strokeWidth: widthOf(r.data, 1),
            fill: fillOf(r.data, null) ?? 'none',
            rotation: ang(r.data.rotation ?? 0),
          }));
          made = true;
          break;
        }
        case 'PIN': {
          const px = r.data.x ?? 0, py = r.data.y ?? 0;
          const a = ((r.data.rotation ?? 0) * Math.PI) / 180;
          const len = r.data.length ?? 10;
          const [x1, y1] = P(px, py, sxf);
          const [x2, y2] = P(px + len * Math.cos(a), py + len * Math.sin(a), sxf);
          const pinG = new Group();
          pinG.add(new Line({ x1, y1, x2, y2, stroke: COLORS.schPin, strokeWidth: 1, hitStoke: 'all' }));
          if (r.data.pinShape && r.data.pinShape !== 'NONE') {
            const first = r.data.pinShape.includes('HOLE') ? 0.25 : 1;
            const ex = x1 + (x2 - x1) * first, ey = y1 + (y2 - y1) * first;
            pinG.add(new Ellipse({ x: ex - 1.5, y: ey - 1.5, width: 3, height: 3, fill: COLORS.schPin }));
          }
          local.add(pinG);
          made = true;
          break;
        }
        case 'TEXT': case 'STRING': case 'PINLABEL': {
          const value = String(r.data.value ?? r.data.text ?? '');
          if (value) {
            const t = new Text({ text: value, fontSize: Number(r.data.fontSize) || 8, fill: COLORS.schText } as any);
            t.x = X(Number(r.data.x ?? 0), sxf); t.y = Y(Number(r.data.y ?? 0), sxf);
            if (typeof r.data.rotation === 'number') t.rotation = ang(r.data.rotation);
            const tg = new Group(); tg.add(t);
            local.add(tg);
            made = true;
          }
          break;
        }
        case 'CIRCLE': {
          const cx = X(Number(r.data.centerX ?? 0), sxf), cy = Y(Number(r.data.centerY ?? 0), sxf);
          const rad = Math.abs(Number(r.data.radius ?? 0)) || 1;
          local.add(new Ellipse({
            x: cx - rad, y: cy - rad, width: rad * 2, height: rad * 2,
            stroke: strokeOf(r.data, COLORS.schStroke), strokeWidth: widthOf(r.data, 1),
            fill: fillOf(r.data, null) ?? 'none',
          }));
          made = true;
          break;
        }
        case 'ELLIPSE': case 'OVAL': {
          const cx = X(Number(r.data.centerX ?? 0), sxf), cy = Y(Number(r.data.centerY ?? 0), sxf);
          const rx = Math.abs(Number(r.data.radiusX ?? r.data.radius ?? 0)) || 1;
          const ry = Math.abs(Number(r.data.radiusY ?? r.data.radius ?? 0)) || 1;
          const e = new Ellipse({
            x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2,
            stroke: strokeOf(r.data, COLORS.schStroke), strokeWidth: widthOf(r.data, 1),
            fill: fillOf(r.data, null) ?? 'none',
          });
          e.rotation = ang(r.data.rotation ?? 0);
          local.add(e);
          made = true;
          break;
        }
        case 'TABLE': {
          drawTable(local, r.data, sxf);
          made = true;
          break;
        }
        case 'OBJ':
          break; // embedded object (cloud blob content) — not renderable locally
        case 'PART': case 'ATTR': case 'DOCHEAD': case 'CANVAS': case 'META': case 'GROUP':
        case 'ELE_PLACEHOLDER': case 'RULE': case 'ACTIVE_LAYER': case 'NG_SETTING':
          break; // structural / metadata
        default:
          if (!opened.report.unknownTypes.includes(r.type)) opened.report.unknownTypes.push(r.type);
      }
      if (made) inner.add(local);
    }
  }

  /** title-block table: grid lines from cumulative row/col sizes + cell values */
  function drawTable(target: Group, d: any, xfc: Xf): void {
    const cols = (Array.isArray(d.colSizes) ? d.colSizes : []).map(Number);
    const rows = (Array.isArray(d.rowSizes) ? d.rowSizes : []).map(Number);
    if (!cols.length || !rows.length) return;
    const x0 = Number(d.startX ?? 0), y0 = Number(d.startY ?? 0);
    const xs: number[] = [x0]; for (const c of cols) xs.push(xs[xs.length - 1] + c);
    const ys: number[] = [y0]; for (const r of rows) ys.push(ys[ys.length - 1] + r);
    const px = (v: number) => X(v, xfc), py = (v: number) => Y(v, xfc);
    const stroke = strokeOf(d, COLORS.schStroke), sw = widthOf(d, 1);
    const rot = ang(d.rotation ?? 0);
    const grid = new Group();
    if (rot) grid.rotation = rot; // rotation around grid origin approximated at top-left
    for (const x of xs) grid.add(new Line({ x1: px(x), y1: py(ys[0]), x2: px(x), y2: py(ys[ys.length - 1]), stroke, strokeWidth: sw }));
    for (const y of ys) grid.add(new Line({ x1: px(xs[0]), y1: py(y), x2: px(xs[xs.length - 1]), y2: py(y), stroke, strokeWidth: sw }));
    for (const cell of Array.isArray(d.tableCell) ? d.tableCell : []) {
      const value = String(cell?.value ?? '');
      if (!value) continue;
      const ci = Math.min(Number(cell.columnIndex ?? 0), xs.length - 1);
      const ri = Math.min(Number(cell.rowIndex ?? 0), ys.length - 1);
      const t = new Text({ text: value, fontSize: Number(cell.fontSize) || 9, fill: COLORS.schText } as any);
      // top-left of cell in math coords → screen y flips (row grows downward in doc space)
      t.x = px(xs[ci]) + 2; t.y = py(ys[ri + 1]) + 1;
      grid.add(t);
    }
    target.add(grid);
  }

  function textOf(d: any, xfc: Xf, color: string): Group | null {
    const value = String(d.value ?? d.text ?? '');
    if (!value) return null;
    const t = new Text({
      text: value,
      fontSize: Number(d.fontSize) || 10,
      fill: strokeOf({ strokeColor: d.color }, color),
      textAlign: alignX(d.align),
      yAlign: alignY(d.align),
    } as any);
    const g = new Group({ x: X(d.x ?? 0, xfc), y: Y(d.y ?? 0, xfc), rotation: ang(d.rotation ?? 0) });
    g.add(t);
    return g;
  }

  function componentWorldBBox(g: Group, sym: DocSegment | undefined, partId: string, d: any): BBox | null {
    let pts: [number, number][] = [];
    if (sym) {
      const sxf = xfOf(sym.canvas);
      for (const r of sym.recs) {
        if (r.type !== 'PART') continue;
        if (partId && String(r.id) !== String(partId)) continue;
        const bb = r.data.BBOX as number[] | undefined;
        if (Array.isArray(bb) && bb.length >= 4) {
          pts.push(P(bb[0], bb[1], sxf), P(bb[2], bb[3], sxf));
        }
      }
    }
    if (!pts.length) pts = [[-20, -15], [20, 15]];
    const gx = Number(g.x) || 0, gy = Number(g.y) || 0;
    const ra = ((Number(g.rotation) || 0) * Math.PI) / 180;
    const c = Math.cos(ra), s = Math.sin(ra);
    const mirror = d.isMirror ? -1 : 1;
    const world = pts.map(([x, y]) => {
      const my = y * mirror;
      return [gx + x * c - my * s, gy + x * s + my * c] as [number, number];
    });
    return bboxFromPts(world);
  }

  function drawComponent(r: Rec) {
    const d = r.data;
    const attrs = byParent.get(r.id) ?? [];
    const symUuid = attrValue(attrs, 'Symbol') ?? attrValue(attrs, 'Device');
    // DEVICE segments are metadata-only: graphics come from the SYMBOL they name
    let sym = resolveLibGraphics(opened.libs, symUuid ? opened.libs.get(symUuid) : undefined, 'Symbol');
    if (!sym) {
      const devUuid = attrValue(attrs, 'Device');
      if (devUuid && devUuid !== symUuid) sym = resolveLibGraphics(opened.libs, opened.libs.get(devUuid), 'Symbol');
    }
    const g = new Group({ name: `comp:${r.id}` });
    g.x = X(d.x ?? 0, xf);
    g.y = Y(d.y ?? 0, xf);
    g.rotation = ang(d.rotation ?? 0);
    if (d.isMirror) g.scaleY = -1;
    page.add(g);
    if (sym) {
      drawSymbolPart(g, sym, String(d.partId ?? ''), 0, 0, 0, false);
      for (const a of attrs) {
        const ad = a.data;
        const vis = ad.valueVisible ?? ad.keyVisible;
        if (typeof ad.x === 'number' && typeof ad.y === 'number' && vis !== false) {
          const label = ad.key === 'Designator' ? String(ad.value ?? '') : String((ad.keyVisible ? (ad.key ?? '') + ': ' : '') + (ad.value ?? ''));
          if (label.trim()) {
            const t = new Text({
              text: label, fontSize: Number(ad.fontSize) || 8,
              fill: strokeOf({ strokeColor: ad.color }, '#0066cc'),
            } as any);
            // static viewer: attributes are placed in absolute page coords
            t.x = X(ad.x, xf);
            t.y = Y(ad.y, xf);
            if (typeof ad.rotation === 'number') t.rotation = ang(ad.rotation);
            page.add(t);
          }
        }
      }
    } else if (symUuid) {
      // unresolved symbol — fallback marker so user sees something
      const fr = new Rect({ x: -15, y: -10, width: 30, height: 20, stroke: '#cc0000', strokeWidth: 1, strokeDashArray: [3, 3] });
      g.add(fr);
      api.reportDiagnostics.push(`未解析符号 ${symUuid.slice(0, 10)} (line ${r.lineNo})`);
    }
    api.addObject({
      id: r.id, rec: r, node: g, label: `元件 ${r.id}`, kind: 'component',
      title: attrValue(attrs, 'Designator') ?? String(d.attrs?.Designator ?? d.partId ?? r.id),
      bbox: componentWorldBBox(g, sym, String(d.partId ?? ''), d) ?? undefined,
    });
  }

  // ---- page primitives ----
  function drawPrimitive(r: Rec) {
    const d = r.data;
    let node: Group | null = null;
    switch (r.type) {
      case 'LINE': {
        const [x1, y1] = P(d.startX ?? 0, d.startY ?? 0, xf);
        const [x2, y2] = P(d.endX ?? d.startX ?? 0, d.endY ?? d.startY ?? 0, xf);
        const ln = new Line({
          x1, y1, x2, y2,
          stroke: strokeOf(d, COLORS.net),
          strokeWidth: widthOf(d, 1),
          strokeDashArray: d.strokeStyle === 'DASHED' ? [6, 4] : undefined,
        });
        node = new Group(); node.add(ln);
        break;
      }
      case 'POLY': case 'FILL': {
        const pts = (d.points ?? []).flatMap((pt: any) => [X(pt.x ?? 0, xf), Y(pt.y ?? 0, xf)]);
        if (pts.length >= 4) {
          node = new Group();
          node.add(new Line({
            points: pts, closed: r.type === 'FILL' || !!d.closed,
            stroke: strokeOf(d, COLORS.schStroke), strokeWidth: widthOf(d, 1),
            fill: fillOf(d, r.type === 'FILL' ? '#88cccc88' : null) ?? 'none',
          }));
        }
        break;
      }
      case 'RECT': {
        const [x1, y1] = P(d.dotX1 ?? 0, d.dotY1 ?? 0, xf);
        const [x2, y2] = P(d.dotX2 ?? d.dotX1 ?? 0, d.dotY2 ?? d.dotY1 ?? 0, xf);
        node = new Group();
        node.add(new Rect({
          x: Math.min(x1, x2), y: Math.min(y1, y2),
          width: Math.abs(x2 - x1), height: Math.abs(y2 - y1),
          stroke: strokeOf(d, '#666'), strokeWidth: widthOf(d, 1),
          fill: fillOf(d, null) ?? 'none',
          cornerRadius: [d.radiusX ?? 0, d.radiusY ?? 0, d.radiusX ?? 0, d.radiusY ?? 0],
        }));
        break;
      }
      case 'TEXT': case 'STRING': {
        node = textOf(d, xf, COLORS.schText);
        break;
      }
      case 'ARC': case 'ARC2': {
        const [sx, sy] = P(d.startX ?? d.x1 ?? 0, d.startY ?? d.y1 ?? 0, xf);
        const [ex, ey] = P(d.endX ?? d.x2 ?? 0, d.endY ?? d.y2 ?? 0, xf);
        const deg = Number(d.angle ?? 0);
        const dx = ex - sx, dy = ey - sy;
        const chord = Math.hypot(dx, dy);
        const a = Math.abs(deg) > 359 ? 359 : Math.abs(deg);
        const rad = chord / (2 * Math.sin((a * Math.PI) / 360));
        const large = a > 180 ? 1 : 0;
        const sweep = deg > 0 ? 0 : 1;
        node = new Group();
        node.add(new Path({
          path: `M ${sx} ${sy} A ${rad} ${rad} 0 ${large} ${sweep} ${ex} ${ey}`,
          stroke: strokeOf(d, COLORS.net), strokeWidth: widthOf(d, 1),
        }));
        break;
      }
      case 'ELLIPSE': case 'OVAL': {
        const cx = X(d.x ?? 0, xf), cy = Y(d.y ?? 0, xf);
        node = new Group();
        node.add(new Ellipse({ x: cx - (d.radiusX ?? 5), y: cy - (d.radiusY ?? 5), width: (d.radiusX ?? 5) * 2, height: (d.radiusY ?? 5) * 2, stroke: strokeOf(d, '#666'), strokeWidth: widthOf(d, 1), fill: fillOf(d, null) ?? 'none' }));
        break;
      }
      case 'PIN': {
        const px = d.x ?? 0, py = d.y ?? 0;
        const a = ((d.rotation ?? 0) * Math.PI) / 180;
        const len = d.length ?? 10;
        const [x1, y1] = P(px, py, xf);
        const [x2, y2] = P(px + len * Math.cos(a), py + len * Math.sin(a), xf);
        node = new Group();
        node.add(new Line({ x1, y1, x2, y2, stroke: COLORS.schPin, strokeWidth: 1, hitStoke: 'all' }));
        if (d.pinShape && d.pinShape !== 'NONE') {
          const first = String(d.pinShape).includes('HOLE') ? 0.25 : 1;
          node.add(new Ellipse({ x: x1 + (x2 - x1) * first - 1.5, y: y1 + (y2 - y1) * first - 1.5, width: 3, height: 3, fill: COLORS.schPin }));
        }
        break;
      }
      case 'CIRCLE': {
        const cx = X(d.centerX ?? 0, xf), cy = Y(d.centerY ?? 0, xf);
        const rad = Math.abs(Number(d.radius ?? 0)) || 1;
        node = new Group();
        node.add(new Ellipse({ x: cx - rad, y: cy - rad, width: rad * 2, height: rad * 2, stroke: strokeOf(d, COLORS.schStroke), strokeWidth: widthOf(d, 1), fill: fillOf(d, null) ?? 'none' }));
        break;
      }
      case 'TABLE': {
        node = new Group();
        drawTable(node, d, xf);
        break;
      }
      case 'OBJ': return; // embedded object with cloud blob content — not renderable locally
      case 'COMPONENT': drawComponent(r); return;
      case 'ATTR': case 'WIRE': case 'DOCHEAD': case 'CANVAS': case 'META': case 'PART': case 'GROUP':
      case 'NG_SETTING':
        return; // structural / rendered with parent
      case 'ELE_PLACEHOLDER':
        opened.report.placeholders++;
        return;
      default:
        if (!opened.report.unknownTypes.includes(r.type)) opened.report.unknownTypes.push(r.type);
        return;
    }
    if (!node) return;
    page.add(node);
    api.addObject({ id: r.id, rec: r, node, label: `${r.type} ${r.id}`, kind: 'primitive', bbox: objBBox(r, xf) ?? undefined });
  }

  for (const r of sortZ(seg.recs)) drawPrimitive(r);
  api.addGroup(seg, page);
}

function indexAttrs(recs: Rec[]): Map<string, Rec[]> {
  const m = new Map<string, Rec[]>();
  for (const r of recs) {
    if (r.type === 'ATTR') {
      const pid = r.data.parentId;
      if (pid) (m.get(pid) ?? m.set(pid, []).get(pid)!).push(r);
    }
  }
  return m;
}

function attrValue(attrs: Rec[], key: string): string | null {
  for (const a of attrs) if (a.data.key === key && a.data.value) return String(a.data.value);
  return null;
}

function alignX(a: unknown): 'left' | 'center' | 'right' {
  const s = String(a ?? '').toUpperCase();
  return s.includes('CENTER') ? 'center' : s.includes('RIGHT') ? 'right' : 'left';
}
function alignY(a: unknown): 'top' | 'middle' | 'bottom' {
  const s = String(a ?? '').toUpperCase();
  return s.includes('TOP') ? 'top' : s.includes('BOTTOM') ? 'bottom' : 'middle';
}

function sortZ(recs: Rec[]): Rec[] {
  return [...recs].sort((a, b) => (Number(a.data.zIndex ?? 0) || 0) - (Number(b.data.zIndex ?? 0) || 0));
}
