/** Core shared types — format-agnostic intermediate model (see PRD §6.2). */

/** One parsed line record: {outer}||{data} */
export interface Rec {
  type: string;
  /** stringified outer id (may be flattened like "LAYER,1") */
  id: string;
  /** raw outer id: string | number | [string, number] etc. */
  idVal: unknown;
  ticket: number;
  data: Record<string, any>;
  lineNo: number;
  raw: string;
}

export interface CanvasInfo {
  originX: number;
  originY: number;
  /** "up" = the doc uses the newer Y-up convention (client ≥3.2.91 migration):
   *  every record Y and originY is negated vs the classic Y-down sheets */
  yAxisDirection?: string;
  unit?: string;
  gridXSize?: number;
  gridYSize?: number;
}

export interface MetaInfo {
  title?: string;
  description?: string;
  tags?: string[];
  /** SCH_PAGE: parent schematic uuid; PCB: parent board uuid */
  schematic?: string;
  simSchematic?: string;
  board?: string;
  parent?: string;
  zIndex?: number;
  source?: string;
  docType?: number;
  [k: string]: any;
}

/** A document inside a multi-document record stream (separated by DOCHEAD lines). */
export interface DocSegment {
  uuid: string;
  docType: string;
  startLine: number;
  canvas: CanvasInfo | null;
  meta: MetaInfo | null;
  recs: Rec[];
  /** a DELETE_DOC record in the stream tombstoned this document (deleted in EDA) */
  deleted?: boolean;
}

export interface ParseReport {
  /** lines that failed to parse (per opened file) */
  badLines: { lineNo: number; text: string }[];
  /** unknown record types encountered while rendering */
  unknownTypes: string[];
  /** count of ELE_PLACEHOLDER records (heavy geometry omitted by exporter) */
  placeholders: number;
}

export function emptyReport(): ParseReport {
  return { badLines: [], unknownTypes: [], placeholders: 0 };
}

export type NodeKind =
  | 'board' | 'schematic' | 'sheet'
  | 'pcb' | 'panel'
  | 'simGroup' | 'simPage'
  | 'libGroup' | 'lib';

/** Renderable document types. */
export const RENDERABLE = new Set([
  'SCH_PAGE', 'PCB', 'PANEL', 'SYMBOL', 'FOOTPRINT',
  'SIMULATION', 'SIMULATION_SCH', 'SCH',
]);

export interface TreeNode {
  id: string;
  kind: NodeKind;
  title: string;
  docType?: string;
  /** segment uuid inside file */
  uuid?: string;
  /** key into ProjectModel.files */
  fileKey?: string;
  children?: TreeNode[];
}

export interface ProjectModel {
  name: string;
  format: 'eprj3' | 'epro2' | 'single-doc';
  /** path -> raw bytes of each source file (parsed lazily per file) */
  files: Map<string, Uint8Array>;
  tree: TreeNode[];
  /** flat lookup of openable nodes */
  openables: Map<string, TreeNode>;
  meta: Record<string, any>;
}

/** A doc opened for rendering: its segment plus all embedded lib segments of the same file. */
export interface OpenedDoc {
  self: DocSegment;
  /** uuid -> embedded segment (SYMBOL/DEVICE/FOOTPRINT...) anywhere in the file */
  libs: Map<string, DocSegment>;
  /** BLOB record contents (base64 data URLs) keyed by record id */
  blobs: Map<string, string>;
  fileKey: string;
  node: TreeNode;
  /** combined bbox in screen units (already Y-flipped) */
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  report: ParseReport;
}
