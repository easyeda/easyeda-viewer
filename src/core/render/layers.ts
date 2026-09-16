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
  group: Group;
  count: number;
}

export interface RenderApi {
  /** add a leafer group that represents the whole doc page */
  addGroup(seg: DocSegment, group: Group): void;
  /** register an object for tree/properties */
  addObject(o: RenderObject): void;
  /** layer registry for PCB-style docs */
  layer(id: number | string, name?: string, color?: string, show?: boolean): Group;
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
    layer(id, name, color, show) {
      const key = String(id);
      let l = layers.get(key);
      if (!l) {
        const g = new Group({ name: `layer:${key}` });
        l = { id: key, name: name ?? `Layer ${key}`, color: color ?? '#888888', show: true, group: g, count: 0 };
        layers.set(key, l);
        root.add(g);
      }
      if (name) l.name = name;
      if (color) l.color = color;
      if (show === false) l.show = false;
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
  if (dt === 'PCB' || dt === 'PANEL' || dt === 'FOOTPRINT') {
    renderPcb(opened, api);
    // layer groups were created in file order (Top first = drawn bottommost);
    // re-add in real copper stacking order: board/keep-out … bottom group …
    // inner … top paste (user pref: under the top copper) … top group …
    // silk/mask on top … outline/doc … origin axes … drill/slot holes on top
    // (user pref: drills punch through everything, incl. pads on the top copper)
    const Z_ORDER = ['panel', '2', '6', '4', '8', '10', '14', '15', '16', '17', '18', '7', '1', '5', '9', '12', '3', '19', '11', '13', '0', 'axes', '47'];
    for (const id of Z_ORDER) { const l = layers.get(id); if (l) root.add(l.group); }
  } else renderSch(opened, api); // SCH_PAGE / SIMULATION / SYMBOL standalone

  const list = [...layers.values()];
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
