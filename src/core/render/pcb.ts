/** PCB / PANEL renderer: layer-driven colors, pads/tracks/text/pours. */
import { Group, Line, Rect, Path, Text, Ellipse, Image as LeaferImage } from 'leafer-ui';
import type { OpenedDoc, Rec, DocSegment } from '../types';
import type { RenderApi, RenderObject } from './layers';
import { X, Y, P, ang, strokeOf, widthOf, xfOf, objBBox, bboxFromPts, multiPathToSvg, scalePourItems, type BBox, type Xf } from './geom';
import { glyphKey, glyphPathD, fontGlyphMap, GLYPH_UNIT, type FontGlyph } from './font';
import { resolveLibGraphics } from '../model';

/** standard EasyEDA layer ids (numeric layerId used by primitives) */
export const LAYER = {
  TOP: 1, BOTTOM: 2, TOP_SILK: 3, BOT_SILK: 4, TOP_MASK: 5, BOT_MASK: 6,
  TOP_PASTE: 7, BOTTOM_PASTE: 8, OUTLINE: 11, MULTI: 12, DOCUMENT: 13, INNER1: 14,
  KEEPIN: 19, HOLE: 47,
};
/** utility layers EasyEDA keeps in data but never paints in 2D view
 * (49/50 = soldering/pin-soldering pads — the rose discs over through-hole pads) */
const HIDDEN_LAYERS = new Set(['49', '50']);

/** bottom-side layers seen through the board are semi-transparent in EasyEDA's
 * 2D view — alphas measured from the official export (#336619 silk @50%, #000059 copper @70%).
 * Solder mask (5/6) is NOT here: its opacity comes from the file's own
 * activateTransparency on the LAYER record (0.7 in this project). */
const BOTTOM_ALPHA: Record<string, number> = { '2': 0.7, '4': 0.5, '8': 0.5, '10': 0.5 };

/** bottom-side layers the 2D view reads mirrored — looking at the underside
 *  through the board flips every STRING/IMAGE on these layers horizontally
 *  about its own box center (#bottom-mirror) */
const BOTTOM_LAYERS = new Set(['2', '4', '6', '8', '10']);

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
  14: '#f022f0',     // Mechanical
  15: '#008000',     // Inner1
  16: '#008000',     // Inner2
  17: '#008000',     // Inner3
  18: '#008000',     // Inner4
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

// ---- in-primitive net-name labels (#net-labels) ----
/** doc-unit font floor: a net label that would render smaller than this stays
 *  hidden — narrow tracks and small pads never grow a letter mush (#net-labels).
 *  Labels are doc-scaled, so a fitting label stays inside its copper at any
 *  zoom; this floor only decides *which* primitives carry one at all. */
const NET_FONT_MIN = 6;
/** client labels are a fixed ~6.5mil size regardless of copper width — labels
 *  hide when they don't fit along the copper's length, they never shrink to
 *  the track's width. Capped a step lower here (and the available run length
 *  shrunk, see NET_LEN_SHRINK) so the copper reads through the labels
 *  (user pref, #net-labels) */
const NET_FONT_MAX = 6;
/** average glyph width / fontSize for the sans face leafer measures with */
const NET_CHAR_W = 0.62;
/** biggest font size (doc units) at which `text` fits inside maxW×maxH, else
 *  null — the primitive is too small to carry a readable label */
function fitNetFont(text: string, maxW: number, maxH: number): number | null {
  if (!text) return null;
  const f = Math.min(maxH, maxW / (NET_CHAR_W * text.length));
  return f >= NET_FONT_MIN ? f : null;
}
/** user pref: net labels keep a margin inside their copper — the available
 *  text-run length shrinks by this factor before fitting (#net-labels) */
const NET_LEN_SHRINK = 0.8;
/** label ink shared by pad numbers, pad net names and track net names — all
 *  net annotations read in the same light tone as the pad number (user pref) */
const PAD_INK = '#f2f4f7';

/** darken a #rrggbb hex toward black; non-hex colors pass through unchanged */
function dimHex(c: string, f: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (!m) return c;
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/** lift a #rrggbb hex toward white; non-hex colors pass through unchanged */
function liftHex(c: string, f: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (!m) return c;
  const n = parseInt(m[1], 16);
  const ch = (v: number) => Math.round(v + (255 - v) * f);
  const r = ch((n >> 16) & 255), g = ch((n >> 8) & 255), b = ch(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
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
 * it to the topmost hole layer) — use for pads already in world coords.
 * `opts.numSink` likewise hoists the pad-number text to a per-face overlay
 * between the face's copper and silk (caller maps it into world coords).
 * `opts.maskSink` receives the per-face solder-mask opening group (copper shape
 * grown by the pad/rule expansion) for the caller to route to layer 5/6.
 * `opts.pasteSink` likewise receives the per-face paste (钢网/助焊) opening —
 * the pad shape grown by the pad's own / the PASTE rule expansion — for the
 * caller to route to layer 7/8. */
function padNode(d: any, xf: ReturnType<typeof xfOf>, colorOf: (id: unknown) => string, holeFill: string,
  opts?: {
    holeSink?: (hole: Group) => void;
    numSink?: (num: Text) => void;
    maskSink?: (face: 1 | 2, mask: Group) => void;
    maskRule?: { padTop: number; padBot: number; viaTop: number; viaBot: number };
    pasteSink?: (face: 1 | 2, paste: Group) => void;
    pasteRule?: { padTop: number; padBot: number };
    /** net-name label for this pad (PAD_NET / pad data); absent = no label */
    netName?: string;
    /** copper override for nets the user painted (#net-colors); absent = layer color */
    copperColor?: string;
    /** hoists the in-copper net-name text to the face's `nn:` overlay in world
     *  coords (upright, like numSink) — caller maps it through the wrapper */
    netSink?: (t: Text) => void;
  }): Group {
  const g = new Group();
  const padAngleDeg = Number(d.padAngle ?? 0);
  // schema (epskill FOOTPRINT/pad.md): relativeAngle = 孔相对焊盘旋转角度 — the
  // DRILL's rotation relative to the pad — and padOffsetX/Y = 孔偏移 — the
  // drill's offset from the pad center. The copper (and its mask/paste
  // openings) sits on the declared center with only padAngle: feeding either
  // field into the copper displaced POLYGON pads off their centers (U23 mic
  // ring floated away from the traces ending on them) and turned USB1's slot
  // copper against its hole (#pad-offset-regression, #slot-dir)
  const relAngle = Number(d.relativeAngle ?? 0) || 0;
  const padAngle = (padAngleDeg * Math.PI) / 180;
  const offX = Number(d.padOffsetX ?? 0), offY = Number(d.padOffsetY ?? 0);
  // drill = center + padOffset rotated by padAngle, then rotated by
  // padAngle + relativeAngle in its own group. EasyEDA doc angles are
  // clockwise, so rotate clockwise before the Y-flip transform.
  const rawX = Number(d.centerX ?? 0) + offX * Math.cos(padAngle) + offY * Math.sin(padAngle);
  const rawY = Number(d.centerY ?? 0) - offX * Math.sin(padAngle) + offY * Math.cos(padAngle);
  const cx = X(Number(d.centerX ?? 0), xf), cy = Y(Number(d.centerY ?? 0), xf);
  const px = cx, py = cy; // copper anchor = declared pad center
  const dp = d.defaultPad ?? {};
  const color = opts?.copperColor ?? colorOf(d.layerId ?? LAYER.TOP);
  const shape = String(dp.padType ?? 'RECT').toUpperCase();
  // polygon pads (irregular footprint copper — MEMS-mic sector pads etc.) carry
  // no width/height: their outline lives in defaultPad.path, pad-local mil in
  // the same token stream as FILL/POLY paths (#pad-polygon)
  const polyPath = Array.isArray(dp.path) && dp.path.length > 2 ? (dp.path as any[]) : null;
  let w = Number(dp.width ?? 10), h = Number(dp.height ?? 10);
  // POLYGON pad outline origin (see polyPath use below)
  let pbx = 0, pby = 0;
  if (polyPath) {
    // estimate w/h from the path's coordinate pairs for the pad-number size
    // (token payload numbers — ARC/C — only inflate the estimate slightly)
    const DIM: Record<string, number> = { ARC: 3, CARC: 3, C: 6, Q: 4, R: 4 };
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < polyPath.length;) {
      const v = polyPath[i];
      if (typeof v === 'string') { i += 1 + (DIM[String(v).toUpperCase()] ?? 0); continue; }
      if (typeof polyPath[i + 1] === 'number') { xs.push(Number(v)); ys.push(Number(polyPath[i + 1])); }
      i += 2;
    }
    if (xs.length > 1) {
      w = Math.max(...xs) - Math.min(...xs);
      h = Math.max(...ys) - Math.min(...ys);
      // the outline's own bbox center: real files author POLYGON paths in
      // FOOTPRINT coords with centerX/centerY set to the copper bbox center
      // (U23 mic: all three C-arcs ring the sound hole only when read as-is),
      // so anchor by translating the path back onto its bbox center — the
      // declared center. Path-relative files (bbox center ≈ 0,0) get the same
      // treatment as a plain center-anchor, so both authorings land right.
      pbx = (Math.max(...xs) + Math.min(...xs)) / 2;
      pby = (Math.max(...ys) + Math.min(...ys)) / 2;
    }
  }
  const pad = new Group({ x: px, y: py, rotation: ang(padAngleDeg) });
  if (polyPath) {
    // the outline is pad-local y-up doc coords re-centered on its bbox center
    // (see pbx/pby) — flip into screen space inside the pad group, which
    // already carries the pad's position & rotation
    for (const dd of multiPathToSvg(polyPath, { ox: pbx, oy: pby, flip: true }, true)) {
      pad.add(new Path({ path: dd, fill: color }));
    }
  } else if (shape === 'RECT' || shape === 'SQUARE') {
    pad.add(new Rect({ x: -w / 2, y: -h / 2, width: w, height: h, fill: color, cornerRadius: (Number(dp.radius) || 0) }));
  } else {
    // every round-family copper shape keeps round caps: ELLIPSE is the *round*
    // pad in EasyEDA's schema (圆焊盘 — OVAL is the oblong one), so equal w/h is
    // a plain circle and a stretched w/h (PCB4's 260×200 slot-pad demo) is an
    // oblong with half-circle caps, never a pointed ellipse (#pad-oval)
    const cr = Math.min(w, h) / 2;
    pad.add(new Rect({ x: -w / 2, y: -h / 2, width: w, height: h, fill: color, cornerRadius: [cr, cr, cr, cr] }));
  }
  g.add(pad);
  const hole = d.hole;
  if (hole) {
    const hw = Number(hole.width ?? 0), hh = Number(hole.height ?? hw);
    if (hw > 0) {
      const ht = String(hole.holeType ?? 'ROUND').toUpperCase();
      // hole width runs along X, height along Y in the HOLE's own frame; the
      // drill rotates with the pad's full angle — e.g. a vertical slot in a
      // horizontal pad is relAngle=90, NOT swapped w/h (#slot-dir)
      let hn: any;
      if (ht === 'SLOT' || ht === 'ROUND') {
        // SLOT 挖槽 and ROUND 长圆孔 (schema) are round-cap drills — oblong when
        // w≠h, degrading to a plain round drill at w=h; never a pointed ellipse
        const cr = Math.min(hw, hh) / 2;
        hn = new Rect({ x: -hw / 2, y: -hh / 2, width: hw, height: hh, fill: holeFill, cornerRadius: [cr, cr, cr, cr] });
      } else if (ht === 'SQUARE' || ht === 'RECT' || ht === 'ROUND_RECT') {
        hn = new Rect({ x: -hw / 2, y: -hh / 2, width: hw, height: hh, fill: holeFill, cornerRadius: (Number(hole.cornerRadius) || 0) });
      } else {
        hn = new Ellipse({ x: -hw / 2, y: -hh / 2, width: hw, height: hh, fill: holeFill });
      }
      const hg = new Group({ x: X(rawX, xf), y: Y(rawY, xf), rotation: ang(padAngleDeg + relAngle) });
      hg.add(hn);
      if (opts?.holeSink) opts.holeSink(hg); // hoisted to the topmost hole layer
      else g.add(hg);
    }
  }
  // pad's own expansion field wins; null/absent falls back to the design rule
  const pickExpan = (own: unknown, fb: number | undefined): number =>
    own != null && Number.isFinite(Number(own)) ? Number(own) : Number(fb);
  // solder-mask opening (阻焊开窗): the copper shape grown by the pad's own
  // top/bottomSolderExpansion (mil doc units), falling back to the SOLDER
  // design rule. Negative values shrink the window; a fully closed shape
  // (w/h ≤ 0) paints nothing. Irregular pads (specialPad) are skipped —
  // the client windows those from their special shapes themselves (#mask-window)
  if (opts?.maskSink && !(Array.isArray(d.specialPad) && d.specialPad.length)) {
    const rule = opts.maskRule;
    const bottom = Number(d.layerId) === LAYER.BOTTOM;
    const faces: [1 | 2, number][] = hole
      ? [[1, pickExpan(d.topSolderExpansion, rule?.padTop)], [2, pickExpan(d.bottomSolderExpansion, rule?.padBot)]]
      : [[bottom ? 2 : 1, pickExpan(bottom ? d.bottomSolderExpansion : d.topSolderExpansion, bottom ? rule?.padBot : rule?.padTop)]];
    for (const [face, e0] of faces) {
      const e = Number(e0);
      if (!isFinite(e) || e <= -900) continue; // rule sentinel (≤ -1000): no window
      const mw = w + 2 * e, mh = h + 2 * e;
      if (mw <= 0 || mh <= 0) continue;
      const mg = new Group({ x: px, y: py, rotation: ang(padAngleDeg) });
      if (polyPath) {
        // POLYGON pads window from their own outline: fill it and stroke it by
        // the expansion — a 2e round-join stroke dilates the polygon by e the
        // way the client grows the special shape (a negative expansion cannot
        // shrink a fill, so the window then equals the pad outline itself)
        const ds = multiPathToSvg(polyPath, { ox: pbx, oy: pby, flip: true }, true);
        const sw = Math.max(0, 2 * e);
        const mc = colorOf(face === 1 ? LAYER.TOP_MASK : LAYER.BOT_MASK);
        mg.add(new Path({ path: ds.join(' '), fill: mc, stroke: sw > 0 ? mc : undefined, strokeWidth: sw, strokeCap: 'round', strokeJoin: 'round' }));
      } else {
        const cr = shape === 'RECT' || shape === 'SQUARE'
          ? Math.min(Math.max(0, (Number(dp.radius) || 0) + e), Math.min(mw, mh) / 2)
          : Math.min(mw, mh) / 2;
        mg.add(new Rect({ x: -mw / 2, y: -mh / 2, width: mw, height: mh, fill: colorOf(face === 1 ? LAYER.TOP_MASK : LAYER.BOT_MASK), cornerRadius: cr }));
      }
      opts.maskSink(face, mg);
    }
  }
  // paste opening (助焊/钢网): the pad shape grown by the pad's own
  // top/bottomPasteExpansion (mil doc units), falling back to the PASTE design
  // rule when the pad carries no field of its own. The file's "no paste"
  // sentinel rides the same convention as the mask rule (≤ -1000; this project
  // writes -3937 = -100mm on suppressed pads) — negative values shrink the
  // opening. Through-hole pads open both faces (the client's default too —
  // suppressing them is the per-pad -1000 custom from the official FAQ);
  // SMD pads open only their own face. The paste shape paints UNDER the copper
  // (see the layer stacking order), so an expansion of 0 hides beneath the pad.
  if (opts?.pasteSink && !(Array.isArray(d.specialPad) && d.specialPad.length)) {
    const rule = opts.pasteRule;
    const bottom = Number(d.layerId) === LAYER.BOTTOM;
    const faces: [1 | 2, number][] = hole
      ? [[1, pickExpan(d.topPasteExpansion, rule?.padTop)], [2, pickExpan(d.bottomPasteExpansion, rule?.padBot)]]
      : [[bottom ? 2 : 1, pickExpan(bottom ? d.bottomPasteExpansion : d.topPasteExpansion, bottom ? rule?.padBot : rule?.padTop)]];
    for (const [face, e0] of faces) {
      const e = Number(e0);
      if (!isFinite(e) || e <= -900) continue; // "no paste" sentinel (-1000 / -3937)
      const pw = w + 2 * e, ph = h + 2 * e;
      if (pw <= 0 || ph <= 0) continue;
      const pg = new Group({ x: px, y: py, rotation: ang(padAngleDeg) });
      if (polyPath) {
        // POLYGON paste opens from the outline too (same stroke-dilation as
        // the mask window above; paste sits UNDER the copper in paint order)
        const ds = multiPathToSvg(polyPath, { ox: pbx, oy: pby, flip: true }, true);
        const sw = Math.max(0, 2 * e);
        const pc = colorOf(face === 1 ? LAYER.TOP_PASTE : LAYER.BOTTOM_PASTE);
        pg.add(new Path({ path: ds.join(' '), fill: pc, stroke: sw > 0 ? pc : undefined, strokeWidth: sw, strokeCap: 'round', strokeJoin: 'round' }));
      } else {
        const cr = shape === 'RECT' || shape === 'SQUARE'
          ? Math.min(Math.max(0, (Number(dp.radius) || 0) + e), Math.min(pw, ph) / 2)
          : Math.min(pw, ph) / 2;
        pg.add(new Rect({ x: -pw / 2, y: -ph / 2, width: pw, height: ph, fill: colorOf(face === 1 ? LAYER.TOP_PASTE : LAYER.BOTTOM_PASTE), cornerRadius: cr }));
      }
      opts.pasteSink(face, pg);
    }
  }
  // pad number + net name, one stacked label block centered inside the copper
  // (user pref): the pair reads along the pad's LONG axis — wide pads read
  // horizontally with the number above the net name, tall pads read up the
  // axis with the number beside it (the whole block just rotates with the
  // pad, the number is NOT forced upright, user pref). Alone, the number sits
  // dead-center. The net name must FIT: the two lines span the pad's short
  // axis (numF + gap + f ≤ shortLen) and the longer line runs the long axis
  // (shrunk a step, NET_LEN_SHRINK) — a pad too small stays unlabeled (no
  // floor fallback; a squeezed label reads worse than none, user pref).
  const num = d.num == null ? '' : String(d.num);
  const netName = opts?.netName ?? '';
  if (num || netName) {
    const along = h > w;
    const rot = along ? padAngleDeg - 90 : padAngleDeg;
    const shortLen = along ? w : h;
    const numF = num ? Math.max(Math.min(w, h) * 0.6, 1) : 0;
    const f = netName
      ? fitNetFont(netName, (along ? h : w) * 0.9 * NET_LEN_SHRINK, Math.min(NET_FONT_MAX, shortLen - numF - 2))
      : null;
    // line centers in the block's rotated frame — block-centered when both
    // lines show, centered alone when only one does
    const GAP = 1;
    const two = numF > 0 && f != null;
    const numLy = two ? -(GAP + (f as number)) / 2 : 0;
    const netLy = two ? (numF + GAP) / 2 : 0;
    // text-frame vertical offset → doc-space delta for the block rotation
    // (leafer ρ = −θ − 90° when along, screen delta = (ly·cosθ, −ly·sinθ) —
    // doc space flips y): along pads put the second line beside the number,
    // horizontal pads below it
    const docDelta = (ly: number): [number, number] =>
      along ? [ly * Math.cos(padAngle), ly * Math.sin(padAngle)]
            : [ly * Math.sin(padAngle), -ly * Math.cos(padAngle)];
    if (num) {
      const t = new Text({
        // doc-scaled like the client's own labels — grows with zoom, sized to
        // stay inside the copper (#pad-num-zoom); PAD_INK, one step brighter
        // than the client's gray, over bright copper (user pref #pad-num-ink)
        text: num, fontSize: numF, fill: PAD_INK,
        textAlign: 'center', verticalAlign: 'middle', autoSizeAlign: true, hittable: false,
        rotation: rot,
      } as any);
      const [dx, dy] = docDelta(numLy);
      t.x = X(Number(d.centerX ?? 0) + dx, xf);
      t.y = Y(Number(d.centerY ?? 0) + dy, xf);
      if (opts?.numSink) opts.numSink(t);
      else g.add(t);
    }
    if (netName && f != null) {
      const t = new Text({
        // same ink as the pad number (user pref: 一致的颜色)
        text: netName, fontSize: f, fill: PAD_INK,
        textAlign: 'center', verticalAlign: 'middle', autoSizeAlign: true, hittable: false,
        rotation: rot,
      } as any);
      const [dx, dy] = docDelta(netLy);
      t.x = X(Number(d.centerX ?? 0) + dx, xf);
      t.y = Y(Number(d.centerY ?? 0) + dy, xf);
      if (opts?.netSink) opts.netSink(t);
      else g.add(t);
    }
  }
  return g;
}

/** exact world bbox of a glyph-rendered STRING (#string-bbox): FONT outline
 *  subs are pure polyline coordinate pairs, so their ink bounds are exact —
 *  placed through the same anchor/origin/angle/flip math as glyphLabel, the
 *  pick box hugs the painted glyphs instead of the measured layout estimate.
 *  Text-fallback strings (no FONT record) return undefined and keep the
 *  generic objBBox estimate. */
function stringBBox(d: any, glyphs: Map<string, FontGlyph>, xfc: Xf): BBox | undefined {
  const text = String(d.text ?? d.value ?? '');
  if (!text) return undefined;
  const glyph = glyphs.get(glyphKey(text, String(d.fontFamily ?? ''), Number(d.fontSize) || 0));
  if (!glyph) return undefined;
  const s = String(d.origin ?? '').toUpperCase();
  const ha = s.includes('CENTER') ? 0.5 : s.includes('RIGHT') ? 1 : 0;
  const va = s.includes('TOP') ? 0 : s.includes('BOTTOM') ? 1 : 0.5;
  let ux0 = Infinity, ux1 = -Infinity, uy0 = Infinity, uy1 = -Infinity;
  for (const sub of glyph.subs) {
    if (!Array.isArray(sub)) continue;
    for (let i = 0; i < sub.length;) {
      if (typeof sub[i] === 'string') { i += 1; continue; } // "L" marker — pairs follow
      const x = Number(sub[i]), y = Number(sub[i + 1]);
      i += 2;
      if (!isFinite(x) || !isFinite(y)) continue;
      if (x < ux0) ux0 = x;
      if (x > ux1) ux1 = x;
      if (y < uy0) uy0 = y;
      if (y > uy1) uy1 = y;
    }
  }
  if (!isFinite(ux0)) return undefined;
  // glyph px space → node-local screen offsets (same mapping as glyphLabel):
  // x right of the anchor minus the origin shift, y from the box top downward
  const lx0 = ux0 * GLYPH_UNIT - ha * glyph.width, lx1 = ux1 * GLYPH_UNIT - ha * glyph.width;
  const ly0 = (1 - va) * glyph.height - uy1 * GLYPH_UNIT, ly1 = (1 - va) * glyph.height - uy0 * GLYPH_UNIT;
  const [ax, ay] = P(Number(d.x ?? 0), Number(d.y ?? 0), xfc);
  const rr = (-Number(d.angle ?? d.rotation ?? 0) * Math.PI) / 180;
  const cs = Math.cos(rr), sn = Math.sin(rr);
  const kx = d.reverse ? -1 : 1, ky = d.mirror ? -1 : 1;
  const corners: [number, number][] = ([[lx0, ly0], [lx1, ly0], [lx1, ly1], [lx0, ly1]] as [number, number][]).map(
    ([lx, ly]) => [ax + (lx * kx) * cs - (ly * ky) * sn, ay + (lx * kx) * sn + (ly * ky) * cs] as [number, number],
  );
  return bboxFromPts(corners) ?? undefined;
}

/** bottom-face viewing flip (#bottom-mirror): the official 2D view reads records
 *  on the board's underside mirrored when the board is seen from the top — each
 *  object flips horizontally about its own rendered box center, so position and
 *  size stay put and only the glyph/image content mirrors. A record authored
 *  mirror:true already stores the flipped form (the two flips XOR out), so it
 *  renders as-is. `center` is the rendered world box; the wrapper Group
 *  {x: minX+maxX, scaleX: -1} mirrors every descendant about the vertical line
 *  through the box center (T(2cx)·diag(-1,1) applied to the child's transform). */
function bottomMirrorWrap(d: any, node: Group, center: BBox | undefined): Group | null {
  if (!center || !BOTTOM_LAYERS.has(String(d.layerId)) || d.mirror) return null;
  const wrap = new Group({ x: center.minX + center.maxX, scaleX: -1 });
  wrap.add(node);
  return wrap;
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

  // net per placed pad: PAD_NET id = ["PAD_NET", "<componentId>", "<padNum>", …]
  // — shared by the in-copper net labels and the ratsnest builder
  const netOfPad = new Map<string, string>();
  for (const r of seg.recs) {
    if (r.type !== 'PAD_NET') continue;
    const p = padNetIdParts(r.id);
    if (p && r.data.padNet) netOfPad.set(`${p[0]}:${p[1]}`, String(r.data.padNet));
  }

  // per-net special color (#net-colors): NET id = flattened "NET,<name>" carries
  // specialColor when the user paints a net in the client. #000000 is the
  // unpainted default — everything stays on its layer color.
  const netColor = new Map<string, string>();
  for (const r of seg.recs) {
    if (r.type !== 'NET') continue;
    const c = r.data.specialColor;
    if (typeof c !== 'string' || !/^#[0-9a-f]{6}$/i.test(c)) continue;
    if (/^#000000$/i.test(c)) continue;
    const m = String(r.id ?? '').match(/^NET,(.+)$/s);
    if (m) netColor.set(m[1], c);
  }
  const colorForNet = (net: unknown, fallback: string): string => {
    const c = net != null ? netColor.get(String(net)) : undefined;
    return c ?? fallback;
  };

  // layers from LAYER records
  const layerMeta = new Map<string, { name: string; color: string; show: boolean; type: string; trans: number }>();
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
      // layerType (TOP / SIGNAL / BOTTOM_SILK / OUTLINE / HOLE …) is the only
      // stable semantic — official docs say layer numbers themselves are not
      type: String(r.data.layerType ?? ''),
      // activateTransparency is the file's own layer opacity (solder mask 0.7)
      trans: Number(r.data.activateTransparency ?? 1) || 1,
    });
    api.layer(key, layerMeta.get(key)!.name, layerMeta.get(key)!.color, show, layerMeta.get(key)!.type);
  }
  // layers whose record carries a transparency paint at that opacity — applied
  // to the whole layer group so every shape in it dims together (#mask-window)
  for (const [key, lm] of layerMeta) {
    if (lm.trans < 1) api.layer(key, lm.name, lm.color, lm.show, lm.type).opacity = lm.trans;
  }
  const layerColor = (id: unknown): string => {
    const lm = layerMeta.get(String(id));
    if (lm) return lm.color;
    return LAYER_FALLBACK[Number(id)] ?? '#999999';
  };
  /** filled copper (pour fill / static fill) paints a DIMMED layer color —
   *  the client's 2D view shows pour fill darker than routing so the round-cap
   *  edge wrap (full layer color) stays visible along the fill border (#pour-edge) */
  const pourColor = (id: unknown): string => layerColor(id);
  /** brightness factor of pour/fill copper vs tracks — ~0.6 reads like the
   *  client's dark-red fill against its bright-red wrap stroke */
  const POUR_FILL_DIM = 0.6;
  /** drill/via holes punch through to the canvas background — lifted a touch
   *  lighter than it so 挖槽 cutouts and drills stay distinguishable from the
   *  empty space around the board (user pref) */
  const holeFill = liftHex(api.bgColor, 0.14);
  /** drill/slot holes hoist to the hole layer (47), the topmost group in the
   *  stacking order, so drills always paint above every copper/silk group */
  const holeLayerGroup = api.layer(String(LAYER.HOLE), layerMeta.get(String(LAYER.HOLE))?.name, layerColor(LAYER.HOLE), true);
  /** pad-number labels hoist to a per-face overlay that stacks between the
   *  face's copper and its silk (client stack: copper < pad numbers < silk) */
  const padNumLayer = (face: 1 | 2): Group =>
    api.layer(`pn:${face}`, face === 1 ? '顶层焊盘编号' : '底层焊盘编号', '#f2f4f7', true);
  /** net-name labels hoist to a per-face overlay above the face's copper —
   *  client stack: copper < net names < pad numbers < silk (see pcbStackKey) */
  const netNameLayer = (face: 1 | 2): Group =>
    api.layer(`nn:${face}`, face === 1 ? '顶层网络名' : '底层网络名', '#c9ccd1', true);
  /** which face (1 top / 2 bottom) a layer id belongs to — by LAYER record
   *  layerType, falling back to the standard numeric layer ids */
  const faceOf = (lid: unknown): 1 | 2 => {
    const key = String(lid);
    if (layerMeta.get(key)?.type.toUpperCase().startsWith('BOT')) return 2;
    return BOTTOM_LAYERS.has(key) ? 2 : 1;
  };
  /** fallback font size (doc units) when a record carries no fontSize */
  const LABEL_PX = 9;

  // custom-font strings render from the file's own FONT glyph outlines (#font-glyph)
  const fontGlyphs = fontGlyphMap(opened.libs);

  /** PCB text node. Custom-font strings whose outline ships in the file's FONT
   * document draw as vector paths (the exact typeface, no font binary needed —
   * #font-glyph); everything else is a leafer Text. `docScale` renders at the
   * record's own font size so the text grows/shrinks with the board like
   * EasyEDA does — silk (heavy display face) and designator labels (plain
   * face) both zoom now (#pad-num-zoom). Origin token (LEFT_BOTTOM …) selects
   * the anchor within the given point. */
  function mkLabel(d: any, color: string, xfc: ReturnType<typeof xfOf>, docScale = false, heavy = docScale): Text | Group {
    const fs = docScale ? (Number(d.fontSize) || LABEL_PX) : LABEL_PX;
    const text = String(d.text ?? d.value ?? '');
    const fam = String(d.fontFamily ?? '');
    // glyph hit: the file carries this exact string/font/size as vector outlines
    const glyph = text ? fontGlyphs.get(glyphKey(text, fam, Number(d.fontSize) || 0)) : undefined;
    if (glyph) return glyphLabel(glyph, d, color, xfc);
    const t = new Text({
      text, fontSize: fs,
      // the record's own font name when the file names one (browser falls back
      // when the typeface is not installed); silk strings without a named font
      // approximate the heavy display face with a bold sans so weight/styles
      // stay close to the reference
      fontFamily: fam && fam !== 'default' ? fam : (docScale && heavy ? 'Arial Black, Arial Bold, Microsoft YaHei, sans-serif' : undefined),
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

  /** FONT glyph outline → Path group placed exactly where the Text fallback
   *  would sit: anchor per the origin token, record angle, reverse/mirror
   *  flips (#font-glyph). Glyph space is y-up with (0,0) at the layout box's
   *  bottom-left and 1 unit = GLYPH_UNIT doc units (width/height are doc
   *  units), so the box spans [0,W]×[0,H] in doc space — i.e.
   *  [ha·W−W…ha·W]×[−va·H…(1−va)·H] around the anchor after the origin
   *  token's shift (node space is y-down, hence the -py). */
  function glyphLabel(g: FontGlyph, d: any, color: string, xfc: Xf): Group {
    const s = String(d.origin ?? '').toUpperCase();
    const ha = s.includes('CENTER') ? 0.5 : s.includes('RIGHT') ? 1 : 0;
    const va = s.includes('TOP') ? 0 : s.includes('BOTTOM') ? 1 : 0.5;
    const node = new Group({ name: 'glyph-text' });
    node.add(new Path({
      // all subpaths in ONE nonzero-filled Path — holes wind opposite to outers
      path: glyphPathD(g.subs, (px, py) =>
        [px * GLYPH_UNIT - ha * g.width, (1 - va) * g.height - py * GLYPH_UNIT]),
      fill: color, windingRule: 'nonzero',
    }));
    node.x = X(Number(d.x ?? 0), xfc);
    node.y = Y(Number(d.y ?? 0), xfc);
    node.rotation = ang(Number(d.angle ?? d.rotation ?? 0));
    if (d.reverse) node.scaleX = -1;
    if (d.mirror) node.scaleY = -1;
    return node;
  }

  const byParent = indexByParent(seg.recs);

  // POUR carries the layerId of its generated fill (POURED id "POURED,<pourId>")
  const pourLayer = new Map<string, unknown>();
  // and its border-wrap gauge: manufacturing-optimized pours write `pourType`
  // as an object {"pourType":"SOLID","fineness":3|4} whose fineness IS the
  // 包边 trace width in mil (3/4 = a 3/4mil wrap). Pours with a string pourType
  // (older files) carry no gauge — record 0 so no synthetic wrap gets painted.
  const pourWidth = new Map<string, number>();
  for (const r of seg.recs) if (r.type === 'POUR') {
    pourLayer.set(String(r.id), r.data.layerId);
    const pt = r.data.pourType;
    pourWidth.set(String(r.id), pt && typeof pt === 'object' ? Number(pt.fineness) || 0 : 0);
  }

  // ---- solder-mask windows (#mask-window) ----
  // SOLDER design rule: RULE id ["RULE","SOLDER","solderMaskExpansion"] whose
  // ruleContext carries the expansions in its own unit (this file: mil doc
  // units; "mm" converts). -1000 marks "no window" — the via default here,
  // i.e. vias are tented (盖油) unless a via record overrides per face.
  const ruleConv = (rc: any) => (v: unknown): number => {
    const n = Number(v);
    if (!isFinite(n)) return n;
    return String(rc?.unit ?? '').toLowerCase() === 'mm' ? n * 39.3701 : n;
  };
  const maskRule = { padTop: 0, padBot: 0, viaTop: -1000, viaBot: -1000 };
  for (const r of seg.recs) {
    if (r.type !== 'RULE' || !String(r.id).includes('solderMaskExpansion')) continue;
    const rc = (r.data.ruleContext ?? {}) as any;
    const conv = ruleConv(rc);
    maskRule.padTop = conv(rc.padTopExpan);
    maskRule.padBot = conv(rc.padBotExpan);
    maskRule.viaTop = conv(rc.viaTopExpan);
    maskRule.viaBot = conv(rc.viaBotExpan);
  }
  // PASTE design rule: RULE id ["RULE","PASTE","pasteMaskExpansion"] — same
  // expansion convention as SOLDER; pads without their own paste-expansion
  // field grow their opening by this (0 = paste shape equals the pad shape).
  const pasteRule = { padTop: 0, padBot: 0 };
  for (const r of seg.recs) {
    if (r.type !== 'RULE' || !String(r.id).includes('pasteMaskExpansion')) continue;
    const rc = (r.data.ruleContext ?? {}) as any;
    const conv = ruleConv(rc);
    pasteRule.padTop = conv(rc.padTopExpan);
    pasteRule.padBot = conv(rc.padBotExpan);
  }
  /** solder-mask group (5 top / 6 bottom) — the file's activateTransparency
   *  (阻焊 0.7) was already applied to the layer group in the LAYER loop */
  const maskLayer = (face: 1 | 2): Group => {
    const lid = face === 1 ? LAYER.TOP_MASK : LAYER.BOT_MASK;
    const lm = layerMeta.get(String(lid));
    return api.layer(String(lid), lm?.name, lm?.color ?? LAYER_FALLBACK[lid], lm?.show ?? true);
  };
  const maskColor = (face: 1 | 2): string => layerColor(face === 1 ? LAYER.TOP_MASK : LAYER.BOT_MASK);
  /** paste group (7 top / 8 bottom) — the stencil/助焊 openings hoist here like
   *  the mask windows; both sit UNDER their face's copper in the paint order */
  const pasteLayer = (face: 1 | 2): Group => {
    const lid = face === 1 ? LAYER.TOP_PASTE : LAYER.BOTTOM_PASTE;
    const lm = layerMeta.get(String(lid));
    return api.layer(String(lid), lm?.name, lm?.color ?? LAYER_FALLBACK[lid], lm?.show ?? true);
  };

  // ---- POURED layer resolution, including the manufacturing-optimize 包边 ----
  // Flat EasyEDA path points (mirrors pathToSvg's token walk: ARC/CARC carry
  // `deg endX endY`, C six numbers, Q four — pour fills only use L/ARC).
  const pathPts = (item: any[], out: [number, number][] = []): [number, number][] => {
    if (!Array.isArray(item)) return out;
    for (let i = 0; i < item.length;) {
      const v = item[i];
      if (typeof v === 'string') {
        i += 1;
        if ((v === 'ARC' || v === 'CARC') && typeof item[i] === 'number') { out.push([Number(item[i + 1]), Number(item[i + 2])]); i += 3; }
        else if (v === 'C') i += 6;
        else if (v === 'Q') i += 4;
        continue;
      }
      out.push([Number(v), Number(item[i + 1])]);
      i += 2;
    }
    return out;
  };
  /** doc-space bbox of a POURED record (pourFill coords are 0.1× doc units) */
  const pouredBBox = (r: Rec): BBox | null => {
    let bb: BBox | null = null;
    for (const pf of (r.data.pourFill ?? []) as any[]) {
      // path nests one level: [[tokens…], [tokens…]] — walk each subpath array
      const paths: any[][] = Array.isArray(pf.path?.[0]) ? pf.path : [pf.path];
      for (const sub of paths) {
        for (const [x0, y0] of pathPts(sub)) {
          const x = x0 * 10, y = y0 * 10;
          if (!bb) bb = { minX: x, minY: y, maxX: x, maxY: y };
          else {
            if (x < bb.minX) bb.minX = x;
            if (y < bb.minY) bb.minY = y;
            if (x > bb.maxX) bb.maxX = x;
            if (y > bb.maxY) bb.maxY = y;
          }
        }
      }
    }
    return bb;
  };
  // A POURED without a POUR is a stale re-pour cache the file kept — drawing
  // those raw would repaint whole-board regions (#pour-gaps). BUT the 导线包边
  // of a manufacturing-optimized pour survives ONLY in such a cache (stroke-only
  // pourFill entries): render a cache just when it carries 包边 strokes, on the
  // layer of the smallest live pour whose fill region contains it (#pour-edge).
  const hasEdgeStrokes = (r: Rec): boolean =>
    ((r.data.pourFill ?? []) as any[]).some((pf) => pf.fill === false && Number(pf.strokeWidth) > 0);
  const pouredLid = new Map<object, unknown>();
  /** paired/orphan-resolved POUR's own border-wrap gauge (mil, pourType.fineness) per POURED */
  const pouredWidth = new Map<object, number>();
  /** orphan edge-caches render their 包边 strokes only — never their stale fill (#pour-gaps) */
  const edgeOnly = new Set<object>();
  const liveBBox = new Map<string, BBox>();
  for (const r of seg.recs) {
    if (r.type !== 'POURED') continue;
    const key = String(r.id).split(',').pop() ?? '';
    if (!pourLayer.has(key)) continue;
    const bb = pouredBBox(r);
    if (bb) liveBBox.set(key, bb);
  }
  for (const r of seg.recs) {
    if (r.type !== 'POURED') continue;
    const key = String(r.id).split(',').pop() ?? '';
    const paired = pourLayer.get(key);
    if (paired !== undefined) {
      pouredLid.set(r.data, paired);
      pouredWidth.set(r.data, pourWidth.get(key) ?? 0);
      continue;
    }
    if (!hasEdgeStrokes(r)) continue;
    const bb = pouredBBox(r);
    if (!bb) continue;
    let best: unknown, bestW = 0, bestArea = Infinity;
    for (const [pid, plid] of pourLayer) {
      const pb = liveBBox.get(pid);
      if (!pb) continue;
      if (pb.minX > bb.minX || pb.minY > bb.minY || pb.maxX < bb.maxX || pb.maxY < bb.maxY) continue;
      const area = (pb.maxX - pb.minX) * (pb.maxY - pb.minY);
      if (area < bestArea) { bestArea = area; best = plid; bestW = pourWidth.get(pid) ?? 0; }
    }
    if (best !== undefined) { pouredLid.set(r.data, best); pouredWidth.set(r.data, bestW); edgeOnly.add(r.data); }
  }

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

  const addToLayer = (d: any, obj: Rec, node: Group, label: string, kind: RenderObject['kind'] = 'primitive', bbox?: BBox,
    group?: { key: string; name: string }) => {
    let lid = d.layerId != null ? String(d.layerId) : '0';
    if (group) lid = group.key; // synthetic per-face sub-group (pour:1 / pour:2)
    if (HIDDEN_LAYERS.has(lid)) return; // never-painted utility layers (#27 area)
    // synthetic groups keep the face layer's own color/show (their `key` has no LAYER record)
    const lm = layerMeta.get(group ? String(d.layerId) : lid);
    api.layer(lid, group?.name ?? lm?.name, lm?.color ?? LAYER_FALLBACK[Number(lid)] ?? '#888888', lm?.show ?? true).add(node);
    // bottom-side layers show through the board at partial opacity — measured
    // from the official 2D export (#336619 = silk @50%, #000059 = copper @70%)
    const alpha = BOTTOM_ALPHA[lid];
    if (alpha !== undefined && node.opacity === undefined) node.opacity = alpha;
    // `bbox` lets callers hand in an exact painted box (glyph ink / rotated
    // image frame) instead of the generic estimate (#string-bbox, #image-bbox)
    api.addObject({ id: obj.id, rec: obj, node, label, kind, bbox: bbox ?? objBBox(obj, xf) ?? undefined });
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
  // `targetFor` routes every primitive to the per-layer wrapper of its own
  // layerId — footprint silk stacks with the doc's silk, pads with the copper —
  // instead of the whole footprint living in one group (see drawComponent).
  function drawFootprint(target: Group, fp: DocSegment, targetFor: (lid: unknown) => Group, numFace: 1 | 2, compId: string) {
    const fxf = xfOf(fp.canvas); // footprint-local canvas (origin likely 0)
    const fpAllIds = new Set(fp.recs.map((fr) => String(fr.id ?? '')));
    const fpRecs = sortZ(fp.recs);
    const drawFpRec = (r: Rec): void => {
      const d = r.data;
      if (HIDDEN_LAYERS.has(String(d.layerId))) return; // pin-soldering rose discs etc.
      switch (r.type) {
        case 'PAD': {
          // drill/slot holes hoist to the hole layer in world coords: the pad
          // group's local (hx,hy) maps through the component's pos + rotation
          // (+ Y flip for bottom-side components — see drawComponent)
          const flipY = Number(target.scaleY) === -1;
          const gx = Number(target.x) || 0, gy = Number(target.y) || 0;
          const gr = ((Number(target.rotation) || 0) * Math.PI) / 180;
          const gc = Math.cos(gr), gs = Math.sin(gr);
          const padNet = netOfPad.get(`${compId}:${d.num ?? ''}`) ?? (d.padNet != null ? String(d.padNet) : undefined);
          // through-hole pad copper hangs off the MULTI-Layer group: the barrel
          // spans every copper face, so the client keeps the ring above inner
          // tracks too — routing it to the face group (most TH pads carry
          // layerId 1) let an activated inner layer bury it (#th-pad-multilayer).
          // The color still follows the record's own face layer.
          const thPad = Number(d.hole?.width ?? 0) > 0;
          targetFor(thPad ? LAYER.MULTI : d.layerId).add(padNode(d, fxf, layerColor, holeFill, {
            holeSink: (hg) => {
              const hx = Number(hg.x) || 0, hy = (flipY ? -1 : 1) * (Number(hg.y) || 0);
              hg.x = gx + hx * gc - hy * gs;
              hg.y = gy + hx * gs + hy * gc;
              // a flip negates the hole's own rotation relative to the component
              hg.rotation = (Number(target.rotation) || 0) + (flipY ? -1 : 1) * (Number(hg.rotation) || 0);
              holeLayerGroup.add(hg);
            },
            // mask openings ride their face's mask layer in world coords —
            // same wrapper-transform replication as the hole above
            maskRule,
            maskSink: (face, mg) => {
              const mx = Number(mg.x) || 0, my = (flipY ? -1 : 1) * (Number(mg.y) || 0);
              mg.x = gx + mx * gc - my * gs;
              mg.y = gy + mx * gs + my * gc;
              mg.rotation = (Number(target.rotation) || 0) + (flipY ? -1 : 1) * (Number(mg.rotation) || 0);
              maskLayer(face).add(mg);
            },
            // paste openings ride their face's paste layer in world coords —
            // same wrapper-transform replication as the mask above
            pasteRule,
            pasteSink: (face, pg) => {
              const sx = Number(pg.x) || 0, sy = (flipY ? -1 : 1) * (Number(pg.y) || 0);
              pg.x = gx + sx * gc - sy * gs;
              pg.y = gy + sx * gs + sy * gc;
              pg.rotation = (Number(target.rotation) || 0) + (flipY ? -1 : 1) * (Number(pg.rotation) || 0);
              pasteLayer(face).add(pg);
            },
            // the pad number rides the face's label overlay in world coords,
            // replicating the wrapper's transform on position AND rotation —
            // the number now reads along the pad's long axis like the net
            // name (user pref: 编号不强制直立，随焊盘方向), mirrored with the
            // component on the bottom face
            numSink: (t) => {
              const tx = Number(t.x) || 0, ty = (flipY ? -1 : 1) * (Number(t.y) || 0);
              t.x = gx + tx * gc - ty * gs;
              t.y = gy + tx * gs + ty * gc;
              t.rotation = (Number(target.rotation) || 0) + (flipY ? -1 : 1) * (Number(t.rotation) || 0);
              padNumLayer(numFace).add(t);
            },
            // in-copper net label: same world mapping as the other hoisted
            // nodes (position AND rotation — the label reads along the pad's
            // long axis, mirrored with the component on the bottom face),
            // hoisted to the face's nn: overlay above the copper (#net-labels)
            netName: padNet,
            copperColor: padNet ? netColor.get(padNet) : undefined,
            netSink: (t) => {
              const tx = Number(t.x) || 0, ty = (flipY ? -1 : 1) * (Number(t.y) || 0);
              t.x = gx + tx * gc - ty * gs;
              t.y = gy + tx * gs + ty * gc;
              t.rotation = (Number(target.rotation) || 0) + (flipY ? -1 : 1) * (Number(t.rotation) || 0);
              netNameLayer(numFace).add(t);
            },
          }));
          break;
        }
        case 'POLY': {
          if (Array.isArray(d.points)) {
            const pts: number[] = [];
            for (const p of d.points as any[]) { const [x, y] = P(Number(p.x ?? 0), Number(p.y ?? 0), fxf); pts.push(x, y); }
            if (pts.length >= 4) targetFor(d.layerId).add(new Line({ points: pts, closed: !!d.closed, stroke: layerColor(d.layerId), strokeWidth: widthOf(d, 4), strokeCap: 'round', strokeJoin: 'round' }));
          }
          const ds = multiPathToSvg(d.path ?? [], fxf, false);
          for (const path of ds) {
            targetFor(d.layerId).add(new Path({ path, stroke: layerColor(d.layerId), strokeWidth: widthOf(d, 4), strokeCap: 'round', strokeJoin: 'round' }));
          }
          break;
        }
        case 'FILL': {
          const ds = multiPathToSvg(d.path ?? [], fxf, true);
          // a footprint FILL on Multi-Layer is a plated slot / cutout (挖槽):
          // the client punches it through the board like a drill — bg-colored
          // ink on the topmost hole layer, never copper-gray. Path data is
          // wrapper-local, so copying the wrapper's transform onto the hoisted
          // node reproduces its exact world placement (incl. bottom-side flip).
          if (Number(d.layerId) === LAYER.MULTI) {
            for (const path of ds) {
              const hole = new Path({ path, fill: holeFill });
              hole.set({ x: Number(target.x) || 0, y: Number(target.y) || 0, rotation: Number(target.rotation) || 0, scaleX: Number(target.scaleX) || 1, scaleY: Number(target.scaleY) || 1 });
              holeLayerGroup.add(hole);
            }
            break;
          }
          for (const path of ds) {
            // static copper fill paints the same full layer color as pour fill (see pourColor)
            const p = new Path({ path, fill: pourColor(d.layerId) });
            targetFor(d.layerId).add(p);
          }
          break;
        }
        case 'LINE': {
          const [x1, y1] = P(Number(d.startX ?? 0), Number(d.startY ?? 0), fxf);
          const [x2, y2] = P(Number(d.endX ?? 0), Number(d.endY ?? 0), fxf);
          targetFor(d.layerId).add(new Line({ points: [x1, y1, x2, y2], stroke: layerColor(d.layerId), strokeWidth: widthOf(d, 4), strokeCap: 'round' }));
          break;
        }
        case 'ARC': {
          const [x1, y1] = P(Number(d.startX ?? 0), Number(d.startY ?? 0), fxf);
          const [x2, y2] = P(Number(d.endX ?? 0), Number(d.endY ?? 0), fxf);
          targetFor(d.layerId).add(new Path({ path: arcD(x1, y1, x2, y2, Number(d.angle ?? 0)), stroke: layerColor(d.layerId), strokeWidth: widthOf(d, 4), strokeCap: 'round' }));
          break;
        }
        case 'RECT': {
          // footprint rectangle primitives (dotX1/dotY1…dotX2/dotY2 like sch RECT);
          // round caps/joins like the client render — thick outlines get visibly
          // rounded corners and ends (user pref, overrides the ref zoom — #pcb-round)
          const [x1, y1] = P(Number(d.dotX1 ?? 0), Number(d.dotY1 ?? 0), fxf);
          const [x2, y2] = P(Number(d.dotX2 ?? d.dotX1 ?? 0), Number(d.dotY2 ?? d.dotY1 ?? 0), fxf);
          const rr = Math.min(Number(d.radiusX ?? 0) || 0, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2);
          targetFor(d.layerId).add(new Rect({
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
          targetFor(d.layerId).add(mkLabel(d, layerColor(d.layerId), fxf, true));
          break;
        }
        case 'CIRCLE': {
          const cx = X(Number(d.centerX ?? 0), fxf), cy = Y(Number(d.centerY ?? 0), fxf);
          const rad = Math.abs(Number(d.radius ?? 0)) || 1;
          targetFor(d.layerId).add(new Ellipse({ x: cx - rad, y: cy - rad, width: rad * 2, height: rad * 2, stroke: layerColor(d.layerId), strokeWidth: widthOf(d, 4), fill: null }));
          break;
        }
        case 'ELLIPSE': {
          const cx = X(Number(d.centerX ?? 0), fxf), cy = Y(Number(d.centerY ?? 0), fxf);
          const rx = Math.abs(Number(d.radiusX ?? 0)) || 1, ry = Math.abs(Number(d.radiusY ?? 0)) || 1;
          const e = new Ellipse({ x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2, stroke: layerColor(d.layerId), strokeWidth: widthOf(d, 4), fill: null });
          e.rotation = ang(Number(d.rotation ?? 0));
          targetFor(d.layerId).add(e);
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
    };
    // pads paint above the footprint's own fills/lines within the same layer
    // group (#pad-top): two passes over the same z order, pads last
    for (const r of fpRecs) if (r.type !== 'PAD') drawFpRec(r);
    for (const r of fpRecs) if (r.type === 'PAD') drawFpRec(r);
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
    // Bottom-side components are implicitly mirrored (the layer IS the mirror —
    // the client stores no explicit flip flag). The doc-space rule is R(θ)·M_y:
    // flip the footprint's Y first, then rotate by the stored angle. The
    // alternative M_y·R(θ) (flip after rotating — leafer `rotation = -θ`)
    // differs from it by R(2θ): identical at 0°/180°, off by 180° at 90°/270°.
    // Data proof (pad→track endpoints, this sample): under M_y·R(θ) not a single
    // 90°/270° bottom pad lands on its net's track end (USB1/USB2 0/12,
    // U22 0/8, D3 0/6, Q1 0/6 …), while R(θ)·M_y lands dead-on (0.0 mil) for
    // every one of them; 0°/180° parts (CN2, CARD1) agree under both. In leafer's
    // scale-then-rotate composition, scaleY=-1 + rotation=+θ is exactly R(θ)·M_y.
    const mirror = Number(d.layerId) === LAYER.BOTTOM;
    if (mirror) { g.scaleY = -1; g.rotation = ang(Number(d.angle ?? 0)); }
    // Per-layer mounting: footprint primitives route to the layer group of their
    // own layerId (silk frame → silk group, pads → copper group) so component
    // graphics stack with the doc's own per-layer content. Previously the whole
    // footprint hung inside the face copper group, letting a later component's
    // pads cover an earlier component's silk. `g` keeps the component transform
    // for bbox/objects but stays off-tree; wrappers replicate its transform.
    const wrappers = new Map<string, Group>();
    // footprint primitives are authored face-up in the footprint editor, so a
    // bottom component's pads/silk carry top-side layer ids (1/3) but must paint
    // on the component's own side — remap them onto the bottom copper/silk,
    // otherwise CARD1's pads render red on the top copper layer (#2). The same
    // face-up authoring applies to the other paired face layers: mask openings,
    // paste (钢网) shapes and assembly drawings ride 5/7/9 in the data and must
    // land on 6/8/10 for a bottom-side component (#paste-face)
    const faceRemap = mirror
      ? new Map([['1', '2'], ['3', '4'], ['5', '6'], ['7', '8'], ['9', '10']])
      : null;
    // remap the record data too so pad/shape fills take the bottom side's color
    const remapRecs = (recs: Rec[]) =>
      faceRemap ? recs.map((r) => {
        const lid = faceRemap.get(String(r.data.layerId));
        return lid ? { ...r, data: { ...r.data, layerId: Number(lid) } } : r;
      }) : recs;
    const targetFor = (lid: unknown): Group => {
      let key = lid != null ? String(lid) : String(d.layerId ?? LAYER.TOP);
      const mapped = faceRemap?.get(key);
      if (mapped) key = mapped;
      let w = wrappers.get(key);
      if (!w) {
        const lm = layerMeta.get(key);
        w = new Group({ name: `comp:${r.id}#${key}` });
        w.x = g.x; w.y = g.y; w.rotation = g.rotation; w.scaleX = g.scaleX; w.scaleY = g.scaleY;
        const alpha = BOTTOM_ALPHA[key];
        if (alpha !== undefined) w.opacity = alpha;
        api.layer(key, lm?.name, lm?.color ?? LAYER_FALLBACK[Number(key)] ?? '#888888', lm?.show ?? true).add(w);
        wrappers.set(key, w);
      }
      return w;
    };
    if (fp) drawFootprint(g, { ...fp, recs: remapRecs(fp.recs) }, targetFor, mirror ? 2 : 1, r.id);
    else {
      targetFor(d.layerId ?? LAYER.TOP).add(new Rect({ x: -12, y: -8, width: 24, height: 16, stroke: '#cc0000', strokeWidth: 1, dashPattern: [3, 3] }));
      if (fpUuid) api.reportDiagnostics.push(`未解析封装 ${fpUuid.slice(0, 10)} (line ${r.lineNo})`);
    }
    // designator / visible attrs: doc-scaled text at the record's own fontSize so
    // they zoom with the canvas. Each attr paints only when its own valueVisible
    // flag allows it — false hides it on the board exactly like the client
    // (this sample's PCB doc carries valueVisible:false on every placed
    // Designator, so none of them render — data-driven) (#attr-vis)
    for (const a of attrs) {
      const ad = a.data;
      if (isDocIdText(ad, r.id, allIds, netNames, padNumbers)) continue;
      const hasPos = typeof ad.x === 'number' && isFinite(ad.x);
      const wantsShow = ad.valueVisible !== false;
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
        node.add(new Line({ points: [x1, y1, x2, y2], stroke: colorForNet(d.netName, layerColor(d.layerId)), strokeWidth: widthOf(d, 6), strokeCap: 'round', hitStroke: 'all' }));
        // net name on the track copper (#net-labels): the client stamps a fixed
        // ~6.5mil label along the wire — width of the track is irrelevant, only
        // a track too SHORT to carry the text stays unlabeled. Top/bottom labels
        // hoist to the face's nn: overlay so later tracks never bury an earlier
        // one; INNER-layer labels ride the track's own layer group — they must
        // occlude with that layer (hidden under the top face until the inner
        // layer is activated, user report), which the hoisted overlays can't do.
        const net = d.netName != null ? String(d.netName) : '';
        const lk = layerIdOf(d);
        const ln = Number(lk);
        const innerCopper = ln >= 15 && ln <= 46; // SIGNAL 15..46 (inner faces)
        if (net && (lk === '1' || lk === '2' || innerCopper)) {
          // run length shrunk a step (NET_LEN_SHRINK) so labels keep a margin
          const f = fitNetFont(net, Math.hypot(x2 - x1, y2 - y1) * 0.9 * NET_LEN_SHRINK, NET_FONT_MAX);
          if (f != null) {
            let rot = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
            if (rot > 90 || rot < -90) rot += 180; // never read upside-down (vertical wires read bottom-up)
            const t = new Text({
              // same ink as the pad numbers / pad net names (user pref: 全部网络名颜色一致)
              text: net, fontSize: f, fill: PAD_INK,
              textAlign: 'center', verticalAlign: 'middle', autoSizeAlign: true, hittable: false, rotation: rot,
            } as any);
            t.x = (x1 + x2) / 2; t.y = (y1 + y2) / 2;
            if (innerCopper) node.add(t); // travels with the track's layer group
            else netNameLayer(lk === '2' ? 2 : 1).add(t);
          }
        }
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
        node.add(new Path({ path: arcD(x1, y1, x2, y2, Number(d.angle ?? 0)), stroke: colorForNet(d.netName, layerColor(d.layerId)), strokeWidth: widthOf(d, 6), strokeCap: 'round' }));
        addToLayer(d, r, node, `圆弧走线 ${r.id} ${d.netName ?? ''}`, 'track');
        return;
      }
      case 'PAD': {
        // page-level pads are in world coords — the hoisted hole group plugs
        // straight into the hole layer, the pad number into the face's overlay
        const padNet = d.padNet != null ? String(d.padNet) : d.netName != null ? String(d.netName) : undefined;
        const node = padNode(d, xf, layerColor, holeFill, {
          holeSink: (hg) => holeLayerGroup.add(hg),
          numSink: (t) => padNumLayer(faceOf(d.layerId)).add(t),
          netName: padNet,
          copperColor: padNet ? netColor.get(padNet) : undefined,
          netSink: (t) => netNameLayer(faceOf(d.layerId)).add(t),
          maskRule,
          maskSink: (face, mg) => maskLayer(face).add(mg),
          pasteRule,
          pasteSink: (face, pg) => pasteLayer(face).add(pg),
        });
        // through-hole pads stack with MULTI-Layer (see the footprint pad case)
        const thPage = Number(d.hole?.width ?? 0) > 0;
        addToLayer(thPage ? { ...d, layerId: LAYER.MULTI } : d, r, node, `焊盘 ${r.id} #${d.num ?? ''}`, 'pad');
        return;
      }
      case 'FILL': {
        const node = new Group();
        // 制造优化包边 (#pour-edge on FILL): a static fill / pour fill written
        // with manufacturing optimization wraps its border in a round-cap trace
        // (client default 0.2mm ≈ 8mil). The fill's `width` field carries that
        // trace width in mm (doc coords are mil — 0.2 would be invisible);
        // stroking the fill path straddles the border exactly like the client.
        const fw = Number(d.width) || 0;
        // width is millimetres (0.2mm ≈ 7.87mil ≈ the client's 8mil wrap); doc
        // coords are mil — 1mm = 39.37mil
        const edge = fw > 0 ? fw * 39.3701 : 0;
        const ink = colorForNet(d.netName, pourColor(d.layerId));
        for (const path of multiPathToSvg(d.path ?? [], xf, true)) {
          // fill and its round-cap edge wrap paint the SAME dimmed tone — the
          // client's manufacturing wrap reads as part of the fill, not a bright
          // outline; only unrouted pour borders stay dark (#pour-edge)
          node.add(new Path({
            path,
            fill: dimHex(ink, POUR_FILL_DIM),
            stroke: edge > 0 ? dimHex(ink, POUR_FILL_DIM) : undefined,
            strokeWidth: edge > 0 ? edge : undefined, strokeCap: 'round', strokeJoin: 'round',
          }));
        }
        // face-level static fills share the pour sub-groups:填充铜与铺铜同
        // 栈序(阻焊之下、走线/焊盘之下),阻焊扩展沿同样要盖过它
        const fn = Number(layerIdOf(d));
        if (fn === LAYER.TOP || fn === LAYER.BOTTOM) {
          if (fn === LAYER.BOTTOM && node.opacity === undefined) node.opacity = BOTTOM_ALPHA['2'];
          addToLayer(d, r, node, `填充 ${r.id}`, 'primitive', undefined,
            { key: fn === LAYER.TOP ? 'pour:1' : 'pour:2', name: fn === LAYER.TOP ? '顶层铺铜' : '底层铺铜' });
        } else {
          addToLayer(d, r, node, `填充 ${r.id}`);
        }
        return;
      }
      case 'VIA': {
        const cx = X(Number(d.centerX ?? 0), xf), cy = Y(Number(d.centerY ?? 0), xf);
        const vd = Number(d.viaDiameter ?? 20), hd = Number(d.holeDiameter ?? 12);
        const node = new Group();
        node.add(new Ellipse({ x: cx - vd / 2, y: cy - vd / 2, width: vd, height: vd, fill: colorForNet(d.netName, layerColor(LAYER.MULTI)) }));
        // the drill goes to the topmost hole layer like pad drills
        holeLayerGroup.add(new Ellipse({ x: cx - hd / 2, y: cy - hd / 2, width: hd, height: hd, fill: holeFill }));
        // solder-mask window per face: the via's own top/bottomSolderExpansion
        // (null → SOLDER rule). The -1000 sentinel = tented via (盖油), no window
        const viaOwn = (v: unknown): number | undefined =>
          v != null && Number.isFinite(Number(v)) ? Number(v) : undefined;
        const openings: [1 | 2, number | undefined][] = [
          [1, viaOwn(d.topSolderExpansion) ?? maskRule.viaTop],
          [2, viaOwn(d.bottomSolderExpansion) ?? maskRule.viaBot],
        ];
        for (const [face, e] of openings) {
          if (e == null || !isFinite(e) || e <= -900) continue;
          const md = vd + 2 * e;
          if (md <= 0) continue;
          maskLayer(face).add(new Ellipse({ x: cx - md / 2, y: cy - md / 2, width: md, height: md, fill: maskColor(face) }));
        }
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
        // (POURED carries id ["POURED", "<pourId>"], not its own layerId).
        // A POURED without a POUR is a stale re-pour cache — skipped (drawing it
        // raw would repaint whole-board regions, #pour-gaps) UNLESS it carries
        // 导线包边 strokes: the manufacturing-optimize trace-wrapping outline
        // survives only in such caches, and pouredLid then placed it on the
        // smallest live pour containing it (#pour-edge).
        const lid = pouredLid.get(d);
        if (lid === undefined) return;
        // the paired POUR's border-wrap gauge (pourType.fineness, already in
        // mil): fill entries stroke with it too — the file keeps fill entries
        // at strokeWidth 0, yet the client's 2D view still outlines the poured
        // copper with a bright wrap (#pour-edge)
        // pourFill paths are authored in 0.1× PCB doc units → scale coords by 10
        const node = new Group();
        for (const pf of (d.pourFill ?? [])) {
          // orphan edge-caches contribute just their 包边 strokes — their fill
          // is a stale re-pour leftover and must not repaint the board (#pour-gaps)
          if (edgeOnly.has(d) && pf.fill !== false) continue;
          // merge the item's subpolygons into ONE nonzero-filled Path: the fill
          // bakes its clearances in as hole subpolygons (opposite winding — e.g.
          // circles around other-net vias/pads), which only punch through when
          // all subpaths share a single path (#pour-gaps)
          const ds = multiPathToSvg(scalePourItems(pf.path), xf, true);
          if (!ds.length) continue;
          // 包边 entries are stroke-only (fill:false, strokeWidth>0): they
          // outline where the pour wraps the tracks. strokeWidth shares the
          // 0.1× doc unit of the path coords → scale it by 10 too (#pour-edge).
          // Fill entries carry no stroke of their own — they take the POUR's
          // wrap gauge; stroke and fill share the SAME dimmed tone — the
          // client's wrap reads as part of the fill, not a bright overlay
          const sw = (Number(pf.strokeWidth) || 0) * 10;
          // fineness gauge is already mil doc units — used as-is (no mm conversion)
          const ew = sw > 0 ? sw : (pouredWidth.get(d) ?? 0);
          const pourInk = colorForNet(d.netName, pourColor(lid));
          node.add(new Path({
            path: ds.join(' '),
            fill: pf.fill === false ? undefined : dimHex(pourInk, POUR_FILL_DIM),
            fillRule: 'nonzero',
            stroke: ew > 0 ? dimHex(pourInk, POUR_FILL_DIM) : undefined,
            strokeWidth: ew > 0 ? ew : undefined, strokeCap: 'round', strokeJoin: 'round',
          }));
        }
        // top/bottom pours paint in their own synthetic sub-group BETWEEN the
        // solder-mask windows and the face copper group (pcbStackKey 'pour:'):
        // the pad 阻焊扩展 rims (mask group) must read over the pour fill — a
        // face-level pour inside the copper group buried them (user report).
        // Tracks & pads sit in the copper group above, so they still cover the
        // rims' inner half. Color/show follow the pour's copper face.
        const pn = Number(lid);
        if (pn === LAYER.TOP || pn === LAYER.BOTTOM) {
          if (pn === LAYER.BOTTOM && node.opacity === undefined) node.opacity = BOTTOM_ALPHA['2'];
          addToLayer({ layerId: lid }, r, node, `铺铜 ${r.id} ${d.netName ?? ''}`, 'primitive', undefined,
            { key: pn === LAYER.TOP ? 'pour:1' : 'pour:2', name: pn === LAYER.TOP ? '顶层铺铜' : '底层铺铜' });
        } else {
          addToLayer({ layerId: lid }, r, node, `铺铜 ${r.id} ${d.netName ?? ''}`);
        }
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
        // exact glyph-ink box (#string-bbox) doubles as the bottom-mirror axis
        const exact = stringBBox(d, fontGlyphs, xf);
        const bb = exact ?? objBBox(r, xf) ?? undefined;
        addToLayer(d, r, bottomMirrorWrap(d, node, bb) ?? node,
          `文本 ${r.id} "${String(d.text ?? d.value ?? '').slice(0, 16)}"`, 'primitive', exact);
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
        // actual painted extent after normalization (= declared w×h when given)
        const bw = lw * sx, bh = lh * sy;
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
        // local content spans [0,bw]×[0,bh] on screen after the flip; the Group
        // rotates it about its origin and the rotated content AABB's top-left is
        // then pinned back onto the anchor — EasyEDA keeps the placed box's doc
        // top-left at (startX,startY) for any angle, so ±90° images sit right/
        // below the anchor instead of mirroring over to its other side
        // (#image-bbox)
        const rr = (-Number(d.angle ?? 0) * Math.PI) / 180;
        const cs = Math.cos(rr), sn = Math.sin(rr);
        const minXc = Math.min(0, bw * cs, bw * cs - bh * sn, -bh * sn);
        const minYc = Math.min(0, bw * sn, bw * sn + bh * cs, bh * cs);
        const node = new Group({ rotation: ang(Number(d.angle ?? 0)) });
        const [px, py] = P(Number(d.startX ?? 0), Number(d.startY ?? 0), xf);
        node.x = px - minXc;
        node.y = py - minYc;
        // the mapping produced y-up doc offsets relative to the anchor — the
        // flip transform turns them into screen coords (body hanging below it)
        const ds = multiPathToSvg(mapped, { ox: 0, oy: 0, flip: true }, true);
        if (ds.length) node.add(new Path({ path: ds.join(' '), fill: layerColor(d.layerId), fillRule: 'nonzero' }));
        // rotated anchor box (#image-bbox) doubles as the bottom-mirror axis
        const bb = objBBox(r, xf) ?? undefined;
        addToLayer(d, r, bottomMirrorWrap(d, node, bb) ?? node, `图形 ${r.id}`, 'primitive', bb);
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
    const la = Number(pouredLid.get(a.data) ?? 0);
    const lb = Number(pouredLid.get(b.data) ?? 0);
    return lb - la; // higher layer number (bottom=2) drawn earlier
  });
  for (const r of pours) drawPrim(r);
  // pads paint above same-layer tracks/fills/pours (#pad-top): all copper
  // routing & fills first, then components (whose pads join the same layer
  // groups through their wrappers), then page-level pads — within each layer
  // group, so the inter-layer stacking order is untouched
  for (const r of all) {
    if (r.type === 'POURED' || r.type === 'COMPONENT' || r.type === 'PAD') continue;
    drawPrim(r);
  }
  for (const r of all) if (r.type === 'COMPONENT') drawPrim(r);
  for (const r of all) if (r.type === 'PAD') drawPrim(r);
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
    // net per placed pad comes from the shared PAD_NET index (see renderPcb head)
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
  // bottom-side components carry a local Y flip with negated rotation (see drawComponent)
  const flipY = Number(g.scaleY) === -1;
  const rad = (Number(g.rotation) || 0) * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const world = local.map(([x, y]) => {
    if (flipY) y = -y;
    return [cx + x * c - y * s, cy + x * s + y * c] as [number, number];
  });
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
