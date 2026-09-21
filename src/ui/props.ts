/**
 * Properties panel — a complete, translated, decoded property inspector
 * (#1/#7/#29/#31, full-attrs rework #props-full).
 *
 * Selecting any primitive lists ALL of its user-facing properties in bands:
 *   ① X / Y coordinate rows first;
 *   ② the record type's key attributes (designator / value / net / layer,
 *      pad shape·size·drill, track width, via diameters …);
 *   ③ the remaining built-in record fields, decoded (sizes in the current
 *      display unit #unit-toggle, degrees, colors with swatches, readable
 *      enum names, yes/no flags), plus ALL
 *      instance ATTR records — unaffected by the canvas valueVisible paint
 *      rules (those decide what is drawn, not what the inspector lists) —
 *      with symbol/footprint library defaults and device META attributes
 *      back-filling empty instance values;
 *   ④ custom (untranslated) attribute keys last.
 * Raw implementation fields (parentId/uuid/path data…) stay hidden.
 */
import type { RenderObject, RenderLayer } from '../core/render/layers';
import type { OpenedDoc, Rec, TreeNode } from '../core/types';
import { collectAttrs, collectAttrsById, resolveAttrRef, resolveLibGraphics, type AttrEntry } from '../core/model';
import { t, typeLabel, attrLabel, valueLabel } from './i18n';
import { fmtLen, unitSuffix, onUnitChange } from './units';

type Row = [label: string, value: string, swatch?: string];
type RowFn = (label: string, value: string, swatch?: string) => void;

function isNum(v: unknown): boolean {
  return v != null && v !== '' && Number.isFinite(Number(v));
}
function fmt(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  return String(Math.round(v * 1000) / 1000);
}
/** 长度显示:文档坐标单位值 → 当前显示单位(全局单位切换 #unit-toggle) */
const len = (n: unknown): string => `${fmtLen(Number(n))} ${unitSuffix()}`;
/** 坐标对显示:换算到当前显示单位并带后缀(#unit-toggle) */
const xy = (x: unknown, y: unknown): string => `${fmtLen(Number(x))}, ${fmtLen(Number(y))} ${unitSuffix()}`;

/** record data fields that are raw implementation/geometry data — never listed */
const INTERNAL_KEYS = new Set([
  'id', 'uuid', 'ticket', 'parentId', 'groupID', 'groupId', 'partitionId', 'partId',
  'zIndex', 'attrsMap', 'lineGroup', 'refs', 'pinSwap', 'pinSwapInfo', 'footprintPrimitives',
  'networkList', 'matrix', 'path', 'ploys', 'coords', 'tableCell', 'rowSizes', 'colSizes',
  'rowLocked', 'colLocked', 'dataType', 'max', 'BBOX', 'BBox', 'content', 'busEntry',
  'pourFill', 'subId', 'version', 'rules',
]);

/** inline-attr / library entries that merely restate internal references or are
 *  folded into a decoded row (3D-model title, symbol/footprint uuid lists …) */
const INTERNAL_ATTR_KEYS = new Set([
  'DeviceName', 'FootprintName', 'SymbolName', 'Footprints', 'Devices', 'Symbols',
  'pinClass', 'differentialPairClass', '3D Model Title',
]);

/** defensive skip: attr keys mirroring record control fields (real geometry shows
 *  through the data sweep instead) */
const ATTR_GEOM_SKIP = new Set([
  'x', 'y', 'rotation', 'angle', 'padAngle', 'partId', 'groupId', 'groupID', 'isMirror',
  'attrs', 'zIndex', 'locked', 'layerId', 'layer', 'pinSwap', 'pinSwapInfo', 'partitionId',
]);

/** yes/no flag fields (boolean or 0/1) */
const FLAG_KEYS = new Set([
  'lock', 'locked', 'ratelock', 'bold', 'reverse', 'mirror', 'isMirror', 'closed',
  'displayFill', 'displayStroke', 'valueVisible', 'keyVisible', 'italic', 'underline',
  'strikeout', 'plated', 'textFollow', 'keepIsland', 'isBridgingCopper', 'autoClose',
  'valid', 'visible', 'cover',
]);

/** length fields shown in the current display unit (#unit-toggle) */
const MIL_KEYS = new Set([
  'width', 'height', 'strokeWidth', 'radius', 'radiusX', 'radiusY', 'viaDiameter',
  'holeDiameter', 'diameter', 'fontSize', 'length', 'padOffsetX', 'padOffsetY',
  'spokeSpace', 'spokeWidth', 'padLen', 'gridXSize', 'gridYSize', 'thickness',
]);

/** angle fields shown with a degree sign */
const DEG_KEYS = new Set(['rotation', 'angle', 'padAngle', 'relativeAngle']);

/** color fields rendered with a swatch */
const COLOR_KEYS = new Set(['strokeColor', 'fillColor', 'color', 'specialColor']);

/** enum fields decoded through valueLabel */
const ENUM_KEYS = new Set([
  'shape', 'padType', 'holeType', 'viaType', 'pourType', 'regionType', 'prohibitType',
  'polyType', 'arcType', 'strokeStyle', 'fillStyle', 'origin', 'align', 'pinShape',
  'electric', 'type', 'dimensionType',
]);

/**
 * Key attributes per record type, listed right after the X/Y rows (#props-full).
 * Synthetic keys: padShape/padSize fold defaultPad, textObj unwraps a DIMENSION's
 * text object, pour* resolve a POURED's source POUR record.
 */
const KEY_FIELDS: Record<string, string[]> = {
  PAD: ['num', 'netName', 'layerId', 'padShape', 'padSize', 'hole', 'padAngle', 'plated'],
  VIA: ['netName', 'viaDiameter', 'holeDiameter', 'viaType', 'ruleName'],
  LINE: ['netName', 'net', 'layerId', 'width', 'strokeWidth'],
  ARC: ['netName', 'net', 'layerId', 'width', 'strokeWidth'],
  POLY: ['netName', 'net', 'layerId', 'width', 'polyType'],
  FILL: ['netName', 'net', 'layerId', 'width', 'fillStyle'],
  POUR: ['netName', 'layerId', 'name', 'pourType', 'width', 'order', 'keepIsland'],
  POURED: ['pourNet', 'pourLayer', 'pourType'],
  STRING: ['text', 'fontSize', 'fontFamily', 'strokeWidth'],
  TEXT: ['value', 'fontSize', 'fontFamily'],
  DIMENSION: ['type', 'text', 'unit', 'precision', 'textFollow'],
  REGION: ['regionType', 'prohibitType', 'name', 'layerId', 'width'],
  RECT: ['strokeWidth', 'radiusX', 'radiusY'],
  CIRCLE: ['radius'],
  ELLIPSE: ['radiusX', 'radiusY'],
  HOLE: ['hole', 'holeDiameter', 'plated'],
  TEARDROP: ['netName', 'layerId'],
  IMAGE: ['fileName'],
  OBJ: ['fileName'],
};
/** fallback for types without a dedicated key list */
const FALLBACK_KEYS = ['name', 'value', 'text', 'netName', 'net', 'layerId', 'layer', 'width', 'height', 'strokeWidth', 'rotation', 'angle'];

/** values that are serialized JSON objects/arrays get rendered as a hierarchy */
function parseObjectLike(v: string): unknown {
  const s = v.trim();
  if (s.length < 2 || (s[0] !== '{' && s[0] !== '[')) return null;
  try {
    const p = JSON.parse(s);
    return p && typeof p === 'object' ? p : null;
  } catch {
    return null;
  }
}

const OBJ_MAX_NODES = 80;
const OBJ_MAX_DEPTH = 6;

/** nested key/value tree for object-valued attributes (indent + guide border) */
function objectTree(v: unknown, depth: number, budget: { n: number }): HTMLElement {
  const box = document.createElement('div');
  box.className = 'ev-obj';
  if (v == null || typeof v !== 'object' || depth >= OBJ_MAX_DEPTH || budget.n <= 0) {
    box.textContent = JSON.stringify(v) ?? '';
    return box;
  }
  const entries: [string, unknown][] = Array.isArray(v)
    ? v.map((x, i) => [String(i), x])
    : Object.entries(v as Record<string, unknown>);
  for (const [k, val] of entries) {
    if (budget.n-- <= 0) {
      const more = document.createElement('div');
      more.className = 'ev-obj-row';
      more.textContent = '…';
      box.appendChild(more);
      break;
    }
    const rowEl = document.createElement('div');
    rowEl.className = 'ev-obj-row';
    const key = document.createElement('span');
    key.className = 'ev-obj-k';
    key.textContent = Array.isArray(v) ? `[${k}]` : k;
    rowEl.appendChild(key);
    if (val != null && typeof val === 'object') {
      rowEl.appendChild(objectTree(val, depth + 1, budget));
    } else {
      const valEl = document.createElement('span');
      valEl.className = 'ev-obj-v';
      valEl.textContent = String(val);
      rowEl.appendChild(valEl);
    }
    box.appendChild(rowEl);
  }
  return box;
}

export class PropsView {
  private host: HTMLElement;
  private layerNames = new Map<string, string>();
  private current: RenderObject | null = null;
  private opened: OpenedDoc | null = null;
  private deviceNode: TreeNode | null = null;
  private deviceOpened: OpenedDoc | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
    this.host.className = 'ev-props';
    this.clear();
    // 显示单位切换(#unit-toggle):重建当前属性行,坐标/尺寸按新单位换算
    onUnitChange(() => this.refresh());
  }

  /** layerId -> file layer name, so "图层 1" reads "Top Layer" etc. */
  setLayerNames(layers: RenderLayer[]): void {
    this.layerNames = new Map(layers.map((l) => [l.id, l.name]));
  }

  /** context of the currently opened document (needed to resolve component attributes) */
  setOpened(opened: OpenedDoc | null): void {
    this.opened = opened;
  }

  clear(): void {
    this.host.innerHTML = '';
    const hint = document.createElement('div');
    hint.className = 'ev-hint';
    hint.textContent = t('propsHint');
    this.host.appendChild(hint);
  }

  show(obj: RenderObject | null): void {
    this.current = obj;
    this.deviceNode = null;
    this.deviceOpened = null;
    this.render();
  }

  /** show library DEVICE metadata when its tree node is clicked (#11) */
  showDevice(node: TreeNode, opened: OpenedDoc): void {
    this.current = null;
    this.deviceNode = node;
    this.deviceOpened = opened;
    this.renderDevice();
  }

  /** re-render after language change */
  refresh(): void {
    if (this.deviceNode && this.deviceOpened) this.renderDevice();
    else this.render();
  }

  private render(): void {
    const obj = this.current;
    this.host.innerHTML = '';
    if (!obj) return this.clear();
    const rec = obj.rec;
    const d = rec.data ?? {};

    const head = document.createElement('div');
    head.className = 'ev-props-head';
    head.textContent = typeLabel(rec.type);
    this.host.appendChild(head);

    const table = document.createElement('table');
    table.className = 'ev-props-table';
    const row: RowFn = (k, v, swatch) => {
      const tr = document.createElement('tr');
      const tk = document.createElement('td'); tk.className = 'ev-k'; tk.textContent = k;
      const tv = document.createElement('td'); tv.className = 'ev-v';
      if (swatch) {
        const s = document.createElement('span'); s.className = 'ev-props-color'; s.style.background = swatch;
        tv.appendChild(s);
      }
      this.fillValue(tv, v);
      tr.append(tk, tv);
      table.appendChild(tr);
    };
    const used = new Set<string>();

    // ① X / Y coordinates come first for every object (#props-full)
    this.xyRows(d, row, used);

    if (rec.type === 'COMPONENT' && this.opened) this.renderComponent(rec, d, obj.title, row, used);
    else this.renderPrimitive(rec, d, obj.title, row, used);

    this.host.appendChild(table);
  }

  /** ① the X / Y band: center, corners, endpoints — whatever the record carries
   *  (converted to the current display unit, #unit-toggle) */
  private xyRows(d: any, row: RowFn, used: Set<string>): void {
    const mark = (...ks: string[]): void => { for (const k of ks) used.add(k); };
    if (isNum(d.centerX) || isNum(d.centerY)) {
      row('X / Y', xy(d.centerX ?? 0, d.centerY ?? 0));
      mark('centerX', 'centerY');
    }
    if (isNum(d.x) && isNum(d.y)) {
      if (isNum(d.x2) && isNum(d.y2)) {
        row('X₁ / Y₁', xy(d.x, d.y));
        row('X₂ / Y₂', xy(d.x2, d.y2));
        mark('x', 'y', 'x2', 'y2', 'x1', 'y1');
      } else {
        row('X / Y', xy(d.x, d.y));
        mark('x', 'y');
      }
    }
    if (isNum(d.dotX1) && isNum(d.dotY1)) {
      const both = isNum(d.dotX2) && isNum(d.dotY2);
      row(both ? 'X₁ / Y₁' : 'X / Y', xy(d.dotX1, d.dotY1));
      if (both) row('X₂ / Y₂', xy(d.dotX2, d.dotY2));
      mark('dotX1', 'dotY1', 'dotX2', 'dotY2');
    }
    if (isNum(d.startX) && isNum(d.startY)) {
      if (isNum(d.endX) && isNum(d.endY)) {
        row('X₁ / Y₁', xy(d.startX, d.startY));
        row('X₂ / Y₂', xy(d.endX, d.endY));
        mark('startX', 'startY', 'endX', 'endY');
      } else {
        row('X / Y', xy(d.startX, d.startY));
        mark('startX', 'startY');
      }
    }
  }

  /**
   * Decode one record data field into a display row (or null to hide it).
   * Marks every consumed key (incl. folded composites) in `used` so the sweep
   * never repeats them. `type` only tunes a couple of labels.
   */
  private decodeField(k: string, d: any, type: string, used: Set<string>): Row | null {
    const v = d[k];
    const mark = (...ks: string[]): void => { for (const x of ks) used.add(x); };
    // synthetic keys fold other fields (defaultPad) — check before the value guard
    if (k === 'padShape') {
      const dp = d.defaultPad;
      const pt = dp && typeof dp === 'object' ? dp.padType : undefined;
      mark('padShape', 'padType', 'shape', 'defaultPad');
      return pt ? [attrLabel('padType'), valueLabel(String(pt).toUpperCase())] : null;
    }
    if (k === 'padSize') {
      const dp = d.defaultPad && typeof d.defaultPad === 'object' ? d.defaultPad : null;
      const w = dp ? dp.width : d.width, h = dp ? dp.height : d.height;
      mark('padSize', 'width', 'height', 'defaultPad');
      return isNum(w) && isNum(h)
        ? [`${attrLabel('width')} × ${attrLabel('height')}`, `${len(w)} × ${len(h)}`]
        : null;
    }
    if (v == null || v === '' || INTERNAL_KEYS.has(k)) return null;
    // type-aware labels: a pad's number, a circle's radius
    if (k === 'num' && type === 'PAD') { mark('num'); return [attrLabel('padNumber'), String(v)]; }
    if (k === 'radius' && type === 'CIRCLE') { mark('radius'); return [attrLabel('circleRadius'), len(v)]; }
    // folded composites: inline attrs live in the attribute bands, the default
    // pad spec is decoded as pad shape / size rows
    if (k === 'attrs' || k === 'defaultPad') { mark(k); return null; }
    if (k === 'hole' && v && typeof v === 'object') {
      const ht = String(v.holeType ?? 'ROUND').toUpperCase();
      const hw = Number(v.width ?? 0), hh = Number(v.height ?? hw);
      const size = hw === hh ? `Ø${len(hw)}` : `${len(hw)} × ${len(hh)}`;
      mark('hole', 'holeType');
      return [attrLabel('hole'), `${valueLabel(ht)} · ${size}`];
    }
    if (k === 'pourType') {
      mark('pourType', 'fineness');
      if (v && typeof v === 'object') {
        const pt = valueLabel(String(v.pourType ?? '').toUpperCase());
        const fin = Number(v.fineness);
        return [attrLabel('pourType'), Number.isFinite(fin) && fin > 0 ? `${pt} · ${t('pourEdge')} ${len(fin)}` : pt];
      }
      return [attrLabel('pourType'), valueLabel(String(v).toUpperCase())];
    }
    if (k === 'text' && v && typeof v === 'object') {
      // DIMENSION text is an object {x,y,text,…} — show the label string
      const s = v.text != null ? String(v.text) : '';
      return s ? [attrLabel('text'), s] : null;
    }
    if (k === 'points') {
      if (!Array.isArray(v) || !v.length) return null;
      // flat [x,y,…] lists count pairs; object lists count entries
      const n = typeof v[0] === 'object' ? v.length : Math.ceil(v.length / 2);
      return [attrLabel('points'), String(n)];
    }
    if (k === 'unusedInnerLayers') {
      if (!Array.isArray(v)) return null;
      const s = v.map((x) => this.layerText(x)).filter(Boolean).join(' / ');
      return s ? [attrLabel(k), s] : null;
    }
    if (k === 'layerId' || k === 'layer') {
      const s = this.layerText(v);
      mark('layerId', 'layer');
      return s ? [attrLabel('layerId'), s] : null;
    }
    if (k === 'net' || k === 'netName') {
      const s = String(v);
      return s ? [attrLabel('net'), s] : null;
    }
    if (k === 'value') return [attrLabel('value'), valueLabel(v)];
    if (COLOR_KEYS.has(k)) {
      const s = String(v);
      return /^#[0-9a-fA-F]{3,8}$/.test(s) ? [attrLabel(k), s.toUpperCase(), s] : null;
    }
    if (FLAG_KEYS.has(k) || typeof v === 'boolean') {
      if (v === true || v === 1 || v === '1') return [attrLabel(k), t('yes')];
      if (v === false || v === 0 || v === '0') return [attrLabel(k), t('no')];
      return null;
    }
    if (MIL_KEYS.has(k)) {
      if (!isNum(v)) return null;
      // track/pour/region outline widths read better as 线宽 than 宽
      const label = (k === 'width' && ['LINE', 'ARC', 'POUR', 'REGION'].includes(type))
        ? attrLabel('strokeWidth') : attrLabel(k);
      return [label, len(v)];
    }
    if (DEG_KEYS.has(k)) return isNum(v) ? [attrLabel(k), `${fmt(v)}${t('deg')}`] : null;
    if (ENUM_KEYS.has(k)) {
      if (Array.isArray(v)) return [attrLabel(k), v.map((x) => valueLabel(String(x).toUpperCase())).join('、')];
      return [attrLabel(k), valueLabel(String(v).toUpperCase())];
    }
    if (Array.isArray(v)) return null; // remaining arrays are reference lists
    if (typeof v === 'object') return [attrLabel(k), JSON.stringify(v)];
    if (typeof v === 'number') return [attrLabel(k), fmt(v)];
    return [attrLabel(k), String(v)];
  }

  /** ③ remaining record data fields: translated (decoded) first, custom last */
  private sweepData(d: any, rec: Rec, used: Set<string>): { known: Row[]; custom: Row[] } {
    const known: Row[] = [];
    const custom: Row[] = [];
    // combined size row when both dimensions exist and no key row consumed them
    if (!used.has('width') && !used.has('height') && isNum(d.width) && isNum(d.height)) {
      known.push([`${attrLabel('width')} × ${attrLabel('height')}`, `${len(d.width)} × ${len(d.height)}`]);
      used.add('width'); used.add('height');
    }
    for (const k of Object.keys(d)) {
      if (used.has(k) || INTERNAL_KEYS.has(k)) continue;
      const r = this.decodeField(k, d, rec.type, used);
      used.add(k);
      if (!r) continue;
      (attrLabel(k) !== k ? known : custom).push(r);
    }
    const cmp = (a: Row, b: Row): number => a[0].localeCompare(b[0], 'zh');
    known.sort(cmp);
    custom.sort(cmp);
    return { known, custom };
  }

  /** instance ATTR records attached to a drawing record (wire net labels, pins) */
  private collectPrimitiveAttrs(rec: Rec, d: any): AttrEntry[] {
    const opened = this.opened;
    if (!opened) return [];
    const ids = [rec.id];
    const group = d.lineGroup;
    if (typeof group === 'string' && group && group !== rec.id) ids.push(group);
    const out: AttrEntry[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      for (const e of collectAttrsById(id, opened)) {
        if (seen.has(e.key)) continue; // the record's own attrs win over group ones
        seen.add(e.key);
        out.push(e);
      }
    }
    return out;
  }

  /** attribute entries → rows, deduped and ref-resolved; custom keys land in `custom` */
  private attrRows(entries: AttrEntry[], seen: Set<string>): { known: Row[]; custom: Row[] } {
    const map: Record<string, string> = {};
    for (const e of entries) if (!map[e.key] || e.source === 'instance') map[e.key] = e.value;
    const known: Row[] = [];
    const custom: Row[] = [];
    for (const k of Object.keys(map)) {
      if (seen.has(k) || INTERNAL_ATTR_KEYS.has(k) || ATTR_GEOM_SKIP.has(k)) continue;
      const v = this.displayAttrValue(resolveAttrRef(map, map[k]));
      if (!v) continue; // blank attrs (often whitespace or empty JSON) carry nothing
      const l = attrLabel(k);
      (l !== k ? known : custom).push([l, v]);
    }
    const cmp = (a: Row, b: Row): number => a[0].localeCompare(b[0], 'zh');
    known.sort(cmp);
    custom.sort(cmp);
    return { known, custom };
  }

  /** attr display value: trim, drop empty JSON shells, and read yes/no-style
   *  flags in the UI language (e.g. "Add into BOM = yes") */
  private displayAttrValue(v: unknown): string {
    if (v == null) return '';
    const s = String(v).trim();
    if (!s || s === '{}' || s === '[]') return '';
    const low = s.toLowerCase();
    if (low === 'yes' || low === 'true' || low === '1') return t('yes');
    if (low === 'no' || low === 'false' || low === '0') return t('no');
    return s;
  }

  /** ②/③/④ every non-component object: key fields, then all data + attr rows */
  private renderPrimitive(rec: Rec, d: any, title: string | undefined, row: RowFn, used: Set<string>): void {
    const attrEntries = this.collectPrimitiveAttrs(rec, d);
    const attrMap: Record<string, string> = {};
    for (const e of attrEntries) if (!attrMap[e.key] || e.source === 'instance') attrMap[e.key] = e.value;
    const attrVal = (k: string): string => resolveAttrRef(attrMap, attrMap[k]) ?? '';
    const seen = new Set<string>();
    const emit = (rows: Row[]): void => { for (const r of rows) row(r[0], r[1], r[2]); };

    if (title) row(attrLabel('designator'), title);

    // a pin's name/number live in ATTR records parented to the pin
    if (rec.type === 'PIN') {
      for (const k of ['Pin Number', 'Pin Name']) {
        const v = attrVal(k);
        if (v) { row(attrLabel(k), v); seen.add(k); }
      }
    }

    // solid copper resolves net/name/layer from its source POUR record
    // (POURED id is ["POURED", "<pourId>"])
    let pour: any = null;
    if (rec.type === 'POURED' && this.opened) {
      const key = String(rec.id).split(',').pop() ?? '';
      pour = this.opened.self.recs.find((r) => r.type === 'POUR' && String(r.id) === key)?.data ?? null;
    }

    let netShown = false;
    for (const k of KEY_FIELDS[rec.type] ?? FALLBACK_KEYS) {
      if (pour && (k === 'pourNet' || k === 'pourName' || k === 'pourLayer' || k === 'pourType')) {
        const src = k === 'pourNet' ? 'netName' : k === 'pourName' ? 'name' : k === 'pourLayer' ? 'layerId' : 'pourType';
        const r = this.decodeField(src, pour, rec.type, used);
        if (r) row(r[0], r[1], r[2]);
        continue;
      }
      const r = this.decodeField(k, d, rec.type, used);
      used.add(k);
      if (r) {
        row(r[0], r[1], r[2]);
        if (k === 'netName' || k === 'net') netShown = true;
      }
    }
    // schematic wire nets hang off the WIRE id in lineGroup, not on the LINE record
    if (!netShown) {
      const nv = attrVal('NET') || attrVal('Global Net Name');
      if (nv) { row(attrLabel('net'), nv); seen.add('NET'); seen.add('Global Net Name'); }
    }

    // ③ remaining data fields, then all remaining attr records; ④ custom keys last
    const data = this.sweepData(d, rec, used);
    const attrs = this.attrRows(attrEntries, seen);
    emit(data.known);
    emit(attrs.known);
    emit(data.custom);
    emit(attrs.custom);
  }

  /** component attribute table: instance ATTRs + library/device defaults +
   *  symbol/footprint lib defaults, `={…}` refs resolved (#2/#3/#props-full) */
  private renderComponent(rec: Rec, d: any, title: string | undefined, row: RowFn, used: Set<string>): void {
    const entries = this.opened ? collectAttrs(rec, this.opened, { libAttrs: true }) : [];
    const map: Record<string, string> = {};
    for (const e of entries) if (!map[e.key] || e.source === 'instance') map[e.key] = e.value;
    const val = (k: string): string => resolveAttrRef(map, map[k]) ?? '';
    const seen = new Set<string>();
    const emit = (rows: Row[]): void => { for (const r of rows) row(r[0], r[1], r[2]); };
    const displayFor = (k: string, raw: string): string => {
      if (k === '3D Model') return this.model3dTitle(val('3D Model Title') || undefined, raw);
      if (['Symbol', 'Footprint', 'Device'].includes(k)) return this.libTitle(raw);
      return raw;
    };
    // ② key attributes
    const priority = ['Designator', 'Name', 'Value', 'Symbol', 'Footprint', '3D Model', 'Device'];
    for (const k of priority) {
      const raw = k === 'Designator' ? (val(k) || title || '') : val(k);
      if (!raw) continue;
      const disp = displayFor(k, raw);
      if (disp) { row(attrLabel(k), disp); seen.add(k); }
    }
    // a PCB component's layer sits with the key attributes
    const layerRow = this.decodeField('layerId', d, rec.type, used);
    if (layerRow) { row(layerRow[0], layerRow[1], layerRow[2]); used.add('layerId'); used.add('layer'); }
    used.add('attrs');

    // ③ remaining record fields + attributes, ④ custom keys last
    const data = this.sweepData(d, rec, used);
    const attrs = this.attrRows(entries, seen);
    emit(data.known);
    emit(attrs.known);
    emit(data.custom);
    emit(attrs.custom);
  }

  /** look up a library/3D-model uuid and return the segment title if known */
  private libTitle(uuid: string): string {
    if (!uuid) return uuid;
    const seg = this.opened?.libs.get(uuid) ?? this.deviceOpened?.libs.get(uuid);
    return seg?.meta?.title ? String(seg.meta.title) : uuid;
  }

  /** display value for the "3D Model" attr: the sibling "3D Model Title" wins,
   *  then a lib lookup; the compound `modelUuid|owner` form never shows raw (#3d-model) */
  private model3dTitle(titleAttr: string | undefined, raw: string): string {
    if (titleAttr) return titleAttr;
    if (!raw.includes('|')) return this.libTitle(raw);
    const first = raw.split('|')[0];
    const titled = this.libTitle(first);
    // libTitle echoes the uuid back when unknown — report "unresolvable" instead
    return titled === first ? '' : titled;
  }

  /** decode a layerId / layer value against the doc's layer list */
  private layerText(v: unknown): string {
    if (v == null || v === '') return '';
    const one = (id: unknown): string => {
      const s = String(id);
      return s ? this.layerNames.get(s) ?? `#${s}` : '';
    };
    return Array.isArray(v) ? v.map(one).filter(Boolean).join(' / ') : one(v);
  }

  /** fill a property value cell: full text in the hover title, 2-line clamp for
   *  long values, and JSON-object values expanded as a hierarchy (#props-1:1) */
  private fillValue(tv: HTMLElement, v: string): void {
    tv.title = v;
    const obj = parseObjectLike(v);
    if (obj) {
      tv.appendChild(objectTree(obj, 0, { n: OBJ_MAX_NODES }));
      return;
    }
    const s = document.createElement('div');
    s.className = 'ev-vtext';
    s.textContent = v;
    tv.appendChild(s);
  }

  /** device (library) metadata panel: same priority rows, translated rest, custom last */
  private renderDevice(): void {
    const node = this.deviceNode;
    const opened = this.deviceOpened;
    this.host.innerHTML = '';
    if (!node || !opened) return this.clear();

    const head = document.createElement('div');
    head.className = 'ev-props-head';
    head.textContent = node.title;
    this.host.appendChild(head);

    const table = document.createElement('table');
    table.className = 'ev-props-table';
    const row = (k: string, v: string): void => {
      const tr = document.createElement('tr');
      const tk = document.createElement('td'); tk.className = 'ev-k'; tk.textContent = k;
      const tv = document.createElement('td'); tv.className = 'ev-v';
      this.fillValue(tv, v);
      tr.append(tk, tv);
      table.appendChild(tr);
    };
    const metaAny = opened.self.meta as any;
    const attrs = (metaAny?.attributes && typeof metaAny.attributes === 'object') ? metaAny.attributes : {};
    // resolved display value per attribute key (uuid refs already folded)
    const shown = new Map<string, string>();
    if (metaAny?.title) shown.set('Name', String(metaAny.title));
    // Symbol/Footprint(/Name) attrs are raw uuids — the resolved rows below show
    // their titles, so echoing the uuids would just repeat each entry twice
    const folded = new Set(['3D Model Title', 'Symbol', 'Footprint', 'SymbolName', 'FootprintName']);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === '3D Model') {
        const title = typeof attrs['3D Model Title'] === 'string' ? (attrs['3D Model Title'] as string) : undefined;
        const s = this.model3dTitle(title, v == null ? '' : String(v));
        if (s) shown.set(k, s);
        continue;
      }
      if (folded.has(k)) continue;
      const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (s) shown.set(k, k === 'Device' ? this.libTitle(s) : s);
    }
    const sym = resolveLibGraphics(opened.libs, opened.self, 'Symbol');
    const fp = resolveLibGraphics(opened.libs, opened.self, 'Footprint');
    if (sym) shown.set('Symbol', String(sym.meta?.title ?? sym.uuid));
    if (fp) shown.set('Footprint', String(fp.meta?.title ?? fp.uuid));

    // ② Designator…Device first, ③ remaining translated attributes, ④ custom last
    const priority = ['Designator', 'Name', 'Value', 'Symbol', 'Footprint', '3D Model', 'Device'];
    const label = (k: string): string => { const l = attrLabel(k); return l !== k ? l : k; };
    const seen = new Set<string>();
    for (const k of priority) {
      const s = shown.get(k);
      if (!s) continue;
      row(label(k), s);
      seen.add(k);
    }
    const rest = [...shown.entries()].filter(([k]) => !seen.has(k) && !INTERNAL_ATTR_KEYS.has(k));
    const translated = rest.filter(([k]) => label(k) !== k)
      .sort((a, b) => label(a[0]).localeCompare(label(b[0]), 'zh'));
    const custom = rest.filter(([k]) => label(k) === k)
      .sort((a, b) => a[0].localeCompare(b[0]));
    for (const [k, s] of translated) row(label(k), s);
    for (const [k, s] of custom) row(k, s);
    this.host.appendChild(table);
  }
}
