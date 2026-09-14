/**
 * Viewer shell: DOM layout + Leafer canvas + camera + panels wiring.
 * The single stateful component used by both main.ts (standalone page)
 * and embed.ts (programmatic API).
 */
import { Leafer, Group, Rect } from 'leafer-ui';
import '../styles.css';
import type { ProjectModel, TreeNode } from '../core/types';
import { loadFromFiles, loadFromMap } from '../core/parse/container';
import { openDoc } from '../core/model';
import { renderDoc, type RenderObject, type RenderLayer } from '../core/render/layers';
import { Camera } from './camera';
import { setupDnd, pickFiles, pickFolder, type DndController } from './dnd';
import { DocTreeView, ObjectListView, LayerListView, type ObjectRow } from './tree';
import { PropsView } from './props';
import { icon } from './icons';

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
  /** show/hide toolbar & side panels; default all true */
  chrome?: Partial<ChromeFlags>;
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
  private zoomEl: HTMLElement;
  private titleEl: HTMLElement;
  private welcomeEl: HTMLElement;
  private dnd: DndController;

  private theme: Theme;
  private flags: ChromeFlags;
  private toolbarEl: HTMLElement;
  private leftEl: HTMLElement;
  private rightEl: HTMLElement;
  private themeBtn!: HTMLButtonElement;

  private model: ProjectModel | null = null;
  private currentRoot: Group | null = null;
  private objects: RenderObject[] = [];
  private layers: RenderLayer[] = [];
  private layerVisible = new Map<string, boolean>();
  private selected: RenderObject | null = null;
  private selRect: Rect | null = null;
  private destroyed = false;

  constructor(host: HTMLElement, private events: ShellOptions = {}) {
    this.theme = events.theme === 'dark' ? 'dark' : 'light';
    this.flags = { ...FULL_CHROME, ...events.chrome };

    this.el = document.createElement('div');
    this.el.className = 'ev-shell';
    host.appendChild(this.el);

    this.el.innerHTML = `
      <div class="ev-toolbar">
        <span class="ev-brand"><span class="ev-brand-logo">${icon('waypoints', 16)}</span>EasyEDA 查看器</span>
        <button class="ev-btn" data-act="files" title="打开工程文件">${icon('folderOpen')}<span>打开文件</span></button>
        <button class="ev-btn" data-act="folder" title="打开工程文件夹">${icon('folderTree')}<span>打开文件夹</span></button>
        <span class="ev-sep"></span>
        <button class="ev-btn ev-btn-icon" data-act="zoomout" title="缩小">${icon('zoomOut')}</button>
        <span class="ev-zoom">100%</span>
        <button class="ev-btn ev-btn-icon" data-act="zoomin" title="放大">${icon('zoomIn')}</button>
        <button class="ev-btn" data-act="fit" title="缩放到全部内容">${icon('fit')}<span>适配</span></button>
        <span class="ev-title"></span>
        <button class="ev-btn ev-btn-icon" data-act="theme" title="切换明暗主题">${icon('moon')}</button>
        <button class="ev-btn ev-btn-icon" data-act="panelL" title="显示/隐藏左侧面板">${icon('panelLeft')}</button>
        <button class="ev-btn ev-btn-icon" data-act="panelR" title="显示/隐藏右侧面板">${icon('panelRight')}</button>
      </div>
      <div class="ev-body">
        <aside class="ev-left">
          <div class="ev-tabs">
            <button class="ev-tab ev-active" data-tab="tree">${icon('list', 14)}<span>文档树</span></button>
            <button class="ev-tab" data-tab="objects">${icon('box', 14)}<span>对象树</span></button>
            <button class="ev-tab" data-tab="layers">${icon('layers', 14)}<span>图层</span></button>
          </div>
          <div class="ev-pane ev-pane-tree"></div>
          <div class="ev-pane ev-pane-objects" hidden></div>
          <div class="ev-pane ev-pane-layers" hidden></div>
        </aside>
        <div class="ev-canvas">
          <div class="ev-welcome">
            <div class="ev-wz">
              <div class="ev-wz-ico">${icon('uploadCloud', 38)}</div>
              <h2>拖放 EasyEDA 工程到此处</h2>
              <p class="ev-wz-ext">.eprj3 / .epro2 工程包,或单个 .esch2 / .epcb2 / .epan2 文档</p>
              <div class="ev-wz-btns">
                <button class="ev-btn ev-btn-primary" data-wz="files">${icon('folderOpen', 15)}<span>打开文件…</span></button>
                <button class="ev-btn" data-wz="folder">${icon('folderTree', 15)}<span>打开文件夹…</span></button>
              </div>
              <p class="ev-wz-or">解析与渲染全部在本地完成,文件不会离开这台设备</p>
            </div>
          </div>
        </div>
        <aside class="ev-right"></aside>
      </div>
      <div class="ev-status">拖入 .eprj3 / .epro2 工程或单个文档文件开始</div>`;

    this.canvasHost = this.el.querySelector('.ev-canvas') as HTMLElement;
    this.statusEl = this.el.querySelector('.ev-status') as HTMLElement;
    this.zoomEl = this.el.querySelector('.ev-zoom') as HTMLElement;
    this.titleEl = this.el.querySelector('.ev-title') as HTMLElement;
    this.welcomeEl = this.el.querySelector('.ev-welcome') as HTMLElement;
    this.toolbarEl = this.el.querySelector('.ev-toolbar') as HTMLElement;
    this.leftEl = this.el.querySelector('.ev-left') as HTMLElement;
    this.rightEl = this.el.querySelector('.ev-right') as HTMLElement;
    this.themeBtn = this.el.querySelector('[data-act="theme"]') as HTMLButtonElement;

    this.leafer = new Leafer({ view: this.canvasHost, type: 'draw' });
    this.camera = new Camera(this.canvasHost, this.leafer);
    this.camera.onView = () => {
      this.zoomEl.textContent = Math.round(this.camera.scale * 100) + '%';
      this.updateSelStroke();
    };
    this.overlay = new Group({ hittable: false });
    this.camera.world.add(this.overlay);

    const treePane = this.el.querySelector('.ev-pane-tree') as HTMLElement;
    const objPane = this.el.querySelector('.ev-pane-objects') as HTMLElement;
    const layerPane = this.el.querySelector('.ev-pane-layers') as HTMLElement;

    this.docTree = new DocTreeView(treePane, { onNode: (n) => this.onTreeNode(n) });
    this.objList = new ObjectListView(objPane, { onPick: (id) => this.pickObject(id, true) });
    this.layerList = new LayerListView(layerPane, {
      onToggle: (id, show) => {
        this.layerVisible.set(id, show);
        const l = this.layers.find((x) => x.id === id);
        if (l) l.group.visible = show;
      },
    });
    this.props = new PropsView(this.rightEl);

    this.el.querySelectorAll('.ev-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.el.querySelectorAll('.ev-tab').forEach((t) => t.classList.remove('ev-active'));
        tab.classList.add('ev-active');
        const which = (tab as HTMLElement).dataset.tab;
        for (const p of ['tree', 'objects', 'layers']) {
          (this.el.querySelector(`.ev-pane-${p}`) as HTMLElement).hidden = p !== which;
        }
      });
    });

    const openFiles = async (files: File[]) => { if (files.length) await this.loadFiles(files); };
    this.el.querySelectorAll('[data-act="files"],[data-wz="files"]').forEach((b) =>
      b.addEventListener('click', () => void pickFiles().then(openFiles)));
    this.el.querySelectorAll('[data-act="folder"],[data-wz="folder"]').forEach((b) =>
      b.addEventListener('click', () => void pickFolder().then(openFiles)));
    this.el.querySelector('[data-act="zoomin"]')!.addEventListener('click', () => this.zoomStep(1.25));
    this.el.querySelector('[data-act="zoomout"]')!.addEventListener('click', () => this.zoomStep(0.8));
    this.el.querySelector('[data-act="fit"]')!.addEventListener('click', () => this.fitCurrent());
    this.themeBtn.addEventListener('click', () => this.setTheme(this.theme === 'dark' ? 'light' : 'dark'));
    this.el.querySelector('[data-act="panelL"]')!.addEventListener('click', () => this.setChrome({ left: !this.flags.left }));
    this.el.querySelector('[data-act="panelR"]')!.addEventListener('click', () => this.setChrome({ right: !this.flags.right }));

    this.canvasHost.addEventListener('pointerup', (e) => this.onCanvasClick(e));

    this.dnd = setupDnd(this.el, {
      onFiles: (fs) => void this.loadFiles(fs),
      onDragState: (active) => this.el.querySelector('.ev-wz')?.classList.toggle('ev-dragover', active),
    });

    this.applyTheme();
    this.applyChrome();
    this.events.onReady?.();
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
    this.applyChrome();
  }

  getChrome(): ChromeFlags {
    return { ...this.flags };
  }

  private applyTheme(): void {
    this.el.dataset.theme = this.theme;
    this.themeBtn.innerHTML = icon(this.theme === 'dark' ? 'sun' : 'moon');
  }

  private applyChrome(): void {
    this.toolbarEl.classList.toggle('ev-hidden', !this.flags.toolbar);
    this.leftEl.classList.toggle('ev-hidden', !this.flags.left);
    this.rightEl.classList.toggle('ev-hidden', !this.flags.right);
    this.statusEl.classList.toggle('ev-hidden', !this.flags.status);
    (this.el.querySelector('[data-act="panelL"]') as HTMLElement).classList.toggle('ev-on', this.flags.left);
    (this.el.querySelector('[data-act="panelR"]') as HTMLElement).classList.toggle('ev-on', this.flags.right);
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
    this.setStatus('加载失败:' + e.message, true);
    this.events.onError?.(e);
  }

  private setModel(model: ProjectModel): void {
    this.model = model;
    this.welcomeEl.classList.add('ev-hidden');
    this.titleEl.innerHTML = `<b>${escapeHtml(model.name)}</b> · ${model.format}`;
    const openables = new Set(model.openables.keys());
    this.docTree.setTree(model.tree, openables);
    this.setStatus(
      `已加载 ${model.format} 工程:${model.openables.size} 个可打开文档,${model.files.size} 个文件。点击左侧文档树打开。`,
    );
    this.events.onLoaded?.(model);
    // auto-open the first openable node (usually first sheet / pcb)
    const first = model.openables.values().next().value;
    if (first) this.openNode(first);
  }

  // ---------- doc rendering ----------

  openNode(node: TreeNode): void {
    if (!this.model || !node.fileKey || !node.uuid) return;
    try {
      const opened = openDoc(this.model, node);
      const result = renderDoc(opened);
      this.currentRoot?.remove();
      this.camera.world.add(result.root);
      this.currentRoot = result.root;
      this.objects = result.objects;
      this.layers = result.layers;
      this.layerVisible = new Map(this.layers.map((l) => [l.id, l.show]));
      // canvas keeps the document's native background regardless of UI theme
      this.canvasHost.dataset.kind = docKind(node.docType ?? '');
      // prefer what actually rendered (panel outline etc. are not data records)
      this.camera.fit(this.objBBoxUnion() ?? opened.bbox);
      this.select(null);
      this.docTree.highlight(node.id);

      const rows: ObjectRow[] = this.objects.map((o) => ({
        id: o.id,
        label: o.title && o.title !== o.id ? `${o.label} — ${o.title}` : o.label,
      }));
      this.objList.setObjects(rows);
      this.layerList.setLayers(this.layers.map((l) => ({ id: l.id, name: l.name, color: l.color, show: l.show, count: l.count })));

      const notes: string[] = [];
      if (result.diagnostics.length) notes.push(result.diagnostics.slice(0, 3).join(';') + (result.diagnostics.length > 3 ? '…' : ''));
      if (result.report.badLines.length) notes.push(`${result.report.badLines.length} 行解析失败`);
      if (result.report.placeholders) notes.push(`${result.report.placeholders} 个占位符`);
      if (result.report.unknownTypes.length) notes.push(`未支持类型: ${result.report.unknownTypes.slice(0, 6).join(', ')}`);
      this.setStatus(`${node.title}:${this.objects.length} 个对象,${this.layers.length} 个图层${notes.length ? ' — ' + notes.join(' | ') : ''}`);
    } catch (err) {
      this.fail(err);
    }
  }

  private onTreeNode(node: TreeNode): void {
    if (this.model?.openables.has(node.id)) this.openNode(node);
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
    if (this.camera.didPan) return;
    const r = this.canvasHost.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const wx = (px - this.camera.tx) / this.camera.scale;
    const wy = (py - this.camera.ty) / this.camera.scale;
    let best: RenderObject | null = null;
    let bestArea = Infinity;
    for (const o of this.objects) {
      if (!o.bbox) continue;
      // skip objects on hidden layers (PCB objects live in layer groups keyed by layerId)
      const lid = o.rec.data.layerId;
      if (lid != null && this.layerVisible.get(String(lid)) === false) continue;
      const b = o.bbox;
      if (wx >= b.minX && wx <= b.maxX && wy >= b.minY && wy <= b.maxY) {
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
        strokeDashArray: [6, 4], fill: 'none', hittable: false,
      } as any);
      this.overlay.add(this.selRect);
    }
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
function docKind(docType: string): 'sch' | 'pcb' | 'panel' | 'other' {
  if (docType === 'PCB') return 'pcb';
  if (docType === 'PANEL') return 'panel';
  if (docType.startsWith('SCH') || docType.startsWith('SIM')) return 'sch';
  return 'other';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
