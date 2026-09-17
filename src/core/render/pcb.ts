/** PCB / PANEL renderer: layer-driven colors, pads/tracks/text/pours. */
import { Group, Line, Rect, Path, Text, Ellipse, Image as LeaferImage } from 'leafer-ui';
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
const BOTTOM_ALPHA: Record<string, number> = { '2': 0.7, '4': 0.5, '6': 0.5, '7': 0.5, '8': 0.5, '10': 0.5 };

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

/** normalize a layer id that may be a number, ["LAYER",13], or "LAYER,13". */
function layerIdOf(d: any): string {
  const raw = d.layerId ?? d.layer;
  if (Array.isArray(raw) && raw.length >= 2) return String(raw[1]);
  const s = String(raw ?? '');
  const p = s.split(',');
  if (p.length >= 2) return p[1];
  return s;
}

/** Internal-id heuristics used to skip auto-generated element-id text on the document layer (#13). */
function looksLikeInternalId(t: string): boolean {
  if (/^e\d+$/i.test(t)) return true;
  if (/^gge\d+$/i.test(t)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return true;
  if (/^[0-9a-f]{32}$/i.test(t)) return true;
  if (/^[0-9a-f]{16}$/i.test(t)) return true;
  if (/^\d{8,}$/.test(t)) return true; // long numeric identifiers
  return false;
}

/** PAD_NET ids are flattened to `PAD_NET,<componentId>,<padNum>,<elemId>`; pull the two key fields. */
function padNetIdParts(id: unknown): [string, string] | null {
  const m = String(id ?? '').match(/^PAD_NET,([^,]*),([^,]*)/);
  return m ? [m[1], m[2]] : null;
}

/** Skip auto-generated element-id text on the document layer (#13).
 *  `ownerId` is the parent component id; `allIds` is every record id in the current scope.
 *  Net names and pad numbers are preserved because they are semantically useful. */
function isDocIdText(d: any, ownerId?: string, allIds?: Set<string>, netNames?: Set<string>, padNumbers?: Set<string>): boolean {
  if (layerIdOf(d) !== '13') return false;
  const t = String(d.text ?? d.value ?? '').trim();
  if (!t) return false;
  if (netNames?.has(t) || padNumbers?.has(t)) return false;
  if (looksLikeInternalId(t)) return true;
  if (ownerId && t.toLowerCase() === ownerId.toLowerCase()) return true;
  if (allIds && allIds.has(t)) return true;
  return false;
}

/** pad shape → leafer node (local footprint coords, center at cx,cy).
 * `holeFill` is the canvas background: drills punch through the board, they
 * are not a colored ink layer (EasyEDA shows them as bg-colored holes).
 * Rotation pivot: leafer rotates around the node's own (x,y) placement point,
 * so each shape is drawn centered on the local origin and wrapped in a Group
 * positioned at the pad center — rotating the Group then spins the pad around
 * its center (rotating a node placed at top-left would swing it off-target).
 * Pad numbers are drawn doc-scaled (they zoom with the canvas like the client).
 * `opts.holeSink` hoists the drill/slot group out of the pad group (caller adds
 * it to the topmost hole layer) — use for pads already in world coords. */
function padNode(d: any, xf: ReturnType<typeof xfOf>, colorOf: (id: unknown) => string, holeFill: string,
  opts?: { holeSink?: (hole: Group) => void }): Group {
  const g = new Group();
  const padAngleDeg = Number(d.padAngle ?? 0);
  const padAngle = (padAngleDeg * Math.PI) / 180;
  const offX = Number(d.padOffsetX ?? 0), offY = Number(d.padOffsetY ?? 0);
  // pad copper is offset from the pad center; the drill stays at the center (#13).
  // EasyEDA doc angles are clockwise, so rotate clockwise before the Y-flip transform.
  const rawX = Number(d.centerX ?? 0) + offX * Math.cos(padAngle) + offY * Math.sin(padAngle);
  const rawY = Number(d.centerY ?? 0) - offX * Math.sin(padAngle) + offY * Math.cos(padAngle);
  const cx = X(Number(d.centerX ?? 0), xf), cy = Y(Number(d.centerY ?? 0), xf);
  const px = X(rawX, xf), py = Y(rawY, xf);
  const dp = d.defaultPad ?? {};
  const w = Number(dp.width ?? 10), h = Number(dp.height ?? 10);
  const color = colorOf(d.layerId ?? LAYER.TOP);
  const shape = String(dp.padType ?? 'RECT').toUpperCase();
  const pad = new Group({ x: px, y: py, rotation: ang(padAngleDeg) });
  if (shape === 'ELLIPSE' || shape === 'ROUND' || shape === 'CIRCLE') {
    pad.add(new Ellipse({ x: -w / 2, y: -h / 2, width: w, height: h, fill: color }));
  } else if (shape === 'OVAL' || shape === 'SLOT') {
    const cr = Math.min(w, h) / 2;
    pad.add(new Rect({ x: -w / 2, y: -h / 2, width: w, height: h, fill: color, cornerRadius: [cr, cr, cr, cr] }));
  } else {
    pad.add(new Rect({ x: -w / 2, y: -h / 2, width: w, height: h, fill: color, cornerRadius: (Number(dp.radius) || 0) }));
  }
  g.add(pad);
  const hole = d.hole;
  if (hole) {
    const hw = Number(hole.width ?? 0), hh = Number(hole.height ?? hw);
    if (hw > 0) {
      const ht = String(hole.holeType ?? 'ROUND').toUpperCase();
      // hole width runs along X, height along Y in the HOLE's own frame; the
      // hole rotates relative to the pad by `relativeAngle` — e.g. a vertical
      // slot in a horizontal pad is relAngle=90, NOT swapped w/h (#slot-dir)
      let hn: any;
      if (ht === 'SLOT') {
        // oblong drill: rounded-rect with half-circle caps, NOT a pointed ellipse
        const cr = Math.min(hw, hh) / 2;
        hn = new Rect({ x: -hw / 2, y: -hh / 2, width: hw, height: hh, fill: holeFill, cornerRadius: [cr, cr, cr, cr] });
      } else if (ht === 'SQUARE' || ht === 'RECT' || ht === 'ROUND_RECT') {
        hn = new Rect({ x: -hw / 2, y: -hh / 2, width: hw, height: hh, fill: holeFill, cornerRadius: (Number(hole.cornerRadius) || 0) });
      } else {
        hn = new Ellipse({ x: -hw / 2, y: -hh / 2, width: hw, height: hh, fill: holeFill });
      }
      const hg = new Group({ x: cx, y: cy, rotation: ang(padAngleDeg + (Number(d.relativeAngle ?? 0) || 0)) });
      hg.add(hn);
      if (opts?.holeSink) opts.holeSink(hg); // hoisted to the topmost hole layer
      else g.add(hg);
    }
  }
  // pad number: doc-scaled like the client's own labels — it grows with zoom
  // and its size follows the pad so it stays inside the copper (#pad-num-zoom)
  const num = d.num == null ? '' : String(d.num);
  if (num) {
    const t = new Text({
      text: num, fontSize: Math.max(Math.min(w, h) * 0.6, 1), fill: '#c9ccd1',
      textAlign: 'center', verticalAlign: 'middle', autoSizeAlign: true, hittable: false,
    } as any);
    t.x = cx; t.y = cy;
    g.add(t);
  }
  return g;
}

export function renderPcb(opened: OpenedDoc, api: RenderApi): void {
  const seg = opened.self;
  const xf = xfOf(seg.canvas);
  // auto-generated element-id labels on the document layer reuse record ids (e1, e2… or UUIDs)
  const allIds = new Set(seg.recs.map((r) => String(r.id ?? '')));

  // collect net names / pad numbers so the document layer keeps useful labels and only hides ids
  const netNames = new Set<string>();
  const padNumbers = new Set<string>();
  for (const r of seg.recs) {
    const d = r.data;
    if (d.netName) netNames.add(String(d.netName));
    if (d.padNet) netNames.add(String(d.padNet));
    if (r.type === 'NET') {
      const m = String(r.id ?? '').match(/"NET","([^"]*)"/);
      if (m) netNames.add(m[1]);
    }
    if (r.type === 'PAD_NET') {
      const p = padNetIdParts(r.id);
      if (p) padNumbers.add(p[1]);
    }
    if (r.type === 'PAD' && d.num != null) padNumbers.add(String(d.num));
  }

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
  /** filled copper (pour fill / static fill) paints the SAME layer color as
   *  tracks — user pref: pour must not look dimmed against the routing (#pour-col) */
  const pourColor = (id: unknown): string => layerColor(id);
  /** drill/via holes punch through to the canvas background */
  const holeFill = api.bgColor;
  /** drill/slot holes hoist to the hole layer (47), the topmost group in the
   *  stacking order, so drills always paint above every copper/silk group */
  const holeLayerGroup = api.layer(String(LAYER.HOLE), layerMeta.get(String(LAYER.HOLE))?.name, layerColor(LAYER.HOLE), true);
  /** fallback font size (doc units) when a record carries no fontSize */
  const LABEL_PX = 9;

  /** PCB text node. `docScale` renders at the record's own font size so the
   * text grows/shrinks with the board like EasyEDA does — silk (heavy display
   * face) and designator labels (plain face) both zoom now (#pad-num-zoom).
   * Origin token (LEFT_BOTTOM …) selects the anchor within the given point. */
  function mkLabel(d: any, color: string, xfc: ReturnType<typeof xfOf>, docScale = false, heavy = docScale): Text {
    const fs = docScale ? (Number(d.fontSize) || LABEL_PX) : LABEL_PX;
    const t = new Text({
      text: String(d.text ?? d.value ?? ''), fontSize: fs,
      // silk uses heavy display fonts (e.g. 阿里巴巴普惠体 Heavy) — approximate
      // with a bold sans face so weight/styles stay close to the reference
      fontFamily: docScale && heavy ? 'Arial Black, Arial Bold, Microsoft YaHei, sans-serif' : undefined,
      fill: color, bold: (docScale && heavy) || !!d.bold,
      textAlign: alignX(d.origin),
      verticalAlign: String(d.origin ?? '').toUpperCase().includes('BOTTOM') ? 'bottom'
        : String(d.origin ?? '').toUpperCase().includes('TOP') ? 'top' : 'middle',
    } as any);
    t.x = X(Number(d.x ?? 0), xfc);
    t.y = Y(Number(d.y ?? 0), xfc);
    t.rotation = ang(Number(d.angle ?? d.rotation ?? 0));
    if (d.reverse) t.scaleX = -1;
    if (d.mirror) t.scaleY = -1;
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

  // ---- origin axes at the business origin (CANVAS originX/originY) (#11) ----
  // only for dark-canvas docs (PCB / footprint); panel is white. The cross keeps
  // a constant 1px width at any zoom via the constant-stroke registry.
  if (seg.docType === 'PCB' || seg.docType === 'FOOTPRINT') {
    const c = seg.canvas as any;
    const ox = X(Number(c?.originX ?? 0), xf), oy = Y(Number(c?.originY ?? 0), xf);
    const b = opened.bbox;
    // extend the axes well past the content bbox so they are visible around the board
    const ex = Math.max((b.maxX - b.minX) * 0.35, 300);
    const ey = Math.max((b.maxY - b.minY) * 0.35, 300);
    const axes = new Group({ name: 'origin-axes' });
    const axis = (pts: number[], color: string) => {
      const ln = new Line({ points: pts, stroke: color, strokeWidth: 1, hittable: false });
      api.addConstantStroke(ln, 1);
      axes.add(ln);
    };
    axis([ox - ex, oy, ox + ex, oy], 'rgba(214,96,96,0.55)'); // X axis (red)
    axis([ox, oy - ey, ox, oy + ey], 'rgba(98,192,124,0.5)'); // Y axis (green)
    api.layer('axes', '原点轴线', '#9aa2ad', true).add(axes);
  }

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
    const fpAllIds = new Set(fp.recs.map((fr) => String(fr.id ?? '')));
    for (const r of sortZ(fp.recs)) {
      const d = r.data;
      if (HIDDEN_LAYERS.has(String(d.layerId))) continue; // pin-soldering rose discs etc.
      switch (r.type) {
        case 'PAD': {
          // drill/slot holes hoist to the hole layer in world coords: the pad
          // group's local (hx,hy) maps through the component's pos + rotation
          const gx = Number(target.x) || 0, gy = Number(target.y) || 0;
          const gr = ((Number(target.rotation) || 0) * Math.PI) / 180;
          const gc = Math.cos(gr), gs = Math.sin(gr);
          target.add(padNode(d, fxf, layerColor, holeFill, {
            holeSink: (hg) => {
              const hx = Number(hg.x) || 0, hy = Number(hg.y) || 0;
              hg.x = gx + hx * gc - hy * gs;
              hg.y = gy + hx * gs + hy * gc;
              hg.rotation = (Number(hg.rotation) || 0) + (Number(target.rotation) || 0);
              holeLayerGroup.add(hg);
            },
          }));
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
            // static copper fill paints the same full layer color as pour fill (see pourColor)
            const p = new Path({ path, fill: pourColor(d.layerId) });
            target.add(p);
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
        case 'RECT': {
          // footprint rectangle primitives (dotX1/dotY1…dotX2/dotY2 like sch RECT);
          // round caps/joins like the client render — thick outlines get visibly
          // rounded corners and ends (user pref, overrides the ref zoom — #pcb-round)
          const [x1, y1] = P(Number(d.dotX1 ?? 0), Number(d.dotY1 ?? 0), fxf);
          const [x2, y2] = P(Number(d.dotX2 ?? d.dotX1 ?? 0), Number(d.dotY2 ?? d.dotY1 ?? 0), fxf);
          const rr = Math.min(Number(d.radiusX ?? 0) || 0, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2);
          target.add(new Rect({
            x: Math.min(x1, x2), y: Math.min(y1, y2),
            width: Math.abs(x2 - x1), height: Math.abs(y2 - y1),
            stroke: layerColor(d.layerId), strokeWidth: widthOf(d, 4),
            strokeCap: 'round', strokeJoin: 'round',
            cornerRadius: rr,
            fill: d.fillColor && d.fillColor !== 'none' ? String(d.fillColor) : null,
          }));
          break;
        }
        case 'STRING': case 'TEXT': {
          if (isDocIdText(d, r.id, fpAllIds, netNames, padNumbers)) break;
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
      g.add(new Rect({ x: -12, y: -8, width: 24, height: 16, stroke: '#cc0000', strokeWidth: 1, dashPattern: [3, 3] }));
      if (fpUuid) api.reportDiagnostics.push(`未解析封装 ${fpUuid.slice(0, 10)} (line ${r.lineNo})`);
    }
    // designator / visible attrs: doc-scaled text at the record's own fontSize so
    // they zoom with the canvas. The designator shows even when valueVisible is
    // false — the client paints every positioned Designator on the board (the
    // reference export does), the flag only tracks the properties panel (#desig-zoom)
    for (const a of attrs) {
      const ad = a.data;
      if (isDocIdText(ad, r.id, allIds, netNames, padNumbers)) continue;
      const hasPos = typeof ad.x === 'number' && isFinite(ad.x);
      const wantsShow = !!ad.valueVisible || String(ad.key) === 'Designator';
      if (hasPos && wantsShow) {
        const t = mkLabel(ad, layerColor(ad.layerId), xf, true, false);
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
          if (pts.length >= 4) node.add(new Line({ points: pts, closed: !!d.closed, stroke, strokeWidth: widthOf(d, 6), strokeCap: 'round', strokeJoin: 'round', hitStroke: 'all' }));
        }
        for (const path of multiPathToSvg(d.path ?? [], xf, false)) {
          node.add(new Path({ path, stroke, strokeWidth: widthOf(d, 6), strokeCap: 'round', strokeJoin: 'round' }));
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
              node.add(new Line({ points: pts, closed: true, stroke: d.displayStroke === false ? null : stroke, strokeWidth: Number(d.strokeWidth) || 1, strokeCap: 'round', strokeJoin: 'round', fill }));
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
        // page-level pads are in world coords — the hoisted hole group plugs
        // straight into the hole layer
        const node = padNode(d, xf, layerColor, holeFill, {
          holeSink: (hg) => holeLayerGroup.add(hg),
        });
        addToLayer(d, r, node, `焊盘 ${r.id} #${d.num ?? ''}`, 'pad');
        return;
      }
      case 'FILL': {
        const node = new Group();
        for (const path of multiPathToSvg(d.path ?? [], xf, true)) {
          // static copper fill paints the same full layer color as pour fill (see pourColor)
          node.add(new Path({ path, fill: pourColor(d.layerId) }));
        }
        addToLayer(d, r, node, `填充 ${r.id}`);
        return;
      }
      case 'VIA': {
        const cx = X(Number(d.centerX ?? 0), xf), cy = Y(Number(d.centerY ?? 0), xf);
        const vd = Number(d.viaDiameter ?? 20), hd = Number(d.holeDiameter ?? 12);
        const node = new Group();
        node.add(new Ellipse({ x: cx - vd / 2, y: cy - vd / 2, width: vd, height: vd, fill: layerColor(LAYER.MULTI) }));
        // the drill goes to the topmost hole layer like pad drills
        holeLayerGroup.add(new Ellipse({ x: cx - hd / 2, y: cy - hd / 2, width: hd, height: hd, fill: holeFill }));
        addToLayer({ layerId: LAYER.MULTI }, r, node, `过孔 ${r.id} ${d.netName ?? ''}`, 'pad');
        return;
      }
      case 'POUR': {
        const node = new Group();
        for (const path of multiPathToSvg(d.path ?? [], xf, true)) {
          node.add(new Path({ path, stroke: layerColor(d.layerId), strokeWidth: widthOf(d, 2), strokeCap: 'round', strokeJoin: 'round' }));
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
          // merge the item's subpolygons into ONE nonzero-filled Path: the fill
          // bakes its clearances in as hole subpolygons (opposite winding — e.g.
          // circles around other-net vias/pads), which only punch through when
          // all subpaths share a single path (#pour-gaps)
          const ds = multiPathToSvg(scalePourItems(pf.path), xf, true);
          if (!ds.length) continue;
          // pour copper paints the SAME full layer color as tracks (user pref:
          // the pour must not look dimmed next to routing) — #pour-col
          node.add(new Path({
            path: ds.join(' '), fill: pourColor(lid), fillRule: 'nonzero',
            stroke: pf.strokeWidth ? layerColor(lid) : undefined,
            strokeWidth: Number(pf.strokeWidth) || undefined, strokeCap: 'round', strokeJoin: 'round',
          }));
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
        if (silkTwins.has(d) || isDocIdText(d, r.id, allIds, netNames, padNumbers)) return;
        const node = new Group();
        // layer color wins over specialColor — matches how EasyEDA shows silk strings;
        // doc-scaled so big silk words grow with the board like the reference export
        node.add(mkLabel(d, layerColor(d.layerId), xf, true));
        addToLayer(d, r, node, `文本 ${r.id} "${String(d.text ?? d.value ?? '').slice(0, 16)}"`);
        return;
      }
      case 'OBJ': {
        // bitmap object imported into the doc: `path`/`content` is a `blob:<id>`
        // URI pointing at a BLOB record (base64 data URL). (startX, startY) is the
        // TOP-LEFT corner in doc space (PCB doc is y-up, so startY is the top edge),
        // not the center — verified against the reference export's dialog placement.
        const ref = typeof d.path === 'string' && d.path.startsWith('blob:') ? d.path
          : typeof d.content === 'string' && d.content.startsWith('blob:') ? d.content : null;
        const url = ref ? opened.blobs.get(ref.slice(5)) : undefined;
        if (url) {
          const wDoc = Number(d.width) || 0, hDoc = Number(d.height) || 0;
          const node = new Group();
          // pic centered on the node origin; offset the node by half extents so the
          // pic's top-left lands on (startX, startY) — keeps mirror flips centered
          const pic = new LeaferImage({ url, width: wDoc, height: hDoc, x: -wDoc / 2, y: -hDoc / 2 });
          if (d.mirror ?? d.isMirror) pic.scaleX = -1;
          node.add(pic);
          const [px, py] = P(Number(d.startX ?? 0), Number(d.startY ?? 0), xf);
          node.x = px + wDoc / 2;
          node.y = py + hDoc / 2;
          node.rotation = ang(Number(d.angle ?? d.rotation ?? 0));
          addToLayer(d, r, node, `图片 ${r.id} ${d.fileName ?? ''}`);
          return;
        }
        return; // blob missing — nothing to draw
      }
      case 'IMAGE': {
        // vector graphic (converted logo / glyph outlines, #image-holes): `path`
        // holds 复杂多边形 data — the first subpolygon is the outer frame, later
        // ones are holes with the opposite winding, so ALL subpaths must live in
        // one nonzero-filled Path; per-subpath Paths paint the holes solid.
        // Local coords are y-up like the doc space (cloud glyph y>0 sits above
        // the text glyphs y<0 in the reference export), normalized to fill the
        // declared width×height box whose top-left (y-up: maxY edge) is
        // (startX, startY) with the body hanging below it; angle rotates about
        // that corner and mirror flips the original image about its bbox mid.
        const raw = (Array.isArray(d.path) ? d.path : []) as any[];
        const segs: any[][] = raw.length && Array.isArray(raw[0]) ? (raw as any[][]) : [raw];
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const seg of segs) {
          for (let i = 0; i < seg.length; i++) {
            const v = seg[i];
            // ARC/CARC carry a leading sweep-degree value that is not a coordinate
            if (typeof v !== 'number') { if ((v === 'ARC' || v === 'CARC') && typeof seg[i + 1] === 'number') i += 1; continue; }
            const x = Number(v), y = Number(seg[i + 1]); i += 1;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
        const lw = maxX - minX, lh = maxY - minY;
        const wDoc = Number(d.width), hDoc = Number(d.height);
        const sx = isFinite(wDoc) && wDoc > 0 && lw > 0 ? wDoc / lw : 1;
        const sy = isFinite(hDoc) && hDoc > 0 && lh > 0 ? hDoc / lh : sx;
        // local → doc offsets relative to the top-left anchor: x grows right,
        // the y-up top edge (maxY) sits on startY so the body extends downward
        const mapped = segs.map((seg) => {
          const out: any[] = [];
          for (let i = 0; i < seg.length; i++) {
            const v = seg[i];
            if (typeof v !== 'number') {
              out.push(v);
              if ((v === 'ARC' || v === 'CARC') && typeof seg[i + 1] === 'number') { out.push(seg[i + 1]); i += 1; }
              continue;
            }
            const x = Number(v), y = Number(seg[i + 1]); i += 1;
            const lx = d.mirror ? minX + maxX - x : x;
            out.push((lx - minX) * sx, (y - maxY) * sy);
          }
          return out;
        });
        // coords are relative to the anchor, so the Group can rotate about it
        const node = new Group({ rotation: ang(Number(d.angle ?? 0)) });
        const [px, py] = P(Number(d.startX ?? 0), Number(d.startY ?? 0), xf);
        node.x = px; node.y = py;
        // the mapping produced y-up doc offsets relative to the anchor — the
        // flip transform turns them into screen coords (body hanging below it)
        const ds = multiPathToSvg(mapped, { ox: 0, oy: 0, flip: true }, true);
        if (ds.length) node.add(new Path({ path: ds.join(' '), fill: layerColor(d.layerId), fillRule: 'nonzero' }));
        addToLayer(d, r, node, `图形 ${r.id}`);
        return;
      }
      case 'DIMENSION': {
        // LENGTH dimension: coords = [ext1-ref, dim-start, dim-end, ext2-ref];
        // extension lines run ref→dim point, arrows sit on the measured segment
        const node = new Group();
        const cs = (d.coords ?? []) as number[];
        if (cs.length >= 8) {
          const A = P(Number(cs[0]), Number(cs[1]), xf), B = P(Number(cs[2]), Number(cs[3]), xf);
          const C = P(Number(cs[4]), Number(cs[5]), xf), D = P(Number(cs[6]), Number(cs[7]), xf);
          // dimensions read as annotation, not copper: keep the gray EasyEDA uses
          // regardless of the (white) document layer color
          const col = '#888888';
          const sw = widthOf(d, 1);
          node.add(new Line({ points: [A[0], A[1], B[0], B[1]], stroke: col, strokeWidth: sw }));
          node.add(new Line({ points: [D[0], D[1], C[0], C[1]], stroke: col, strokeWidth: sw }));
          node.add(new Line({ points: [B[0], B[1], C[0], C[1]], stroke: col, strokeWidth: sw }));
          // arrowheads: tips on B / C, bases pointing back along the measured segment
          const len = Math.hypot(C[0] - B[0], C[1] - B[1]) || 1;
          const ux = (C[0] - B[0]) / len, uy = (C[1] - B[1]) / len;
          const px = -uy, py = ux, L = 80, W = 26;
          const arrow = (tip: number[], sgn: number) => new Path({
            path: `M ${tip[0]} ${tip[1]} L ${tip[0] + sgn * L * ux + W * px} ${tip[1] + sgn * L * uy + W * py} L ${tip[0] + sgn * L * ux - W * px} ${tip[1] + sgn * L * uy - W * py} Z`,
            fill: col,
          });
          node.add(arrow(B, 1));
          node.add(arrow(C, -1));
          const td = (d.text ?? {}) as any;
          // the stored text is a stale cache the client recomputes on open
            // (this file's horizontal dim says "0.0mm" for a 1496 mil span) —
          // recompute LENGTH dimensions from the measured segment instead
          const mil = Math.hypot(Number(cs[4]) - Number(cs[2]), Number(cs[5]) - Number(cs[3]));
          const tv = mil > 0 ? (mil * 0.0254).toFixed(1) : (td.text ?? td.value);
          if (tv != null && tv !== '') {
            const tp = P(Number(td.x ?? 0), Number(td.y ?? 0), xf);
            const fs = Number(td.fontSize) || 100;
            const t = new Text({ text: `${tv}${d.unit ?? 'mm'}`, fontSize: fs, fill: col, textAlign: 'center', verticalAlign: 'bottom' } as any);
            const vertical = Math.abs(Number(cs[4]) - Number(cs[2])) < 1e-6;
            if (vertical) {
              t.rotation = -90; // read bottom-up alongside a vertical dimension
              t.textAlign = 'left';
              t.verticalAlign = 'middle';
              t.x = tp[0] + fs * 0.35; t.y = tp[1];
            } else {
              t.x = tp[0]; t.y = tp[1]; // above the dimension line
            }
            node.add(t);
          }
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
  drawRatsnest();

  /** ratsnest for unrouted boards: thin lines connecting same-net pads (MST per
   *  net), like EasyEDA shows on a fresh layout. Skipped entirely once the board
   *  carries copper tracks — routed nets must not grow whiskers. */
  function drawRatsnest(): void {
    const hasTracks = seg.recs.some((r) => {
      if (r.type !== 'LINE') return false;
      const l = layerIdOf(r.data);
      return l === '1' || l === '2' || l === '11' || l === '12';
    });
    if (hasTracks) return;
    // net per placed pad: PAD_NET id = ["PAD_NET", "<componentId>", "<padNum>", …]
    const netOfPad = new Map<string, string>();
    for (const r of seg.recs) {
      if (r.type !== 'PAD_NET') continue;
      const p = padNetIdParts(r.id);
      if (p && r.data.padNet) netOfPad.set(`${p[0]}:${p[1]}`, String(r.data.padNet));
    }
    const padsByNet = new Map<string, [number, number][]>();
    for (const r of seg.recs) {
      if (r.type !== 'COMPONENT') continue;
      const d = r.data;
      const attrs = byParent.get(r.id) ?? [];
      const fpUuid = attrValue(attrs, 'Footprint');
      let fp = resolveLibGraphics(opened.libs, fpUuid ? opened.libs.get(fpUuid) : undefined, 'Footprint');
      if (!fp) {
        const devUuid = attrValue(attrs, 'Device');
        if (devUuid && devUuid !== fpUuid) fp = resolveLibGraphics(opened.libs, opened.libs.get(devUuid), 'Footprint');
      }
      if (!fp) continue;
      const fxf = xfOf(fp.canvas);
      const gx = X(Number(d.x ?? 0), xf), gy = Y(Number(d.y ?? 0), xf);
      const a = (ang(Number(d.angle ?? 0)) * Math.PI) / 180;
      for (const pr of fp.recs) {
        if (pr.type !== 'PAD') continue;
        const net = netOfPad.get(`${r.id}:${pr.data.num}`);
        if (!net) continue;
        const lx = X(Number(pr.data.centerX ?? 0), fxf), ly = Y(Number(pr.data.centerY ?? 0), fxf);
        const p: [number, number] = [gx + lx * Math.cos(a) - ly * Math.sin(a), gy + lx * Math.sin(a) + ly * Math.cos(a)];
        (padsByNet.get(net) ?? padsByNet.set(net, []).get(net)!).push(p);
      }
    }
    const ratLayer = api.layer('rats', 'Ratsnest', '#4a57d8', true);
    for (const pts of padsByNet.values()) {
      if (pts.length < 2) continue;
      // Prim MST: connect each pad once, closest first
      const inTree = new Set<number>([0]);
      const from = new Array<number>(pts.length).fill(0);
      const dist = pts.map((p) => Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]));
      while (inTree.size < pts.length) {
        let bi = -1, bd = Infinity;
        for (let k = 0; k < pts.length; k++) {
          if (inTree.has(k) || dist[k] >= bd) continue;
          bd = dist[k]; bi = k;
        }
        if (bi < 0) break;
        ratLayer.add(new Line({ points: [pts[from[bi]][0], pts[from[bi]][1], pts[bi][0], pts[bi][1]], stroke: '#4a57d8', strokeWidth: 2.5 }));
        inTree.add(bi);
        for (let k = 0; k < pts.length; k++) {
          if (inTree.has(k)) continue;
          const dd = Math.hypot(pts[k][0] - pts[bi][0], pts[k][1] - pts[bi][1]);
          if (dd < dist[k]) { dist[k] = dd; from[k] = bi; }
        }
      }
    }
  }
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
