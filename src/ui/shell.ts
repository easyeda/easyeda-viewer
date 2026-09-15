/**
 * Viewer shell: DOM layout + Leafer canvas + camera + panels wiring.
 *
 * Left column: document tree over object tree (draggable divider).
 * Right column: properties over layer list (PCB/PANEL only, draggable divider);
 * hidden until a primitive is selected or layers exist. Both columns resize.
 * The single stateful component used by main.ts (standalone) and embed.ts.
 */
import { Leafer, Group, Rect } from 'leafer-ui';
import '../styles.css';
import type { ProjectModel, TreeNode, OpenedDoc } from '../core/types';
import { loadFromFiles, loadFromMap } from '../core/parse/container';
import { openDoc, collectAttrs, resolveAttrRef, resolveLibGraphics } from '../core/model';
import { renderDoc, type RenderObject, type RenderLayer } from '../core/render/layers';
import type { Text as LeaferText } from 'leafer-ui';
import { Camera } from './camera';
import { setupDnd, pickFiles, pickFolder, type DndController } from './dnd';
import { DocTreeView, ObjectListView, LayerListView, escapeHtml, type ObjectRow } from './tree';
import { PropsView } from './props';
import { icon, easyedaMark } from './icons';
import { t, setLang as setI18nLang, getLang, type Lang } from './i18n';

export interface ShellEvents {
  onReady?(): void;
  onLoaded?(model: ProjectModel): void;
  onSelect?(obj: RenderObject | null): void;
  onError?(err: Error): void;
}

export type Theme = 'light' | 'dark';

/** Which chrome elements to render. All-off = pure canvas. */
export interface ChromeFlags {
  toolbar: boolean;
  left: boolean;
  right: boolean;
  status: boolean;
}

export interface ShellOptions extends ShellEvents {
  /** UI theme for the chrome; default 'light'. The canvas always keeps document colors. */
  theme?: Theme;
  /** pin toolbar & side panels; left/right default to auto (hidden until useful) */
  chrome?: Partial<ChromeFlags>;
  /** UI language; default 'zh' */
  lang?: Lang;
}

const FULL_CHROME: ChromeFlags = { toolbar: true, left: true, right: true, status: true };

export class Shell {
  readonly el: HTMLElement;
  private canvasHost: HTMLElement;
  private leafer: Leafer;
  private camera: Camera;
  private overlay: Group;

  private docTree: DocTreeView;
  private objList: ObjectListView;
  private layerList: LayerListView;
  private props: PropsView;
  private statusEl: HTMLElement;
  private zoomEl!: HTMLInputElement;
  private titleEl: HTMLElement;
  private welcomeEl: HTMLElement;
  private dnd: DndController;
  private leftEl: HTMLElement;
  private rightEl: HTMLElement;
  private layerPane: HTMLElement;
  private layerSplit: HTMLElement;

  private theme: Theme;
  private lang: Lang;
  private flags: ChromeFlags;
  private toolbarEl: HTMLElement;
  private themeBtn!: HTMLButtonElement;
  private langBtn!: HTMLButtonElement;
  /** null = auto behavior (hidden on welcome / until selection) */
  private leftForced: boolean | null = null;
  private rightForced: boolean | null = null;

  private model: ProjectModel | null = null;
  private currentRoot: Group | null = null;
  private objects: RenderObject[] = [];
  private layers: RenderLayer[] = [];
  private constantTexts: { node: LeaferText; basePx: number }[] = [];
  private layerVisible = new Map<string, boolean>();
  private selected: RenderObject | null = null;
  private selRect: Rect | null = null;
  private destroyed = false;

  private docLoaded = false;
  private docKind: 'sch' | 'pcb' | 'panel' | 'footprint' | 'other' = 'other';
  private curNode: TreeNode | null = null;
  private lastTree: TreeNode[] | null = null;
  private lastOpenables: Set<string> | null = null;
  private lastObjRows: ObjectRow[] = [];
  private lastLayerItems: { id: string; name: string; color: string; show: boolean; count: number }[] = [];

  constructor(host: HTMLElement, private events: ShellOptions = {}) {
    this.theme = events.theme === 'dark' ? 'dark' : 'light';
    this.flags = { ...FULL_CHROME, ...events.chrome };
    this.lang = events.lang === 'en' ? 'en' : 'zh';
    setI18nLang(this.lang);
    // explicit ?left=/?right= pin the panels; otherwise they appear on demand
    if (events.chrome && 'left' in events.chrome) this.leftForced = !!events.chrome.left;
    if (events.chrome && 'right' in events.chrome) this.rightForced = !!events.chrome.right;

    this.el = document.createElement('div');
    this.el.className = 'ev-shell';
    host.appendChild(this.el);

    this.el.innerHTML = `
      <div class="ev-toolbar">
        <span class="ev-brand"><span class="ev-brand-logo">${easyedaMark(22)}</span><span data-i18n="appTitle"></span></span>
        <button class="ev-btn ev-btn-icon" data-act="files" data-tip="tipFiles">${icon('folderOpen')}</button>
        <button class="ev-btn ev-btn-icon" data-act="folder" data-tip="tipFolder">${icon('folderTree')}</button>
        <span class="ev-sep"></span>
        <button class="ev-btn ev-btn-icon" data-act="zoomout" data-tip="tipZoomOut">${icon('zoomOut')}</button>
        <input class="ev-zoom" type="text" inputmode="decimal" spellcheck="false" data-tip="zoomPh"/>
        <button class="ev-btn ev-btn-icon" data-act="zoomin" data-tip="tipZoomIn">${icon('zoomIn')}</button>
        <button class="ev-btn ev-btn-icon" data-act="fit" data-tip="tipFit">${icon('fit')}</button>
        <span class="ev-title"></span>
        <button class="ev-btn ev-btn-icon ev-btn-lang" data-act="lang" data-tip="tipLang">${icon('globe')}<span class="ev-lang-code"></span></button>
        <button class="ev-btn ev-btn-icon" data-act="theme" data-tip="tipTheme">${icon('moon')}</button>
        <button class="ev-btn ev-btn-icon" data-act="panelL" data-tip="tipPanelL">${icon('panelLeft')}</button>
        <button class="ev-btn ev-btn-icon" data-act="panelR" data-tip="tipPanelR">${icon('panelRight')}</button>
      </div>
      <div class="ev-body">
        <aside class="ev-left">
          <div class="ev-pane ev-pane-tree"><div class="ev-pane-cap" data-i18n="paneTree"></div><div class="ev-pane-inner"></div></div>
          <div class="ev-split ev-split-h" data-sp="left" title=""></div>
          <div class="ev-pane ev-pane-objects"><div class="ev-pane-cap" data-i18n="paneObjects"></div><div class="ev-pane-inner"></div></div>
        </aside>
        <div class="ev-resize" data-side="left"></div>
        <div class="ev-canvas">
          <div class="ev-welcome">
            <div class="ev-wz">
              <div class="ev-wz-ico">${easyedaMark(64)}</div>
              <h2 data-i18n="welcomeTitle"></h2>
              <p class="ev-wz-ext" data-i18n="welcomeExt"></p>
              <div class="ev-wz-btns">
                <button class="ev-btn ev-btn-primary" data-wz="files">${icon('folderOpen', 15)}<span data-i18n="btnOpenFiles"></span></button>
                <button class="ev-btn" data-wz="folder">${icon('folderTree', 15)}<span data-i18n="btnOpenFolder"></span></button>
              </div>
              <p class="ev-wz-or" data-i18n="welcomeLocal"></p>
            </div>
          </div>
        </div>
        <div class="ev-resize" data-side="right"></div>
        <aside class="ev-right">
          <div class="ev-props-host"></div>
          <div class="ev-split ev-split-h" data-sp="right" hidden></div>
          <div class="ev-pane ev-pane-layers" hidden><div class="ev-pane-cap" data-i18n="paneLayers"></div><div class="ev-pane-inner"></div></div>
        </aside>
      </div>
      <div class="ev-status"></div>`;

    this.canvasHost = this.el.querySelector('.ev-canvas') as HTMLElement;
    this.statusEl = this.el.querySelector('.ev-status') as HTMLElement;
    this.titleEl = this.el.querySelector('.ev-title') as HTMLElement;
    this.welcomeEl = this.el.querySelector('.ev-welcome') as HTMLElement;
    this.toolbarEl = this.el.querySelector('.ev-toolbar') as HTMLElement;
    this.leftEl = this.el.querySelector('.ev-left') as HTMLElement;
    this.rightEl = this.el.querySelector('.ev-right') as HTMLElement;
    this.layerPane = this.el.querySelector('.ev-pane-layers') as HTMLElement;
    this.layerSplit = this.el.querySelector('[data-sp="right"]') as HTMLElement;
    this.themeBtn = this.el.querySelector('[data-act="theme"]') as HTMLButtonElement;
    this.langBtn = this.el.querySelector('[data-act="lang"]') as HTMLButtonElement;
    this.zoomEl = this.el.querySelector('.ev-zoom') as HTMLInputElement;

    this.leafer = new Leafer({ view: this.canvasHost, type: 'draw' });
    this.camera = new Camera(this.canvasHost, this.leafer);
    this.camera.onView = () => {
      if (document.activeElement !== this.zoomEl) this.zoomEl.value = Math.round(this.camera.scale * 100) + '%';
      this.updateSelStroke();
      // keep net/pad labels at a constant pixel size at any zoom (#11)
      for (const ct of this.constantTexts) (ct.node as unknown as { fontSize: number }).fontSize = ct.basePx / this.camera.scale;
    };
    this.overlay = new Group({ hittable: false });
    this.camera.world.add(this.overlay);

    this.docTree = new DocTreeView(this.el.querySelector('.ev-pane-tree .ev-pane-inner') as HTMLElement, { onNode: (n) => this.onTreeNode(n) });
    this.objList = new ObjectListView(this.el.querySelector('.ev-pane-objects .ev-pane-inner') as HTMLElement, { onPick: (id) => this.pickObject(id, true) });
    this.layerList = new LayerListView(this.layerPane.querySelector('.ev-pane-inner') as HTMLElement, {
      onToggle: (id, show) => {
        this.layerVisible.set(id, show);
        const l = this.layers.find((x) => x.id === id);
        if (l) l.group.visible = show;
      },
    });
    this.props = new PropsView(this.el.querySelector('.ev-props-host') as HTMLElement);

    this.bindToolbar();
    this.bindSplitters();
    this.applyI18n();

    this.canvasHost.addEventListener('pointerup', (e) => this.onCanvasClick(e));

    this.dnd = setupDnd(this.el, {
      onFiles: (fs) => void this.loadFiles(fs),
      onDragState: (active) => this.el.querySelector('.ev-wz')?.classList.toggle('ev-dragover', active),
    });

    this.applyTheme();
    this.applyChrome();
    this.events.onReady?.();
  }

  private bindToolbar(): void {
    const openFiles = async (files: File[]) => { if (files.length) await this.loadFiles(files); };
    this.el.querySelectorAll('[data-act="files"],[data-wz="files"]').forEach((b) =>
      b.addEventListener('click', () => void pickFiles().then(openFiles)));
    this.el.querySelectorAll('[data-act="folder"],[data-wz="folder"]').forEach((b) =>
      b.addEventListener('click', () => void pickFolder().then(openFiles)));
    this.el.querySelector('[data-act="zoomin"]')!.addEventListener('click', () => this.zoomStep(1.25));
    this.el.querySelector('[data-act="zoomout"]')!.addEventListener('click', () => this.zoomStep(0.8));
    this.el.querySelector('[data-act="fit"]')!.addEventListener('click', () => this.fitCurrent());
    this.el.querySelector('[data-act="lang"]')!.addEventListener('click', () => this.setLang(this.lang === 'zh' ? 'en' : 'zh'));
    this.themeBtn.addEventListener('click', () => this.setTheme(this.theme === 'dark' ? 'light' : 'dark'));
    this.el.querySelector('[data-act="panelL"]')!.addEventListener('click', () => { this.leftForced = !this.leftVisible(); this.applyChrome(); });
    this.el.querySelector('[data-act="panelR"]')!.addEventListener('click', () => { this.rightForced = !this.rightVisible(); this.applyChrome(); });

    // typed zoom percentage (#33)
    const commit = (): void => {
      const v = parseFloat(this.zoomEl.value.replace(',', '.'));
      if (Number.isFinite(v) && v > 0) {
        const w = this.canvasHost.clientWidth || 800, h = this.canvasHost.clientHeight || 600;
        this.camera.zoomAt(w / 2, h / 2, (v / 100) / this.camera.scale);
      }
      this.zoomEl.value = Math.round(this.camera.scale * 100) + '%';
    };
    this.zoomEl.addEventListener('change', commit);
    this.zoomEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
      e.stopPropagation(); // don't trigger canvas shortcuts while typing
    });
  }

  /** drag-resize: column widths + the in-column dividers (#5/#6/#30) */
  private bindSplitters(): void {
    const drag = (el: HTMLElement, onMove: (e: PointerEvent) => void): void => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        el.classList.add('ev-split-active');
        const mv = (ev: PointerEvent) => onMove(ev);
        const up = (): void => {
          el.classList.remove('ev-split-active');
          el.removeEventListener('pointermove', mv);
          el.removeEventListener('pointerup', up);
        };
        el.addEventListener('pointermove', mv);
        el.addEventListener('pointerup', up);
      });
    };
    for (const h of this.el.querySelectorAll('.ev-resize')) {
      const side = (h as HTMLElement).dataset.side;
      drag(h as HTMLElement, (e) => {
        const r = this.el.getBoundingClientRect();
        if (side === 'left') {
          const w = Math.min(Math.max(e.clientX - r.left, 170), Math.min(560, r.width * 0.5));
          this.el.style.setProperty('--ev-left-w', w + 'px');
        } else {
          const w = Math.min(Math.max(r.right - e.clientX, 200), Math.min(640, r.width * 0.55));
          this.el.style.setProperty('--ev-right-w', w + 'px');
        }
      });
    }
    for (const sp of this.el.querySelectorAll('.ev-split-h')) {
      const col = (sp as HTMLElement).parentElement as HTMLElement;
      // first child = tree pane (left) / props host (right; its class is rewritten by PropsView)
      const top = col.children[0] as HTMLElement;
      drag(sp as HTMLElement, (e) => {
        const r = col.getBoundingClientRect();
        const hgt = Math.min(Math.max(e.clientY - r.top, 60), r.height - 60);
        top.style.flex = 'none';
        top.style.height = hgt + 'px';
      });
    }
  }

  // ---------- i18n ----------

  setLang(lang: Lang): void {
    this.lang = lang === 'en' ? 'en' : 'zh';
    setI18nLang(this.lang);
    this.el.dataset.lang = this.lang;
    this.applyI18n();
    // data-driven panels need a rebuild to pick up new labels
    if (this.lastTree && this.lastOpenables) this.docTree.setTree(this.lastTree, this.lastOpenables);
    if (this.curNode) this.docTree.highlight(this.curNode.id);
    this.objList.setObjects(this.lastObjRows);
    if (this.layers.length) {
      this.layerList.setLayers(this.lastLayerItems, false);
    }
    this.props.refresh();
    this.setStatus(this.docLoaded ? t('statusInit') : t('statusInit'), false);
    if (this.model) this.announceLoaded();
    else if (this.curNode) this.announceOpened();
  }

  getLang(): Lang {
    return this.lang;
  }

  private applyI18n(): void {
    this.el.querySelectorAll('[data-i18n]').forEach((n) => {
      n.textContent = t((n as HTMLElement).dataset.i18n as string);
    });
    this.el.querySelectorAll('[data-tip]').forEach((n) => {
      n.setAttribute('title', t((n as HTMLElement).dataset.tip as string));
    });
    this.el.querySelector('.ev-lang-code')!.textContent = this.lang === 'zh' ? 'EN' : '中';
    if (!this.model && !this.curNode) this.statusEl.textContent = t('statusInit');
  }

  // ---------- theme & chrome ----------

  setTheme(theme: Theme): void {
    this.theme = theme === 'dark' ? 'dark' : 'light';
    this.applyTheme();
  }

  getTheme(): Theme {
    return this.theme;
  }

  setChrome(partial: Partial<ChromeFlags>): void {
    this.flags = { ...this.flags, ...partial };
    if ('left' in partial) this.leftForced = !!partial.left;
    if ('right' in partial) this.rightForced = !!partial.right;
    this.applyChrome();
  }

  getChrome(): ChromeFlags {
    return { ...this.flags, left: this.leftVisible(), right: this.rightVisible() };
  }

  private leftVisible(): boolean {
    return this.leftForced !== null ? this.leftForced && this.docLoaded : this.docLoaded;
  }

  private rightVisible(): boolean {
    const useful = !!this.selected || this.layers.length > 0;
    return this.rightForced !== null ? this.rightForced && this.docLoaded : this.docLoaded && useful;
  }

  private applyTheme(): void {
    this.el.dataset.theme = this.theme;
    this.themeBtn.innerHTML = icon(this.theme === 'dark' ? 'sun' : 'moon');
  }

  private applyChrome(): void {
    this.toolbarEl.classList.toggle('ev-hidden', !this.flags.toolbar);
    this.leftEl.classList.toggle('ev-hidden', !this.leftVisible());
    (this.el.querySelector('.ev-resize[data-side="left"]') as HTMLElement).classList.toggle('ev-hidden', !this.leftVisible());
    this.rightEl.classList.toggle('ev-hidden', !this.rightVisible());
    (this.el.querySelector('.ev-resize[data-side="right"]') as HTMLElement).classList.toggle('ev-hidden', !this.rightVisible());
    this.statusEl.classList.toggle('ev-hidden', !this.flags.status);
    const hasLayers = this.layers.length > 0 && (this.docKind === 'pcb' || this.docKind === 'panel' || this.docKind === 'footprint');
    this.layerPane.hidden = !hasLayers;
    this.layerSplit.hidden = !hasLayers;
    (this.el.querySelector('[data-act="panelL"]') as HTMLElement).classList.toggle('ev-on', this.leftVisible());
    (this.el.querySelector('[data-act="panelR"]') as HTMLElement).classList.toggle('ev-on', this.rightVisible());
  }

  // ---------- loading ----------

  async loadFiles(files: File[]): Promise<void> {
    try {
      const model = await loadFromFiles(files);
      this.setModel(model);
    } catch (err) {
      this.fail(err);
    }
  }

  loadMap(map: Map<string, Uint8Array>): void {
    try {
      this.setModel(loadFromMap(map));
    } catch (err) {
      this.fail(err);
    }
  }

  private fail(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    this.setStatus(t('statusFail') + e.message, true);
    this.events.onError?.(e);
  }

  private announceLoaded(): void {
    const m = this.model!;
    this.setStatus(t('statusLoaded', { fmt: m.format.toUpperCase(), docs: m.openables.size, files: m.files.size }));
  }

  private setModel(model: ProjectModel): void {
    this.model = model;
    this.docLoaded = true;
    this.welcomeEl.classList.add('ev-hidden');
    this.titleEl.innerHTML = `<b>${escapeHtml(model.name)}</b> · ${model.format}`;
    const openables = new Set(model.openables.keys());
    this.lastTree = model.tree;
    this.lastOpenables = openables;
    this.docTree.setTree(model.tree, openables);
    this.announceLoaded();
    this.events.onLoaded?.(model);
    this.applyChrome();
    // auto-open the first openable node (usually first sheet / pcb)
    const first = model.openables.values().next().value;
    if (first) this.openNode(first);
  }

  // ---------- doc rendering ----------

  private openNode(node: TreeNode): void {
    if (!this.model || !node.fileKey || !node.uuid) return;
    try {
      const opened = openDoc(this.model, node);
      const kind = docKind(node.docType ?? '');
      const result = renderDoc(opened, canvasBg(kind));
      this.currentRoot?.remove();
      this.camera.world.add(result.root);
      this.currentRoot = result.root;
      this.objects = result.objects;
      this.layers = result.layers;
      this.constantTexts = result.constantTexts as { node: LeaferText; basePx: number }[];
      this.layerVisible = new Map(this.layers.map((l) => [l.id, l.show]));
      this.curNode = node;
      this.docKind = kind;
      // canvas keeps the document's native background regardless of UI theme
      this.canvasHost.dataset.kind = kind;
      // prefer what actually rendered (panel outline etc. are not data records)
      this.camera.fit(this.objBBoxUnion() ?? opened.bbox);
      this.select(null);
      this.docTree.highlight(node.id);

      // component tree: only components, naturally sorted by designator (#6/#12)
      const rows: ObjectRow[] = [];
      for (const o of this.objects) {
        if (o.rec.type !== 'COMPONENT') continue;
        const attrs = collectAttrs(o.rec, opened);
        const map = new Map<string, string>(attrs.map((e) => [e.key, e.value]));
        const des = map.get('Designator') ?? o.title ?? o.id;
        const extraKey = map.has('Name') ? 'Name' : map.has('Value') ? 'Value' : '';
        const extra = extraKey ? resolveAttrRef(Object.fromEntries(map), map.get(extraKey)) : '';
        rows.push({
          id: o.id,
          type: o.rec.type,
          label: extra ? `${des} (${extra})` : String(des),
        });
      }
      rows.sort((a, b) => naturalDesignator(a.label, b.label));
      this.lastObjRows = rows;
      this.objList.setObjects(rows);
      if (this.docKind === 'pcb' || this.docKind === 'panel' || this.docKind === 'footprint') {
        this.lastLayerItems = this.layers.map((l) => ({ id: l.id, name: l.name, color: l.color, show: l.show, count: l.count }));
        this.layerList.setLayers(this.lastLayerItems, this.layers.length === 0);
        this.props.setLayerNames(this.layers);
      } else {
        this.lastLayerItems = [];
      }
      this.props.setOpened(opened);
      this.announceOpened(result, node);
      this.applyChrome();
    } catch (err) {
      this.fail(err);
    }
  }

  private openResult: { diagnostics: string[]; bad: number; placeholders: number; unknown: string[] } | null = null;
  private announceOpened(result?: { diagnostics: string[]; report: { badLines: unknown[]; placeholders: number; unknownTypes: string[] } }, node?: TreeNode): void {
    if (result) {
      this.openResult = {
        diagnostics: result.diagnostics,
        bad: result.report.badLines.length,
        placeholders: result.report.placeholders,
        unknown: result.report.unknownTypes,
      };
    }
    const r = this.openResult;
    const title = node ? node.title : this.curNode?.title ?? '';
    if (!r) return;
    const notes: string[] = [];
    if (r.diagnostics.length) notes.push(r.diagnostics.slice(0, 3).join(';') + (r.diagnostics.length > 3 ? '…' : ''));
    if (r.bad) notes.push(t('statusBadLines', { n: r.bad }));
    if (r.placeholders) notes.push(t('statusPlaceholders', { n: r.placeholders }));
    if (r.unknown.length) notes.push(t('statusUnknownTypes', { types: r.unknown.slice(0, 6).join(', ') }));
    const nonEmpty = this.layers.filter((l) => l.count > 0).length;
    this.setStatus(`${t('statusOpened', { title, n: this.objects.length, m: nonEmpty })}${notes.length ? ' — ' + notes.join(' | ') : ''}`);
  }

  private onTreeNode(node: TreeNode): void {
    if (!this.model) return;
    if (this.model.openables.has(node.id)) {
      this.openNode(node);
      return;
    }
    if (node.docType === 'DEVICE' && node.fileKey && node.uuid) {
      try {
        const opened = openDoc(this.model, node);
        this.props.showDevice(node, opened);
        this.rightForced = true;
        this.applyChrome();
      } catch (err) {
        this.fail(err);
      }
    }
  }

  /** open a doc node by id (also used by the postMessage bridge) */
  openNodeId(nodeId: string): boolean {
    const node = this.model?.openables.get(nodeId);
    if (!node) return false;
    this.openNode(node);
    return true;
  }

  // ---------- selection ----------

  private pickObject(id: string, center: boolean): void {
    const obj = this.objects.find((o) => o.id === id) ?? null;
    this.select(obj);
    if (obj && center && obj.bbox) {
      const b = obj.bbox;
      this.camera.centerOn((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
    }
  }

  private onCanvasClick(e: PointerEvent): void {
    if (e.button !== 0) return; // right/middle drag only pans (#8)
    if (this.camera.didPan) return;
    const r = this.canvasHost.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const wx = (px - this.camera.tx) / this.camera.scale;
    const wy = (py - this.camera.ty) / this.camera.scale;
    const tol = 6 / this.camera.scale;
    let best: RenderObject | null = null;
    let bestArea = Infinity;
    for (const o of this.objects) {
      if (!o.bbox) continue;
      // skip objects on hidden layers (PCB objects live in layer groups keyed by layerId)
      const lid = o.rec.data.layerId;
      if (lid != null && this.layerVisible.get(String(lid)) === false) continue;
      const b = o.bbox;
      if (wx >= b.minX && wx <= b.maxX && wy >= b.minY && wy <= b.maxY) {
        if (o.hit && !o.hit(wx, wy, tol)) continue; // stroke-only pick (#23)
        const area = (b.maxX - b.minX) * (b.maxY - b.minY);
        if (area < bestArea) { bestArea = area; best = o; }
      }
    }
    this.select(best);
  }

  private select(obj: RenderObject | null): void {
    this.selected = obj;
    if (this.selRect) { this.selRect.remove(); this.selRect = null; }
    this.props.show(obj);
    this.objList.select(obj?.id ?? null);
    if (obj?.bbox) {
      const b = obj.bbox;
      this.selRect = new Rect({
        x: b.minX, y: b.minY,
        width: Math.max(2, b.maxX - b.minX), height: Math.max(2, b.maxY - b.minY),
        stroke: '#ff3366', strokeWidth: 2 / this.camera.scale,
        strokeDashArray: [6, 4], fill: null, hittable: false,
      } as any);
      this.overlay.add(this.selRect);
    }
    this.applyChrome(); // properties panel appears on first pick (#1)
    this.events.onSelect?.(obj);
  }

  private updateSelStroke(): void {
    if (this.selRect) (this.selRect as any).strokeWidth = 2 / this.camera.scale;
  }

  // ---------- misc ----------

  fitCurrent(): void {
    if (this.model && this.currentRoot) {
      const b = this.objBBoxUnion();
      if (b) this.camera.fit(b);
    }
  }

  private objBBoxUnion() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const o of this.objects) {
      if (!o.bbox) continue;
      minX = Math.min(minX, o.bbox.minX); minY = Math.min(minY, o.bbox.minY);
      maxX = Math.max(maxX, o.bbox.maxX); maxY = Math.max(maxY, o.bbox.maxY);
    }
    return isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  }

  private zoomStep(factor: number): void {
    const w = this.canvasHost.clientWidth || 800, h = this.canvasHost.clientHeight || 600;
    this.camera.zoomAt(w / 2, h / 2, factor);
  }

  private setStatus(text: string, error = false): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle('ev-err', error);
  }

  getModel(): ProjectModel | null {
    return this.model;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.dnd.destroy();
    this.leafer.destroy();
    this.el.remove();
  }
}

/** canvas background family for a document type */
function docKind(docType: string): 'sch' | 'pcb' | 'panel' | 'footprint' | 'other' {
  if (docType === 'PCB') return 'pcb';
  if (docType === 'PANEL') return 'panel';
  if (docType === 'FOOTPRINT') return 'footprint';
  if (docType.startsWith('SCH') || docType.startsWith('SIM')) return 'sch';
  return 'other';
}

/** canvas bg color passed to the renderer so drill holes match it (#27) */
function canvasBg(kind: 'sch' | 'pcb' | 'panel' | 'footprint' | 'other'): string {
  if (kind === 'pcb' || kind === 'footprint') return '#14161a';
  if (kind === 'sch' || kind === 'panel') return '#ffffff';
  return '#f5f6f7';
}

/** sort designators alphabetically by prefix then numerically by suffix (#6) */
function naturalDesignator(a: string, b: string): number {
  const parse = (s: string) => {
    const m = s.match(/^([A-Za-z]+)(\d+(\.\d+)?)?/);
    return {
      prefix: (m?.[1] ?? s).toUpperCase(),
      num: m?.[2] ? Number(m[2]) : 0,
      raw: s,
    };
  };
  const aa = parse(a), bb = parse(b);
  if (aa.prefix !== bb.prefix) return aa.prefix.localeCompare(bb.prefix);
  if (aa.num !== bb.num) return aa.num - bb.num;
  return aa.raw.localeCompare(bb.raw);
}
