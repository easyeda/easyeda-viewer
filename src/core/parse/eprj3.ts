/** eprj3 folder-project adapter: index JSON + sch/pcb/panel source files. */
import type { ProjectModel, TreeNode } from '../types';
import { scanDocHeads } from './records';

/** entry point: files map that contains a `<name>.eprj3` index file */
export function isEprj3(files: Map<string, Uint8Array>): boolean {
  for (const p of files.keys()) if (p.toLowerCase().endsWith('.eprj3')) return true;
  return false;
}

const dec = new TextDecoder('utf-8');
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/** index JSON may itself be saved as UTF-8 or GBK on Chinese Windows */
export function decodeTextSafe(bytes: Uint8Array): string {
  try {
    return utf8Strict.decode(bytes);
  } catch {
    try {
      return new TextDecoder('gbk').decode(bytes);
    } catch {
      return dec.decode(bytes);
    }
  }
}

interface IndexProfile {
  boards?: Record<string, { uuid: string; title: string }>;
  schematics?: Record<string, { uuid: string; name: string; board?: string }>;
  sheets?: Record<string, { uuid: string; title: string; schematic_uuid: string; zIndex?: number }>;
  pcbs?: Record<string, { uuid: string; title: string; board?: string }>;
  panels?: Record<string, { uuid: string; title: string }>;
  simSchematics?: Record<string, { uuid: string; title: string }>;
  simulations?: Record<string, { uuid: string; title: string; simSchematic?: string }>;
}

/** fast uuid lookup per file without a full parse */
function fileUuids(files: Map<string, Uint8Array>, path: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const h of scanDocHeads(files.get(path)!)) m.set(h.uuid, h.docType);
  return m;
}

export function buildEprj3(
  files: Map<string, Uint8Array>,
  rootHint?: string,
): ProjectModel {
  let indexPath = '';
  for (const p of files.keys()) if (p.toLowerCase().endsWith('.eprj3')) { indexPath = p; break; }
  const idx = JSON.parse(decodeTextSafe(files.get(indexPath)!));
  const profile: IndexProfile = idx.profile ?? {};
  const name = idx.name || (rootHint ?? indexPath.replace(/\.eprj3$/i, '').split('/').pop()) || 'Project';

  // --- associate every .esch2/.epcb2/.epan2 file by DOCHEAD uuid ---
  const docFiles = [...files.keys()].filter((p) => /\.(esch2|epcb2|epan2|elib2)$/i.test(p));
  const uuidToPath = new Map<string, string>();
  for (const p of docFiles) {
    for (const [u] of fileUuids(files, p)) uuidToPath.set(u, p);
  }

  let counter = 0;
  const nid = (k: string) => `${k}${++counter}`;
  const openables = new Map<string, TreeNode>();
  const node = (kind: TreeNode['kind'], title: string, uuid?: string): TreeNode => {
    const path = uuid ? uuidToPath.get(uuid) : undefined;
    const n: TreeNode = {
      id: nid(kind), kind, title, uuid,
      fileKey: path,
      docType: path && uuid ? fileDocType(path, uuid) : undefined,
    };
    if (uuid && !path) n.children = []; // placeholder: missing file
    if (path) openables.set(n.id, n);
    return n;
  };
  const fileDocTypeCache = new Map<string, Map<string, string>>();
  function fileDocType(path: string, uuid: string): string | undefined {
    let m = fileDocTypeCache.get(path);
    if (!m) { m = fileUuids(files, path); fileDocTypeCache.set(path, m); }
    return m.get(uuid);
  }

  const tree: TreeNode[] = [];
  const schematicByUuid = new Map<string, TreeNode>();

  // boards → schematics → sheets
  const boards = Object.values(profile.boards ?? {});
  const schematics = Object.values(profile.schematics ?? {});
  const sheets = Object.values(profile.sheets ?? {});
  const orphanSchematics: TreeNode[] = [];
  for (const sch of schematics) {
    const group: TreeNode = { id: nid('sch'), kind: 'schematic', title: sch.name || sch.uuid, children: [] };
    for (const sh of sheets.filter((s) => s.schematic_uuid === sch.uuid).sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0))) {
      group.children!.push(node('sheet', sh.title || sh.uuid, sh.uuid));
    }
    schematicByUuid.set(sch.uuid, group);
    const board = sch.board ? boards.find((b) => b.uuid === sch.board) : undefined;
    if (board) continue; // attached below
    orphanSchematics.push(group);
  }
  const boardNodeByUuid = new Map<string, TreeNode>();
  for (const b of boards) {
    const bn: TreeNode = { id: nid('board'), kind: 'board', title: b.title || b.uuid, children: [] };
    for (const sch of schematics) if (sch.board === b.uuid) bn.children!.push(schematicByUuid.get(sch.uuid)!);
    boardNodeByUuid.set(b.uuid, bn);
    tree.push(bn);
  }
  tree.push(...orphanSchematics);

  // pcbs — group under their board when known, else top-level
  for (const p of Object.values(profile.pcbs ?? {})) {
    const n = node('pcb', p.title || p.uuid, p.uuid);
    const holder = p.board ? boardNodeByUuid.get(p.board) : undefined;
    if (holder) (holder.children ??= []).push(n);
    else tree.push(n);
  }
  // panels
  for (const p of Object.values(profile.panels ?? {})) tree.push(node('panel', p.title || p.uuid, p.uuid));
  // simulation
  const simSch = Object.values(profile.simSchematics ?? {});
  const sims = Object.values(profile.simulations ?? {});
  if (simSch.length || sims.length) {
    const root: TreeNode = { id: nid('simg'), kind: 'simGroup', title: 'Simulation', children: [] };
    for (const s of simSch) {
      const g: TreeNode = { id: nid('sim'), kind: 'simGroup', title: s.title || s.uuid, children: [] };
      for (const sim of sims.filter((x) => x.simSchematic === s.uuid)) {
        g.children!.push(node('simPage', sim.title || sim.uuid, sim.uuid));
      }
      root.children!.push(g);
    }
    for (const sim of sims.filter((x) => !x.simSchematic || !simSch.some((s) => s.uuid === x.simSchematic))) {
      root.children!.push(node('simPage', sim.title || sim.uuid, sim.uuid));
    }
    if (root.children!.length) tree.push(root);
  }

  const reportMeta: Record<string, any> = {
    ticket: idx.ticket,
    defaultSheet: idx.config?.defaultSheet ?? idx.default_sheet,
    boardCount: boards.length,
    pcbCount: Object.keys(profile.pcbs ?? {}).length,
  };
  return { name, format: 'eprj3', files, tree, openables, meta: reportMeta };
}
