/**
 * Render orchestrator: builds a Leafer Group tree for an opened doc,
 * collecting a flat object list (for the object tree / properties panel)
 * and layer groups (for the layer panel toggles).
 */
import { Group, Line, Text } from 'leafer-ui';
import type { OpenedDoc, Rec, DocSegment, ParseReport } from '../types';
import { renderSch } from './sch';
import { renderPcb } from './pcb';

export interface BBoxLike { minX: number; minY: number; maxX: number; maxY: number }

export interface RenderObject {
  id: string;
  rec: Rec;
  node: Group;
  label: string;
  kind: 'component' | 'primitive' | 'pad' | 'track';
  title?: string;
  /** world-space bbox (screen coords, origin-flipped) for custom hit-test & locate */
  bbox?: BBoxLike;
  /**
   * precise pick: world point + tolerance (world units). Used for stroke-only
   * primitives so clicking inside an unfilled rect outline does NOT select it.
   */
  hit?(wx: number, wy: number, tol: number): boolean;
}

export interface RenderLayer {
  id: string;
  name: string;
  color: string;
  show: boolean;
  /** file layerType (TOP / SIGNAL / BOTTOM_SILK / OUTLINE / HOLE …) that drives the PCB stack order */
  type?: string;
  group: Group;
  count: number;
}

export interface RenderApi {
  /** add a leafer group that represents the whole doc page */
  addGroup(seg: DocSegment, group: Group): void;
  /** register an object for tree/properties */
  addObject(o: RenderObject): void;
  /** layer registry for PCB-style docs */
  layer(id: number | string, name?: string, color?: string, show?: boolean, type?: string): Group;
  /** fill color that tracks the canvas background (drill holes etc.) */
  bgColor: string;
  /** register a label that must stay the same pixel size at any zoom */
  addConstantText(node: Text, basePx: number): void;
  /** register a stroke whose width must stay the same pixels at any zoom (origin axes) */
  addConstantStroke(node: Line, baseW: number): void;
  reportDiagnostics: string[];
}

export interface RenderResult {
  root: Group;
  objects: RenderObject[];
  layers: RenderLayer[];
  report: ParseReport;
  /** human-readable warnings collected during rendering */
  diagnostics: string[];
  /** node -> object reverse index for hit resolution */
  nodeIndex: Map<object, RenderObject>;
  /** labels that must stay a fixed pixel size (rescale fontSize with camera) */
  constantTexts: { node: Text; basePx: number }[];
  /** strokes that must keep a fixed pixel width (rescale strokeWidth with camera) */
  constantStrokes: { node: Line; baseW: number }[];
}

/** numeric-id stacking fallback (paint key) for layers created without a file
 *  layerType (missing LAYER record) — same table the type-driven branch maps to */
const NUM_STACK: Record<number, number> = {
  1: 430, 2: 130, 3: 460, 4: 160, 5: 420, 6: 120, 7: 410, 8: 110, 9: 400, 10: 100,
  11: 8000, 12: 470, 13: 0, 14: 0, 47: 9900,
};
for (let i = 15; i <= 46; i++) NUM_STACK[i] = 200 + (46 - i); // inner1(15)=231 … inner32(46)=200

/** PCB stacking key — ascending key paints first / sits lower in the stack,
 *  matching the client's 2D view (bottom → top):
 *  annotation layers (mech / document / custom / pin / component / 3D …) <
 *  bottom face (assembly → paste → mask → copper → net names → pad numbers →
 *  silk) < inner faces (inner32 … inner1) < top face (same order as bottom) <
 *  multi-layer (through-hole copper stays visible over both faces) <
 *  board outline < origin-axes & ratsnest tools < drill holes (topmost, so
 *  copper never covers a hole). Equal keys keep creation order (stable sort). */
export function pcbStackKey(l: RenderLayer): number {
  if (l.id === 'panel') return -100;
  if (l.id === 'axes') return 9000;
  if (l.id === 'rats') return 9100;
  // synthetic per-face label overlays (see renderPcb's padNumLayer)
  if (l.id.startsWith('pn:')) return l.id.endsWith(':2') ? 150 : 450;
  if (l.id.startsWith('nn:')) return l.id.endsWith(':2') ? 140 : 440;
  const t = String(l.type ?? '').toUpperCase();
  const n = Number(l.id);
  if (t === 'HOLE' || t === 'DRILL' || (!t && n === 47)) return 9900;
  if (t === 'OUTLINE' || (!t && n === 11)) return 8000;
  if (t === 'MULTI' || (!t && n === 12)) return 470;
  if (t) {
    // stiffener films are documentation-like overlays, not a copper face
    if (t.includes('STIFFENER')) return 0;
    const kind = t.endsWith('ASSEMBLY') ? 0 : t.includes('PASTE') ? 10
      : t.includes('SOLDER_MASK') ? 20 : t.endsWith('SILK') ? 60 : 30;
    if (t.startsWith('TOP')) return 400 + kind;
    if (t.startsWith('BOTTOM') || t.startsWith('BOT_')) return 100 + kind;
    if (t === 'SIGNAL' || t === 'PLANE' || t.startsWith('INNER')) {
      // inner1 paints above inner2 … inner32 sits just above the bottom face
      return n >= 15 && n <= 46 ? 200 + (46 - n) : 200;
    }
    return 0; // document / mechanical / custom / pin / component / 3D / other …
  }
  return NUM_STACK[n] ?? 0;
}

export function renderDoc(opened: OpenedDoc, bgColor = '#000000'): RenderResult {
  const root = new Group({ name: `doc:${opened.self.uuid}` });
  const objects: RenderObject[] = [];
  const layers = new Map<string, RenderLayer>();
  const reportDiagnostics: string[] = [];
  const nodeIndex = new Map<object, RenderObject>();
  const constantTexts: { node: Text; basePx: number }[] = [];
  const constantStrokes: { node: Line; baseW: number }[] = [];

  const api: RenderApi = {
    addGroup(_seg, group) {
      root.add(group);
    },
    addObject(o) {
      objects.push(o);
      indexTree(o.node, o, nodeIndex);
    },
    layer(id, name, color, show, type) {
      const key = String(id);
      let l = layers.get(key);
      if (!l) {
        const g = new Group({ name: `layer:${key}` });
        l = { id: key, name: name ?? `Layer ${key}`, color: color ?? '#888888', show: true, type, group: g, count: 0 };
        layers.set(key, l);
        root.add(g);
      }
      if (name) l.name = name;
      if (color) l.color = color;
      if (show === false) l.show = false;
      if (type) l.type = type;
      l.count++;
      return l.group;
    },
    bgColor,
    addConstantText(node, basePx) {
      constantTexts.push({ node, basePx });
    },
    addConstantStroke(node, baseW) {
      constantStrokes.push({ node, baseW });
    },
    reportDiagnostics,
  };

  const dt = opened.self.docType;
  let list: RenderLayer[];
  if (dt === 'PCB' || dt === 'PANEL' || dt === 'FOOTPRINT') {
    renderPcb(opened, api);
    // stack like the client's 2D view: leafer paints later-added children
    // on top, so re-adding the layer groups in sorted order re-stacks them —
    // annotations bottommost, bottom face, inner faces, top face (silk on top
    // of each face), multi-layer, board outline, axes & ratsnest tools, drill
    // holes topmost (see pcbStackKey). The sorted order is also what the layer
    // panel lists, so the UI matches the real stacking.
    list = [...layers.values()];
    const created = new Map(list.map((l, i) => [l, i] as const));
    list.sort((a, b) => pcbStackKey(a) - pcbStackKey(b) || created.get(a)! - created.get(b)!);
    for (const l of list) root.add(l.group);
  } else {
    renderSch(opened, api); // SCH_PAGE / SIMULATION / SYMBOL standalone
    list = [...layers.values()];
  }
  for (const l of list) {
    l.group.visible = l.show;
    l.count = l.group.children?.length ?? l.count;
  }
  return { root, objects, layers: list, report: opened.report, diagnostics: reportDiagnostics, nodeIndex, constantTexts, constantStrokes };
}

/** map every descendant leafer node to its owning object (hit resolution) */
function indexTree(node: object, obj: RenderObject, idx: Map<object, RenderObject>): void {
  idx.set(node, obj);
  const g = node as Group;
  for (const c of g.children ?? []) indexTree(c as object, obj, idx);
}
