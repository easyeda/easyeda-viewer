/**
 * Properties panel — curated, translated, decoded view of the selection (#1/#7/#29/#31).
 * Shows what a normal user cares about (designator, shape, size, layer, net,
 * drill, text…) instead of every raw record field. No path data, no raw line.
 */
import type { RenderObject, RenderLayer } from '../core/render/layers';
import type { OpenedDoc, TreeNode } from '../core/types';
import { collectAttrs, resolveAttrRef, resolveLibGraphics } from '../core/model';
import { t, typeLabel, attrLabel, valueLabel } from './i18n';

const FLAG_KEYS = new Set(['lock', 'ratelock', 'bold', 'reverse', 'mirror', 'closed', 'displayFill', 'displayStroke', 'pourFill', 'valueVisible']);

function fmt(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  return String(Math.round(v * 1000) / 1000);
}
const mil = (n: unknown): string => `${fmt(n)} ${t('mil')}`;

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
    const d = obj.rec.data ?? {};

    const head = document.createElement('div');
    head.className = 'ev-props-head';
    head.textContent = typeLabel(obj.rec.type);
    this.host.appendChild(head);

    const table = document.createElement('table');
    table.className = 'ev-props-table';
    const row = (k: string, v: string, swatch?: string): void => {
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
    const colorRow = (k: string, v: unknown): void => {
      if (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)) row(k, v.toUpperCase(), v);
    };
    const layerRow = (id: unknown): void => {
      if (id == null || id === '') return;
      const key = String(Array.isArray(id) ? id.join(',') : id);
      row(attrLabel('layerId'), this.layerNames.get(key) ?? `#${key}`);
    };

    const num = (s: unknown): boolean => s != null && s !== '' && Number.isFinite(Number(s));
    const used = new Set<string>();

    // ---------- identity ----------
    if (obj.rec.type === 'COMPONENT' && this.opened) {
      this.renderComponent(table, obj.rec, used);
    } else {
      if (obj.title) row(attrLabel('designator'), obj.title);
      const compAttrs = d.attrs;
      if (compAttrs && typeof compAttrs === 'object') {
        for (const [k, v] of Object.entries(compAttrs)) {
          if (typeof v === 'string' && v && k !== 'Designator') row(attrLabel(k) !== k ? attrLabel(k) : k, v);
        }
        used.add('attrs');
      }
      if (typeof d.text === 'string' && d.text) { row(attrLabel('text'), d.text); used.add('text'); }
      if (d.value != null && String(d.value) !== '') { row(attrLabel('value'), valueLabel(d.value)); used.add('value'); }
      if (d.num != null && String(d.num) !== '') { row(attrLabel('num'), String(d.num)); used.add('num'); }
      if (typeof d.name === 'string' && d.name) { row(attrLabel('name'), d.name); used.add('name'); }
    }

    // ---------- geometry ----------
    if (num(d.x) && num(d.y)) {
      if (num(d.x2)) {
        row('X₁ / Y₁', `${fmt(d.x)}, ${fmt(d.y)}`);
        row('X₂ / Y₂', `${fmt(d.x2)}, ${fmt(d.y2)}`);
        used.add('x'); used.add('y'); used.add('x2'); used.add('y2'); used.add('x1'); used.add('y1');
      } else if (num(d.centerX) || num(d.endX)) {
        // pad / arc / via style: center is the meaningful anchor, show endpoints too
        if (num(d.centerX)) { row('X / Y', `${fmt(d.centerX)}, ${fmt(d.centerY)}`); used.add('centerX'); used.add('centerY'); }
      } else {
        row('X / Y', `${fmt(d.x)}, ${fmt(d.y)}`);
        used.add('x'); used.add('y');
      }
    }
    if (num(d.centerX) && !used.has('centerX')) { row('X / Y', `${fmt(d.centerX)}, ${fmt(d.centerY)}`); used.add('centerX'); used.add('centerY'); }
    const dp = (d.defaultPad && typeof d.defaultPad === 'object') ? d.defaultPad : null;
    const w = dp ? dp.width : d.width, h = dp ? dp.height : d.height;
    if (num(w) && num(h) && !(obj.rec.type === 'IMAGE' || obj.rec.type === 'STRING')) {
      row(`${attrLabel('width')} × ${attrLabel('height')}`, `${mil(w)} × ${mil(h)}`);
      used.add('width'); used.add('height'); if (dp) { used.add('defaultPad'); }
    }
    if (num(d.radius)) { row(attrLabel('radius'), mil(d.radius)); used.add('radius'); }
    if (num(d.viaDiameter)) { row(attrLabel('viaDiameter'), mil(d.viaDiameter)); used.add('viaDiameter'); }
    if (num(d.holeDiameter)) { row(attrLabel('holeDiameter'), mil(d.holeDiameter)); used.add('holeDiameter'); }
    if (num(d.diameter) && !used.has('holeDiameter')) { row(attrLabel('diameter'), mil(d.diameter)); used.add('diameter'); }
    // pad shape + drill decoded from defaultPad / hole objects (#1)
    if (dp && typeof dp.padType === 'string') { row(attrLabel('padType'), valueLabel(dp.padType.toUpperCase())); used.add('padType'); }
    else if (typeof d.shape === 'string') { row(attrLabel('shape'), valueLabel(d.shape.toUpperCase())); used.add('shape'); }
    if (d.hole && typeof d.hole === 'object') {
      const ht = String(d.hole.holeType ?? 'ROUND').toUpperCase();
      const hw = Number(d.hole.width ?? 0), hh = Number(d.hole.height ?? hw);
      const size = hw === hh ? `Ø${fmt(hw)} ${t('mil')}` : `${fmt(hw)} × ${fmt(hh)} ${t('mil')}`;
      row(attrLabel('hole'), `${valueLabel(ht)} · ${size}`);
      used.add('hole');
    }
    const rot = d.rotation ?? d.padAngle ?? d.angle;
    if (num(rot) && obj.rec.type !== 'COMPONENT') {
      row(obj.rec.type === 'PAD' ? attrLabel('padAngle') : attrLabel('rotation'), `${fmt(rot)}${t('deg')}`);
      used.add('rotation'); used.add('padAngle'); used.add('angle');
    }
    if (Array.isArray(d.points) && d.points.length) { row(attrLabel('points'), `${d.points.length} × ${t('mil')}`); used.add('points'); }

    // ---------- layer & net ----------
    layerRow(d.layerId ?? d.layer);
    used.add('layerId'); used.add('layer');
    if (typeof d.net === 'string' && d.net) { row(attrLabel('net'), d.net); used.add('net'); }
    if (typeof d.netName === 'string' && d.netName) { row(attrLabel('net'), d.netName); used.add('netName'); }

    // ---------- appearance ----------
    if (num(d.strokeWidth)) { row(attrLabel('strokeWidth'), mil(d.strokeWidth)); used.add('strokeWidth'); }
    if (num(d.fontSize)) { row(attrLabel('fontSize'), mil(d.fontSize)); used.add('fontSize'); }
    colorRow(attrLabel('strokeColor'), d.strokeColor); used.add('strokeColor');
    colorRow(attrLabel('fillColor'), d.fillColor); used.add('fillColor');
    colorRow(attrLabel('color'), d.color); used.add('color');
    for (const k of FLAG_KEYS) {
      const v = d[k];
      if (v === true || v === 1 || v === '1' || v === false || v === 0 || v === '0') {
        row(attrLabel(k), t(v ? 'yes' : 'no'));
        used.add(k);
      }
    }
    if (typeof d.origin === 'string') { row(attrLabel('origin'), valueLabel(d.origin.toUpperCase())); used.add('origin'); }

    this.host.appendChild(table);
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

  /** component attribute table: merge instance ATTR records + library/device defaults, resolve ={...} refs (#2/#3) */
  private renderComponent(table: HTMLTableElement, rec: RenderObject['rec'], used: Set<string>): void {
    const entries = this.opened ? collectAttrs(rec, this.opened) : [];
    const map: Record<string, string> = {};
    for (const e of entries) if (!map[e.key] || e.source === 'instance') map[e.key] = e.value;
    const val = (k: string): string => resolveAttrRef(map, map[k]) ?? '';
    const row = (k: string, v: string): void => {
      const tr = document.createElement('tr');
      const tk = document.createElement('td'); tk.className = 'ev-k'; tk.textContent = k;
      const tv = document.createElement('td'); tv.className = 'ev-v';
      this.fillValue(tv, v);
      tr.append(tk, tv);
      table.appendChild(tr);
    };
    const displayFor = (k: string, raw: string): string => {
      if (k === '3D Model') return this.model3dTitle(val('3D Model Title') || undefined, raw);
      if (['Symbol', 'Footprint', 'Device'].includes(k)) return this.libTitle(raw);
      return raw;
    };
    const priority = ['Designator', 'Name', 'Value', 'Symbol', 'Footprint', '3D Model', 'Device'];
    const seen = new Set<string>();
    for (const k of priority) {
      const raw = val(k);
      if (!raw) continue;
      const disp = displayFor(k, raw);
      if (disp) { row(attrLabel(k), disp); seen.add(k); }
    }
    // remaining attributes (skip raw geometry/control keys already handled below;
    // "3D Model Title" is folded into the 3D-model row above)
    const skip = new Set(['x', 'y', 'rotation', 'angle', 'padAngle', 'partId', 'groupId', 'isMirror', 'isMirror', 'attrs', 'zIndex', 'locked', 'layerId', 'layer', '3D Model Title']);
    for (const e of entries) {
      if (seen.has(e.key) || skip.has(e.key)) continue;
      const v = resolveAttrRef(map, e.value);
      if (v) row(attrLabel(e.key), v);
    }
    used.add('attrs');
    used.add('Designator'); used.add('Name'); used.add('Value');
  }

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
    if (metaAny?.title) row(attrLabel('name'), String(metaAny.title));
    const attrs = metaAny?.attributes;
    if (attrs && typeof attrs === 'object') {
      // Symbol/Footprint(/Name) attrs are raw uuids — the resolved rows below show
      // their titles, so echoing the uuids would just repeat each entry twice
      const folded = new Set(['3D Model Title', 'Symbol', 'Footprint', 'SymbolName', 'FootprintName']);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === '3D Model') {
          const title = typeof attrs['3D Model Title'] === 'string' ? (attrs['3D Model Title'] as string) : undefined;
          const shown = this.model3dTitle(title, v == null ? '' : String(v));
          if (shown) row(attrLabel(k), shown);
          continue;
        }
        if (folded.has(k)) continue;
        const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
        if (k === 'Device' && s) { row(attrLabel(k), this.libTitle(s)); continue; }
        if (s) row(attrLabel(k), s);
      }
    }
    const sym = resolveLibGraphics(opened.libs, opened.self, 'Symbol');
    const fp = resolveLibGraphics(opened.libs, opened.self, 'Footprint');
    if (sym) row(attrLabel('symbol'), String(sym.meta?.title ?? sym.uuid));
    if (fp) row(attrLabel('footprint'), String(fp.meta?.title ?? fp.uuid));
    this.host.appendChild(table);
  }
}
