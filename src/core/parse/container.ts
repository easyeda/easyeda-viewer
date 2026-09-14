/**
 * Container probe: given a flat path→bytes map (from drop / file picker / zip),
 * detect the format and build a ProjectModel. See PRD §6.2.
 */
import type { ProjectModel } from '../types';
import { collectOpenables } from '../model';
import { isZip, zipToFileMap } from './zip';
import { isEprj3, buildEprj3 } from './eprj3';
import { isEpro2, buildEpro2 } from './epro2';
import { isSingleDoc, buildSingle, RECORD_FILE_RE } from './single';

export interface LoadInput {
  /** browser File objects with optional webkitRelativePath */
  files: File[];
  /** already-read name→bytes (API use) */
  data?: Map<string, Uint8Array>;
}

export async function filesToMap(files: File[]): Promise<Map<string, Uint8Array>> {
  const m = new Map<string, Uint8Array>();
  for (const f of files) {
    const path = ((f as any).webkitRelativePath || f.name).replace(/\\/g, '/');
    m.set(path, new Uint8Array(await f.arrayBuffer()));
  }
  return m;
}

/** flatten zips into the file map (zipped eprj3 folders / epro2 stay intact for probe) */
export function expandZips(map: Map<string, Uint8Array>): Map<string, Uint8Array> {
  const zips = [...map.entries()].filter(([, b]) => isZip(b));
  if (!zips.length) return map;
  const out = new Map(map);
  for (const [name, bytes] of zips) {
    out.delete(name);
    let inner: Map<string, Uint8Array>;
    try {
      inner = zipToFileMap(bytes);
    } catch {
      continue;
    }
    const base = name.replace(/\.zip$/i, '');
    for (const [p, b] of inner) {
      // avoid clobbering when zip root equals an existing path
      const key = out.has(p) ? `${base}/${p}` : p;
      out.set(key, b);
    }
  }
  return out;
}

export function loadFromMap(input: Map<string, Uint8Array>): ProjectModel {
  const files = expandZips(input);
  // keep blobs (webp/images) out of doc detection but retain for renderers
  if (isEprj3(files)) return finish(buildEprj3(files));
  if (isEpro2(files)) return finish(buildEpro2(files));
  if (isSingleDoc(files)) return finish(buildSingle(files));
  throw new Error('无法识别的工程格式（支持 .eprj3 目录/.zip、.epro2、单个 .esch2/.epcb2/.epan2/.epru）');
}

/** convenience for File[] inputs */
export async function loadFromFiles(files: File[]): Promise<ProjectModel> {
  return loadFromMap(await filesToMap(files));
}

function finish(model: ProjectModel): ProjectModel {
  collectOpenables(model);
  return model;
}

export { RECORD_FILE_RE };
