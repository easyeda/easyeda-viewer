/**
 * epro2 adapter. Container = ZIP with:
 *  - project2.json : {title, editorVersion, introduction}
 *  - <name>.epru   : WHOLE project as one concatenated multi-doc record stream
 *  - IMAGE/<id>.webp : BLOB images
 * epru has no structural index — the tree is rebuilt by scanning DOCHEAD + META.
 */
import type { ProjectModel, TreeNode, DocSegment } from '../types';
import { RENDERABLE } from '../types';
import { getSegments } from './records';
import { decodeTextSafe } from './eprj3';

export function isEpro2(files: Map<string, Uint8Array>): boolean {
  for (const p of files.keys()) {
    if (/\.epru$/i.test(p) || /(^|\/)project2\.json$/i.test(p)) return true;
  }
  return false;
}

export function buildEpro2(files: Map<string, Uint8Array>, sourceName?: string): ProjectModel {
  let projectName = sourceName?.replace(/\.epro2$/i, '') ?? 'Project';
  if (sourceName) projectName = sourceName.replace(/^.*\//, '').replace(/\.epro2$/i, '');
  let pj: Record<string, any> = {};
  let epruPath = '';
  for (const [p, bytes] of files) {
    if (/(^|\/)project2\.json$/i.test(p)) {
      try { pj = JSON.parse(decodeTextSafe(bytes)); } catch { /* keep default */ }
    } else if (/\.epru$/i.test(p)) {
      epruPath = p;
      const base = p.replace(/^.*\//, '').replace(/\.epru$/i, '');
      if (base) projectName = base;
    }
  }
  if (pj.title) projectName = String(pj.title);
  if (!epruPath) throw new Error('epro2: no .epru stream file found');

  const segs = getSegments(epruPath, files.get(epruPath)!);
  return {
    name: projectName,
    format: 'epro2',
    files,
    tree: buildTreeFromSegments(epruPath, segs),
    openables: new Map(),
    meta: { editorVersion: pj.editorVersion, introduction: pj.introduction },
  };
}

/** shared with single-doc adapter */
export function buildTreeFromSegments(fileKey: string, segs: DocSegment[]): TreeNode[] {
  let c = 0;
  const nid = (k: string) => `${k}${++c}`;
  const mk = (kind: TreeNode['kind'], title: string, s: DocSegment): TreeNode => ({
    id: nid(kind), kind, title, docType: s.docType, uuid: s.uuid, fileKey,
  });
  const titleOf = (s: DocSegment) => (s.meta?.title as string) || s.docType + ' ' + s.uuid.slice(0, 8);

  // DELETE_DOC tombstones: segments deleted in the EDA client must not appear in the tree
  const live = segs.filter((s) => !s.deleted);
  const boards = live.filter((s) => s.docType === 'BOARD');
  const schs = live.filter((s) => s.docType === 'SCH');
  const pages = live.filter((s) => s.docType === 'SCH_PAGE');
  const pcbs = live.filter((s) => s.docType === 'PCB');
  const panels = live.filter((s) => s.docType === 'PANEL');
  const simSch = live.filter((s) => s.docType === 'SIMULATION_SCH');
  const simPages = live.filter((s) => s.docType === 'SIMULATION');
  const libs = live.filter((s) => ['SYMBOL', 'DEVICE', 'FOOTPRINT'].includes(s.docType));

  const tree: TreeNode[] = [];
  const boardNode = new Map<string, TreeNode>();
  for (const b of boards) {
    const bn: TreeNode = { id: nid('board'), kind: 'board', title: titleOf(b), children: [] };
    boardNode.set(b.uuid, bn);
  }
  const schNode = new Map<string, TreeNode>();
  for (const sch of schs) {
    const sn: TreeNode = { id: nid('sch'), kind: 'schematic', title: titleOf(sch), children: [] };
    schNode.set(sch.uuid, sn);
    const holder = sch.meta?.board ? boardNode.get(String(sch.meta.board)) : undefined;
    if (holder) holder.children!.push(sn);
    else tree.push(sn);
  }
  for (const pg of pages) {
    const holder = pg.meta?.schematic ? schNode.get(String(pg.meta.schematic)) : undefined;
    const n = mk('sheet', titleOf(pg), pg);
    if (holder) holder.children!.push(n);
    else tree.push(n);
  }
  for (const pcb of pcbs) {
    const holder = pcb.meta?.board ? boardNode.get(String(pcb.meta.board)) : undefined;
    const n = mk('pcb', titleOf(pcb), pcb);
    if (holder) (holder.children ??= []).push(n);
    else tree.push(n);
  }
  for (const p of panels) tree.push(mk('panel', titleOf(p), p));
  const simRoot: TreeNode = { id: nid('simg'), kind: 'simGroup', title: 'Simulation', children: [] };
  for (const ss of simSch) {
    const g: TreeNode = { id: nid('sim'), kind: 'simGroup', title: titleOf(ss), children: [] };
    for (const sp of simPages.filter((x) => x.meta?.simSchematic === ss.uuid)) {
      g.children!.push(mk('simPage', titleOf(sp), sp));
    }
    simRoot.children!.push(g);
  }
  for (const sp of simPages.filter((x) => !x.meta?.simSchematic || !simSch.some((s) => s.uuid === x.meta!.simSchematic))) {
    simRoot.children!.push(mk('simPage', titleOf(sp), sp));
  }
  if (simRoot.children!.length) tree.push(simRoot);
  if (libs.length) {
    const g: TreeNode = { id: nid('libg'), kind: 'libGroup', title: 'Library', children: [] };
    // three collapsible sub-groups: symbols / footprints / devices (#lib-12)
    const sub = [
      { title: '符号', docTypes: ['SYMBOL'] },
      { title: '封装', docTypes: ['FOOTPRINT'] },
      { title: '器件', docTypes: ['DEVICE'] },
    ];
    for (const s of sub) {
      const members = libs.filter((l) => s.docTypes.includes(String(l.docType)));
      if (!members.length) continue;
      // library entries sort naturally by title ("L0603" < "L1206" < "SOD-323…" ← #lib-1)
      members.sort((a, b) => titleOf(a).localeCompare(titleOf(b), undefined, { numeric: true, sensitivity: 'base' }));
      const sg: TreeNode = { id: nid('libg'), kind: 'libGroup', title: s.title, children: [] };
      for (const l of members) sg.children!.push(mk('lib', titleOf(l), l));
      g.children!.push(sg);
    }
    tree.push(g);
  }
  for (const bn of boardNode.values()) if (bn.children?.length) tree.unshift(bn);
  void RENDERABLE;
  return tree;
}
