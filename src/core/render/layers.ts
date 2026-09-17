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

/** numeric-id stacking fallback ([side, type]) for layers created without a file
 *  layerType (missing LAYER record): side 0 top · 1 inner · 2 bottom · 3 multi · 4 other */
const NUM_STACK: Record<number, [number, number]> = {
  1: [0, 0], 2: [2, 0], 3: [0, 2], 4: [2, 2], 5: [0, 1], 6: [2, 1], 7: [0, 3], 8: [2, 3],
  9: [4, 4], 10: [4, 4], 12: [3, 0], 13: [4, 4], 19: [4, 4], 56: [4, 4],
};
for (let i = 14; i <= 46; i++) NUM_STACK[i] = [1, 0];

/** PCB stacking key — lower paints first / lower in the stack: board outline <
 *  top face < inner faces < bottom face < multi/all < annotation layers <
 *  origin-axes & ratsnest tools < drill holes (topmost, so copper never covers
 *  a hole). Within a face copper(0) → solder mask(1) → silk(2) → paste(3),
 *  mirroring the reference viewer's side*10+type sort; equal keys keep
 *  creation order (stable sort). */
function pcbStackKey(l: RenderLayer): number {
  if (l.id === 'panel') return -100;
  if (l.id === 'axes') return 9000;
  if (l.id === 'rats') return 9100;
  const t = String(l.type ?? '').toUpperCase();
  const n = Number(l.id);
  if (t === 'OUTLINE' || (!t && n === 11)) return 0;
  if (t === 'HOLE' || t === 'DRILL' || t === 'DRILL_DRAWING' || (!t && n === 47)) return 9999;
  let side: number, type: number;
  if (t) {
    // layerType is a compound token (TOP / TOP_SILK / BOT_SOLDER_MASK / SIGNAL /
    // MULTI / OUTLINE …) — match the face by prefix, the kind by infix/suffix
    side = t.startsWith('TOP') ? 0
      : t === 'SIGNAL' || t === 'PLANE' || t.startsWith('INNER') ? 1
      : t.startsWith('BOTTOM') ? 2 : t.startsWith('MULTI') ? 3 : 4;
    type = t.endsWith('SILK') ? 2 : t.includes('SOLDER_MASK') ? 1 : t.includes('PASTE') ? 3
      : t === 'TOP' || t === 'BOTTOM' || t === 'SIGNAL' || t === 'PLANE' || t.startsWith('MULTI') ? 0 : 4;
  } else {
    const e = NUM_STACK[n];
    side = e?.[0] ?? 4;
    type = e?.[1] ?? 4;
  }
  return 100 + side * 10 + type;
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
    // stack like the reference gerber viewer: leafer paints later-added children
    // on top, so re-adding the layer groups in sorted order re-stacks them —
    // outline bottommost, faces copper→mask→silk→paste (top/inner/bottom/multi),
    // annotations, axes & ratsnest tools, drill holes on top. The sorted order is
    // also what the layer panel lists, so the UI matches the real stacking.
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
