/** PCB / PANEL renderer: layer-driven colors, pads/tracks/text/pours. */
import { Group, Line, Rect, Path, Text, Ellipse } from 'leafer-ui';
import type { OpenedDoc, Rec, DocSegment } from '../types';
import type { RenderApi, RenderObject } from './layers';
import { X, Y, P, ang, strokeOf, widthOf, xfOf, objBBox, bboxFromPts, multiPathToSvg, scalePourItems, type BBox } from './geom';
import { resolveLibGraphics } from '../model';

/** standard EasyEDA layer ids (numeric layerId used by primitives) */
export const LAYER = {
  TOP: 1, BOTTOM: 2, TOP_SILK: 3, BOT_SILK: 4, TOP_MASK: 5, BOT_MASK: 6,
  TOP_PASTE: 7, OUTLINE: 11, MULTI: 12, DOCUMENT: 13, INNER1: 14,
  KEEPIN: 19, HOLE: 47,
};
/** utility layers EasyEDA keeps in data but never paints in 2D view
 * (49/50 = soldering/pin-soldering pads — the rose discs over through-hole pads) */
const HIDDEN_LAYERS = new Set(['49', '50']);

/** bottom-side layers seen through the board are semi-transparent in EasyEDA's
 * 2D view — alphas measured from the official export (#336619 silk @50%, #000059 copper @70%) */
const BOTTOM_ALPHA: Record<string, number> = { '2': 0.7, '4': 0.5, '6': 0.5, '8': 0.5, '10': 0.5 };

/** used only when a LAYER record is missing; files carry the real names+colors */
const LAYER_FALLBACK: Record<number, string> = {
  1: '#ff0000',      // Top copper
  2: '#0000ff',      // Bottom copper
  3: '#ffffff',      // Top silk
  4: '#ffffff',      // Bottom silk
  5: '#800000',      // Top solder mask
  6: '#000080',      // Bottom solder mask
  7: '#c0c0c0',      // Top paste
  8: '#c0c0c0',      // Bottom paste
  9: '#ff9900',      // Top adhesive / glue
  10: '#ff9900',     // Bottom adhesive
  11: '#e0e0e0',     // Board outline
  12: '#c0c0c0',     // Multi-layer / pads
  13: '#7f7f7f',     // Document
  14: '#008000',     // Inner1
  15: '#008000',     // Inner2
  16: '#008000',     // Inner3
  17: '#008000',     // Inner4
  18: '#008000',     // Inner5
  19: '#00a000',     // Keep-out
  47: '#c8a400',     // Drill / hole
};

/** records embedded at the head of each FOOTPRINT sub-segment (its own doc boilerplate) */
const FOOTPRINT_STRUCTURAL = new Set([
  'DOCHEAD', 'CANVAS', 'META', 'GROUP', 'PART', 'ATTR', 'PAD_NET', 'PRIMITIVE',
  'LAYER', 'LAYER_PHYS', 'ACTIVE_LAYER', 'RULE', 'RULE_TEMPLATE', 'RULE_NET',
  'RULE_DIFF_PAIR', 'RULE_EQUAL_LENGTH', 'RULE_SELECTOR', 'SILK_OPTS', 'PREFERENCE',
  'PANELIZE', 'NET', 'LAYER_STACK', 'VIA_TYPE', 'PAD_TYPE', 'DRC_RULE',
]);

/** skip the auto-generated element-id text EasyEDA puts on the document layer (#9) */
function isDocIdText(d: any): boolean {
  const lid = String(d.layerId ?? '');
  if (lid !== '13') return false;
  const t = String(d.text ?? d.value ?? '').trim();
  return /^e\d+$/i.test(t);
}

/** pad shape → leafer node (local footprint coords, center at cx,cy).
 * `holeFill` is the canvas background: drills punch through the board, they
 * are not a colored ink layer (EasyEDA shows them as bg-colored holes). */
function padNode(d: any, xf: ReturnType<typeof xfOf>, colorOf: (id: unknown) => string, holeFill: string): Group {
  const g = new Group();
  // padOffset is applied inside the pad's own rotated coordinate frame (#13)
  const padAngle = (Number(d.padAngle ?? 0) * Math.PI) / 180;
  const offX = Number(d.padOffsetX ?? 0), offY = Number(d.padOffsetY ?? 0);
  const rawX = Number(d.centerX ?? 0) + offX * Math.cos(padAngle) - offY * Math.sin(padAngle);
  const rawY = Number(d.centerY ?? 0) + offX * Math.sin(padAngle) + offY * Math.cos(padAngle);
  const cx = X(rawX, xf), cy = Y(rawY, xf);
  const dp = d.defaultPad ?? {};
  const w = Number(dp.width ?? 10), h = Number(dp.height ?? 10);
  const color = colorOf(d.layerId ?? LAYER.TOP);
  const shape = String(dp.padType ?? 'RECT').toUpperCase();
  let pad: Group['children'][number] | null = null;
  if (shape === 'ELLIPSE' || shape === 'ROUND' || shape === 'CIRCLE') {
    pad = new Ellipse({ x: cx - w / 2, y: cy - h / 2, width: w, height: h, fill: color });
  } else if (shape === 'OVAL' || shape === 'SLOT') {
    const cr = Math.min(w, h) / 2;
    pad = new Rect({ x: cx - w / 2, y: cy - h / 2, width: w, height: h, fill: color, cornerRadius: [cr, cr, cr, cr] });
  } else {
    pad = new Rect({ x: cx - w / 2, y: cy - h / 2, width: w, height: h, fill: color, cornerRadius: (Number(dp.radius) || 0) });
  }
  pad.rotation = ang(Number(d.padAngle ?? 0));
  g.add(pad);
  const hole = d.hole;
  if (hole) {
    const hw = Number(hole.width ?? 0), hh = Number(hole.height ?? hw);
    if (hw > 0) {
      const ht = String(hole.holeType ?? 'ROUND').toUpperCase();
      let hn: any;
      if (ht === 'SLOT') {
        // oblong drill: rounded-rect with half-circle caps, NOT a pointed ellipse
        const cr = Math.min(hw, hh) / 2;
        hn = new Rect({ x: cx - hw / 2, y: cy - hh / 2, width: hw, height: hh, fill: holeFill, cornerRadius: [cr, cr, cr, cr] });
      } else if (ht === 'SQUARE') {
        hn = new Rect({ x: cx - hw / 2, y: cy - hh / 2, width: hw, height: hh, fill: holeFill });
      } else {
        hn = new Ellipse({ x: cx - hw / 2, y: cy - hh / 2, width: hw, height: hh, fill: holeFill });
      }
      hn.rotation = pad.rotation;
      g.add(hn);
    }
  }
  return g;
}

export function renderPcb(opened: OpenedDoc, api: RenderApi): void {
  const seg = opened.self;
  const xf = xfOf(seg.canvas);

  // layers from LAYER records
  const layerMeta = new Map<string, { name: string; color: string; show: boolean }>();
  for (const r of seg.recs) {
    if (r.type !== 'LAYER') continue;
    const m = r.idVal;
    let key = r.id;
    let numId: number | null = null;
    if (Array.isArray(m) && m.length >= 2) { numId = Number(m[1]); key = String(numId); }
    else {
      const p = r.id.split(',');
      if (p[0] === 'LAYER' && p[1]) { numId = Number(p[1]); key = p[1]; }
    }
    if (numId == null || !isFinite(numId)) continue;
    const c = String(r.data.activeColor ?? r.data.color ?? r.data.layerColor ?? LAYER_FALLBACK[numId] ?? '#999999');
    const show = r.data.show !== false && r.data.visible !== false;
    layerMeta.set(key, {
      name: String(r.data.layerName ?? r.data.name ?? r.data.layerType ?? `Layer ${key}`),
      color: c.startsWith('#') ? c : '#' + c,
      show,
    });
    api.layer(key, layerMeta.get(key)!.name, layerMeta.get(key)!.color, show);
  }
  const layerColor = (id: unknown): string => {
    const lm = layerMeta.get(String(id));
    if (lm) return lm.color;
    return LAYER_FALLBACK[Number(id)] ?? '#999999';
  };
  /** drill/via holes punch through to the canvas background */
  const holeFill = api.bgColor;
  /** attribute labels (net names / pad numbers / designators) keep a small
   * fixed pixel size at any zoom (see RenderApi.addConstantText) */
  const LABEL_PX = 9;

  /** PCB text node. `docScale` (STRING silk records) renders at the file's
   * own font size so silk grows/shrinks with the board like EasyEDA does;
   * attribute labels are fixed-pixel instead.
   * Origin token (LEFT_BOTTOM …) selects the anchor within the given point. */
  function mkLabel(d: any, color: string, xfc: ReturnType<typeof xfOf>, docScale = false): Text {
    const fs = docScale ? (Number(d.fontSize) || LABEL_PX) : LABEL_PX;
    const t = new Text({
      text: String(d.text ?? d.value ?? ''), fontSize: fs,
      // silk uses heavy display fonts (e.g. 阿里巴巴普惠体 Heavy) — approximate
      // with a bold sans face so weight/styles stay close to the reference
      fontFamily: docScale ? 'Arial Black, Arial Bold, Microsoft YaHei, sans-serif' : undefined,
      fill: color, bold: docScale || !!d.bold,
      textAlign: alignX(d.origin),
      verticalAlign: String(d.origin ?? '').toUpperCase().includes('BOTTOM') ? 'bottom'
        : String(d.origin ?? '').toUpperCase().includes('TOP') ? 'top' : 'middle',
    } as any);
    t.x = X(Number(d.x ?? 0), xfc);
    t.y = Y(Number(d.y ?? 0), xfc);
    t.rotation = ang(Number(d.angle ?? d.rotation ?? 0));
    if (d.reverse) t.scaleX = -1;
    if (d.mirror) t.scaleY = -1;
    if (!docScale) api.addConstantText(t, LABEL_PX);
    return t;
  }

  const byParent = indexByParent(seg.recs);

  // POUR carries the layerId of its generated fill (POURED id "POURED,<pourId>")
  const pourLayer = new Map<string, unknown>();
  for (const r of seg.recs) if (r.type === 'POUR') pourLayer.set(String(r.id), r.data.layerId);

  // Bottom-silk strings are stored as auto-generated mirror copies of the
  // top-silk originals (same text/size, anchor offset along the text axis);
  // the official 2D view paints them exactly under their L3 twins, so only
  // unique bottom text (e.g. the part-number watermark) is ever visible.
  // Skip the twins instead of trying to reproduce the mirror anchor.
  const silkTwins = new Set<object>();
  {
    const top = seg.recs.filter((r) => r.type === 'STRING' && String(r.data.layerId) === '3');
    for (const r of seg.recs) {
      if (r.type !== 'STRING' || String(r.data.layerId) !== '4') continue;
      const t = String(r.data.text ?? '').trim();
      const fs = Number(r.data.fontSize ?? 0);
      const x = Number(r.data.x ?? 0);
      const y = Number(r.data.y ?? 0);
      const tol = Math.max(20, fs * (t.length + 2));
      if (top.some((o) => String(o.data.text ?? '').trim() === t && Number(o.data.fontSize ?? 0) === fs &&
        Math.abs(Number(o.data.x ?? 0) - x) <= tol && Math.abs(Number(o.data.y ?? 0) - y) <= tol)) silkTwins.add(r.data);
    }
  }

  const addToLayer = (d: any, obj: Rec, node: Group, label: string, kind: RenderObject['kind'] = 'primitive') => {
    const lid = d.layerId != null ? String(d.layerId) : '0';
    if (HIDDEN_LAYERS.has(lid)) return; // never-painted utility layers (#27 area)
    const lm = layerMeta.get(lid);
    api.layer(lid, lm?.name, lm?.color ?? LAYER_FALLBACK[Number(lid)] ?? '#888888', lm?.show ?? true).add(node);
    // bottom-side layers show through the board at partial opacity — measured
    // from the official 2D export (#336619 = silk @50%, #000059 = copper @70%)
    const alpha = BOTTOM_ALPHA[lid];
    if (alpha !== undefined && node.opacity === undefined) node.opacity = alpha;
    api.addObject({ id: obj.id, rec: obj, node, label, kind, bbox: objBBox(obj, xf) ?? undefined });
  };

  // ---- panel board outline from CANVAS (mm sizes), drawn before content ----
  if (seg.docType === 'PANEL') {
    const c = seg.canvas as any;
    // PANEL doc space is 0.254mm units (10-mil), same scale as SCH
    const toUnit = (v: unknown): number => {
      const m = String(v ?? '').match(/^([\d.]+)\s*(mm|mil|in|inch)?$/i);
      if (!m) return 0;
      const n = Number(m[1]);
      const u = (m[2] ?? 'mm').toLowerCase();
      return u === 'mm' ? n * 3.93701 : u.startsWith('in') ? n * 100 : n * 0.1;
    };
    const pw = toUnit(c?.width), ph = toUnit(c?.height);
    if (pw > 0 && ph > 0) {
      const node = new Group();
      // panel body spans doc (0,0)→(pw,ph) in y-up space → screen y is negative
      const rx = Math.min(X(0, xf), X(pw, xf)), ry = Math.min(Y(0, xf), Y(ph, xf));
      node.add(new Rect({ x: rx, y: ry, width: pw, height: ph, stroke: '#e05555', strokeWidth: 4, fill: '#ffffff11' }));
      const label = ['material', 'thickness', 'print', 'craft'].map((k) => c?.[k]).filter(Boolean).join(' · ');
      if (label) {
        const t = new Text({ text: `面板 ${label}`, fontSize: 40, fill: '#999999' } as any);
        t.x = rx + 40; t.y = ry + 40; // just inside the top-left corner
        node.add(t);
      }
      api.layer('panel', '面板轮廓', '#8a8a8a').add(node);
      api.addObject({ id: 'panel-outline', rec: { type: 'CANVAS', id: 'CANVAS', data: c, lineNo: 0 } as unknown as Rec, node, label: '面板轮廓', kind: 'primitive', bbox: { minX: rx, minY: ry, maxX: rx + pw, maxY: ry + ph } });
    }
  }

  // ---- footprint geometry ----
  function drawFootprint(target: Group, fp: DocSegment) {
    const fxf = xfOf(fp.canvas); // footprint-local canvas (origin likely 0)
    for (const r of sortZ(fp.recs)) {
      const d = r.data;
      if (HIDDEN_LAYERS.has(String(d.layerId))) continue; // pin-soldering rose discs etc.
      switch (r.type) {
        case 'PAD': {
          target.add(padNode(d, fxf, layerColor, holeFill));
          break;
        }
        case 'POLY': {
          if (Array.isArray(d.points)) {
            const pts: number[] = [];
            for (const p of d.points as any[]) { const [x, y] = P(Number(p.x ?? 0), Number(p.y ?? 0), fxf); pts.push(x, y); }
            if (pts.length >= 4) target.add(new Line({ points: pts, closed: !!d.closed, stroke: layerColor(d.layerId), strokeWidth: widthOf(d, 4), strokeCap: 'round', strokeJoin: 'round' }));
          }
          const ds = multiPathToSvg(d.path ?? [], fxf, false);
          for (const path of ds) {
            target.add(new Path({ path, stroke: layerColor(d.layerId), strokeWidth: widthOf(d, 4), strokeCap: 'round', strokeJoin: 'round' }));
          }
          break;
        }
        case 'FILL': {
          const ds = multiPathToSvg(d.path ?? [], fxf, true);
          for (const path of ds) {
            target.add(new Path({ path, fill: layerColor(d.layerId) }));
          }
          break;
        }
        case 'LINE': {
          const [x1, y1] = P(Number(d.startX ?? 0), Number(d.startY ?? 0), fxf);
          const [x2, y2] = P(Number(d.endX ?? 0), Number(d.endY ?? 0), fxf);
          target.add(new Line({ points: [x1, y1, x2, y2], stroke: layerColor(d.layerId), strokeWidth: widthOf(d, 4), strokeCap: 'round' }));
          break;
        }
        case 'ARC': {
          const [x1, y1] = P(Number(d.startX ?? 0), Number(d.startY ?? 0), fxf);
          const [x2, y2] = P(Number(d.endX ?? 0), Number(d.endY ?? 0), fxf);
          target.add(new Path({ path: arcD(x1, y1, x2, y2, Number(d.angle ?? 0)), stroke: layerColor(d.layerId), strokeWidth: widthOf(d, 4), strokeCap: 'round' }));
          break;
        }
        case 'STRING': case 'TEXT': {
          if (isDocIdText(d)) break;
          target.add(mkLabel(d, layerColor(d.layerId), fxf, true));
          break;
        }
        case 'CIRCLE': {
          const cx = X(Number(d.centerX ?? 0), fxf), cy = Y(Number(d.centerY ?? 0), fxf);
          const rad = Math.abs(Number(d.radius ?? 0)) || 1;
          target.add(new Ellipse({ x: cx - rad, y: cy - rad, width: rad * 2, height: rad * 2, stroke: layerColor(d.layerId), strokeWidth: widthOf(d, 4), fill: null }));
          break;
        }
        case 'ELLIPSE': {
          const cx = X(Number(d.centerX ?? 0), fxf), cy = Y(Number(d.centerY ?? 0), fxf);
          const rx = Math.abs(Number(d.radiusX ?? 0)) || 1, ry = Math.abs(Number(d.radiusY ?? 0)) || 1;
          const e = new Ellipse({ x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2, stroke: layerColor(d.layerId), strokeWidth: widthOf(d, 4), fill: null });
          e.rotation = ang(Number(d.rotation ?? 0));
          target.add(e);
          break;
        }
        case 'ELE_PLACEHOLDER': opened.report.placeholders++; break;
        default: {
          const k = 'FOOTPRINT.' + r.type;
          if (!FOOTPRINT_STRUCTURAL.has(r.type) && !opened.report.unknownTypes.includes(k)) {
            opened.report.unknownTypes.push(k);
          }
        }
      }
    }
  }

  // ---- component ----
  function drawComponent(r: Rec) {
    const d = r.data;
    const attrs = byParent.get(r.id) ?? [];
    const fpUuid = attrValue(attrs, 'Footprint');
    // Footprint may name a DEVICE (meta-only) or be self-referenced (`<boardUuid>_<id>`,
    // geometry not embedded); real graphics come from the FOOTPRINT the DEVICE names.
    let fp = resolveLibGraphics(opened.libs, fpUuid ? opened.libs.get(fpUuid) : undefined, 'Footprint');
    if (!fp) {
      const devUuid = attrValue(attrs, 'Device');
      if (devUuid && devUuid !== fpUuid) fp = resolveLibGraphics(opened.libs, opened.libs.get(devUuid), 'Footprint');
    }
    const g = new Group({ name: `comp:${r.id}` });
    g.x = X(Number(d.x ?? 0), xf);
    g.y = Y(Number(d.y ?? 0), xf);
    g.rotation = ang(Number(d.angle ?? 0));
    api.layer(String(d.layerId ?? LAYER.TOP)).add(g);
    if (fp) drawFootprint(g, fp);
    else {
      g.add(new Rect({ x: -12, y: -8, width: 24, height: 16, stroke: '#cc0000', strokeWidth: 1, strokeDashArray: [3, 3] }));
      if (fpUuid) api.reportDiagnostics.push(`未解析封装 ${fpUuid.slice(0, 10)} (line ${r.lineNo})`);
    }
    // designator / visible attrs (fixed pixel size, same as silk labels)
    for (const a of attrs) {
      const ad = a.data;
      if (isDocIdText(ad)) continue;
      if (ad.valueVisible === true && typeof ad.x === 'number') {
        const t = mkLabel(ad, layerColor(ad.layerId), xf);
        const al = BOTTOM_ALPHA[String(ad.layerId)];
        if (al !== undefined) t.opacity = al;
        api.layer(String(ad.layerId ?? LAYER.TOP)).add(t);
      }
    }
    api.addObject({
      id: r.id, rec: r, node: g, label: `元件 ${r.id}`, kind: 'component',
      title: attrValue(attrs, 'Designator') ?? String(d.attrs?.['Designator'] ?? d.attrs?.['Name'] ?? r.id),
      bbox: footprintBBox(fp, g),
    });
  }

  // ---- primitives ----
  function drawPrim(r: Rec) {
    const d = r.data;
    switch (r.type) {
      case 'COMPONENT': drawComponent(r); return;
      case 'LINE': {
        const [x1, y1] = P(Number(d.startX ?? 0), Number(d.startY ?? 0), xf);
        const [x2, y2] = P(Number(d.endX ?? 0), Number(d.endY ?? 0), xf);
        const node = new Group();
        node.add(new Line({ points: [x1, y1, x2, y2], stroke: layerColor(d.layerId), strokeWidth: widthOf(d, 6), strokeCap: 'round', hitStroke: 'all' }));
        addToLayer(d, r, node, `走线 ${r.id} ${d.netName ?? ''}`, 'track');
        return;
      }
      case 'POLY': {
        const node = new Group();
        const stroke = strokeOf(d, layerColor(d.layerId ?? d.layer));
        if (Array.isArray(d.points)) {
          const pts: number[] = [];
          for (const p of d.points as any[]) { const [x, y] = P(Number(p.x ?? 0), Number(p.y ?? 0), xf); pts.push(x, y); }
          if (pts.length >= 4) node.add(new Line({ points: pts, closed: !!d.closed, stroke, strokeWidth: widthOf(d, 6), hitStroke: 'all' }));
        }
        for (const path of multiPathToSvg(d.path ?? [], xf, false)) {
          node.add(new Path({ path, stroke, strokeWidth: widthOf(d, 6) }));
        }
        // panel shapes: ploys tokens in a normalized rect (local y-DOWN), placed by
        // row-major 2x3 matrix into doc y-UP space: y' = f − d·x − e·y
        if (Array.isArray(d.ploys)) {
          const mtx = Array.isArray(d.matrix) ? d.matrix.map(Number) : null;
          const tm = (x: number, y: number): [number, number] =>
            mtx
              ? P(mtx[0] * x + mtx[1] * y + mtx[2], mtx[5] - mtx[3] * x - mtx[4] * y, xf)
              : P(x, y, xf);
          for (const pl of d.ploys as any[]) {
            const tk = String(pl?.[0] ?? '');
            if (tk === 'R') {
              const [, rx = 0, ry = 0, rw = 0, rh = 0, rot = 0] = pl as number[];
              const cx = Number(rx) + Number(rw) / 2, cy = Number(ry) + Number(rh) / 2;
              const rp = (Number(rot) || 0) * (Math.PI / 180);
              const pts: number[] = [];
              for (const [px, py] of [[rx, ry], [rx + rw, ry], [rx + rw, ry + rh], [rx, ry + rh]] as number[][]) {
                const dx = Number(px) - cx, dy = Number(py) - cy;
                const qx = rp ? cx + dx * Math.cos(rp) - dy * Math.sin(rp) : Number(px);
                const qy = rp ? cy + dx * Math.sin(rp) + dy * Math.cos(rp) : Number(py);
                const [sx, sy] = tm(qx, qy);
                pts.push(sx, sy);
              }
              const fill = d.displayFill !== false && d.fillColor && d.fillColor !== 'none' ? String(d.fillColor) : null;
              node.add(new Line({ points: pts, closed: true, stroke: d.displayStroke === false ? null : stroke, strokeWidth: Number(d.strokeWidth) || 1, fill }));
            } else if (tk) {
              const mk = `面板图形暂不支持:${tk}`;
              if (!api.reportDiagnostics.includes(mk)) api.reportDiagnostics.push(mk);
            }
          }
        }
        addToLayer(d.layerId == null && d.layer != null ? { ...d, layerId: d.layer } : d, r, node, `折线 ${r.id}`);
        return;
      }
      case 'CIRCLE': {
        const cx = X(Number(d.centerX ?? 0), xf), cy = Y(Number(d.centerY ?? 0), xf);
        const rad = Math.abs(Number(d.radius ?? 0)) || 1;
        const node = new Group();
        node.add(new Ellipse({ x: cx - rad, y: cy - rad, width: rad * 2, height: rad * 2, stroke: strokeOf(d, layerColor(d.layerId)), strokeWidth: widthOf(d, 6), fill: null }));
        addToLayer(d, r, node, `圆 ${r.id}`);
        return;
      }
      case 'ELLIPSE': {
        const cx = X(Number(d.centerX ?? 0), xf), cy = Y(Number(d.centerY ?? 0), xf);
        const rx = Math.abs(Number(d.radiusX ?? 0)) || 1, ry = Math.abs(Number(d.radiusY ?? 0)) || 1;
        const node = new Group();
        const e = new Ellipse({ x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2, stroke: strokeOf(d, layerColor(d.layerId)), strokeWidth: widthOf(d, 6), fill: null });
        e.rotation = ang(Number(d.rotation ?? 0));
        node.add(e);
        addToLayer(d, r, node, `椭圆 ${r.id}`);
        return;
      }
      case 'ARC': {
        const [x1, y1] = P(Number(d.startX ?? 0), Number(d.startY ?? 0), xf);
        const [x2, y2] = P(Number(d.endX ?? 0), Number(d.endY ?? 0), xf);
        const node = new Group();
        node.add(new Path({ path: arcD(x1, y1, x2, y2, Number(d.angle ?? 0)), stroke: layerColor(d.layerId), strokeWidth: widthOf(d, 6), strokeCap: 'round' }));
        addToLayer(d, r, node, `圆弧走线 ${r.id} ${d.netName ?? ''}`, 'track');
        return;
      }
      case 'PAD': {
        const node = padNode(d, xf, layerColor, holeFill);
        addToLayer(d, r, node, `焊盘 ${r.id} #${d.num ?? ''}`, 'pad');
        return;
      }
      case 'FILL': {
        const node = new Group();
        for (const path of multiPathToSvg(d.path ?? [], xf, true)) node.add(new Path({ path, fill: layerColor(d.layerId) }));
        addToLayer(d, r, node, `填充 ${r.id}`);
        return;
      }
      case 'VIA': {
        const cx = X(Number(d.centerX ?? 0), xf), cy = Y(Number(d.centerY ?? 0), xf);
        const vd = Number(d.viaDiameter ?? 20), hd = Number(d.holeDiameter ?? 12);
        const node = new Group();
        node.add(new Ellipse({ x: cx - vd / 2, y: cy - vd / 2, width: vd, height: vd, fill: layerColor(LAYER.MULTI) }));
        node.add(new Ellipse({ x: cx - hd / 2, y: cy - hd / 2, width: hd, height: hd, fill: holeFill }));
        addToLayer({ layerId: LAYER.MULTI }, r, node, `过孔 ${r.id} ${d.netName ?? ''}`, 'pad');
        return;
      }
      case 'POUR': {
        const node = new Group();
        for (const path of multiPathToSvg(d.path ?? [], xf, true)) {
          node.add(new Path({ path, stroke: layerColor(d.layerId), strokeWidth: widthOf(d, 2) }));
        }
        addToLayer(d, r, node, `覆铜边界 ${r.id} ${d.name ?? ''}`);
        return;
      }
      case 'POURED': {
        // the copper fill itself; its layer lives on the paired POUR record
        // (POURED carries id ["POURED", "<pourId>"], not its own layerId)
        const key = String(r.id).split(',').pop() ?? '';
        const lid = pourLayer.get(key) ?? LAYER.TOP;
        // pourFill paths are authored in 0.1× PCB doc units → scale coords by 10
        const node = new Group();
        for (const pf of (d.pourFill ?? [])) {
          for (const path of multiPathToSvg(scalePourItems(pf.path), xf, true)) {
            node.add(new Path({ path, fill: layerColor(lid) + (pf.fill ? 'b2' : ''), stroke: pf.strokeWidth ? layerColor(lid) : undefined, strokeWidth: Number(pf.strokeWidth) || undefined }));
          }
        }
        addToLayer({ layerId: lid }, r, node, `铺铜 ${r.id} ${d.netName ?? ''}`);
        return;
      }
      case 'TEARDROP': {
        const node = new Group();
        for (const path of multiPathToSvg(d.path ?? [], xf, true)) node.add(new Path({ path, fill: layerColor(d.layerId) }));
        addToLayer(d, r, node, `泪滴 ${r.id}`);
        return;
      }
      case 'REGION': {
        const node = new Group();
        for (const path of multiPathToSvg(d.path ?? [], xf, true)) node.add(new Path({ path, stroke: '#00b0b0', strokeWidth: 2 }));
        addToLayer(d, r, node, `区域 ${r.id} ${d.regionType ?? ''}`);
        return;
      }
      case 'STRING': case 'TEXT': {
        if (silkTwins.has(d) || isDocIdText(d)) return;
        const node = new Group();
        // layer color wins over specialColor — matches how EasyEDA shows silk strings;
        // doc-scaled so big silk words grow with the board like the reference export
        node.add(mkLabel(d, layerColor(d.layerId), xf, true));
        addToLayer(d, r, node, `文本 ${r.id} "${String(d.text ?? d.value ?? '').slice(0, 16)}"`);
        return;
      }
      case 'IMAGE': {
        // glyph-outline vector: numbers are local coords centered on 0 (y-down),
        // scaled so the declared width matches the real size, placed at startX/startY
        const node = new Group();
        const raw = (Array.isArray(d.path) ? d.path : []) as any[];
        const segs: any[][] = raw.length && Array.isArray(raw[0]) ? (raw as any[][]) : [raw];
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const seg of segs) {
          for (let i = 0; i < seg.length; i++) {
            const v = seg[i];
            if (typeof v !== 'number') { if (v === 'ARC') i += 1; continue; }
            const x = Number(v), y = Number(seg[i + 1]); i += 1;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
        const w = Number(d.width);
        const s = isFinite(w) && w > 0 && maxX > minX ? w / (maxX - minX) : 1;
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        const ox = Number(d.startX ?? 0), oy = Number(d.startY ?? 0);
        const mapped = segs.map((seg) => {
          const out: any[] = [];
          for (let i = 0; i < seg.length; i++) {
            const v = seg[i];
            if (typeof v !== 'number') { out.push(v); if (v === 'ARC') { out.push(seg[i + 1]); i += 1; } continue; }
            const x = Number(v), y = Number(seg[i + 1]); i += 1;
            out.push((x - cx) * s + ox, (cy - y) * s + oy); // y-down path → math coords
          }
          return out;
        });
        // glyph outline geometry (text converted to paths): FILLED, not stroked
        for (const path of multiPathToSvg(mapped, xf, true)) node.add(new Path({ path, fill: layerColor(d.layerId), fillRule: 'nonzero' }));
        addToLayer(d, r, node, `图形 ${r.id}`);
        return;
      }
      case 'DIMENSION': {
        const node = new Group();
        const cs = (d.coords ?? []) as number[];
        const pts: number[] = [];
        for (let i = 0; i + 1 < cs.length; i += 2) { const [x, y] = P(cs[i], cs[i + 1], xf); pts.push(x, y); }
        if (pts.length >= 4) node.add(new Line({ points: pts, stroke: '#888888', strokeWidth: widthOf(d, 3) }));
        const tv = d.text && (d.text.value ?? d.text.text);
        if (tv) {
          const t = new Text({ text: String(tv), fontSize: 10, fill: '#888888' } as any);
          t.x = pts[0] ?? 0; t.y = (pts[1] ?? 0) - 8;
          node.add(t);
        }
        addToLayer(d, r, node, `标注 ${r.id} ${d.type ?? ''}`);
        return;
      }
      case 'ELE_PLACEHOLDER': opened.report.placeholders++; return;
      case 'LAYER': case 'NET': case 'RULE': case 'RULE_NET': case 'RULE_TEMPLATE': case 'RULE_DIFF_PAIR':
      case 'RULE_EQUAL_LENGTH': case 'COMPONENT_GROUP': case 'ATTR': case 'DOCHEAD':
      case 'CANVAS': case 'META': case 'PART': case 'GROUP': case 'PANELIZE':
      case 'PAD_NET': case 'PRIMITIVE': case 'RULE_SELECTOR': case 'ACTIVE_LAYER':
      case 'LAYER_PHYS': case 'SILK_OPTS': case 'PREFERENCE':
        return; // structural / metadata / not drawable in MVP
      default:
        if (!opened.report.unknownTypes.includes(r.type)) opened.report.unknownTypes.push(r.type);
    }
  }
  // copper pours sit under everything else; bottom copper first so top overlaps it
  const all = sortZ(seg.recs);
  const pours = all.filter((r) => r.type === 'POURED');
  pours.sort((a, b) => {
    const la = Number(pourLayer.get(String(a.id).split(',').pop() ?? '') ?? 0);
    const lb = Number(pourLayer.get(String(b.id).split(',').pop() ?? '') ?? 0);
    return lb - la; // higher layer number (bottom=2) drawn earlier
  });
  for (const r of pours) drawPrim(r);
  for (const r of all) if (r.type !== 'POURED') drawPrim(r);
}

/** world bbox of a component: union of footprint geometry (in fp screen coords) transformed by the group transform */
function footprintBBox(fp: DocSegment | undefined, g: Group): BBox | undefined {
  const cx = Number(g.x) || 0, cy = Number(g.y) || 0;
  if (!fp) return { minX: cx - 15, minY: cy - 15, maxX: cx + 15, maxY: cy + 15 };
  const fxf = xfOf(fp.canvas);
  const local: [number, number][] = [];
  for (const r of fp.recs) {
    const b = objBBox(r, fxf);
    if (b) local.push([b.minX, b.minY], [b.minX, b.maxY], [b.maxX, b.minY], [b.maxX, b.maxY]);
  }
  if (!local.length) return { minX: cx - 15, minY: cy - 15, maxX: cx + 15, maxY: cy + 15 };
  const rad = (Number(g.rotation) || 0) * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const world = local.map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c] as [number, number]);
  return bboxFromPts(world) ?? undefined;
}

function arcD(sx: number, sy: number, ex: number, ey: number, deg: number): string {

  const chord = Math.hypot(ex - sx, ey - sy);
  if (chord < 1e-6) return `M ${sx} ${sy}`;
  const a = Math.abs(deg) > 359 ? 359 : Math.abs(deg);
  const rad = chord / (2 * Math.sin((a * Math.PI) / 360));
  const large = a > 180 ? 1 : 0;
  const sweep = deg > 0 ? 0 : 1;
  return `M ${sx} ${sy} A ${rad} ${rad} 0 ${large} ${sweep} ${ex} ${ey}`;
}

function alignX(o: unknown): 'left' | 'center' | 'right' {
  const s = String(o ?? '').toUpperCase();
  if (s.includes('CENTER')) return 'center';
  if (s.includes('RIGHT')) return 'right';
  return 'left';
}

function indexByParent(recs: Rec[]): Map<string, Rec[]> {
  const m = new Map<string, Rec[]>();
  for (const r of recs) {
    const pid = r.data?.parentId;
    if (r.type === 'ATTR' && typeof pid === 'string' && pid) {
      let a = m.get(pid);
      if (!a) { a = []; m.set(pid, a); }
      a.push(r);
    }
  }
  return m;
}

function attrValue(attrs: Rec[], key: string): string | null {
  for (const a of attrs) if (a.data.key === key && a.data.value) return String(a.data.value);
  return null;
}

function sortZ(recs: Rec[]): Rec[] {
  return [...recs].sort((a, b) => (Number(a.data.zIndex) || 0) - (Number(b.data.zIndex) || 0));
}
