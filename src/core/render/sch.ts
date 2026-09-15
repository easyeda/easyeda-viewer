/** Schematic page renderer (SCH_PAGE / SIMULATION docs). */
import { Group, Line, Rect, Path, Text, Ellipse } from 'leafer-ui';
import type { OpenedDoc, Rec, DocSegment } from '../types';
import type { RenderApi, RenderObject } from './layers';
import { X, Y, P, ang, strokeOf, fillOf, widthOf, xfOf, objBBox, bboxFromPts, arcSeg, COLORS, type Xf, type BBox } from './geom';
import { resolveLibGraphics, resolveAttrRef } from '../model';

/** record types that contribute real graphics (for component bbox sizing) */
const DRAWABLE_TYPES = ['POLY', 'FILL', 'LINE', 'RECT', 'CIRCLE', 'ELLIPSE', 'OVAL', 'PIN', 'TEXT', 'STRING', 'TABLE'];

export function renderSch(opened: OpenedDoc, api: RenderApi): void {
  const seg = opened.self;
  const xf = xfOf(seg.canvas, false);
  const page = new Group({ name: 'page' });
  const byParent = indexAttrs(seg.recs);
  // page-level attributes used by the title-block table (both free attrs and border-component attrs)
  let borderId: string | null = null;
  for (const r of seg.recs) {
    if (r.type === 'COMPONENT' && isBorderComponent(byParent.get(r.id) ?? [])) {
      borderId = r.id;
      break;
    }
  }
  const pageAttrs = new Map<string, string>();
  for (const r of seg.recs) {
    if (r.type !== 'ATTR') continue;
    const pid = String(r.data.parentId ?? '');
    if (pid !== '' && pid !== borderId) continue;
    const k = String(r.data.key ?? '');
    if (k && !pageAttrs.has(k)) pageAttrs.set(k, String(r.data.value ?? ''));
  }
  // attr index for embedded library segments (pin labels etc.), cached per segment
  const libAttrIdx = new WeakMap<DocSegment, Map<string, Rec[]>>();
  const attrsOf = (libSeg: DocSegment, id: string): Rec[] => {
    let m = libAttrIdx.get(libSeg);
    if (!m) { m = indexAttrs(libSeg.recs); libAttrIdx.set(libSeg, m); }
    return m.get(id) ?? [];
  };
  // library-level attribute defaults keyed by "partId␟key" (device value,
  // flag net names…). An instance ATTR with a null value inherits from here.
  let defIdx: Map<string, Rec> | null = null;
  const libDefAttr = (partId: string, key: string): Rec | null => {
    if (!defIdx) {
      defIdx = new Map();
      for (const ls of opened.libs.values())
        for (const r of ls.recs)
          if (r.type === 'ATTR' && r.data.partId && r.data.key) {
            const k = `${r.data.partId} ${r.data.key}`;
            if (!defIdx.has(k)) defIdx.set(k, r);
          }
    }
    return defIdx.get(`${partId} ${key}`) ?? null;
  };

  // ---- embedded symbol renderer ----
  /** @param antiRot screen-deg to cancel out (component group rotation) so pin text stays upright */
  function drawSymbolPart(target: Group, sym: DocSegment, partId: string, sx: number, sy: number, rotation: number, mirror: boolean, antiRot = 0): void {
    const sxf = xfOf(sym.canvas, false);
    const g = new Group({ name: `sym:${sym.uuid}` });
    g.x = sx; g.y = sy;
    g.rotation = ang(rotation, sxf);
    const inner = new Group({ scaleX: mirror ? -1 : 1, scaleY: 1 });
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
              stroke: strokeOf(r.data, COLORS.schComponent),
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
            stroke: strokeOf(r.data, COLORS.schComponent), strokeWidth: widthOf(r.data, 1),
            fill: fillOf(r.data, null),
            rotation: ang(r.data.rotation ?? 0, sxf),
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
          pinG.add(new Line({ points: [x1, y1, x2, y2], stroke: COLORS.schPin, strokeWidth: 1, hitStroke: 'all' }));
          if (r.data.pinShape && r.data.pinShape !== 'NONE') {
            const first = r.data.pinShape.includes('HOLE') ? 0.25 : 1;
            const ex = x1 + (x2 - x1) * first, ey = y1 + (y2 - y1) * first;
            pinG.add(new Ellipse({ x: ex - 1.5, y: ey - 1.5, width: 3, height: 3, fill: COLORS.schPin }));
          }
          // pin name / number labels (attributes parented to the PIN record)
          for (const pa of attrsOf(sym, r.id)) {
            const ad = pa.data;
            if (ad.key !== 'Pin Name' && ad.key !== 'Pin Number') continue;
            const v = String(ad.value ?? '');
            if (!v.trim() || (ad.valueVisible ?? true) === false) continue;
            if (typeof ad.x !== 'number' || typeof ad.y !== 'number') continue;
            const [lx, ly] = P(Number(ad.x), Number(ad.y), sxf);
            const t = new Text({
              text: v, fontSize: Number(ad.fontSize) || 8, fill: '#000000',
              textAlign: alignX(ad.align), yAlign: alignY(ad.align),
            } as any);
            t.x = lx; t.y = ly;
            t.rotation = (typeof ad.rotation === 'number' ? ang(Number(ad.rotation), sxf) : 0) - antiRot;
            pinG.add(t);
          }
          local.add(pinG);
          made = true;
          break;
        }
        case 'TEXT': case 'STRING': case 'PINLABEL': {
          const value = String(r.data.value ?? r.data.text ?? '');
          if (value) {
            const t = new Text({ text: value, fontSize: Number(r.data.fontSize) || 8, fill: strokeOf(r.data, COLORS.schComponent) } as any);
            t.x = X(Number(r.data.x ?? 0), sxf); t.y = Y(Number(r.data.y ?? 0), sxf);
            if (typeof r.data.rotation === 'number') t.rotation = ang(r.data.rotation, sxf);
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
            stroke: strokeOf(r.data, COLORS.schComponent), strokeWidth: widthOf(r.data, 1),
            fill: fillOf(r.data, null),
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
            stroke: strokeOf(r.data, COLORS.schComponent), strokeWidth: widthOf(r.data, 1),
            fill: fillOf(r.data, null),
          });
          e.rotation = ang(r.data.rotation ?? 0, sxf);
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
    const rot = ang(d.rotation ?? 0, xfc);
    const grid = new Group();
    if (rot) grid.rotation = rot; // rotation around grid origin approximated at top-left
    for (const x of xs) grid.add(new Line({ points: [px(x), py(ys[0]), px(x), py(ys[ys.length - 1])], stroke, strokeWidth: sw }));
    for (const y of ys) grid.add(new Line({ points: [px(xs[0]), py(y), px(xs[xs.length - 1]), py(y)], stroke, strokeWidth: sw }));
    const attrRecord = Object.fromEntries(pageAttrs);
    for (const cell of Array.isArray(d.tableCell) ? d.tableCell : []) {
      const value = resolveAttrRef(attrRecord, String(cell?.value ?? '')) ?? '';
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
    const g = new Group({ x: X(d.x ?? 0, xfc), y: Y(d.y ?? 0, xfc), rotation: ang(d.rotation ?? 0, xfc) });
    g.add(t);
    return g;
  }

  function componentWorldBBox(g: Group, sym: DocSegment | undefined, partId: string, d: any): BBox | null {
    const local: [number, number][] = [];
    if (sym) {
      const sxf = xfOf(sym.canvas, false);
      for (const r of sym.recs) {
        if (!DRAWABLE_TYPES.includes(r.type)) continue;
        const rp = r.data.partId;
        if (rp != null && rp !== '' && partId && String(rp) !== String(partId)) continue;
        const b = objBBox(r, sxf);
        if (b) local.push([b.minX, b.minY], [b.maxX, b.maxY]);
      }
    }
    if (!local.length) return null;
    const box = bboxFromPts(local)!;
    const gx = Number(g.x) || 0, gy = Number(g.y) || 0;
    const ra = ((Number(g.rotation) || 0) * Math.PI) / 180;
    const c = Math.cos(ra), s = Math.sin(ra);
    const mx = d.isMirror ? -1 : 1; // EasyEDA mirror = flip about the vertical axis
    const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2;
    const world = [[box.minX, box.minY], [box.maxX, box.minY], [box.maxX, box.maxY], [box.minX, box.maxY]].map(([x, y]) => {
      const lx = (x - cx) * mx, ly = y - cy;
      return [gx + cx + lx * c - ly * s, gy + cy + lx * s + ly * c] as [number, number];
    });
    return bboxFromPts(world);
  }

  /** the sheet-border pseudo-component carries page attrs instead of a designator */
  function isBorderComponent(attrs: Rec[]): boolean {
    return !!attrValue(attrs, 'Page Size') || (attrValue(attrs, 'Width') != null && attrValue(attrs, 'Border') != null);
  }

  /** power symbols (GND/VCC/…) are authored pointing the wrong way; rotate 180° to match EasyEDA Pro placement (#4) */
  function isPowerSymbol(sym: DocSegment | undefined, attrs: Rec[]): boolean {
    if (!sym) return false;
    const parts = [
      String(sym.meta?.title ?? ''),
      String(sym.meta?.name ?? ''),
      String(sym.meta?.attributes?.['Name'] ?? ''),
      ...attrs.filter((a) => ['Name', 'Value', 'Symbol'].includes(String(a.data.key ?? ''))).map((a) => String(a.data.value ?? '')),
    ];
    const hay = parts.join(' ').toUpperCase();
    if (/\b(GND|GROUND|VCC|VDD|VSS|VBB|VEE|VPP|VNN|POWER)\b/.test(hay)) return true;
    return sym.recs.some((r) => r.type === 'PIN' && String(r.data.electric ?? '').toUpperCase() === 'POWER');
  }

  /**
   * A4-style page border (EasyEDA renders it from a cloud OBJ blob we can't
   * decode, so synthesize it from the frame component's attributes:
   * Width/Height/Border/region counts/blade width, matching the reference look).
   */
  function drawBorder(attrs: Rec[]): void {
    const g = new Group({ name: 'border', hittable: false });
    const W = Number(attrValue(attrs, 'Width')) || 1170;
    const H = Number(attrValue(attrs, 'Height')) || 825;
    const xn = Math.max(1, Number(attrValue(attrs, 'X Region Count')) || 6);
    const yn = Math.max(1, Number(attrValue(attrs, 'Y Region Count')) || 4);
    const blade = Number(attrValue(attrs, 'Blade Width')) || 16;
    const col = '#a02020';
    // sheet occupies x∈[0,W], y∈[-H,0] (y-down), top-left corner at (0,-H)
    g.add(new Rect({ x: 0, y: -H, width: W, height: H, stroke: col, strokeWidth: 1.2, fill: null }));
    g.add(new Rect({ x: blade, y: -H + blade, width: W - 2 * blade, height: H - 2 * blade, stroke: col, strokeWidth: 1.2, fill: null }));
    const mk = (x1: number, y1: number, x2: number, y2: number) =>
      g.add(new Line({ points: [x1, y1, x2, y2], stroke: col, strokeWidth: 1, hittable: false }));
    const lbl = (text: string, x: number, y: number) => {
      const t = new Text({ text, fontSize: 8, fill: col, textAlign: 'center', yAlign: 'middle' } as any);
      t.x = x; t.y = y;
      g.add(t);
    };
    for (let i = 1; i < xn; i++) {
      const x = (i * W) / xn;
      mk(x, 0, x, blade); mk(x, -H, x, -H + blade);
    }
    for (let j = 1; j < yn; j++) {
      const y = -H + (j * H) / yn;
      mk(0, y, blade, y); mk(W - blade, y, W, y);
    }
    for (let i = 0; i < xn; i++) {
      const x = ((i + 0.5) * W) / xn;
      lbl(String(i + 1), x, -H + blade / 2); lbl(String(i + 1), x, -blade / 2);
    }
    for (let j = 0; j < yn; j++) {
      const y = -H + ((j + 0.5) * H) / yn;
      lbl(String.fromCharCode(65 + j), blade / 2, y); lbl(String.fromCharCode(65 + j), W - blade / 2, y);
    }
    page.add(g);
  }

  function drawComponent(r: Rec) {
    const d = r.data;
    const attrs = byParent.get(r.id) ?? [];
    if (isBorderComponent(attrs)) {
      drawBorder(attrs);
      api.addObject({
        id: r.id, rec: r, node: new Group(), label: `元件 ${r.id}`, kind: 'component',
        title: `图纸 ${attrValue(attrs, 'Page Size') ?? ''}`.trim(),
      });
      return;
    }
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
    g.rotation = ang(d.rotation ?? 0, xf);
    if (d.isMirror) g.scaleX = -1;
    page.add(g);
    if (sym) {
      drawSymbolPart(g, sym, String(d.partId ?? ''), 0, 0, 0, false, Number(g.rotation) || 0);
      drawComponentAttrs(g, attrs, sym, String(d.partId ?? ''));
    } else if (symUuid) {
      // unresolved symbol — fallback marker so user sees something
      const fr = new Rect({ x: -15, y: -10, width: 30, height: 20, stroke: '#cc0000', strokeWidth: 1, strokeDashArray: [3, 3] });
      g.add(fr);
      api.reportDiagnostics.push(`未解析符号 ${symUuid.slice(0, 10)} (line ${r.lineNo})`);
    }
    api.addObject({
      id: r.id, rec: r, node: g, label: `元件 ${r.id}`, kind: 'component',
      title: attrValue(attrs, 'Designator') ?? String((sym?.meta as any)?.title ?? d.attrs?.Designator ?? d.partId ?? r.id),
      bbox: componentWorldBBox(g, sym, String(d.partId ?? ''), d) ?? undefined,
    });
  }

  /**
   * Attribute texts of a placed component (Designator / Value / Pin labels /
   * NET / Global Net Name …). Visibility & colors follow EasyEDA: designator,
   * value and pin text are black; net names and the device code are blue.
   * Attributes without coordinates are anchored to the symbol body: net label
   * beyond the pin's free end, designator at the top-left corner.
   */
  function drawComponentAttrs(g: Group, attrs: Rec[], sym: DocSegment, partId: string): void {
    const sxf = xfOf(sym.canvas, false);
    let lb: BBox | null = null;
    const pts: [number, number][] = [];
    for (const r of sym.recs) {
      if (!DRAWABLE_TYPES.includes(r.type)) continue;
      const rp = r.data.partId;
      if (rp != null && rp !== '' && partId && String(rp) !== partId) continue;
      const b = objBBox(r, sxf);
      if (b) pts.push([b.minX, b.minY], [b.maxX, b.maxY]);
    }
    lb = bboxFromPts(pts);
    const pin = sym.recs.find((r) => r.type === 'PIN' && (!r.data.partId || !partId || String(r.data.partId) === partId));
    // multi-part symbol: designator gets ".N" from the part's position in the PART list
    const partList = sym.recs.filter((r) => r.type === 'PART').map((r) => String(r.id ?? ''));
    const pIdx = partList.indexOf(partId);
    const suffix = partList.length > 1 && pIdx >= 0 ? String(pIdx + 1) : undefined;
    const th = ((Number(g.rotation) || 0) * Math.PI) / 180; // sheet & symbol are y-down: screen deg = doc deg
    const tc = Math.cos(th), ts = Math.sin(th);
    const mirrorOf = (ox: number, oy: number): [number, number] => {
      let x = ox, y = oy;
      if (lb && Number(g.scaleX) < 0) x = (lb.minX + lb.maxX) - x; // mirror about body center
      const cx = lb ? (lb.minX + lb.maxX) / 2 : 0, cy = lb ? (lb.minY + lb.maxY) / 2 : 0;
      return [cx + (x - cx) * tc - (y - cy) * ts, cy + (x - cx) * ts + (y - cy) * tc];
    };
    const gx = Number(g.x) || 0, gy = Number(g.y) || 0;
    // keys the UI actually shows (everything else is library metadata:
    // Symbol/Footprint/Device uuids, manufacturer fields …)
    const SHOW = new Set(['Designator', 'Value', 'Voltage Rated', 'NET', 'Global Net Name', 'Name', 'Pin Name', 'Pin Number']);
    // device meta: "32.768kHz ±20ppm 12.5pF" → Value shows the first unit token
    // ("32.768kHz"); "12pF ±5% 50V" → Voltage Rated shows the V token ("50V").
    // multi-part devices also show their title under the body (R7FA6E2BB3CNE#BA0)
    const devUuid = String(attrValue(attrs, 'Device') ?? '');
    const devSeg = opened.libs.get(devUuid);
    const metaAny = devSeg?.meta as any;
    const descText = String(metaAny?.description ?? metaAny?.attributes?.['LCSC Part Name'] ?? '');
    const tokenRe = /^\d+(\.\d+)?([kKmMµunp])?(F|Ω|V|H)Z?$/i;
    const descTokens = descText.split(/\s+/).filter((t) => tokenRe.test(t));
    const firstToken = descTokens[0] ?? '';
    const voltToken = descTokens.find((t) => /v$/i.test(t)) ?? '';
    const localAttrMap: Record<string, string> = {};
    for (const a of attrs) { const k = String(a.data.key ?? ''); if (k) localAttrMap[k] = String(a.data.value ?? ''); }
    let stacked = 0;
    let sawValue = false;
    let desPos: [number, number] | null = null;
    for (const a of attrs) {
      const ad = a.data;
      const key = String(ad.key ?? '');
      if (!SHOW.has(key)) continue;
      // instance value wins; library default, then device description fill nulls
      const def = libDefAttr(partId, key);
      const fallback = key === 'Value' ? firstToken : key === 'Voltage Rated' ? voltToken : '';
      const value = resolveAttrRef(localAttrMap, String(ad.value ?? def?.data.value ?? fallback ?? '')) ?? '';
      if (!value.trim()) continue;
      if ((ad.valueVisible ?? true) === false && ad.keyVisible !== true) continue;
      let label = key === 'Designator'
        ? (suffix ? value + '.' + suffix : value)
        : (ad.keyVisible ? `${key}: ${value}` : value);
      if (!label.trim()) continue;
      let px: number, py: number, rot: number;
      if (typeof ad.x === 'number' && typeof ad.y === 'number') {
        px = X(Number(ad.x), xf); py = Y(Number(ad.y), xf);
        rot = typeof ad.rotation === 'number' ? ang(Number(ad.rotation), xf) : 0;
      } else if (!lb) {
        continue; // no geometry to anchor to
      } else {
        let ax = lb.minX, ay = lb.minY - 4 + stacked++ * 8; // stack under the designator
        if (key === 'Global Net Name') {
          // hang the net name just beyond the symbol's free (pin) end, always horizontal
          const pa = ((Number(pin?.data.rotation) || 0) * Math.PI) / 180;
          const pinY = pin ? Number(pin.data.y ?? 0) - sxf.oy + (Number(pin.data.length ?? 10) + 4) * Math.sin(pa) : 0;
          // label sits on the side away from the pin tip (flags: beyond the bars)
          ay = pinY > (lb.minY + lb.maxY) / 2 ? lb.minY - 6 : lb.maxY + 6;
          ax = (lb.minX + lb.maxX) / 2;
        }
        const [rx, ry] = mirrorOf(ax, ay);
        px = gx + rx; py = gy + ry;
        rot = typeof ad.rotation === 'number' ? ang(Number(ad.rotation), xf) : 0;
      }
      const t = new Text({
        text: label, fontSize: Number(ad.fontSize ?? def?.data.fontSize) || 8,
        // EasyEDA draws instance labels blue unless the attribute says otherwise
        fill: strokeOf({ strokeColor: ad.color ?? def?.data.color }, '#0000ff'),
        textAlign: key === 'Global Net Name' && typeof ad.x !== 'number' ? 'center' : alignX(ad.align),
        yAlign: alignY(ad.align),
      } as any);
      if (key === 'Value') sawValue = true;
      if (key === 'Designator') desPos = [px, py];
      t.x = px; t.y = py;
      if (rot) t.rotation = rot;
      page.add(t);
    }
    // no Value attr on the instance: synthesize one from the device description
    if (!sawValue && !suffix && firstToken) {
      const [px, py] = desPos ?? (lb ? [gx + mirrorOf(lb.minX, lb.minY - 4)[0], gy + mirrorOf(lb.minX, lb.minY - 4)[1]] : []);
      if (px != null && py != null) {
        const t = new Text({ text: firstToken, fontSize: 8, fill: '#0000ff', textAlign: 'left', yAlign: 'top' } as any);
        t.x = px; t.y = py + 8;
        page.add(t);
      }
    }
    // multi-part devices print their device title below the body
    const devTitle = suffix ? String(devSeg?.meta?.title ?? '') : '';
    if (devTitle && lb) {
      const [rx, ry] = mirrorOf(lb.minX, lb.maxY + 4);
      const t = new Text({ text: devTitle, fontSize: 8, fill: '#0000ff', textAlign: 'left', yAlign: 'top' } as any);
      t.x = gx + rx; t.y = gy + ry;
      page.add(t);
    }
  }

  // ---- page primitives ----
  function drawPrimitive(r: Rec) {
    const d = r.data;
    let node: Group | null = null;
    switch (r.type) {
      case 'LINE': {
        const [x1, y1] = P(d.startX ?? 0, d.startY ?? 0, xf);
        const [x2, y2] = P(d.endX ?? d.startX ?? 0, d.endY ?? d.startY ?? 0, xf);
        node = new Group();
        if (x1 === x2 && y1 === y2) {
          // zero-length wire segment = junction marker (red dot in EasyEDA)
          node.add(new Ellipse({ x: x1 - 1.8, y: y1 - 1.8, width: 3.6, height: 3.6, fill: '#d40000', hittable: false }));
        } else {
          node.add(new Line({
            points: [x1, y1, x2, y2],
            stroke: strokeOf(d, COLORS.net),
            strokeWidth: widthOf(d, 1),
            strokeDashArray: d.strokeStyle === 'DASHED' ? [6, 4] : undefined,
            hitStroke: 'all',
          }));
        }
        break;
      }
      case 'POLY': case 'FILL': {
        const pts = (d.points ?? []).flatMap((pt: any) => [X(pt.x ?? 0, xf), Y(pt.y ?? 0, xf)]);
        if (pts.length >= 4) {
          node = new Group();
          node.add(new Line({
            points: pts, closed: r.type === 'FILL' || !!d.closed,
            stroke: strokeOf(d, COLORS.schStroke), strokeWidth: widthOf(d, 1),
            fill: fillOf(d, r.type === 'FILL' ? '#88cccc88' : null),
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
          fill: fillOf(d, null),
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
        node = new Group();
        node.add(new Path({
          path: `M ${sx} ${sy} ${arcSeg(sx, sy, ex, ey, deg, xf.flip)}`,
          stroke: strokeOf(d, COLORS.net), strokeWidth: widthOf(d, 1),
        }));
        break;
      }
      case 'ELLIPSE': case 'OVAL': {
        const cx = X(d.x ?? 0, xf), cy = Y(d.y ?? 0, xf);
        node = new Group();
        node.add(new Ellipse({ x: cx - (d.radiusX ?? 5), y: cy - (d.radiusY ?? 5), width: (d.radiusX ?? 5) * 2, height: (d.radiusY ?? 5) * 2, stroke: strokeOf(d, '#666'), strokeWidth: widthOf(d, 1), fill: fillOf(d, null) }));
        break;
      }
      case 'PIN': {
        const px = d.x ?? 0, py = d.y ?? 0;
        const a = ((d.rotation ?? 0) * Math.PI) / 180;
        const len = d.length ?? 10;
        const [x1, y1] = P(px, py, xf);
        const [x2, y2] = P(px + len * Math.cos(a), py + len * Math.sin(a), xf);
        node = new Group();
        node.add(new Line({ points: [x1, y1, x2, y2], stroke: COLORS.schPin, strokeWidth: 1, hitStroke: 'all' }));
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
        node.add(new Ellipse({ x: cx - rad, y: cy - rad, width: rad * 2, height: rad * 2, stroke: strokeOf(d, COLORS.schStroke), strokeWidth: widthOf(d, 1), fill: fillOf(d, null) }));
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
    api.addObject({
      id: r.id, rec: r, node, label: `${r.type} ${r.id}`, kind: 'primitive',
      bbox: objBBox(r, xf) ?? undefined,
      hit: strokeHit(r, d, xf),
    });
  }

  for (const r of sortZ(seg.recs)) drawPrimitive(r);
  // net labels parented to wires (component-attached ones render with the component)
  const compIds = new Set(seg.recs.filter((r) => r.type === 'COMPONENT').map((r) => r.id));
  for (const r of seg.recs) {
    if (r.type !== 'ATTR' || r.data.key !== 'NET' || compIds.has(String(r.data.parentId ?? ''))) continue;
    const ad = r.data;
    const v = String(ad.value ?? '');
    if (!v.trim() || (ad.valueVisible ?? true) === false || typeof ad.x !== 'number' || typeof ad.y !== 'number') continue;
    const t = new Text({
      text: v, fontSize: Number(ad.fontSize) || 8, fill: strokeOf({ strokeColor: ad.color }, '#0000ff'),
      textAlign: alignX(ad.align), yAlign: alignY(ad.align),
    } as any);
    t.x = X(Number(ad.x), xf); t.y = Y(Number(ad.y), xf);
    if (typeof ad.rotation === 'number') t.rotation = ang(Number(ad.rotation), xf);
    page.add(t);
  }
  api.addGroup(seg, page);
}

/**
 * Precise picking for stroke-only primitives: clicking inside the outline of
 * an unfilled rect/wire must NOT select it — the pointer has to be on the line.
 * Returns undefined for shapes that keep bbox-based picking (falls back to bbox).
 */
function strokeHit(r: Rec, d: any, xf: Xf): ((wx: number, wy: number, tol: number) => boolean) | undefined {
  const seg = (x1: number, y1: number, x2: number, y2: number) =>
    (wx: number, wy: number, tol: number) => distToSeg(wx, wy, x1, y1, x2, y2) <= tol;
  switch (r.type) {
    case 'LINE': {
      const [x1, y1] = P(d.startX ?? 0, d.startY ?? 0, xf);
      const [x2, y2] = P(d.endX ?? d.startX ?? 0, d.endY ?? d.startY ?? 0, xf);
      if (x1 === x2 && y1 === y2) return undefined; // junction dot → bbox
      return seg(x1, y1, x2, y2);
    }
    case 'RECT': {
      const [x1, y1] = P(d.dotX1 ?? 0, d.dotY1 ?? 0, xf);
      const [x2, y2] = P(d.dotX2 ?? d.dotX1 ?? 0, d.dotY2 ?? d.dotY1 ?? 0, xf);
      const minX = Math.min(x1, x2), maxX = Math.max(x1, x2), minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
      return (wx, wy, tol) =>
        (distToSeg(wx, wy, minX, minY, maxX, minY) <= tol) ||
        (distToSeg(wx, wy, minX, maxY, maxX, maxY) <= tol) ||
        (distToSeg(wx, wy, minX, minY, minX, maxY) <= tol) ||
        (distToSeg(wx, wy, maxX, minY, maxX, maxY) <= tol);
    }
    default:
      return undefined;
  }
}

function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
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
