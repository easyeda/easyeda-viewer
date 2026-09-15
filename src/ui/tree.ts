/**
 * Panel widgets: document tree (top-left), grouped object tree (bottom-left),
 * layer list with eye toggles (bottom-right). All plain DOM.
 */
import type { TreeNode } from '../core/types';
import { icon, edaIcon } from './icons';
import { t, typeLabel } from './i18n';

/** icon for a tree node — official EasyEDA glyphs where they fit (#28) */
function nodeIcon(node: TreeNode): string {
  switch (node.kind) {
    case 'board': return edaIcon('project', 14);
    case 'schematic': case 'sheet': return edaIcon('schematic', 14);
    case 'pcb': return edaIcon('pcb', 14);
    case 'panel': return edaIcon('panel', 14);
    case 'simGroup': case 'simPage': return icon('activity', 14);
    case 'libGroup': return edaIcon('library', 14);
    case 'lib':
      // footprint vs symbol library gets its matching glyph
      if ((node.docType ?? '').includes('FOOTPRINT')) return edaIcon('footprint', 14);
      if ((node.docType ?? '').includes('SYMBOL')) return edaIcon('symbol', 14);
      return edaIcon('device', 14);
    default: return icon('file', 14);
  }
}
const KIND_TINT: Record<string, string> = {
  schematic: 'ev-tint-sch', sheet: 'ev-tint-sch', pcb: 'ev-tint-pcb',
  panel: 'ev-tint-panel', simGroup: 'ev-tint-sim', simPage: 'ev-tint-sim',
  libGroup: 'ev-tint-lib', lib: 'ev-tint-lib',
};

export interface TreeCallbacks {
  /** user clicked a node; openable handling decided by caller */
  onNode(node: TreeNode): void;
}

export class DocTreeView {
  private host: HTMLElement;
  private search: HTMLInputElement;
  private ul: HTMLUListElement;
  private cb: TreeCallbacks;
  private rows = new Map<string, HTMLLIElement>();
  private nodes: TreeNode[] = [];
  private openables = new Set<string>();
  private query = '';

  constructor(host: HTMLElement, cb: TreeCallbacks) {
    this.cb = cb;
    this.host = host;
    this.host.innerHTML = '';
    this.search = document.createElement('input');
    this.search.type = 'search';
    this.search.className = 'ev-search';
    this.search.placeholder = t('searchPh');
    this.search.addEventListener('input', () => {
      this.query = this.search.value.trim().toLowerCase();
      this.render();
    });
    this.ul = document.createElement('ul');
    this.ul.className = 'ev-tree';
    this.host.append(this.search, this.ul);
  }

  setTree(nodes: TreeNode[], openables: Set<string>): void {
    this.nodes = nodes;
    this.openables = openables;
    this.render();
  }

  private render(): void {
    this.ul.innerHTML = '';
    this.rows.clear();
    for (const n of this.nodes) {
      const li = this.buildRow(n, true);
      if (li) this.ul.appendChild(li);
    }
  }

  private matches(node: TreeNode): boolean {
    if (!this.query) return true;
    if (node.title.toLowerCase().includes(this.query)) return true;
    return (node.children ?? []).some((c) => this.matches(c));
  }

  private buildRow(node: TreeNode, forceOpen: boolean): HTMLLIElement | null {
    if (!this.matches(node)) return null;
    const li = document.createElement('li');
    this.rows.set(node.id, li);
    const row = document.createElement('div');
    row.className = 'ev-tree-row';
    if (this.openables.has(node.id)) row.classList.add('ev-openable');

    const kids = node.children ?? [];
    let tw: HTMLSpanElement | null = null;
    let ul: HTMLUListElement | null = null;
    if (kids.length) {
      tw = document.createElement('span');
      tw.className = 'ev-twisty';
      tw.innerHTML = icon('chevronRight', 14);
      ul = document.createElement('ul');
      ul.style.display = 'none';
    } else {
      tw = document.createElement('span');
      tw.className = 'ev-twisty ev-twisty-leaf';
    }
    row.appendChild(tw);

    const ico = document.createElement('span');
    ico.className = 'ev-tree-ico' + (KIND_TINT[node.kind] ? ' ' + KIND_TINT[node.kind] : '');
    ico.innerHTML = nodeIcon(node);
    row.appendChild(ico);

    const label = document.createElement('span');
    label.className = 'ev-tree-label';
    label.innerHTML = highlightHtml(node.title, this.query);
    label.title = node.title;
    row.appendChild(label);
    li.appendChild(row);
    row.onclick = () => this.cb.onNode(node);

    if (ul) {
      const setOpen = (open: boolean): void => {
        tw!.classList.toggle('ev-open', open);
        ul!.style.display = open ? '' : 'none';
      };
      // searching auto-expands; otherwise keep the previous light heuristics
      let open = !!this.query || kids.length <= 3 || node.kind === 'schematic' || forceOpen && node.kind === 'board';
      setOpen(open);
      tw!.onclick = (e) => {
        e.stopPropagation();
        open = !open;
        setOpen(open);
      };
      for (const c of kids) {
        const cl = this.buildRow(c, false);
        if (cl) ul.appendChild(cl);
      }
      li.appendChild(ul);
    }
    return li;
  }

  highlight(nodeId: string | null): void {
    for (const [, el] of this.rows) el.firstElementChild?.classList.remove('ev-active');
    if (nodeId) {
      const el = this.rows.get(nodeId);
      el?.firstElementChild?.classList.add('ev-active');
      el?.scrollIntoView({ block: 'nearest' });
    }
  }
}

export interface ObjectRow {
  id: string;
  /** record type — used for grouping (translated headers) */
  type: string;
  /** display text: designator for components, id for everything else */
  label: string;
  color?: string;
}

/** flat component list of the current doc, naturally sorted by designator (#6/#12) */
export class ObjectListView {
  private host: HTMLElement;
  private search: HTMLInputElement;
  private listEl = document.createElement('ul');
  private rows = new Map<string, HTMLLIElement>();
  private items: ObjectRow[] = [];
  private query = '';

  constructor(host: HTMLElement, private cb: { onPick(id: string): void }) {
    this.host = host;
    this.host.innerHTML = '';
    this.search = document.createElement('input');
    this.search.type = 'search';
    this.search.className = 'ev-search';
    this.search.placeholder = t('searchPh');
    this.search.addEventListener('input', () => {
      this.query = this.search.value.trim().toLowerCase();
      this.render();
    });
    this.listEl.className = 'ev-objlist';
    this.host.append(this.search, this.listEl);
  }

  setObjects(items: ObjectRow[]): void {
    this.items = items;
    this.render();
  }

  private render(): void {
    this.listEl.innerHTML = '';
    this.rows.clear();
    let visible = 0;
    for (const it of this.items) {
      if (this.query && !it.label.toLowerCase().includes(this.query)) continue;
      visible++;
      const li = document.createElement('li');
      li.className = 'ev-obj-row';
      li.innerHTML = highlightHtml(it.label, this.query);
      li.title = it.label;
      if (it.color) li.style.borderLeftColor = it.color;
      li.onclick = () => { this.select(it.id); this.cb.onPick(it.id); };
      this.rows.set(it.id, li);
      this.listEl.appendChild(li);
    }
    if (!visible) {
      const hint = document.createElement('li');
      hint.className = 'ev-hint';
      hint.textContent = t('noObjects');
      this.listEl.appendChild(hint);
    }
  }

  select(id: string | null): void {
    for (const [, el] of this.rows) el.classList.remove('ev-active');
    if (id) {
      const el = this.rows.get(id);
      el?.classList.add('ev-active');
      el?.scrollIntoView({ block: 'nearest' });
    }
  }
}

/** layer toggles — eye icons, only layers that actually contain objects (#19) */
export class LayerListView {
  private host: HTMLElement;
  constructor(host: HTMLElement, private cb: { onToggle(id: string, show: boolean): void }) {
    this.host = host;
  }
  setLayers(items: { id: string; name: string; color: string; show: boolean; count: number }[], isSch = false): void {
    this.host.innerHTML = '';
    const rows = items.filter((l) => l.count > 0);
    for (const l of rows) {
      const row = document.createElement('div');
      row.className = 'ev-layer-row' + (l.show ? ' ev-on' : ' ev-off');
      const eye = document.createElement('button');
      eye.className = 'ev-btn ev-btn-icon ev-layer-eye';
      eye.innerHTML = icon(l.show ? 'eye' : 'eyeOff', 14);
      if (!l.show) eye.classList.add('ev-off');
      eye.onclick = () => {
        const next = !l.show;
        l.show = next;
        eye.innerHTML = icon(next ? 'eye' : 'eyeOff', 14);
        eye.classList.toggle('ev-off', !next);
        row.classList.toggle('ev-on', next);
        row.classList.toggle('ev-off', !next);
        this.cb.onToggle(l.id, next);
      };
      const sw = document.createElement('span');
      sw.className = 'ev-layer-swatch';
      sw.style.background = l.color;
      const name = document.createElement('span');
      name.className = 'ev-layer-name';
      name.textContent = l.name;
      const cnt = document.createElement('em');
      cnt.textContent = String(l.count);
      row.append(eye, sw, name, cnt);
      this.host.appendChild(row);
    }
    if (!rows.length) {
      const hint = document.createElement('div');
      hint.className = 'ev-hint';
      hint.textContent = isSch ? t('layerEmptyDoc') : t('noLayers');
      this.host.appendChild(hint);
    }
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Escape `text`, then wrap case-insensitive occurrences of `query` in `<mark>`. */
export function highlightHtml(text: string, query: string): string {
  if (!query) return escapeHtml(text);
  const re = new RegExp(`(${escapeRegExp(query)})`, 'gi');
  return escapeHtml(text).replace(re, '<mark class="ev-hl">$1</mark>');
}
