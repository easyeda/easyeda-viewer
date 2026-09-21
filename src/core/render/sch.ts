/** Schematic page renderer (SCH_PAGE / SIMULATION docs). */
import { Group, Line, Rect, Path, Text, Ellipse, Image as LeaferImage } from 'leafer-ui';
import type { OpenedDoc, Rec, DocSegment } from '../types';
import type { RenderApi, RenderObject } from './layers';
import { X, Y, P, ang, strokeOf, fillOf, widthOf, xfOf, objBBox, bboxFromPts, arcSeg, arc3Seg, arcPts, arc3Pts, COLORS, type Xf, type BBox } from './geom';
import { resolveLibGraphics, resolveAttrRef } from '../model';

/** record types that contribute real graphics (for component bbox sizing) */
const DRAWABLE_TYPES = ['POLY', 'FILL', 'LINE', 'RECT', 'CIRCLE', 'ELLIPSE', 'OVAL', 'PIN', 'TEXT', 'STRING', 'TABLE', 'OBJ'];

/**
 * Standard title-block layout transcribed from the official Sheet-Symbol_A3 art
 * (#border-size-override). Every Sheet-Symbol_N carries the identical 702×180
 * panel anchored to the sheet's bottom-right corner — A2/A3 records differ only
 * by x+683, y identical — so the block generalizes with dx = W-1655. Used to
 * synthesize the title block when a migrated page's W×H has no matching frame
 * symbol in the embedded libs. Coordinates are encoded as (x, v) with v the
 * height above the sheet's bottom edge (art y is y-down: v = -y).
 */
const TB_BLOB_LOGO = '56eab000776c877d1322f55b5cf782d47e0f458623dfd2bbcc2fb4c34ddd8233';
/** standard sheet sizes in doc units (1 unit = 0.254 mm), by "Page Size" attr */
const PAGE_SIZES: Record<string, [number, number]> = {
  A2: [2338, 1652],
  A3: [1655, 1170],
  A4: [1170, 825],
  A5: [826, 582],
};
const TB_LOGO: [number, number, number, number] = [960, 55, 193, 55]; // x, v(top), w, h
const TB_RECT: [number, number, number, number] = [943, 190, 1645, 10]; // x1,v1,x2,v2
const TB_SEPS: [number, number, number, number][] = [
  [1243, 10, 1243, 70],
  [1035, 50, 1035, 190],
  [1383, 190, 1383, 130],
  [1483, 130, 1483, 190],
  [1163, 130, 1163, 10],
  [1163, 110, 943, 110],
  [1645, 170, 1383, 170],
  [1645, 50, 943, 50],
  [1645, 130, 943, 130],
  [1645, 70, 943, 70],
  [1163, 90, 943, 90],
  [1645, 150, 943, 150],
  [1323, 70, 1323, 10],
];
const TB_LABELS: [string, number, number, string][] = [
  ['审阅', 953, 100, 'LEFT_MIDDLE'],
  ['绘制', 953, 120, 'LEFT_MIDDLE'],
  ['版本', 1203, 60, 'CENTER_MIDDLE'],
  ['创建日期', 1393, 160, 'LEFT_MIDDLE'],
  ['物料编码', 1393, 140, 'LEFT_MIDDLE'],
  ['页', 1407, 61, 'LEFT_MIDDLE'],
  ['共', 1517, 61, 'LEFT_MIDDLE'],
  ['原理图', 953, 170, 'LEFT_MIDDLE'],
  ['更新日期', 1393, 180, 'LEFT_MIDDLE'],
  ['尺寸', 1283, 60, 'CENTER_MIDDLE'],
  ['图页', 953, 140, 'LEFT_MIDDLE'],
];
const TB_SLOTS: [string, number, number, number, string][] = [
  ['Company', 1483, 30, 20, 'CENTER_MIDDLE'],
  ['Drawed', 1043, 120, 15, 'LEFT_MIDDLE'],
  ['Reviewed', 1043, 100, 15, 'LEFT_MIDDLE'],
  ['Version', 1203, 30, 15, 'CENTER_MIDDLE'],
  ['Page Size', 1285, 30, 15, 'CENTER_MIDDLE'],
  ['@Project Name', 1405, 100, 20, 'CENTER_MIDDLE'],
  ['@Page Count', 1587, 61, 15, 'CENTER_MIDDLE'],
  ['@Update Date', 1495, 180, 15, 'LEFT_MIDDLE'],
  ['@Create Date', 1495, 160, 15, 'LEFT_MIDDLE'],
  ['@Schematic Name', 1215, 170, 20, 'CENTER_MIDDLE'],
  ['Part Number', 1495, 140, 15, 'LEFT_MIDDLE'],
  ['@Page No', 1470, 61, 15, 'CENTER_MIDDLE'],
  ['@Page Name', 1215, 140, 15, 'CENTER_MIDDLE'],
];

export function renderSch(opened: OpenedDoc, api: RenderApi): void {
  const seg = opened.self;
  // Two Y conventions exist in the wild (#x86-esch2-flip): classic sheets are
  // Y-down (epro2 exports), while the ≥3.2.91 client migration rewrites every
  // record Y and the CANVAS originY negated and stamps CANVAS.yAxisDirection
  // "up". The flip xf mirrors the Y-up data back onto the same screen layout —
  // ang() keeps the raw rotation for flipped docs, align strings stay
  // screen-anchored in both conventions.
  const up = seg.canvas?.yAxisDirection === 'up';
  const xf = xfOf(seg.canvas, up);
  const page = new Group({ name: 'page' });
  const byParent = indexAttrs(seg.recs);
  // page-level attributes used by the title-block table (both free attrs and border-component attrs)
  let borderId: string | null = null;
  let borderAttrs: Rec[] = [];
  for (const r of seg.recs) {
    if (r.type === 'COMPONENT' && isBorderComponent(byParent.get(r.id) ?? [])) {
      borderId = r.id;
      borderAttrs = byParent.get(r.id) ?? [];
      break;
    }
  }
  // data-flag gates: the border component carries per-page switches for the
  // region frame ("Border") and the title-block table ("Title Block")
  const borderEnabled = attrValue(borderAttrs, 'Border') !== '0';
  const titleBlockEnabled = attrValue(borderAttrs, 'Title Block') !== '0';
  const pageAttrs = new Map<string, string>();
  for (const r of seg.recs) {
    if (r.type !== 'ATTR') continue;
    const pid = String(r.data.parentId ?? '');
    if (pid !== '' && pid !== borderId) continue;
    const k = String(r.data.key ?? '');
    const v = String(r.data.value ?? '');
    if (!k) continue;
    // Border-component attrs carry the real values; free-floating symbol defaults are empty placeholders.
    const existing = pageAttrs.get(k);
    if (!existing || (!existing.trim() && v.trim())) pageAttrs.set(k, v);
  }
  // Synthesized system attributes (@Page Name/@Page No/… from openDoc) resolve the
  // title block's `={@Key}` cells: cached @-ATTR values are a save-time snapshot
  // and usually empty, the client shows live values. Structural keys take the
  // dynamic value; date/time keys only fill gaps — the format's only timestamp is
  // the last-save time, not the true creation date (#titleblock-sysattrs)
  if (opened.sysAttrs) {
    for (const [k, v] of Object.entries(opened.sysAttrs)) {
      if (!v) continue;
      if (pageAttrs.get(k)?.trim() && /^@.*(Date|Time)$/.test(k)) continue;
      pageAttrs.set(k, v);
    }
  }
  // wire groups for synthesizing junction dots at same-net intersections
  type WireSeg = { x1: number; y1: number; x2: number; y2: number };
  const wireGroups = new Map<string, WireSeg[]>();

  function drawJunctions(groups: Map<string, WireSeg[]>) {
    const eps = 0.5;
    const nearP = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) <= eps;
    const onSeg = (x: number, y: number, s: WireSeg) => {
      const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
      const len2 = dx * dx + dy * dy;
      if (!len2) return Math.hypot(x - s.x1, y - s.y1) <= eps;
      const t = Math.max(0, Math.min(1, ((x - s.x1) * dx + (y - s.y1) * dy) / len2));
      return Math.hypot(x - (s.x1 + t * dx), y - (s.y1 + t * dy)) <= eps;
    };
    const segIntersection = (a: WireSeg, b: WireSeg): { x: number; y: number } | null => {
      const d = (a.x2 - a.x1) * (b.y2 - b.y1) - (a.y2 - a.y1) * (b.x2 - b.x1);
      if (Math.abs(d) < 1e-9) return null;
      const ua = ((b.x2 - b.x1) * (a.y1 - b.y1) - (b.y2 - b.y1) * (a.x1 - b.x1)) / d;
      const ub = ((a.x2 - a.x1) * (a.y1 - b.y1) - (a.y2 - a.y1) * (a.x1 - b.x1)) / d;
      if (ua < -eps || ua > 1 + eps || ub < -eps || ub > 1 + eps) return null;
      return { x: a.x1 + ua * (a.x2 - a.x1), y: a.y1 + ua * (a.y2 - a.y1) };
    };
    for (const segs of groups.values()) {
      if (segs.length < 2) continue;
      const candidates: { x: number; y: number }[] = [];
      const addCand = (x: number, y: number) => {
        const p = { x, y };
        if (!candidates.some((c) => nearP(c, p))) candidates.push(p);
      };
      for (const s of segs) { addCand(s.x1, s.y1); addCand(s.x2, s.y2); }
      for (let i = 0; i < segs.length; i++) {
        for (let j = i + 1; j < segs.length; j++) {
          const p = segIntersection(segs[i], segs[j]);
          if (p) addCand(p.x, p.y);
        }
      }
      for (const p of candidates) {
        let count = 0, interior = false;
        for (const s of segs) {
          if (!onSeg(p.x, p.y, s)) continue;
          count++;
          if (!nearP(p, { x: s.x1, y: s.y1 }) && !nearP(p, { x: s.x2, y: s.y2 })) interior = true;
        }
        if (count >= 3 || (count === 2 && interior)) {
          page.add(new Ellipse({ x: p.x - 2.5, y: p.y - 2.5, width: 5, height: 5, fill: '#d40000', hittable: false }));
        }
      }
    }
  }

  // attr index for embedded library segments (pin labels etc.), cached per segment
  const libAttrIdx = new WeakMap<DocSegment, Map<string, Rec[]>>();
  const attrsOf = (libSeg: DocSegment, id: string): Rec[] => {
    let m = libAttrIdx.get(libSeg);
    if (!m) { m = indexAttrs(libSeg.recs); libAttrIdx.set(libSeg, m); }
    return m.get(id) ?? [];
  };
  // library-level attribute defaults keyed by "partId key" within the owning
  // symbol (device value, flag net names…). An instance ATTR with a null value
  // inherits from here. Scoped per symbol segment: partIds are only unique
  // inside one symbol doc, two symbols can reuse the same "pid…" id.
  const libDefIdx = new WeakMap<DocSegment, Map<string, Rec>>();
  const libDefAttr = (sym: DocSegment, partId: string, key: string): Rec | null => {
    let m = libDefIdx.get(sym);
    if (!m) {
      m = new Map();
      for (const r of sym.recs)
        if (r.type === 'ATTR' && r.data.partId && r.data.key) {
          const k = `${r.data.partId} ${r.data.key}`;
          if (!m.has(k)) m.set(k, r);
        }
      libDefIdx.set(sym, m);
    }
    return m.get(`${partId} ${key}`) ?? null;
  };

  // ---- embedded symbol renderer ----
  /** @param antiRot screen-deg to cancel out (component group rotation) so pin text stays upright */
  /** @param titleValues old-style border frames only: attribute name → resolved
   *  value painted at the symbol's positioned ATTR slots (see the ATTR case) */
  function drawSymbolPart(target: Group, sym: DocSegment, partId: string, sx: number, sy: number, rotation: number, mirror: boolean, antiRot = 0, skipTitleBlock = false, gray = false, titleValues?: Record<string, string>): void {
    const sxf = xfOf(sym.canvas, sym.canvas?.yAxisDirection === 'up');
    // title-block hiding (#2): the A4 frame symbol groups the region frame under
    // a GROUP titled "border"; graphics outside that group are title-block
    // artwork the page flag "Title Block" turns off. Symbols without a border
    // group fall back to hiding just their TABLE record.
    let borderGroups: Set<string> | null = null;
    if (skipTitleBlock) {
      for (const r of sym.recs) {
        if (r.type === 'GROUP' && String(r.data.title ?? '') === 'border') {
          (borderGroups ??= new Set()).add(r.id);
        }
      }
    }
    const g = new Group({ name: `sym:${sym.uuid}` });
    g.x = sx; g.y = sy;
    g.rotation = ang(rotation, sxf);
    const inner = new Group({ scaleX: mirror ? -1 : 1, scaleY: 1 });
    g.add(inner);
    target.add(g);
    for (const r of sortZ(sym.recs)) {
      const rp = r.data.partId;
      if (rp != null && rp !== '' && partId && rp !== partId) continue;
      if (borderGroups && r.type !== 'GROUP' && r.type !== 'ATTR' && !borderGroups.has(String(r.data.groupId ?? ''))) continue;
      const local = new Group();
      let made = false;
      switch (r.type) {
        case 'POLY': case 'FILL': {
          const pts = (r.data.points ?? []).flatMap((pt: any) => [X(pt.x ?? 0, sxf), Y(pt.y ?? 0, sxf)]);
          if (pts.length >= 4) {
            const closed = r.type === 'FILL' ? true : !!r.data.closed;
            local.add(new Line({
              points: pts, closed,
              stroke: gray ? '#999999' : strokeOf(r.data, COLORS.schComponent),
              strokeWidth: widthOf(r.data, 1),
              strokeCap: 'round', strokeJoin: 'round', // EasyEDA strokes are round-capped (#lib-3)
              dashPattern: dashArrayOf(r.data.strokeStyle),
              fill: fillOf(r.data, r.data.fillStyle ? '#88cccc88' : null),
            }));
            made = true;
          }
          break;
        }
        case 'ARC': case 'ARC2': {
          // symbol arcs use the 3-point form (referX/referY lies ON the arc);
          // the angle form is the fallback for page-drawn arcs (#arc-3pt)
          const [sx, sy] = P(r.data.startX ?? 0, r.data.startY ?? 0, sxf);
          const [ex, ey] = P(r.data.endX ?? r.data.startX ?? 0, r.data.endY ?? r.data.startY ?? 0, sxf);
          const hasRefer = r.data.referX != null && r.data.referX !== '' && r.data.referY != null && r.data.referY !== '';
          const [rx, ry] = hasRefer ? P(Number(r.data.referX), Number(r.data.referY), sxf) : [0, 0];
          const seg = hasRefer
            ? arc3Seg(sx, sy, rx, ry, ex, ey)
            : arcSeg(sx, sy, ex, ey, Number(r.data.angle ?? 0), sxf.flip);
          local.add(new Path({
            path: `M ${sx} ${sy} ${seg}`,
            stroke: gray ? '#999999' : strokeOf(r.data, COLORS.schComponent),
            strokeWidth: widthOf(r.data, 1),
            strokeCap: 'round',
          }));
          made = true;
          break;
        }
        case 'RECT': {
          const [x1, y1] = P(r.data.dotX1 ?? 0, r.data.dotY1 ?? 0, sxf);
          const [x2, y2] = P(r.data.dotX2 ?? r.data.dotX1 ?? 0, r.data.dotY2 ?? r.data.dotY1 ?? 0, sxf);
          local.add(new Rect({
            x: Math.min(x1, x2), y: Math.min(y1, y2),
            width: Math.abs(x2 - x1), height: Math.abs(y2 - y1),
            stroke: gray ? '#999999' : strokeOf(r.data, COLORS.schComponent), strokeWidth: widthOf(r.data, 1),
            dashPattern: dashArrayOf(r.data.strokeStyle),
            fill: fillOf(r.data, null),
            rotation: ang(r.data.rotation ?? 0, sxf),
          }));
          made = true;
          break;
        }
        case 'PIN': {
          const px = r.data.x ?? 0, py = r.data.y ?? 0;
          // EasyEDA schematic angles are clockwise; Math.cos/sin are CCW (#36);
          // the Y-flip reverses the sense, so Y-up docs keep the raw trig
          const a = (sxf.flip ? 1 : -1) * ((r.data.rotation ?? 0) * Math.PI) / 180;
          const len = r.data.length ?? 10;
          const [x1, y1] = P(px, py, sxf);
          const [x2, y2] = P(px + len * Math.cos(a), py + len * Math.sin(a), sxf);
          const pinG = new Group();
          pinG.add(new Line({ points: [x1, y1, x2, y2], stroke: gray ? '#999999' : COLORS.schPin, strokeWidth: 1, strokeCap: 'round', hitStroke: 'all' }));
          if (r.data.pinShape && r.data.pinShape !== 'NONE') {
            const first = r.data.pinShape.includes('HOLE') ? 0.25 : 1;
            const ex = x1 + (x2 - x1) * first, ey = y1 + (y2 - y1) * first;
            pinG.add(new Ellipse({ x: ex - 1.5, y: ey - 1.5, width: 3, height: 3, fill: gray ? '#999999' : COLORS.schPin }));
          }
          // pin name / number labels (attributes parented to the PIN record)
          for (const pa of attrsOf(sym, r.id)) {
            const ad = pa.data;
            // 'Pin Name'/'Pin Number' = classic format; 'NAME'/'NUMBER' = the
            // uppercase historical keys written by newer client versions (#x86-pins)
            if (ad.key !== 'Pin Name' && ad.key !== 'Pin Number' && ad.key !== 'NAME' && ad.key !== 'NUMBER') continue;
            const v = String(ad.value ?? '');
            // on pages, visibility follows the document's valueVisible flag:
            // only an explicit true paints (false/null = hidden);
            // standalone symbol previews force-show (page-level PIN case below)
            if (!v.trim() || ad.valueVisible !== true) continue;
            if (typeof ad.x !== 'number' || typeof ad.y !== 'number') continue;
            const [lx, ly] = P(Number(ad.x), Number(ad.y), sxf);
            const t = new Text({
              text: v, fontSize: Number(ad.fontSize) || 8, fill: gray ? '#999999' : '#000000',
              textAlign: alignX(ad.align), verticalAlign: alignY(ad.align), autoSizeAlign: true,
            });
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
            const t = new Text({
              text: value, fontSize: Number(r.data.fontSize) || 8,
              fill: gray ? '#999999' : strokeOf(r.data, COLORS.schComponent),
              fontFamily: r.data.fontFamily || undefined,
              textAlign: alignX(r.data.align), verticalAlign: alignY(r.data.align ?? 'TOP'),
              autoSizeAlign: true,
            } as any);
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
          // the border component's symbol embeds the title-block table; the page
          // flag "Title Block" decides whether it is drawn at all
          if (skipTitleBlock) break;
          drawTable(local, r.data, sxf);
          made = true;
          break;
        }
        case 'ATTR': {
          // old-style border frames (Sheet-Symbol_*) have no TABLE record — the
          // title block is TEXT artwork plus positioned ATTR slots (审核/页/共…
          // labels' value cells). The lib slots carry the coordinates but empty
          // values; the real values live on the border component's instance
          // attrs and the synthesized sysAttrs (pageAttrs). New-style frames
          // carry the values inside their TABLE cells instead (#titleblock-sysattrs)
          if (!titleValues || skipTitleBlock) break;
          const ad = r.data;
          const key = String(ad.key ?? '');
          if (!key || key === 'Symbol') break;
          if (typeof ad.x !== 'number' || typeof ad.y !== 'number') break;
          const value = resolveAttrRef(titleValues, titleValues[key] ?? '') ?? '';
          if (!value.trim()) break;
          const t = new Text({
            text: value, fontSize: Number(ad.fontSize) || 8, fill: gray ? '#999999' : '#000000',
            textAlign: alignX(ad.align), verticalAlign: alignY(ad.align ?? 'LEFT_BOTTOM'), autoSizeAlign: true,
          });
          t.x = X(Number(ad.x), sxf); t.y = Y(Number(ad.y), sxf);
          if (typeof ad.rotation === 'number' && ad.rotation) t.rotation = ang(ad.rotation, sxf);
          local.add(t);
          made = true;
          break;
        }
        case 'OBJ': {
          // embedded bitmap object: `content`/`path` is a `blob:<id>` URI into
          // the file's BLOB records (base64 data URL). (startX, startY) is the
          // TOP-LEFT corner (verified on the PCB doc's dialog against the
          // reference export), not the center.
          const ref = typeof r.data.content === 'string' && r.data.content.startsWith('blob:') ? r.data.content
            : typeof r.data.path === 'string' && r.data.path.startsWith('blob:') ? r.data.path : null;
          const url = ref ? opened.blobs.get(ref.slice(5)) : undefined;
          if (url) {
            const w = Number(r.data.width) || 0, h = Number(r.data.height) || 0;
            const pic = new LeaferImage({ url, width: w, height: h, x: -w / 2, y: -h / 2 });
            if (r.data.isMirror ?? r.data.mirror) pic.scaleX = -1;
            const pg = new Group({ x: X(Number(r.data.startX ?? 0), sxf) + w / 2, y: Y(Number(r.data.startY ?? 0), sxf) + h / 2 });
            pg.add(pic);
            local.add(pg);
            made = true;
          }
          break;
        }
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
    const p0x = X(x0, xfc), p0y = Y(y0, xfc);
    // local coords relative to the table top-left so rotation pivots correctly
    const lx = (v: number) => X(v, xfc) - p0x;
    const ly = (v: number) => Y(v, xfc) - p0y;
    // EasyEDA draws the title-block grid in the same dark red as the page frame
    const stroke = strokeOf(d, '#a02020'), sw = widthOf(d, 1);
    const rot = ang(d.rotation ?? 0, xfc);
    const grid = new Group({ x: p0x, y: p0y });
    if (rot) grid.rotation = rot;
    for (const x of xs) grid.add(new Line({ points: [lx(x), ly(ys[0]), lx(x), ly(ys[ys.length - 1])], stroke, strokeWidth: sw }));
    for (const y of ys) grid.add(new Line({ points: [lx(xs[0]), ly(y), lx(xs[xs.length - 1]), ly(y)], stroke, strokeWidth: sw }));
    const attrRecord = Object.fromEntries(pageAttrs);
    for (const cell of Array.isArray(d.tableCell) ? d.tableCell : []) {
      const value = resolveAttrRef(attrRecord, String(cell?.value ?? '')) ?? '';
      if (!value) continue;
      const ci = Math.min(Number(cell.columnIndex ?? 0), cols.length - 1);
      const ri = Math.min(Number(cell.rowIndex ?? 0), rows.length - 1);
      const cspan = Math.max(1, Math.min(Number(cell.colSpan ?? cell.columnSpan ?? 1), cols.length - ci));
      const rspan = Math.max(1, Math.min(Number(cell.rowSpan ?? cell.rowSpan ?? 1), rows.length - ri));
      const c1 = ci + cspan, r1 = ri + rspan;
      const fs = cell?.fontStyle ?? {};
      const ha = alignX(fs.hAlign ?? cell?.align);
      const va = alignY(fs.vAlign ?? cell?.align);
      const left = lx(xs[ci]), right = lx(xs[c1]);
      const top = ly(ys[ri]), bottom = ly(ys[r1]);
      const pad = 2;
      let tx = left + pad;
      if (ha === 'center') tx = (left + right) / 2;
      else if (ha === 'right') tx = right - pad;
      let ty = top + pad;
      if (va === 'middle') ty = (top + bottom) / 2;
      else if (va === 'bottom') ty = bottom - pad;
      const t = new Text({
        text: value, fontSize: Number(fs.fontSize ?? cell?.fontSize) || 9,
        fill: fs.color ?? COLORS.schText,
        textAlign: ha,
        verticalAlign: va,
        autoSizeAlign: true,
      });
      t.x = tx; t.y = ty;
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
      // the record's own font name (e.g. 宋体) when the file names one — the
      // browser falls back to its default face when it is not installed
      fontFamily: (typeof d.fontFamily === 'string' && d.fontFamily && d.fontFamily !== 'default')
        ? d.fontFamily : undefined,
      textAlign: alignX(d.align),
      verticalAlign: alignY(d.align),
      autoSizeAlign: true,
    });
    const g = new Group({ x: X(d.x ?? 0, xfc), y: Y(d.y ?? 0, xfc), rotation: ang(d.rotation ?? 0, xfc) });
    g.add(t);
    return g;
  }

  function componentWorldBBox(g: Group, sym: DocSegment | undefined, partId: string, d: any): BBox | null {
    const local: [number, number][] = [];
    if (sym) {
      const sxf = xfOf(sym.canvas, sym.canvas?.yAxisDirection === 'up');
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
    const ra = ((ang(Number(d.rotation ?? 0), xf)) * Math.PI) / 180;
    const c = Math.cos(ra), s = Math.sin(ra);
    const mx = d.isMirror ? -1 : 1; // EasyEDA mirror = flip about the vertical axis through the component origin
    // rotate around the component origin (the symbol insertion point), not the
    // bbox center; mirror/rotation order follows the drawComponent composite —
    // R·M on Y-up pages, M·R on Y-down ones (#mirror-rot-order)
    const world = [[box.minX, box.minY], [box.maxX, box.minY], [box.maxX, box.maxY], [box.minX, box.maxY]].map(([x, y]) => {
      if (!xf.flip) {
        const rx = x * c - y * s, ry = x * s + y * c;
        return [gx + rx * mx, gy + ry] as [number, number];
      }
      const lx = x * mx, ly = y;
      return [gx + lx * c - ly * s, gy + lx * s + ly * c] as [number, number];
    });
    return bboxFromPts(world);
  }

  /** the sheet-border pseudo-component carries page attrs instead of a designator */
  function isBorderComponent(attrs: Rec[]): boolean {
    return !!attrValue(attrs, 'Page Size') || (attrValue(attrs, 'Width') != null && attrValue(attrs, 'Border') != null);
  }

  /**
   * page rectangle of the border frame, in the same world space the other
   * objects' bboxes use (post X/Y): the sheet sits at doc x∈[dx,dx+W],
   * y∈[dy-H,dy] on Y-down pages and y∈[dy,dy+H] on Y-up ones. The former
   * doc-space {0,-H,W,0} leaked the canvas origin into every camera fit
   * (#border-size-override)
   */
  function borderPageBBox(r: Rec, attrs: Rec[]): BBox {
    const std = PAGE_SIZES[String(attrValue(attrs, 'Page Size') ?? '').trim().toUpperCase()];
    const W = Number(attrValue(attrs, 'Width')) || std?.[0] || 1170;
    const H = Number(attrValue(attrs, 'Height')) || std?.[1] || 825;
    const dx = Number(r.data.x ?? 0), dy = Number(r.data.y ?? 0);
    return {
      minX: X(dx, xf),
      maxX: X(dx + W, xf),
      minY: Y(dy + (xf.flip ? H : -H), xf),
      maxY: Y(dy, xf),
    };
  }

  /** PART BBOX of a symbol as {w,h} (the standard Sheet-Symbol_* frame art spans the whole sheet) */
  function symbolFrameSize(seg: DocSegment | undefined): { w: number; h: number } | null {
    if (!seg) return null;
    const bb = seg.recs.find((r) => r.type === 'PART')?.data?.BBOX as number[] | undefined;
    if (!bb || bb.length < 4) return null;
    const w = Math.round(Math.abs(Number(bb[2]) - Number(bb[0])));
    const h = Math.round(Math.abs(Number(bb[3]) - Number(bb[1])));
    return w > 0 && h > 0 ? { w, h } : null;
  }

  /**
   * Standard sheet symbol whose frame art is exactly W×H (Sheet-Symbol_A2/A3/A4/…
   * carry PART BBOX equal to the sheet size and a GROUP 'border' with the artwork).
   */
  function borderSymbolAtSize(w: number, h: number): DocSegment | undefined {
    for (const seg of opened.libs.values()) {
      const size = symbolFrameSize(seg);
      if (!size || size.w !== Math.round(w) || size.h !== Math.round(h)) continue;
      if (seg.recs.some((r) => r.type === 'GROUP' && String(r.data.title ?? '') === 'border')) return seg;
    }
    return undefined;
  }

  /**
   * Migrated pages keep explicit Width/Height overrides on the border instance that
   * disagree with the referenced Sheet-Symbol (e.g. the instance says 1655×1170 = A3
   * but still points at Sheet-Symbol_A4, or references nothing at all). The client
   * paints the frame from the instance size, using the standard border symbol whose
   * art matches that size — verified against the official page thumbnails, whose
   * separators/labels sit at the matching Sheet-Symbol's coordinates. When the
   * embedded libs carry no symbol at that size (eprj3 pages embed only the symbols
   * their own records reference) the wrong-size art is dropped entirely and the
   * parametric frame + transcribed title block take over. A referenced tb-only
   * symbol (new-style Drawing-Symbol_*, no full-frame art) is left alone so its
   * TABLE keeps rendering and only the parametric frame is synthesized.
   */
  function resolveBorderSymbol(attrs: Rec[], sym: DocSegment | undefined): DocSegment | undefined {
    const W = Number(attrValue(attrs, 'Width'));
    const H = Number(attrValue(attrs, 'Height'));
    if (!(W > 0) || !(H > 0)) return sym;
    const cur = symbolFrameSize(sym);
    const fullFrame = cur != null && cur.w >= 600 && cur.h >= 400;
    if (fullFrame && (cur.w !== Math.round(W) || cur.h !== Math.round(H))) {
      return borderSymbolAtSize(W, H);
    }
    if (!sym) return borderSymbolAtSize(W, H);
    return sym;
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
   * All coordinates go through the page xf — Y-up pages place the sheet at
   * y∈[0,H] like their migrated records, Y-down pages at y∈[-H,0]; both are
   * expressed here as "v = height above the sheet's bottom edge" and converted
   * uniformly. When the frame symbol art is unavailable (#border-size-override
   * fallback) the standard title block is transcribed from TB_* (#titleblock-sysattrs).
   */
  function drawBorder(r: Rec, titleValues?: Record<string, string>): void {
    const attrs = byParent.get(r.id) ?? [];
    const dx = Number(r.data.x ?? 0), dy = Number(r.data.y ?? 0);
    const g = new Group({ name: 'border', hittable: false });
    const W = Number(attrValue(attrs, 'Width')) || PAGE_SIZES[String(attrValue(attrs, 'Page Size') ?? '').trim().toUpperCase()]?.[0] || 1170;
    const H = Number(attrValue(attrs, 'Height')) || PAGE_SIZES[String(attrValue(attrs, 'Page Size') ?? '').trim().toUpperCase()]?.[1] || 825;
    const xn = Math.max(1, Number(attrValue(attrs, 'X Region Count')) || 6);
    const yn = Math.max(1, Number(attrValue(attrs, 'Y Region Count')) || 4);
    const blade = Number(attrValue(attrs, 'Blade Width')) || 10;
    const start = Number(attrValue(attrs, 'Region Start')) || 1;
    const col = COLORS.schComponent;
    // doc position of a point at (x, v) — v measured up from the sheet's bottom
    // edge: Y-down pages keep the sheet at y∈[dy-H,dy] (art v=-y), Y-up pages at
    // y∈[dy,dy+H] (art v=y-dy); both fold into one expression
    const P2 = (x: number, v: number): [number, number] => {
      const yDoc = xf.flip ? v + dy : -v + dy;
      return [X(x + dx, xf), Y(yDoc, xf)];
    };
    g.add(new Rect({ x: P2(0, H)[0], y: P2(0, H)[1], width: W, height: H, stroke: col, strokeWidth: 1, fill: null }));
    const mk = (x1: number, v1: number, x2: number, v2: number) => {
      const a = P2(x1, v1), b = P2(x2, v2);
      g.add(new Line({ points: [a[0], a[1], b[0], b[1]], stroke: col, strokeWidth: 1, hittable: false }));
    };
    const lbl = (text: string, x: number, v: number, align = 'CENTER_MIDDLE', size = 10, fill = col) => {
      const t = new Text({
        text, fontSize: size, fill, fontFamily: fill === col ? '宋体' : undefined,
        textAlign: alignX(align), verticalAlign: alignY(align), autoSizeAlign: true,
      });
      const p = P2(x, v);
      t.x = p[0]; t.y = p[1];
      g.add(t);
    };
    // double frame + region grid exactly as the official Sheet-Symbol_N art:
    // inner rect inset by `blade`, grid cells of W/xn × H/yn anchored at the
    // inner rect's top-left corner (verified against Sheet-Symbol_A3 records)
    const inner = P2(blade, H - blade);
    g.add(new Rect({ x: inner[0], y: inner[1], width: W - 2 * blade, height: H - 2 * blade, stroke: col, strokeWidth: 1, fill: null }));
    for (let i = 1; i < xn; i++) {
      const x = blade + (i * W) / xn;
      mk(x, 0, x, blade); mk(x, H, x, H - blade);
    }
    for (let k = 1; k < yn; k++) {
      const v = H - blade - (k * H) / yn;
      mk(0, v, blade, v); mk(W - blade, v, W, v);
    }
    for (let i = 0; i < xn; i++) {
      const x = blade + ((i + 0.5) * W) / xn;
      lbl(String(i + start), x, H - blade / 2); lbl(String(i + start), x, blade / 2);
    }
    for (let j = 0; j < yn; j++) {
      const v = H - blade - ((j + 0.5) * H) / yn;
      lbl(String.fromCharCode(65 + j), blade / 2, v); lbl(String.fromCharCode(65 + j), W - blade / 2, v);
    }
    // title block: fixed 702×180 panel anchored to the bottom-right corner
    if (titleValues) {
      const shift = W - 1655;
      const tb = P2(TB_RECT[0] + shift, TB_RECT[1]);
      g.add(new Rect({
        x: tb[0], y: tb[1],
        width: TB_RECT[2] - TB_RECT[0], height: TB_RECT[1] - TB_RECT[3],
        stroke: col, strokeWidth: 1, fill: null,
      }));
      for (const [x1, v1, x2, v2] of TB_SEPS) mk(x1 + shift, v1, x2 + shift, v2);
      for (const [text, x, v, align] of TB_LABELS) lbl(text, x + shift, v, align, 15);
      for (const [key, x, v, size, align] of TB_SLOTS) {
        const value = resolveAttrRef(titleValues, titleValues[key] ?? '') ?? '';
        if (!value.trim()) continue;
        lbl(value, x + shift, v, align, size, '#000000');
      }
      const url = opened.blobs.get(TB_BLOB_LOGO);
      if (url) {
        const [lw, lh] = [TB_LOGO[2], TB_LOGO[3]];
        const p = P2(TB_LOGO[0] + shift, TB_LOGO[1]);
        const pg = new Group({ x: p[0], y: p[1] });
        pg.add(new LeaferImage({ url, width: lw, height: lh }));
        g.add(pg);
      }
    }
    page.add(g);
  }

  function drawComponent(r: Rec) {
    const d = r.data;
    const attrs = byParent.get(r.id) ?? [];
    const isBorder = isBorderComponent(attrs);
    const symUuid = attrValue(attrs, 'Symbol') ?? attrValue(attrs, 'Device');
    // DEVICE segments are metadata-only: graphics come from the SYMBOL they name
    let sym = resolveLibGraphics(opened.libs, symUuid ? opened.libs.get(symUuid) : undefined, 'Symbol');
    if (!sym) {
      const devUuid = attrValue(attrs, 'Device');
      if (devUuid && devUuid !== symUuid) sym = resolveLibGraphics(opened.libs, opened.libs.get(devUuid), 'Symbol');
    }
    // explicit Width/Height on the border instance wins over the referenced frame
    // symbol's own sheet size (#border-size-override)
    if (isBorder) sym = resolveBorderSymbol(attrs, sym);
    // migrated (Width/Height-carrying) pages fill only the @-system slots of the
    // old-style title block — the official client leaves the Company/Version/"Page
    // Size" value cells empty there even when the instance carries values
    // (#border-size-override, #titleblock-sysattrs)
    const migratedBorder = isBorder && attrValue(attrs, 'Width') != null && attrValue(attrs, 'Height') != null;
    // the A4 frame symbol ships its own region artwork (GROUP 'border') — only
    // synthesize the page frame for symbols that don't carry it, otherwise the
    // region labels/frame lines render twice with slightly different anchors
    const hasBorderArt = !!sym?.recs.some((rr) => rr.type === 'GROUP' && String(rr.data.title ?? '') === 'border');
    // old-style frames (Sheet-Symbol_*) draw their title-block values at the
    // symbol's positioned ATTR slots; new-style frames carry a TABLE whose cells
    // resolve against pageAttrs inside drawSymbolPart — painting slots there too
    // would duplicate the table's cells. Also feeds the synthesized title block
    // when the frame art is unavailable (#border-size-override, #titleblock-sysattrs)
    const titleValues = isBorder && titleBlockEnabled && (!sym || !sym.recs.some((rr) => rr.type === 'TABLE'))
      ? Object.fromEntries(
          migratedBorder
            ? [...pageAttrs].filter(([k]) => k.startsWith('@'))
            : pageAttrs,
        )
      : undefined;
    if (isBorder && borderEnabled && !hasBorderArt) drawBorder(r, titleValues);
    // "Add into BOM = no" parts (DNP/NC) render all-gray like the EasyEDA export
    const gray = attrValue(attrs, 'Add into BOM') === 'no';
    const g = new Group({ name: `comp:${r.id}` });
    g.x = X(d.x ?? 0, xf);
    g.y = Y(d.y ?? 0, xf);
    // EasyEDA mirrors about the component's own vertical axis, then rotates —
    // R·M in doc space. On Y-up pages ang() keeps the raw angle and one group
    // with rotation+scaleX realizes it (leafer composes T·R·M, mirror
    // innermost). On Y-down pages the negated screen angle conjugates the
    // composite into M·R — the mirror must wrap the rotation group, otherwise
    // mirrored+rotated parts land 2·θ off their wires (#mirror-rot-order;
    // verified against wire endpoints: 735/737 mirrored pins hit vs 623 before)
    let target = g;
    const rot = ang(d.rotation ?? 0, xf);
    if (xf.flip) {
      g.rotation = rot;
      if (d.isMirror) g.scaleX = -1;
    } else {
      if (d.isMirror) g.scaleX = -1;
      const rotG = new Group({ rotation: rot });
      g.add(rotG);
      target = rotG;
    }
    page.add(g);
    if (sym) {
      drawSymbolPart(target, sym, String(d.partId ?? ''), 0, 0, 0, false, rot, isBorder && !titleBlockEnabled, gray, titleValues);
      //        ^ rotation stays 0 — the component rotation lives on the outer
      //          chain; `rot` only cancels itself for pin text (antiRot)
      drawComponentAttrs(g, attrs, sym, String(d.partId ?? ''), { gray, hideAll: isBorder && !titleBlockEnabled });
    } else if (symUuid && !isBorder) {
      // unresolved symbol — fallback marker so user sees something (border
      // components are rendered by the synthesized frame above instead)
      const fr = new Rect({ x: -15, y: -10, width: 30, height: 20, stroke: '#cc0000', strokeWidth: 1, dashPattern: [3, 3] });
      g.add(fr);
      api.reportDiagnostics.push(`未解析符号 ${symUuid.slice(0, 10)} (line ${r.lineNo})`);
    }
    api.addObject({
      id: r.id, rec: r, node: g, label: `元件 ${r.id}`, kind: 'component',
      title: isBorder
        ? `图纸 ${attrValue(attrs, 'Page Size') ?? ''}`.trim()
        : (attrValue(attrs, 'Designator') ?? String((sym?.meta as any)?.title ?? d.attrs?.Designator ?? d.partId ?? r.id)),
      // the border component contributes the full page rect so camera fit shows the whole sheet
      bbox: isBorder ? borderPageBBox(r, attrs) : (componentWorldBBox(g, sym, String(d.partId ?? ''), d) ?? undefined),
    });
  }

  /**
   * Attribute texts of a placed component. Instance ATTR records carry absolute
   * page coordinates plus per-attribute visibility; values resolve
   * instance → symbol library default → device META.attributes, with ={…}
   * formulas resolved against the merged map. Attributes without coordinates
   * are library metadata and stay hidden, exactly like the EasyEDA export.
   * Net names (NET / Global Net Name) paint blue, everything else black;
   * "Add into BOM = no" parts (DNP/NC) render gray.
   */
  function drawComponentAttrs(g: Group, attrs: Rec[], sym: DocSegment, partId: string, opts: { gray: boolean; hideAll: boolean }): void {
    if (opts.hideAll) return; // border component with the title block switched off
    // multi-part symbol: designator gets ".N" from the part's position in the PART list
    const partList = sym.recs.filter((r) => r.type === 'PART').map((r) => String(r.id ?? ''));
    const pIdx = partList.indexOf(partId);
    const suffix = partList.length > 1 && pIdx >= 0 ? String(pIdx + 1) : undefined;
    // device meta attributes: resolution floor for null instance values and the
    // scope for ={…} formulas; {Device} names the device title (U14 →
    // "BTB-24P(12x2)-0.4mm"), not the uuid the Device attr stores
    const devUuid = String(attrValue(attrs, 'Device') ?? '');
    const devSeg = opened.libs.get(devUuid);
    const metaAny = devSeg?.meta as any;
    const metaAttrs: Record<string, string> = metaAny?.attributes ?? {};
    const varMap: Record<string, string> = { ...metaAttrs };
    for (const a of attrs) { const k = String(a.data.key ?? ''); if (k && a.data.value != null) varMap[k] = String(a.data.value); }
    if (devSeg?.meta?.title) varMap.Device = String(devSeg.meta.title);
    // description tokens only feed the legacy synthesis fallback below
    // ("32.768kHz ±20ppm 12.5pF" → "32.768kHz")
    const descText = String(metaAny?.description ?? metaAny?.attributes?.['LCSC Part Name'] ?? '');
    const tokenRe = /^\d+(\.\d+)?([kKmMµunp])?(F|Ω|V|H)Z?$/i;
    const firstToken = descText.split(/\s+/).find((t) => tokenRe.test(t)) ?? '';
    const grayColor = opts.gray ? '#999999' : null;
    const defaultColor = (key: string) => grayColor ?? (key === 'NET' || key === 'Global Net Name' ? '#0000ff' : '#000000');
    type Item = { key: string; label: string; a: Rec; def: Rec | null };
    const items: Item[] = [];
    for (const a of attrs) {
      const ad = a.data;
      const key = String(ad.key ?? '');
      // Symbol/Device hold uuids (the border's Symbol attr even has coordinates)
      // and Pin Name/Number live on PIN records — metadata, never painted here
      if (!key || key === 'Symbol' || key === 'Device' || key === 'Pin Name' || key === 'Pin Number') continue;
      // unpositioned instance attrs are library metadata (R100's Value "0Ω",
      // Q5's Footprint uuid …) — EasyEDA does not paint them at all
      if (typeof ad.x !== 'number' || typeof ad.y !== 'number') continue;
      // valueVisible is the per-value display switch the client's property panel
      // toggles: true = shown, false = unchecked, null = never checked (stored
      // for every attr, e.g. OFFPAGELEFT_R's IREF or a CPU's Name — not painted).
      // Verified across all samples: every painted attr carries an explicit flag.
      // Exception — net flags & ports (symbol docType 18/19): the net name IS the
      // symbol's label, the client paints a value-bearing Name / Global Net Name
      // whatever the flag says. Older saves keep every GNN at null (327 across
      // X86-PC's 71 sheets, vv=true 0) yet the official renders show the labels;
      // newer client saves moved them to Name vv=true. A null-value Name (GND
      // flags on the CPU sheet, the CPU's own Name) still stays hidden.
      if (ad.valueVisible !== true) {
        const dt = Number(sym.meta?.docType);
        const flagLabel = (dt === 18 || dt === 19) && (key === 'Name' || key === 'Global Net Name') && String(ad.value ?? '').trim() !== '';
        if (!flagLabel) continue;
      }
      const def = libDefAttr(sym, partId, key);
      const raw = ad.value ?? def?.data.value ?? metaAttrs[key] ?? '';
      let value = resolveAttrRef(varMap, String(raw)) ?? '';
      if (key === 'Footprint' && /^[0-9a-f]{16,}$/i.test(value)) {
        // footprint attrs store the footprint doc uuid; EasyEDA displays its title
        value = String(opened.libs.get(value)?.meta?.title ?? value);
      }
      if (key === 'Designator' && suffix) value = `${value}.${suffix}`;
      if (!value.trim()) continue;
      items.push({ key, label: ad.keyVisible === true ? `${key}: ${value}` : value, a, def });
    }
    // power flags carry the net in both 'Name' and 'Global Net Name' at the same
    // spot; EasyEDA paints it once — keep the blue Global Net Name copy
    const gnn = items.find((i) => i.key === 'Global Net Name');
    let sawNetText = false;
    let desPos: [number, number] | null = null;
    for (const it of items) {
      if (it.key === 'Name' && gnn && gnn.label === it.label) continue;
      const ad = it.a.data;
      const align = ad.align ?? it.def?.data.align;
      const t = new Text({
        text: it.label, fontSize: Number(ad.fontSize ?? it.def?.data.fontSize) || 8,
        fill: strokeOf({ strokeColor: ad.color ?? it.def?.data.color }, defaultColor(it.key)),
        textAlign: alignX(align),
        verticalAlign: alignY(align ?? 'LEFT_BOTTOM'),
        autoSizeAlign: true,
      });
      t.x = X(Number(ad.x), xf);
      t.y = Y(Number(ad.y), xf);
      if (typeof ad.rotation === 'number' && ad.rotation) t.rotation = ang(ad.rotation, xf);
      if (it.key === 'Designator') desPos = [t.x, t.y];
      if (it.key === 'Name' || it.key === 'Value' || it.key === 'NET' || it.key === 'Global Net Name') sawNetText = true;
      page.add(t);
    }
    // legacy fallback for libraries without positioned attributes: derive a
    // value token from the device description so the part still shows one
    if (!sawNetText && !suffix && firstToken && desPos) {
      const t = new Text({ text: firstToken, fontSize: 8, fill: grayColor ?? '#0000ff', textAlign: 'left', verticalAlign: 'top', autoSizeAlign: true });
      t.x = desPos[0]; t.y = desPos[1] + 8;
      page.add(t);
    }
  }

  // ---- page primitives ----
  // record ids of this page: wires deleted in the client leave LINEs whose
  // lineGroup parent is gone; EasyEDA never renders those orphans (#3)
  const pageRecIds = new Set(seg.recs.map((r) => r.id));
  function drawPrimitive(r: Rec) {
    const d = r.data;
    let node: Group | null = null;
    // 线类图元的实际绘制路径顶点(屏幕坐标)—— 选中高亮沿路径贴合而非
    // 取整体 bbox 最大矩形;仅导线/多段线/弧设置(#select-box-path)
    let pathPts: [number, number][] | undefined;
    switch (r.type) {
      case 'LINE': {
        const gk = String(d.lineGroup ?? '');
        if (gk && !pageRecIds.has(gk)) return;
        const [x1, y1] = P(d.startX ?? 0, d.startY ?? 0, xf);
        const [x2, y2] = P(d.endX ?? d.startX ?? 0, d.endY ?? d.startY ?? 0, xf);
        node = new Group();
        if (x1 === x2 && y1 === y2) {
          // zero-length wire segment = junction marker (red dot in EasyEDA)
          node.add(new Ellipse({ x: x1 - 1.8, y: y1 - 1.8, width: 3.6, height: 3.6, fill: '#d40000', hittable: false }));
        } else {
          pathPts = [[x1, y1], [x2, y2]];
          node.add(new Line({
            points: [x1, y1, x2, y2],
            stroke: strokeOf(d, COLORS.net),
            strokeWidth: widthOf(d, 1),
            strokeCap: 'round',
            strokeJoin: 'round',
            dashPattern: dashArrayOf(d.strokeStyle),
            hitStroke: 'all',
          }));
          if (gk) {
            const arr = wireGroups.get(gk) ?? [];
            arr.push({ x1, y1, x2, y2 });
            wireGroups.set(gk, arr);
          }
        }
        break;
      }
      case 'POLY': case 'FILL': {
        const pts = (d.points ?? []).flatMap((pt: any) => [X(pt.x ?? 0, xf), Y(pt.y ?? 0, xf)]);
        if (pts.length >= 4) {
          if (r.type === 'POLY') { // FILL 矩形填充保持 bbox 框
            pathPts = [];
            for (let i = 0; i + 1 < pts.length; i += 2) pathPts.push([pts[i], pts[i + 1]]);
          }
          node = new Group();
          node.add(new Line({
            points: pts, closed: r.type === 'FILL' || !!d.closed,
            stroke: strokeOf(d, COLORS.schStroke), strokeWidth: widthOf(d, 1),
            strokeCap: 'round', strokeJoin: 'round', // #lib-3
            dashPattern: dashArrayOf(d.strokeStyle),
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
          stroke: strokeOf(d, '#000000'), strokeWidth: widthOf(d, 1),
          dashPattern: dashArrayOf(d.strokeStyle),
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
        // three-point form (referX/referY on the arc) wins over the angle form (#arc-3pt)
        const hasRefer = d.referX != null && d.referX !== '' && d.referY != null && d.referY !== '';
        const [rx, ry] = hasRefer ? P(Number(d.referX), Number(d.referY), xf) : [0, 0];
        const seg = hasRefer
          ? arc3Seg(sx, sy, rx, ry, ex, ey)
          : arcSeg(sx, sy, ex, ey, Number(d.angle ?? 0), xf.flip);
        // 采样弧为折线顶点,与 seg 画出的 SVG 弧逐点吻合(#select-box-path)
        pathPts = hasRefer
          ? arc3Pts(sx, sy, rx, ry, ex, ey)
          : arcPts(sx, sy, ex, ey, Number(d.angle ?? 0), xf.flip);
        node = new Group();
        node.add(new Path({
          path: `M ${sx} ${sy} ${seg}`,
          stroke: strokeOf(d, COLORS.net), strokeWidth: widthOf(d, 1),
          strokeCap: 'round',
        }));
        break;
      }
      case 'ELLIPSE': case 'OVAL': {
        const cx = X(d.x ?? 0, xf), cy = Y(d.y ?? 0, xf);
        node = new Group();
        node.add(new Ellipse({ x: cx - (d.radiusX ?? 5), y: cy - (d.radiusY ?? 5), width: (d.radiusX ?? 5) * 2, height: (d.radiusY ?? 5) * 2, stroke: strokeOf(d, '#000000'), strokeWidth: widthOf(d, 1), fill: fillOf(d, null) }));
        break;
      }
      case 'PIN': {
        const px = d.x ?? 0, py = d.y ?? 0;
        // EasyEDA schematic angles are clockwise; Math.cos/sin are CCW (#36);
        // the Y-flip reverses the sense, so Y-up docs keep the raw trig
        const a = (xf.flip ? 1 : -1) * ((d.rotation ?? 0) * Math.PI) / 180;
        const len = d.length ?? 10;
        const [x1, y1] = P(px, py, xf);
        const [x2, y2] = P(px + len * Math.cos(a), py + len * Math.sin(a), xf);
        node = new Group();
        node.add(new Line({ points: [x1, y1, x2, y2], stroke: COLORS.schPin, strokeWidth: 1, strokeCap: 'round', hitStroke: 'all' }));
        if (d.pinShape && d.pinShape !== 'NONE') {
          const first = String(d.pinShape).includes('HOLE') ? 0.25 : 1;
          node.add(new Ellipse({ x: x1 + (x2 - x1) * first - 1.5, y: y1 + (y2 - y1) * first - 1.5, width: 3, height: 3, fill: COLORS.schPin }));
        }
        // standalone symbol preview (top-level PINs): pin name / number labels
        // ALWAYS show here, regardless of the valueVisible flag (#lib-2)
        for (const pa of byParent.get(r.id) ?? []) {
          const ad = pa.data;
          // 'Pin Name'/'Pin Number' = classic format; 'NAME'/'NUMBER' = the
          // uppercase historical keys written by newer client versions (#x86-pins)
          if (ad.key !== 'Pin Name' && ad.key !== 'Pin Number' && ad.key !== 'NAME' && ad.key !== 'NUMBER') continue;
          const v = String(ad.value ?? '');
          if (!v.trim() || typeof ad.x !== 'number' || typeof ad.y !== 'number') continue;
          const [lx, ly] = P(Number(ad.x), Number(ad.y), xf);
          const t = new Text({
            text: v, fontSize: Number(ad.fontSize) || 8, fill: '#000000',
            textAlign: alignX(ad.align), verticalAlign: alignY(ad.align), autoSizeAlign: true,
          });
          t.x = lx; t.y = ly;
          if (typeof ad.rotation === 'number') t.rotation = ang(Number(ad.rotation), xf);
          node.add(t);
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
        if (!titleBlockEnabled) break; // page flag: title block disabled
        node = new Group();
        drawTable(node, d, xf);
        break;
      }
      case 'OBJ': {
        // page-level bitmap object: `content`/`path` is a `blob:<id>` URI into
        // the file's BLOB records (base64 data URL) — resolvable via opened.blobs.
        // (startX, startY) is the TOP-LEFT corner; the pic is centered on the
        // group so mirror flips stay centered (same pattern as the PCB renderer).
        const ref = typeof d.content === 'string' && d.content.startsWith('blob:') ? d.content
          : typeof d.path === 'string' && d.path.startsWith('blob:') ? d.path : null;
        const url = ref ? opened.blobs.get(ref.slice(5)) : undefined;
        if (!url) return; // blob missing — nothing to draw
        const w = Number(d.width) || 0, h = Number(d.height) || 0;
        const pic = new LeaferImage({ url, width: w, height: h, x: -w / 2, y: -h / 2 });
        if (d.isMirror ?? d.mirror) pic.scaleX = -1;
        node = new Group({ x: X(Number(d.startX ?? 0), xf) + w / 2, y: Y(Number(d.startY ?? 0), xf) + h / 2 });
        if (Number(d.rotation ?? 0)) node.rotation = ang(Number(d.rotation), xf);
        node.add(pic);
        break;
      }
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
      pathPts,
    });
  }

  for (const r of sortZ(seg.recs)) drawPrimitive(r);
  drawJunctions(wireGroups);
  // no-connect flags: page ATTRs keyed NO_CONNECT on "{component}-{pin}" parents.
  // value "yes" marks the pin as intentionally unconnected — the client draws a
  // green × at the pin tip; any other value ("no") stays invisible. The attr
  // x/y is only a display cache that goes stale when the component moves (the
  // CPU page shows exact 5/10 mil lags), so resolve the live pin anchor from
  // the parent ids instead. Parents whose ids no longer exist in the page are
  // treated as "not applied" by the client (the migrated X86-PC sheets left
  // NO_CONNECT parents pointing at pre-migration ids; adding an "i"-prefixed
  // fallback resolved them and wrongly painted × the client does not show) —
  // so unresolvable parents are skipped, matching the client.
  const ncCompById = new Map<string, Rec>();
  for (const r of seg.recs) if (r.type === 'COMPONENT') ncCompById.set(r.id, r);
  const ncAnchorCache = new Map<string, { x: number; y: number } | null>();
  const ncAnchor = (parentId: string): { x: number; y: number } | null => {
    if (ncAnchorCache.has(parentId)) return ncAnchorCache.get(parentId)!;
    let out: { x: number; y: number } | null = null;
    const m = /^(.+?)-(.+)$/.exec(parentId);
    const comp = m ? ncCompById.get(m[1]) : undefined;
    if (m && comp) {
      const attrs = byParent.get(comp.id) ?? [];
      const symUuid = attrValue(attrs, 'Symbol') ?? attrValue(attrs, 'Device');
      let sym = resolveLibGraphics(opened.libs, symUuid ? opened.libs.get(symUuid) : undefined, 'Symbol');
      if (!sym) {
        const devUuid = attrValue(attrs, 'Device');
        if (devUuid && devUuid !== symUuid) sym = resolveLibGraphics(opened.libs, opened.libs.get(devUuid), 'Symbol');
      }
      const pin = sym?.recs.find((pr) => pr.type === 'PIN' && pr.id === m[2]);
      if (sym && pin) {
        // same transform chain as drawComponent: symbol-canvas offset, then the
        // mirror/rotation composite — R·M on Y-up pages, M·R on Y-down ones
        // (#mirror-rot-order) — and finally the component translation
        const sxf = xfOf(sym.canvas, sym.canvas?.yAxisDirection === 'up');
        const d = comp.data;
        const lx0 = X(Number(pin.data.x ?? 0), sxf);
        const ly = Y(Number(pin.data.y ?? 0), sxf);
        const ra = (ang(Number(d.rotation ?? 0), xf) * Math.PI) / 180;
        const c = Math.cos(ra), s = Math.sin(ra);
        let dx: number, dy: number;
        if (xf.flip) {
          const lx = d.isMirror ? -lx0 : lx0;
          dx = lx * c - ly * s;
          dy = lx * s + ly * c;
        } else {
          const rx = lx0 * c - ly * s, ry = lx0 * s + ly * c;
          dx = d.isMirror ? -rx : rx;
          dy = ry;
        }
        out = {
          x: X(Number(d.x ?? 0), xf) + dx,
          y: Y(Number(d.y ?? 0), xf) + dy,
        };
      }
    }
    ncAnchorCache.set(parentId, out);
    return out;
  };
  for (const r of seg.recs) {
    if (r.type !== 'ATTR' || r.data.key !== 'NO_CONNECT' || String(r.data.value ?? '') !== 'yes') continue;
    const pos = ncAnchor(String(r.data.parentId ?? ''));
    if (!pos) continue; // dangling parent — the client does not apply it either
    const cx = pos.x;
    const cy = pos.y;
    const arm = 4.5;
    const cross = new Group({ hittable: false });
    cross.add(new Line({ points: [cx - arm, cy - arm, cx + arm, cy + arm], stroke: COLORS.net, strokeWidth: 1, strokeCap: 'round' }));
    cross.add(new Line({ points: [cx - arm, cy + arm, cx + arm, cy - arm], stroke: COLORS.net, strokeWidth: 1, strokeCap: 'round' }));
    page.add(cross);
  }
  // net labels parented to wires (component-attached ones render with the component;
  // labels of deleted wires are orphans like their LINEs and must not render)
  const compIds = new Set(seg.recs.filter((r) => r.type === 'COMPONENT').map((r) => r.id));
  for (const r of seg.recs) {
    if (r.type !== 'ATTR' || r.data.key !== 'NET' || compIds.has(String(r.data.parentId ?? ''))) continue;
    const parent = String(r.data.parentId ?? '');
    if (parent && !pageRecIds.has(parent)) continue;
    const ad = r.data;
    const v = String(ad.value ?? '');
    if (!v.trim() || ad.valueVisible !== true || typeof ad.x !== 'number' || typeof ad.y !== 'number') continue;
    // no explicit align → EasyEDA parks the label just ABOVE the wire (left-aligned,
    // bottom edge lifted ~0.4em off the anchor; centered on the anchor overlaps the line)
    const plain = ad.align == null || ad.align === '';
    const t = new Text({
      text: v, fontSize: Number(ad.fontSize) || 8, fill: strokeOf({ strokeColor: ad.color }, '#0000ff'),
      textAlign: plain ? 'left' : alignX(ad.align), verticalAlign: plain ? 'bottom' : alignY(ad.align), autoSizeAlign: true,
      lineHeight: 1, // default line-height > 1 leaves an invisible gap under the glyphs (#net-gap)
    });
    t.x = X(Number(ad.x), xf); t.y = Y(Number(ad.y), xf);
    const rot = typeof ad.rotation === 'number' ? ang(Number(ad.rotation), xf) : 0;
    if (rot) t.rotation = rot;
    // lift the bottom-aligned glyphs ~0.4em off the wire along the text's own up
    // axis (user pref: a bit higher than the 1.6wu measured in the ref export — #net-gap)
    const lift = (Number(ad.fontSize) || 8) * 0.4;
    const rr = (rot * Math.PI) / 180;
    t.x += lift * Math.sin(rr);
    t.y += -lift * Math.cos(rr);
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

/** EasyEDA stroke style → leafer dash array (px) */
function dashArrayOf(style: unknown): number[] | undefined {
  switch (String(style ?? '').toUpperCase()) {
    case 'DASHED': return [6, 4];
    case 'DOTTED': return [1, 3];
    case 'DASH_DOT': case 'DOT_DASH': return [7, 3, 1.5, 3];
    case 'DASH_DOT_DOT': return [7, 3, 1.5, 3, 1.5, 3];
    default: return undefined;
  }
}

function sortZ(recs: Rec[]): Rec[] {
  return [...recs].sort((a, b) => (Number(a.data.zIndex ?? 0) || 0) - (Number(b.data.zIndex ?? 0) || 0));
}
