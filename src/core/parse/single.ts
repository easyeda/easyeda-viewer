/** Single-document adapter: a bare .esch2/.epcb2/.epan2/.epru/.elibu file. */
import type { ProjectModel, TreeNode } from '../types';
import { getSegments } from './records';
import { buildTreeFromSegments } from './epro2';
import { readZip } from './zip';

export const RECORD_FILE_RE = /\.(esch2|epcb2|epan2|elib2|elibu|epru|esym2|efp2)$/i;

/** `.elibz2`: ZIP-packaged EasyEDA Pro library (one `.elibu` record stream + metadata JSON). */
export const LIBRARY_ARCHIVE_RE = /\.elibz2$/i;

export function isSingleDoc(files: Map<string, Uint8Array>): boolean {
  return [...files.keys()].some((p) => RECORD_FILE_RE.test(p));
}

function displayName(path: string): string {
  return path.replace(/^.*[/\\]/, '').replace(/\.elibz2$/i, '').replace(RECORD_FILE_RE, '');
}

export function buildSingle(files: Map<string, Uint8Array>): ProjectModel {
  const path = [...files.keys()].find((p) => RECORD_FILE_RE.test(p))!;
  const segs = getSegments(path, files.get(path)!);
  const tree = buildTreeFromSegments(path, segs);
  const model: ProjectModel = {
    name: displayName(path),
    format: 'single-doc',
    files,
    tree,
    openables: new Map(),
    meta: {},
  };
  return model;
}

/**
 * Build a library model from a packaged `.elibz2` archive. The archive holds a
 * single `.elibu` record stream (symbols / footprints / devices) plus
 * `device2.json` / `footprint2.json` metadata; only the record stream is needed
 * for preview.
 */
export function buildElibz2(archivePath: string, bytes: Uint8Array): ProjectModel {
  const entries = readZip(bytes);
  const lib = entries.find((e) => /\.elibu$/i.test(e.name));
  if (!lib) throw new Error('`.elibz2` 中未找到 `.elibu` 库文件（文件可能已损坏）');
  const files = new Map(entries.map((e) => [e.name, e.data]));
  const segs = getSegments(lib.name, lib.data);
  const tree = buildTreeFromSegments(lib.name, segs);
  return {
    name: displayName(archivePath),
    format: 'elibz2',
    files,
    tree,
    openables: new Map(),
    meta: { libraryEntries: entries.length },
  };
}
