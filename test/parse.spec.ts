/**
 * Parsing tests against the RA6E2 sample projects (samples/ dir, gitignored).
 * Skipped automatically when samples are not present.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFromMap } from '../src/core/parse/container';
import { parseAllRecords, splitSegments } from '../src/core/parse/records';
import { openDoc } from '../src/core/model';
import { RENDERABLE } from '../src/core/types';
import type { ProjectModel } from '../src/core/types';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const EPRJ3_DIR = path.join(root, 'samples/RA6E2-eprj3'); // folder-form project (index + doc files)
const EPRO2 = path.join(root, 'samples/RA6E2-epro2/RA6E2.epro2');
const hasSamples = existsSync(EPRJ3_DIR) && existsSync(EPRO2);

function zipToMap(file: string): Map<string, Uint8Array> {
  return new Map([[path.basename(file), new Uint8Array(readFileSync(file))]]);
}

/** read a folder-form project the way a drag&drop upload would: posix-relative paths */
function dirToMap(dir: string, prefix = ''): Map<string, Uint8Array> {
  const m = new Map<string, Uint8Array>();
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const key = prefix ? `${prefix}/${name}` : name;
    if (statSync(p).isDirectory()) {
      for (const [k, b] of dirToMap(p, key)) m.set(k, b);
    } else {
      m.set(key, new Uint8Array(readFileSync(p)));
    }
  }
  return m;
}

describe('record line format', () => {
  it('splits {outer}||{inner}| records', () => {
    const text =
      '{"type":"DOCHEAD","id":"x1"}||{"docType":"SCH_PAGE","uuid":"u1"}|\n' +
      '{"type":"LINE","id":["L",7]}||{"startX":1,"startY":2}';
    const { lines, bad } = parseAllRecords(text);
    expect(bad).toHaveLength(0);
    expect(lines).toHaveLength(2);
    const segs = splitSegments(lines).segs;
    expect(segs).toHaveLength(1);
    expect(segs[0].docType).toBe('SCH_PAGE');
    expect(segs[0].uuid).toBe('u1');
    expect(segs[0].recs[0].type).toBe('LINE');
    expect(segs[0].recs[0].id).toBe('L,7'); // array id flattened
    expect(segs[0].recs[0].idVal).toEqual(['L', 7]);
  });

  it('reports unparseable lines instead of throwing', () => {
    const { lines, bad } = parseAllRecords('not json at all\n{"a":1}||{"b":2}|');
    expect(bad).toHaveLength(1);
    expect(lines).toHaveLength(1);
  });
});

describe.skipIf(!hasSamples)('eprj3 container (RA6E2 sample)', () => {
  const model = loadFromMap(dirToMap(EPRJ3_DIR)) as ProjectModel;

  it('detects format and names the project', () => {
    expect(model.format).toBe('eprj3');
    expect(model.name).toContain('RA6E2');
  });

  it('exposes sheets, PCBs and panels as openable tree nodes', () => {
    const openables = [...model.openables.values()];
    expect(openables.length).toBeGreaterThan(0);
    expect(new Set(openables.map((n) => n.docType)).has('SCH_PAGE')).toBe(true);
    expect(new Set(openables.map((n) => n.docType)).has('PCB')).toBe(true);
  });

  it('associates index uuids with DOCHEAD uuids inside files (no reliance on empty source fields)', () => {
    const nodes = [...model.openables.values()].filter((n) => n.docType === 'SCH_PAGE');
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) {
      expect(n.fileKey).toBeTruthy();
      const opened = openDoc(model, n);
      expect(opened.self.uuid).toBe(n.uuid);
      expect(opened.self.docType).toBe('SCH_PAGE');
    }
  });

  it('resolves embedded symbol libraries for schematic pages', () => {
    const page = [...model.openables.values()].find((n) => n.docType === 'SCH_PAGE')!;
    const opened = openDoc(model, page);
    const comps = opened.self.recs.filter((r) => r.type === 'COMPONENT');
    expect(comps.length).toBeGreaterThan(0);
    let resolved = 0;
    for (const c of comps) {
      for (const a of opened.self.recs) {
        if (a.type === 'ATTR' && a.data.parentId === c.id && a.data.key === 'Symbol') {
          if (opened.libs.get(String(a.data.value))) resolved++;
        }
      }
    }
    expect(resolved).toBeGreaterThan(0);
    expect([...opened.libs.values()].some((s) => s.docType === 'SYMBOL')).toBe(true);
  });

  it('computes a finite bbox for opened docs', () => {
    for (const n of [...model.openables.values()].slice(0, 5)) {
      const { bbox } = openDoc(model, n);
      expect(Number.isFinite(bbox.minX)).toBe(true);
      expect(bbox.maxX).toBeGreaterThan(bbox.minX);
    }
  });
});

describe.skipIf(!hasSamples)('epro2 container (RA6E2 sample)', () => {
  const model = loadFromMap(zipToMap(EPRO2)) as ProjectModel;

  it('detects format', () => {
    expect(model.format).toBe('epro2');
  });

  it('rebuilds board/sch/pcb/library tree from epru META', () => {
    const kinds = new Set<string>();
    const walk = (ns: typeof model.tree) => ns.forEach((n) => { kinds.add(n.kind); if (n.children) walk(n.children); });
    walk(model.tree);
    expect(kinds.has('board')).toBe(true);
    expect(kinds.has('schematic')).toBe(true);
    expect(kinds.has('pcb')).toBe(true);
    expect(kinds.has('lib')).toBe(true);
  });

  it('opens epru segments and finds footprints in the same stream', () => {
    // some PCB variants in the sample are empty stubs — accumulate across all of them
    const nodes = [...model.openables.values()].filter((n) => n.docType === 'PCB');
    let comps = 0, fpResolved = 0;
    for (const n of nodes) {
      const opened = openDoc(model, n);
      const cs = opened.self.recs.filter((r) => r.type === 'COMPONENT');
      comps += cs.length;
      for (const c of cs) {
        for (const a of opened.self.recs) {
          if (a.type === 'ATTR' && a.data.parentId === c.id && a.data.key === 'Footprint') {
            if (opened.libs.get(String(a.data.value))) fpResolved++;
          }
        }
      }
    }
    expect(comps).toBeGreaterThan(0);
    expect(fpResolved).toBeGreaterThan(0);
  });

  it('tree nodes all point at real segments', () => {
    for (const n of model.openables.values()) {
      expect(() => openDoc(model, n)).not.toThrow();
    }
  });
});

describe.skipIf(!hasSamples)('single .esch2 fallback', () => {
  it('loads a loose document file as single-doc project', () => {
    const model = loadFromMap(dirToMap(EPRJ3_DIR));
    // grab one .esch2 out of the eprj3 project and feed it alone
    const key = [...model.files.keys()].find((k) => k.endsWith('.esch2'))!;
    const alone = new Map([[path.basename(key), model.files.get(key)!]]);
    const m2 = loadFromMap(alone);
    expect(m2.format).toBe('single-doc');
    expect(m2.openables.size).toBeGreaterThan(0);
  });
});
