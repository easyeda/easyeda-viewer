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
    case 'libGroup':
      // the three library sub-groups get their own glyph; only the umbrella
      // "Library" node uses the library icon (#lib-12)
      if (node.title === '符号') return edaIcon('symbol', 14);
      if (node.title === '封装') return edaIcon('footprint', 14);
      if (node.title === '器件') return edaIcon('device', 14);
      return edaIcon('library', 14);
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
  private nodeById = new Map<string, TreeNode>();
  private nodes: TreeNode[] = [];
  private openables = new Set<string>();
  private query = '';
  private selectedId: string | null = null;

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
    // ArrowUp/ArrowDown walk the VISIBLE rows (collapsed sub-trees are skipped)
    // and pick each node, like the component list (#kbd-tree)
    this.ul.tabIndex = 0;
    this.ul.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const ids = [...this.rows.entries()].filter(([, el]) => el.offsetParent !== null).map(([id]) => id);
      if (!ids.length) return;
      const cur = ids.indexOf(this.selectedId ?? '');
      const next = e.key === 'ArrowDown' ? Math.min(cur + 1, ids.length - 1) : Math.max(cur - 1, 0);
      const id = ids[cur < 0 ? (e.key === 'ArrowDown' ? 0 : ids.length - 1) : next];
      this.highlight(id);
      const node = this.nodeById.get(id);
      if (node) this.cb.onNode(node);
    });
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
    this.nodeById.clear();
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
    this.nodeById.set(node.id, node);
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
    row.onclick = () => { this.ul.focus(); this.cb.onNode(node); };

    if (ul) {
      const setOpen = (open: boolean): void => {
        tw!.classList.toggle('ev-open', open);
        ul!.style.display = open ? '' : 'none';
      };
      // searching auto-expands; by default only the board and its schematic
      // containers start open — PCB / panel / library / simulation stay collapsed
      let open = !!this.query || node.kind === 'schematic' || (forceOpen && node.kind === 'board');
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
    this.selectedId = nodeId; // anchor for ArrowUp/ArrowDown
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
  /** schematic-wide list: tree-node id of the page owning the component */
  pageNodeId?: string;
}

/** flat component list of the current doc, naturally sorted by designator (#6/#12);
 *  ArrowUp/ArrowDown walk the visible rows and pick each one */
export class ObjectListView {
  private host: HTMLElement;
  private search: HTMLInputElement;
  private listEl = document.createElement('ul');
  private rows = new Map<string, HTMLLIElement>();
  private items: ObjectRow[] = [];
  private query = '';
  private selectedId: string | null = null;

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
    this.listEl.tabIndex = 0;
    this.listEl.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const ids = [...this.rows.keys()]; // visible, in render order
      if (!ids.length) return;
      const cur = ids.indexOf(this.selectedId ?? '');
      const next = e.key === 'ArrowDown' ? Math.min(cur + 1, ids.length - 1) : Math.max(cur - 1, 0);
      const id = ids[cur < 0 ? (e.key === 'ArrowDown' ? 0 : ids.length - 1) : next];
      this.select(id);
      this.cb.onPick(id);
    });
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
    this.selectedId = id;
    for (const [, el] of this.rows) el.classList.remove('ev-active');
    if (id) {
      const el = this.rows.get(id);
      el?.classList.add('ev-active');
      el?.scrollIntoView({ block: 'nearest' });
    }
  }
}

/** layer toggles — eye icons, only layers that actually contain objects (#19);
 *  a header eye shows/hides every layer at once */
export class LayerListView {
  private host: HTMLElement;
  /** currently highlighted (active) layer row — clicking a row raises that
   *  layer's group to the top of the paint order (#active-layer) */
  private activeId: string | null = null;
  constructor(host: HTMLElement, private cb: { onToggle(id: string, show: boolean): void; onToggleAll(show: boolean): void; onActivate?(id: string): void; onReset?: () => void }) {
    this.host = host;
  }
  /** clear the highlighted (active) layer row highlight */
  clearActive(): void {
    this.activeId = null;
    this.host.querySelector('.ev-layer-row.ev-active')?.classList.remove('ev-active');
  }
  /** programmatically set the highlighted (active) layer row — used by the
   *  shell's default top-layer activation on doc open (#default-top-layer) */
  setActive(id: string | null): void {
    this.activeId = id;
    for (const el of this.host.querySelectorAll('.ev-layer-row.ev-active')) el.classList.remove('ev-active');
    if (id) this.host.querySelector(`.ev-layer-row[data-id="${CSS.escape(id)}"]`)?.classList.add('ev-active');
  }
  setLayers(items: { id: string; name: string; color: string; show: boolean; count: number }[], isSch = false): void {
    this.host.innerHTML = '';
    if (this.activeId && !items.some((l) => l.id === this.activeId)) this.activeId = null;
    const rows = items.filter((l) => l.count > 0);
    if (rows.length) {
      const anyOn = rows.some((l) => l.show);
      const head = document.createElement('div');
      head.className = 'ev-layer-head';
      const all = document.createElement('button');
      all.className = 'ev-btn ev-btn-icon ev-layer-eye';
      all.innerHTML = icon(anyOn ? 'eyeOff' : 'eye', 14);
      all.title = t(anyOn ? 'layerHideAll' : 'layerShowAll');
      all.onclick = () => this.cb.onToggleAll(!anyOn);
      const lbl = document.createElement('span');
      lbl.className = 'ev-layer-name';
      lbl.textContent = t('paneLayers');
      const reset = document.createElement('button');
      reset.className = 'ev-btn ev-btn-icon ev-layer-eye';
      reset.innerHTML = icon('rotateCcw', 13);
      reset.title = t('layerReset');
      // reset: show every layer and restore the default paint-order stack
      reset.onclick = () => {
        this.activeId = null;
        this.cb.onReset?.();
      };
      head.append(all, lbl, reset);
      this.host.appendChild(head);
    }
    for (const l of rows) {
      const row = document.createElement('div');
      row.className = 'ev-layer-row' + (l.show ? ' ev-on' : ' ev-off') + (l.id === this.activeId ? ' ev-active' : '');
      row.dataset.id = l.id; // 供 setActive 编程式高亮定位(#default-top-layer)
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
      row.onclick = () => {
        // click = activate: highlight the row and raise the layer's entities
        // to the top of the stack; layers without entities keep their priority
        if (this.activeId !== l.id) {
          const prev = this.host.querySelector('.ev-layer-row.ev-active');
          prev?.classList.remove('ev-active');
          this.activeId = l.id;
          row.classList.add('ev-active');
        }
        this.cb.onActivate?.(l.id);
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
