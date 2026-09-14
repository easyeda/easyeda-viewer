/**
 * Line-record parsing for EasyEDA Pro documents.
 * File = newline-separated lines, each `{outerJson}||{innerJson}|` (last line no trailing |).
 * A file may contain MANY documents; each starts with a DOCHEAD line.
 */
import type { Rec, DocSegment, ParseReport } from '../types';

const dec = new TextDecoder('utf-8');

export function bytesToText(bytes: Uint8Array): string {
  // strip BOM if present
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  return dec.decode(bytes.subarray(start));
}

interface RawLine {
  outer: any;
  inner: any;
  raw: string;
}

function splitLine(line: string): RawLine | null {
  const i = line.indexOf('||');
  if (i < 0) return null;
  try {
    const outer = JSON.parse(line.slice(0, i));
    let tail = line.slice(i + 2);
    if (tail.endsWith('|')) tail = tail.slice(0, -1);
    const inner = JSON.parse(tail);
    return { outer, inner, raw: line };
  } catch {
    return null;
  }
}

/** Parse all records of a text (keeps line numbers for diagnostics). */
export function parseAllRecords(text: string): { lines: RawLine[]; bad: ParseReport['badLines'] } {
  const lines: RawLine[] = [];
  const bad: ParseReport['badLines'] = [];
  const arr = text.split('\n');
  for (let n = 0; n < arr.length; n++) {
    const t = arr[n].trim();
    if (!t) continue;
    const r = splitLine(t);
    if (r) lines.push(r);
    else bad.push({ lineNo: n + 1, text: t.slice(0, 120) });
  }
  return { lines, bad };
}

function toRec(l: RawLine, lineNo: number): Rec {
  const id = Array.isArray(l.outer.id) ? l.outer.id.join(',') : String(l.outer.id ?? '');
  return {
    type: String(l.outer.type ?? ''),
    id,
    idVal: l.outer.id,
    ticket: Number(l.outer.ticket ?? 0),
    data: l.inner ?? {},
    lineNo,
    raw: l.raw,
  };
}

/** Split a raw line list into document segments on DOCHEAD boundaries. */
export function splitSegments(lines: RawLine[]): { segs: DocSegment[] } {
  const segs: DocSegment[] = [];
  let cur: DocSegment | null = null;
  lines.forEach((l, idx) => {
    const rec = toRec(l, idx + 1);
    if (rec.type === 'DOCHEAD') {
      cur = {
        uuid: String(rec.data.uuid ?? `doc${segs.length}`),
        docType: String(rec.data.docType ?? ''),
        startLine: idx,
        canvas: null,
        meta: null,
        recs: [],
      };
      segs.push(cur);
      return;
    }
    if (!cur) {
      // records before any DOCHEAD (shouldn't happen) — create implicit segment
      cur = { uuid: `doc0`, docType: '', startLine: idx, canvas: null, meta: null, recs: [] };
      segs.push(cur);
    }
    if (rec.type === 'CANVAS' && cur) cur.canvas = rec.data as any;
    else if (rec.type === 'META' && cur) cur.meta = { ...(cur.meta ?? {}), ...rec.data };
    cur.recs.push(rec);
  });
  return { segs };
}

export interface DocHead {
  docType: string;
  uuid: string;
}

/** Cheap pass: collect only DOCHEAD lines (docType, uuid) for tree association. */
export function scanDocHeads(bytes: Uint8Array): DocHead[] {
  const text = bytesToText(bytes);
  const out: DocHead[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{"type":"DOCHEAD"')) continue;
    const i = t.indexOf('||');
    if (i <= 0) continue;
    try {
      let tail = t.slice(i + 2);
      if (tail.endsWith('|')) tail = tail.slice(0, -1);
      const d = JSON.parse(tail);
      out.push({ docType: String(d.docType ?? ''), uuid: String(d.uuid ?? '') });
    } catch { /* skip malformed head */ }
  }
  return out;
}

/** Cache: fileKey -> segments (parse a file at most once). */
const segCache = new Map<string, DocSegment[]>();

export function getSegments(fileKey: string, bytes: Uint8Array): DocSegment[] {
  let segs = segCache.get(fileKey);
  if (!segs) {
    const { lines, bad } = parseAllRecords(bytesToText(bytes));
    void bad;
    segs = splitSegments(lines).segs;
    segCache.set(fileKey, segs);
  }
  return segs;
}

export function clearSegCache(): void {
  segCache.clear();
}

/** Main (page) segment of a file: the last segment with a renderable docType, else last. */
export function mainSegment(segs: DocSegment[]): DocSegment | null {
  const renderable = new Set(['SCH_PAGE', 'PCB', 'PANEL', 'SYMBOL', 'FOOTPRINT', 'PANEL_LIB', 'SIMULATION', 'SIMULATION_SCH', 'SCH']);
  for (let i = segs.length - 1; i >= 0; i--) {
    if (renderable.has(segs[i].docType)) return segs[i];
  }
  return segs.length ? segs[segs.length - 1] : null;
}
