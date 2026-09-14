/** Single-document adapter: a bare .esch2/.epcb2/.epan2/.epru/.elib2 file. */
import type { ProjectModel, TreeNode } from '../types';
import { getSegments } from './records';
import { buildTreeFromSegments } from './epro2';

export const RECORD_FILE_RE = /\.(esch2|epcb2|epan2|elib2|epru|esym2|efp2)$/i;

export function isSingleDoc(files: Map<string, Uint8Array>): boolean {
  return [...files.keys()].some((p) => RECORD_FILE_RE.test(p));
}

export function buildSingle(files: Map<string, Uint8Array>): ProjectModel {
  const path = [...files.keys()].find((p) => RECORD_FILE_RE.test(p))!;
  const segs = getSegments(path, files.get(path)!);
  const tree = buildTreeFromSegments(path, segs);
  const model: ProjectModel = {
    name: path.replace(/^.*\//, ''),
    format: 'single-doc',
    files,
    tree,
    openables: new Map(),
    meta: {},
  };
  return model;
}
