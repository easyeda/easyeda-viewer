/** Left-side document tree + object list renderers (plain DOM, virtual enough for MVP). */
import type { TreeNode } from '../core/types';
import { icon } from './icons';

const KIND_ICON: Record<string, string> = {
  board: 'packageOpen', schematic: 'layoutTemplate', sheet: 'fileText', pcb: 'circuitBoard',
  panel: 'box', simGroup: 'activity', simPage: 'activity', libGroup: 'library', lib: 'library',
};
/** tint classes for doc-kind icons (see styles.css) */
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
  private ul: HTMLUListElement;
  private cb: TreeCallbacks;
  private rows = new Map<string, HTMLLIElement>();

  constructor(host: HTMLElement, cb: TreeCallbacks) {
    this.cb = cb;
    this.ul = document.createElement('ul');
    this.ul.className = 'ev-tree';
    host.appendChild(this.ul);
  }

  setTree(nodes: TreeNode[], openables: Set<string>): void {
    this.ul.innerHTML = '';
    this.rows.clear();
    for (const n of nodes) this.ul.appendChild(this.buildRow(n, openables));
  }

  private buildRow(node: TreeNode, openables: Set<string>): HTMLLIElement {
    const li = document.createElement('li');
    this.rows.set(node.id, li);
    const row = document.createElement('div');
    row.className = 'ev-tree-row';
    if (openables.has(node.id)) row.classList.add('ev-openable');

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
    ico.innerHTML = icon(KIND_ICON[node.kind] ?? 'file', 14);
    row.appendChild(ico);

    const label = document.createElement('span');
    label.className = 'ev-tree-label';
    label.textContent = node.title;
    label.title = node.title;
    row.appendChild(label);
    li.appendChild(row);
    row.onclick = () => this.cb.onNode(node);

    if (ul) {
      const setOpen = (open: boolean): void => {
        tw!.classList.toggle('ev-open', open);
        ul!.style.display = open ? '' : 'none';
      };
      let open = kids.length <= 3 || node.kind === 'schematic';
      setOpen(open);
      tw!.onclick = (e) => {
        e.stopPropagation();
        open = !open;
        setOpen(open);
      };
      for (const c of kids) ul.appendChild(this.buildRow(c, openables));
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
  label: string;
  color?: string;
}

/** flat object list of the currently rendered doc */
export class ObjectListView {
  private host: HTMLElement;
  private listEl = document.createElement('ul');
  private rows = new Map<string, HTMLLIElement>();

  constructor(host: HTMLElement, private cb: { onPick(id: string): void }) {
    this.host = host;
    this.listEl.className = 'ev-objlist';
    host.appendChild(this.listEl);
  }


  setObjects(items: ObjectRow[]): void {
    this.listEl.innerHTML = '';
    this.rows.clear();
    for (const it of items) {
      const li = document.createElement('li');
      li.textContent = it.label;
      if (it.color) li.style.borderLeftColor = it.color;
      li.onclick = () => { this.select(it.id); this.cb.onPick(it.id); };
      this.rows.set(it.id, li);
      this.listEl.appendChild(li);
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

/** layer toggle list (PCB) */
export class LayerListView {
  private host: HTMLElement;
  constructor(host: HTMLElement, private cb: { onToggle(id: string, show: boolean): void }) {
    this.host = host;
  }
  setLayers(items: { id: string; name: string; color: string; show: boolean; count: number }[]): void {
    this.host.innerHTML = '';
    for (const l of items) {
      const row = document.createElement('label');
      row.className = 'ev-layer-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = l.show;
      cb.onchange = () => this.cb.onToggle(l.id, cb.checked);
      const sw = document.createElement('span');
      sw.className = 'ev-layer-swatch';
      sw.style.background = l.color;
      const name = document.createElement('span');
      name.textContent = `${l.name} (${l.count})`;
      row.append(cb, sw, name);
      this.host.appendChild(row);
    }
    if (!items.length) {
      const hint = document.createElement('div');
      hint.className = 'ev-hint';
      hint.textContent = '当前文档无图层（原理图文档）';
      this.host.appendChild(hint);
    }
  }
}
