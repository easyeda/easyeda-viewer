/**
 * Viewer shell: DOM layout + Leafer canvas + camera + panels wiring.
 *
 * Left column: document tree over object tree (draggable divider).
 * Right column: properties over layer list (PCB/PANEL only, draggable divider);
 * hidden until a primitive is selected or layers exist. Both columns resize.
 * The single stateful component used by main.ts (standalone) and embed.ts.
 */
import { Leafer, Group, Rect, Line } from 'leafer-ui';
import '../styles.css';
import type { ProjectModel, TreeNode, OpenedDoc } from '../core/types';
import { loadFromFiles, loadFromMap } from '../core/parse/container';
import { openDoc, collectAttrs, resolveAttrRef, resolveLibGraphics } from '../core/model';
import { renderDoc, pcbStackKey, type RenderObject, type RenderLayer } from '../core/render/layers';
import type { Text as LeaferText, Line as LeaferLine } from 'leafer-ui';
import { Camera } from './camera';
import { setupDnd, pickFiles, pickFolder, type DndController } from './dnd';
import { DocTreeView, ObjectListView, LayerListView, escapeHtml, type ObjectRow } from './tree';
import { PropsView } from './props';
import { MeasureController } from './measure';
import { icon, easyedaMark } from './icons';
import { t, setLang as setI18nLang, getLang, layerLabel, type Lang } from './i18n';
import { fmtCoord, getUnit, toggleUnit, unitSuffix, setDocScale, docScaleFor, onUnitChange } from './units';

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
  /** user manually zoomed/panned — suspend the resize auto-refit */
  private userView = false;
  private leafer: Leafer;
  private camera: Camera;
  private overlay: Group;
  /** document background painted inside the scene, below the world (#bg-flash) */
  private bgRect: Rect;

  private docTree: DocTreeView;
  private objList: ObjectListView;
  private layerList: LayerListView;
  private props: PropsView;
  private statusEl: HTMLElement;
  private statusPosEl: HTMLElement;
  private statusMsgEl: HTMLElement;
  private zoomEl!: HTMLInputElement;
  private titleEl: HTMLElement;
  private welcomeEl: HTMLElement;
  private loadingEl: HTMLElement;
  private loadingMsgEl: HTMLElement;
  private deviceNoteEl!: HTMLElement;
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
  private measureBtn!: HTMLButtonElement;
  private measure!: MeasureController;
  /** units 广播退订(#unit-toggle) */
  private offUnit: (() => void) | null = null;
  /** 最近一次指针的视口坐标(单位切换时据此重算状态栏坐标) */
  private lastCursor: { x: number; y: number } | null = null;
  /** null = auto behavior (hidden on welcome / until selection) */
  private leftForced: boolean | null = null;
  private rightForced: boolean | null = null;

  private model: ProjectModel | null = null;
  private currentRoot: Group | null = null;
  private objects: RenderObject[] = [];
  private layers: RenderLayer[] = [];
  private constantTexts: { node: LeaferText; basePx: number }[] = [];
  private constantStrokes: { node: LeaferLine; baseW: number }[] = [];
  private layerVisible = new Map<string, boolean>();
  private selected: RenderObject | null = null;
  /** 选中高亮图形(bbox 控制框或沿路径的高亮线,#select-box-path) */
  private selShapes: (Rect | Line)[] = [];
  /** 当前激活图层 id(图层面板点击行时的拾取优先层,#pick-active-layer) */
  private activeLayerId: string | null = null;
  private destroyed = false;

  private docLoaded = false;
  private docKind: 'sch' | 'pcb' | 'panel' | 'footprint' | 'other' = 'other';
  private curNode: TreeNode | null = null;
  private lastTree: TreeNode[] | null = null;
  private lastOpenables: Set<string> | null = null;
  private lastObjRows: ObjectRow[] = [];
  /** id signature of the rows currently in the object-list DOM (#page-switch-jank) */
  private lastRowSig = '';
  /** schematic-wide component rows cached per page node id (invalidate on model change) */
  private compRowsCache = new Map<string, ObjectRow[]>();
  /** true while the object list spans the whole owning schematic, not just the open page */
  private schematicWide = false;
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
        <button class="ev-btn ev-btn-icon" data-act="zoomin" data-tip="tipZoomIn">${icon('zoomIn')}</button>
        <button class="ev-btn ev-btn-icon" data-act="fit" data-tip="tipFit">${icon('fit')}</button>
        <input class="ev-zoom" type="text" inputmode="decimal" spellcheck="false" data-tip="zoomPh"/>
        <button class="ev-btn ev-btn-icon" data-act="measure" data-tip="tipMeasure" disabled>${icon('ruler')}</button>
        <span class="ev-title"></span>
        <button class="ev-btn ev-btn-unit" data-act="unit" data-tip="tipUnit"><span class="ev-unit-code"></span></button>
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
              <div class="ev-wz-ico">${easyedaMark(108, 80)}</div>
              <h2 data-i18n="welcomeTitle"></h2>
              <p class="ev-wz-ext" data-i18n="welcomeExt"></p>
              <div class="ev-wz-btns">
                <button class="ev-btn ev-btn-primary" data-wz="files">${icon('folderOpen', 15)}<span data-i18n="btnOpenFiles"></span></button>
                <button class="ev-btn ev-btn-secondary" data-wz="folder">${icon('folderTree', 15)}<span data-i18n="btnOpenFolder"></span></button>
              </div>
              <div class="ev-wz-foot">
                <p class="ev-wz-or" data-i18n="welcomeLocal"></p>
              </div>
            </div>
          </div>
          <div class="ev-device-note ev-hidden" data-i18n="deviceNoGraphics"></div>
        </div>
        <div class="ev-resize" data-side="right"></div>
        <aside class="ev-right">
          <div class="ev-props-host"></div>
          <div class="ev-split ev-split-h ev-hidden" data-sp="right"></div>
          <div class="ev-pane ev-pane-layers ev-hidden"><div class="ev-pane-cap" data-i18n="paneLayers"></div><div class="ev-pane-inner"></div></div>
        </aside>
      </div>
      <div class="ev-status"><span class="ev-status-pos"></span><span class="ev-status-msg"></span></div>
      <div class="ev-loading ev-hidden"><div class="ev-loading-box"><div class="ev-loading-spin"></div><span class="ev-loading-msg"></span></div></div>`;

    this.canvasHost = this.el.querySelector('.ev-canvas') as HTMLElement;
    this.statusEl = this.el.querySelector('.ev-status') as HTMLElement;
    this.statusPosEl = this.el.querySelector('.ev-status-pos') as HTMLElement;
    this.statusMsgEl = this.el.querySelector('.ev-status-msg') as HTMLElement;
    this.titleEl = this.el.querySelector('.ev-title') as HTMLElement;
    this.welcomeEl = this.el.querySelector('.ev-welcome') as HTMLElement;
    this.loadingEl = this.el.querySelector('.ev-loading') as HTMLElement;
    this.loadingMsgEl = this.el.querySelector('.ev-loading-msg') as HTMLElement;
    this.deviceNoteEl = this.el.querySelector('.ev-device-note') as HTMLElement;
    this.toolbarEl = this.el.querySelector('.ev-toolbar') as HTMLElement;
    this.leftEl = this.el.querySelector('.ev-left') as HTMLElement;
    this.rightEl = this.el.querySelector('.ev-right') as HTMLElement;
    this.layerPane = this.el.querySelector('.ev-pane-layers') as HTMLElement;
    this.layerSplit = this.el.querySelector('[data-sp="right"]') as HTMLElement;
    this.themeBtn = this.el.querySelector('[data-act="theme"]') as HTMLButtonElement;
    this.langBtn = this.el.querySelector('[data-act="lang"]') as HTMLButtonElement;
    this.measureBtn = this.el.querySelector('[data-act="measure"]') as HTMLButtonElement;
    this.zoomEl = this.el.querySelector('.ev-zoom') as HTMLInputElement;

    this.leafer = new Leafer({ view: this.canvasHost, type: 'draw' });
    (window as any).__ev = { root: this.leafer, shell: this }; // QA dump hook
    this.camera = new Camera(this.canvasHost, this.leafer);
    // document background lives INSIDE the leafer scene (a viewport-sized rect
    // under the world), not CSS: a CSS class swap turns the host dark
    // immediately while leafer still shows the previous frame — switching
    // SCH → PCB flashed a dark schematic for one frame. Changing this rect's
    // fill in the same task as the root swap repaints background + content
    // atomically in leafer's next frame (#bg-flash). leafer.fill does NOT
    // paint with type:'draw' (verified) — hence the rect.
    this.bgRect = new Rect({ name: 'doc-bg', fill: '#f5f6f7', width: 1, height: 1, hittable: false });
    this.leafer.add(this.bgRect);
    this.leafer.add(this.camera.world); // keep the world above the bg rect
    this.camera.onView = () => {
      if (document.activeElement !== this.zoomEl) this.zoomEl.value = Math.round(this.camera.scale * 100) + '%';
      this.updateSelStroke();
      // constant-pixel texts (registered via addConstantText) keep their screen
      // size at any zoom; PCB labels are doc-scaled now and don't register
      for (const ct of this.constantTexts) (ct.node as unknown as { fontSize: number }).fontSize = ct.basePx / this.camera.scale;
      // keep origin axes at a constant pixel width at any zoom (#11)
      for (const cs of this.constantStrokes) cs.node.strokeWidth = cs.baseW / this.camera.scale;
      // measure rulers re-project on every view change (#measure)
      this.measure?.redraw();
    };
    this.overlay = new Group({ hittable: false });
    this.camera.world.add(this.overlay);

    // measure tool (#measure): PCB-family docs only; the overlay canvas lives
    // in .ev-canvas and paints in screen space (see ui/measure.ts)
    this.measure = new MeasureController({
      host: this.canvasHost,
      camera: this.camera,
      onActive: (active) => {
        this.measureBtn.classList.toggle('ev-on', active);
        if (active) this.setStatus(t('measureHint'), false);
        else if (this.model && this.curNode) {
          if (this.openResult) this.announceOpened();
          else this.announceLoaded();
        }
      },
    });

    this.docTree = new DocTreeView(this.el.querySelector('.ev-pane-tree .ev-pane-inner') as HTMLElement, { onNode: (n) => this.onTreeNode(n) });
    this.objList = new ObjectListView(this.el.querySelector('.ev-pane-objects .ev-pane-inner') as HTMLElement, { onPick: (id) => void this.pickObject(id, true) });
    this.layerList = new LayerListView(this.layerPane.querySelector('.ev-pane-inner') as HTMLElement, {
      onToggle: (id, show) => {
        this.layerVisible.set(id, show);
        const l = this.layers.find((x) => x.id === id);
        if (l) l.group.visible = show;
      },
      onToggleAll: (show) => {
        for (const it of this.lastLayerItems) {
          if (it.count <= 0) continue;
          it.show = show;
          this.layerVisible.set(it.id, show);
          const l = this.layers.find((x) => x.id === it.id);
          if (l) l.group.visible = show;
        }
        this.layerList.setLayers(this.lastLayerItems, this.layers.length === 0);
      },
      // 点击行 = 激活层 (#active-layer):有实体图元的层把它的层组临时提到
      // 最前(重新 add 即移动到末尾 = 绘制顺序最上,与 renderDoc 的重排同一
      // 机制);没有实体图元的层优先级不变。选择框 overlay 挂在 doc root 之外,
      // 不会被动。
      // 活跃层只盖住同层面的图元:钻孔层(孔永远可见)与多层铜皮(永远在
      // 最上)连同其上的板框/工具层一起按栈序重新压回;再把活跃面的焊盘
      // 编号 / 网络名标注置顶 —— 切顶层 → 顶层标注,切底层 → 底层标注。
      onActivate: (id) => {
        // 记住激活层,画布点选命中重叠图元时优先拾取它(#pick-active-layer)
        this.activeLayerId = id;
        const l = this.layers.find((x) => x.id === id);
        if (!l || l.count <= 0 || !this.currentRoot) return;
        const root = this.currentRoot;
        // 先整体按栈序归位:撤销上一次激活遗留的置顶 —— 只提不沉会让切换
        // 面层后,对面标注层(如切过底层再切顶层时的底层网络名)一直压在
        // 最上,不再被顶层/内层铜皮遮挡
        for (const x of [...this.layers].sort((a, b) => pcbStackKey(a) - pcbStackKey(b))) root.add(x.group);
        root.add(l.group);
        // 只有必须常驻顶部的层(多层铜皮 470 / 板框 8000 / 原点轴 9000 / 飞线
        // 9100 / 钻孔 9900)按栈序压回活跃层之上;其余层(同面的铜皮/阻焊/丝印
        // 与对面各层)都留在活跃层之下 —— 之前把所有栈序更高的层全部重新 add,
        // 丝印/阻焊/文档层这些低栈层点击后仍被铜皮盖住,提层形同未提
        const key = pcbStackKey(l);
        for (const x of this.layers.filter((x) => x.count > 0 && pcbStackKey(x) > key && pcbStackKey(x) >= 470).sort((a, b) => pcbStackKey(a) - pcbStackKey(b))) root.add(x.group);
        const face = activeLayerFace(l);
        if (face) for (const gid of [`nn:${face}`, `pn:${face}`]) {
          const g = this.layers.find((x) => x.id === gid);
          if (g) root.add(g.group);
        }
      },
      // 重置 (#layer-reset):全部层重新可见,并按渲染器的默认栈序(pcbStackKey
      // 升序 = 从底到顶)重新 add 所有层组,撤销激活置顶造成的层叠改动
      onReset: () => {
        if (!this.currentRoot) return;
        // 重置恢复默认栈序,同时撤销激活层的拾取优先(与面板行高亮的清除一致)
        this.activeLayerId = null;
        const root = this.currentRoot;
        for (const l of [...this.layers].sort((a, b) => pcbStackKey(a) - pcbStackKey(b))) {
          l.group.visible = true;
          this.layerVisible.set(l.id, true);
          root.add(l.group);
        }
        for (const it of this.lastLayerItems) it.show = true;
        this.layerList.setLayers(this.lastLayerItems, this.layers.length === 0);
      },
    });
    this.props = new PropsView(this.el.querySelector('.ev-props-host') as HTMLElement);

    this.bindToolbar();
    this.bindSplitters();
    this.applyI18n();

    // 显示单位切换(#unit-toggle):按钮文字显示目标单位,状态栏坐标立即按
    // 新单位重算;props / measure 各自订阅 units 广播
    this.offUnit = onUnitChange(() => this.applyUnit());
    this.applyUnit();

    this.canvasHost.addEventListener('pointerup', (e) => this.onCanvasClick(e));

    // status bar bottom-left live cursor position in document coords (#cursor-pos)
    this.canvasHost.addEventListener('pointermove', (e) => this.showCursorPos(e));
    this.canvasHost.addEventListener('pointerleave', () => { /* keep the last position */ });

    // any manual navigation (wheel zoom / drag pan) stops the auto re-fit below
    this.canvasHost.addEventListener('wheel', () => { this.userView = true; }, { passive: true });
    this.canvasHost.addEventListener('pointerdown', () => { this.userView = true; });
    // when the canvas resizes (panels opening, window resize) keep the initial
    // fit valid — otherwise the document gets cropped (#fit-after-layout)
    new ResizeObserver(() => {
      // the scene bg rect always tracks the viewport (its fill is doc-kind);
      // refitting the view stays gated on user interaction
      this.syncDocBg(this.docKind);
      if (!this.userView && this.model && this.currentRoot) this.fitCurrent();
    }).observe(this.canvasHost);

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
    // measure mode toggle (#measure): exit keeps the rulers, right-click clears them
    this.measureBtn.addEventListener('click', () => this.measure.toggle());
    this.el.querySelector('[data-act="lang"]')!.addEventListener('click', () => this.setLang(this.lang === 'zh' ? 'en' : 'zh'));
    // 单位切换(#unit-toggle):mm/mil 跟随 units 广播刷新各显示面
    this.el.querySelector('[data-act="unit"]')!.addEventListener('click', () => toggleUnit());
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
    this.measure?.redraw(); // ruler labels re-render in the new language
    if (this.measure?.active) this.setStatus(t('measureHint'), false);
    else this.setStatus(this.docLoaded ? t('statusInit') : t('statusInit'), false);
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
    if (!this.model && !this.curNode) this.statusMsgEl.textContent = t('statusInit');
  }

  /** 单位切换后的按钮与状态栏刷新(#unit-toggle):按钮文字显示目标单位
   *  (当前 mm → 显示 mil,与语言按钮显示 EN/中 同一习惯) */
  private applyUnit(): void {
    const code = this.el.querySelector('.ev-unit-code') as HTMLElement | null;
    if (code) code.textContent = getUnit() === 'mm' ? 'mil' : 'mm';
    this.renderCursorPos();
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
    // `.ev-pane` sets display:flex, which beats the UA [hidden] rule — use the
    // !important .ev-hidden class so stale layer rows really disappear (#lib-layers)
    this.layerPane.classList.toggle('ev-hidden', !hasLayers);
    this.layerSplit.classList.toggle('ev-hidden', !hasLayers);
    (this.el.querySelector('[data-act="panelL"]') as HTMLElement).classList.toggle('ev-on', this.leftVisible());
    (this.el.querySelector('[data-act="panelR"]') as HTMLElement).classList.toggle('ev-on', this.rightVisible());
  }

  /** resize the scene bg rect to the viewport and paint the doc background
   *  (called on doc open and on canvas resize; see the #bg-flash note) */
  private syncDocBg(kind: 'sch' | 'pcb' | 'panel' | 'footprint' | 'other'): void {
    this.bgRect.width = Math.max(this.canvasHost.clientWidth, 1);
    this.bgRect.height = Math.max(this.canvasHost.clientHeight, 1);
    this.bgRect.fill = canvasBg(kind);
  }

  // ---------- loading ----------

  async loadFiles(files: File[]): Promise<void> {
    if (!files.length) {
      // drag delivered nothing readable (OS interception / empty drop) — say so
      // instead of the misleading "unrecognized format" parse error
      this.setStatus(t('statusEmptyDrop'), true);
      this.events.onError?.(new Error(t('statusEmptyDrop')));
      return;
    }
    // parsing a large project blocks the main thread for seconds — put the
    // busy overlay on screen (and let it paint) BEFORE that work starts (#loading)
    this.showLoading(t('loadingProject'));
    await this.nextPaint();
    try {
      const model = await loadFromFiles(files);
      await this.setModel(model);
    } catch (err) {
      this.fail(err);
    } finally {
      this.hideLoading();
    }
  }

  async loadMap(map: Map<string, Uint8Array>): Promise<void> {
    this.showLoading(t('loadingProject'));
    await this.nextPaint();
    try {
      await this.setModel(loadFromMap(map));
    } catch (err) {
      this.fail(err);
    } finally {
      this.hideLoading();
    }
  }

  // ---------- busy overlay (#loading) ----------

  private showLoading(msg: string): void {
    this.loadingMsgEl.textContent = msg;
    this.loadingEl.classList.remove('ev-hidden');
  }

  private hideLoading(): void {
    this.loadingEl.classList.add('ev-hidden');
  }

  /** two animation frames — one isn't enough: the rAF callback still runs
   *  before that frame's paint, so the overlay would never reach the screen */
  private nextPaint(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
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

  private async setModel(model: ProjectModel): Promise<void> {
    this.model = model;
    this.docLoaded = true;
    this.compRowsCache.clear();
    this.lastRowSig = '';
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
    if (first) await this.openNode(first);
  }

  // ---------- doc rendering ----------

  private async openNode(node: TreeNode): Promise<void> {
    if (!this.model || !node.fileKey || !node.uuid) return;
    // rulers belong to the document they were drawn on — a doc switch leaves
    // the measure mode and drops them (#measure)
    this.measure.reset();
    // 换文档 = 活跃层复位(#pick-active-layer):面板行高亮与拾取优先层
    // 一并清空,避免跨文档残留同 id 的层(不同 PCB 共用 1/2/11… 层号)
    this.activeLayerId = null;
    this.layerList.clearActive();
    // doc open (a large PCB takes seconds) blocks the main thread — show the
    // busy overlay and let it paint before that work starts (#loading);
    // schematic pages open in ~100ms, there the overlay's double-rAF wait is
    // pure latency on every page switch (#page-switch-jank)
    if (docKind(node.docType ?? '') !== 'sch') {
      this.showLoading(t('loadingDoc'));
      await this.nextPaint();
    }
    try {
      this.deviceNoteEl.classList.add('ev-hidden');
      const opened = openDoc(this.model, node);
      const kind = docKind(node.docType ?? '');
      // 显示换算基准(#unit-toggle):pcb/footprint 1 单位 = 1mil,sch/panel
      // 1 单位 = 0.254mm = 10mil —— 状态栏/属性面板/量测的换算都以此为基准
      setDocScale(docScaleFor(kind));
      // measure entry is a PCB-family feature (#measure)
      const measurable = kind === 'pcb' || kind === 'footprint' || kind === 'panel';
      this.measureBtn.disabled = !measurable;
      this.measure.setAvailable(measurable);
      const result = renderDoc(opened, canvasBg(kind));
      this.currentRoot?.remove();
      this.camera.world.add(result.root);
      // re-add the overlay AFTER the doc root so the selection box always paints
      // above the document content (on PCBs the opaque board used to cover it)
      this.camera.world.add(this.overlay);
      this.currentRoot = result.root;
      this.objects = result.objects;
      this.layers = result.layers;
      this.constantTexts = result.constantTexts as { node: LeaferText; basePx: number }[];
      this.constantStrokes = result.constantStrokes;
      this.layerVisible = new Map(this.layers.map((l) => [l.id, l.show]));
      this.curNode = node;
      this.docKind = kind;
      this.syncDocBg(kind);
      // prefer what actually rendered (panel outline etc. are not data records)
      this.camera.fit(this.objBBoxUnion() ?? opened.bbox);
      this.select(null);
      this.docTree.highlight(node.id);

      // component tree: only real components, naturally sorted by designator (#6/#12);
      // when a sheet page is open the list spans the WHOLE owning schematic —
      // clicking a component from another page jumps to that page first.
      // "Is a component" is the client's device symbolType:"component" flag; the
      // stored form of that flag is the referenced SYMBOL doc's META.docType
      // (2=component, 17=multi-part block vs 18 netflag / 19 netport / 20 drawing
      // frame / 22 short / 31 diff-pair flag — verified across all epro2+esch2
      // samples). Designator presence is NOT the criterion: components with a
      // blank Designator are still listed (#component-tree)
      const isComponentType = (od: OpenedDoc, map: Map<string, string>): boolean => {
        const sym = map.get('Symbol');
        let seg = typeof sym === 'string' && sym ? od.libs.get(sym) : undefined;
        if (!seg || seg.docType !== 'SYMBOL') {
          const dev = map.get('Device');
          seg = resolveLibGraphics(od.libs, typeof dev === 'string' && dev ? od.libs.get(dev) : undefined, 'Symbol');
        }
        const dt = Number(seg?.meta?.docType);
        if (!Number.isFinite(dt)) return true; // unresolvable lib ref — keep listing
        return dt === 2 || dt === 17;
      };
      const rowLabel = (map: Map<string, string>, fallback: string): string => {
        const desVal = map.get('Designator');
        const des = desVal !== undefined && desVal !== '' ? desVal : fallback;
        const extraKey = map.has('Name') ? 'Name' : map.has('Value') ? 'Value' : '';
        const extra = extraKey ? resolveAttrRef(Object.fromEntries(map), map.get(extraKey)) : '';
        return extra ? `${des} (${extra})` : String(des);
      };
      const buildRows = (objs: RenderObject[], od: OpenedDoc, pageNodeId: string): ObjectRow[] => {
        const rows: ObjectRow[] = [];
        for (const o of objs) {
          if (o.rec.type !== 'COMPONENT') continue;
          const map = new Map<string, string>(collectAttrs(o.rec, od).map((e) => [e.key, e.value]));
          if (!isComponentType(od, map)) continue;
          rows.push({
            id: pageNodeId ? `${pageNodeId}::${o.id}` : o.id,
            type: o.rec.type,
            label: rowLabel(map, o.title ?? o.id),
            pageNodeId: pageNodeId || undefined,
          });
        }
        return rows;
      };
      // scan a sibling sheet's COMPONENT records WITHOUT building a render
      // scene — the list only needs attrs, and rendering every page of a big
      // project on first open froze the UI (#page-switch-jank)
      const scanPageRows = (od: OpenedDoc, pageNodeId: string): ObjectRow[] => {
        const rows: ObjectRow[] = [];
        for (const r of od.self.recs) {
          if (r.type !== 'COMPONENT') continue;
          const map = new Map<string, string>(collectAttrs(r, od).map((e) => [e.key, e.value]));
          if (!isComponentType(od, map)) continue;
          rows.push({
            id: `${pageNodeId}::${r.id}`,
            type: r.type,
            label: rowLabel(map, r.id),
            pageNodeId,
          });
        }
        return rows;
      };
      const siblings = this.docKind === 'sch' ? this.siblingSheets(node) : null;
      let rows: ObjectRow[];
      if (siblings && siblings.length > 1) {
        this.schematicWide = true;
        rows = [];
        for (const p of siblings) {
          let pr = this.compRowsCache.get(p.id);
          if (!pr) {
            if (p.id === node.id) {
              pr = buildRows(this.objects, opened, p.id);
            } else {
              try { pr = scanPageRows(openDoc(this.model, p), p.id); } catch { pr = []; }
            }
            this.compRowsCache.set(p.id, pr);
          }
          rows.push(...pr);
        }
      } else {
        this.schematicWide = false;
        rows = buildRows(this.objects, opened, '');
      }
      rows.sort((a, b) => naturalDesignator(a.label, b.label));
      // the schematic-wide list is identical for every page of the schematic —
      // rebuilding the (thousands of rows) DOM on each page switch only added
      // jank; skip it while the row set is unchanged (#page-switch-jank)
      const sig = rows.map((r) => r.id).join('\n');
      this.lastObjRows = rows;
      if (sig !== this.lastRowSig) {
        this.lastRowSig = sig;
        this.objList.setObjects(rows);
      }
      if (this.docKind === 'pcb' || this.docKind === 'panel' || this.docKind === 'footprint') {
        // layer panel order follows human convention (top face first, drill/board
        // outline/multi-layer after, mechanical & panel utility layers last) —
        // NOT the renderer's paint order, which puts pour/annotation groups first
        this.lastLayerItems = [...this.layers]
          .sort((a, b) => uiLayerRank(a.id, a.name, a.type) - uiLayerRank(b.id, b.name, b.type))
          .map((l) => ({ id: l.id, name: layerLabel(l.name), color: l.color, show: l.show, count: l.count }));
        this.layerList.setLayers(this.lastLayerItems, this.layers.length === 0);
        this.props.setLayerNames(this.layers);
      } else {
        this.lastLayerItems = [];
        // destroy the previous doc's layer rows — the pane is hidden for
        // sch/symbol/device docs, but stale DOM must not survive (#lib-layers)
        this.layerList.setLayers([], this.docKind === 'sch');
        this.props.setLayerNames([]);
      }
      this.props.setOpened(opened);
      this.announceOpened(result, node);
      this.applyChrome();
    } catch (err) {
      this.fail(err);
    } finally {
      this.hideLoading();
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
      void this.openNode(node);
      return;
    }
    if (node.docType === 'DEVICE' && node.fileKey && node.uuid) {
      try {
        const opened = openDoc(this.model, node);
        // DEVICE 元数据无几何;显示换算基准回 sch 族尺度(#unit-toggle)
        setDocScale(docScaleFor('other'));
        // a DEVICE carries only attributes, no graphics — clear the canvas and
        // show the hint instead of leaving stale content around (#10)
        this.currentRoot?.remove();
        this.currentRoot = null;
        this.objects = [];
        this.layers = [];
        this.constantTexts = [];
        this.constantStrokes = [];
        this.layerVisible.clear();
        this.selected = null;
        this.clearSelShapes();
        this.activeLayerId = null;
        this.curNode = node;
        this.docKind = 'other';
        this.syncDocBg('other');
        this.measureBtn.disabled = true;
        this.measure.setAvailable(false);
        this.lastObjRows = [];
        this.lastRowSig = '';
        this.lastLayerItems = [];
        this.objList.setObjects([]);
        this.layerList.setLayers([], true);
        this.props.setLayerNames([]);
        this.docTree.highlight(node.id);
        this.deviceNoteEl.classList.remove('ev-hidden');
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
    void this.openNode(node);
    return true;
  }

  // ---------- selection ----------

  /** sheet pages sharing the current page's owning schematic (null = standalone) */
  private siblingSheets(node: TreeNode): TreeNode[] | null {
    const findParent = (ns: TreeNode[]): TreeNode | null => {
      for (const n of ns) {
        if ((n.children ?? []).some((c) => c.id === node.id)) return n;
        const deep = findParent(n.children ?? []);
        if (deep) return deep;
      }
      return null;
    };
    const parent = this.model ? findParent(this.model.tree) : null;
    const kids = (parent?.children ?? []).filter((c) => c.kind === 'sheet');
    return kids.length ? kids : null;
  }

  /** row id of an object in the (possibly schematic-wide) component list */
  private rowIdOf(objId: string): string {
    return this.schematicWide && this.curNode ? `${this.curNode.id}::${objId}` : objId;
  }

  private async pickObject(id: string, center: boolean): Promise<void> {
    // schematic-wide list: rows carry their owning page's node id —
    // clicking a component that lives on another page opens that page first
    // (await the open: the object lookup below must see the NEW doc's objects)
    let compId = id;
    const sep = id.indexOf('::');
    if (sep > 0) {
      const pageId = id.slice(0, sep);
      compId = id.slice(sep + 2);
      if (this.curNode?.id !== pageId) {
        const node = this.model?.openables.get(pageId);
        if (node) await this.openNode(node);
      }
    }
    const obj = this.objects.find((o) => o.id === compId) ?? null;
    this.select(obj);
    if (obj && center && obj.bbox) {
      const b = obj.bbox;
      this.camera.centerOn((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
    }
  }

  private onCanvasClick(e: PointerEvent): void {
    if (e.button !== 0) return; // right/middle drag only pans (#8)
    if (this.camera.didPan) return;
    if (this.measure?.active) return; // left-clicks take points while measuring (#measure)
    const r = this.canvasHost.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const wx = (px - this.camera.tx) / this.camera.scale;
    const wy = (py - this.camera.ty) / this.camera.scale;
    const tol = 6 / this.camera.scale;
    // 隐藏层判定优先用渲染时落定的层组 key(合成组 pour:/pn:/nn: 与元件等
    // 由此精确归层,兼容开旧记录 data.layerId 兜底)—— #pick-active-layer
    const hidden = (o: RenderObject): boolean => {
      const lk = o.layerKey ?? (o.rec.data.layerId != null ? String(o.rec.data.layerId) : null);
      return lk != null && this.layerVisible.get(lk) === false;
    };
    const pass = (o: RenderObject): boolean => {
      const b = o.bbox!;
      if (wx < b.minX || wx > b.maxX || wy < b.minY || wy > b.maxY) return false;
      if (o.hit && !o.hit(wx, wy, tol)) return false; // stroke-only pick (#23)
      return true;
    };
    const areaOf = (o: RenderObject): number => {
      const b = o.bbox!;
      return (b.maxX - b.minX) * (b.maxY - b.minY);
    };
    // 线类图元(pathPts ≥ 2)的精确命中(#pick-precise):点到折线各段的最小
    // 距离 ≤ 容差(文档单位,与恒定像素选中线宽同量级)才算命中;bbox 仅作
    // 扩容差粗筛预过滤,精确测试不过不回退 bbox——L 形/斜线 bbox 的空白区
    // 点了就是没命中。弧在渲染层已采样成折线顶点,同一测试覆盖
    const segDist = (pts: [number, number][], x: number, y: number): number => {
      let dmin = Infinity;
      for (let i = 0; i + 1 < pts.length; i++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
        const dx = x2 - x1, dy = y2 - y1;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / l2)) : 0;
        const d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
        if (d < dmin) dmin = d;
      }
      return dmin;
    };
    // 活跃层优先仅在 PCB 族文档生效;原理图无层激活概念,行为不变
    const act = this.activeLayerId != null
      && (this.docKind === 'pcb' || this.docKind === 'panel' || this.docKind === 'footprint')
      ? this.activeLayerId : null;
    // 命中规则(#pick-active-layer 收紧 + #pick-precise):
    // 1) 依次过隐藏层/激活层过滤——设了激活层就只看激活层上的图元,激活层
    //    无命中等于点了空白(取消选中),绝不回退穿透到其他层;未设激活层
    //    时保持整体命中规则不变;
    // 2) 线类图元走精确命中,非线类保持 bbox 包含 + 既有描边命中;
    // 3) 线类之间取段距离最小者(近距平行导线取更近者),非线类之间沿用
    //    bbox 面积最小;两类并存时按 bbox 面积比较——焊盘/文本等小目标不被
    //    穿过它的走线抢走(走线端点常落在焊盘中心),走线仍胜过大面积铺铜
    //    的空腔 bbox
    let wireHit: RenderObject | null = null;
    let wireDist = Infinity;
    let wireArea = Infinity;
    let boxHit: RenderObject | null = null;
    let boxArea = Infinity;
    for (const o of this.objects) {
      if (!o.bbox) continue;
      if (hidden(o)) continue;
      if (act && o.layerKey !== act) continue;
      const pts = o.pathPts;
      if (pts && pts.length >= 2) {
        const b = o.bbox;
        if (wx < b.minX - tol || wx > b.maxX + tol || wy < b.minY - tol || wy > b.maxY + tol) continue;
        const d = segDist(pts, wx, wy);
        if (d > tol) continue;
        const area = areaOf(o);
        if (d < wireDist - 1e-9 || (d <= wireDist + 1e-9 && area < wireArea)) {
          wireDist = d; wireArea = area; wireHit = o;
        }
      } else {
        if (!pass(o)) continue;
        const area = areaOf(o);
        if (area < boxArea) { boxArea = area; boxHit = o; }
      }
    }
    this.select(wireHit && boxHit ? (wireArea < boxArea ? wireHit : boxHit) : (wireHit ?? boxHit));
  }

  private select(obj: RenderObject | null): void {
    this.selected = obj;
    this.clearSelShapes();
    this.props.show(obj);
    this.objList.select(obj ? this.rowIdOf(obj.id) : null);
    if (obj) {
      const selStroke = (this.docKind === 'pcb' || this.docKind === 'footprint' || this.docKind === 'panel') ? '#c9ccd1' : '#2563eb';
      const s = this.camera.scale;
      // 恒定像素虚线(4 开 3 关),任意缩放下线宽与疏密不变
      const common = {
        stroke: selStroke, strokeWidth: 2 / s,
        dashPattern: [4 / s, 3 / s], fill: null, hittable: false,
      } as any;
      // 线类图元(导线/走线/弧/折线)沿实际路径描亮(#select-box-path):
      // 整体 bbox 最大矩形对斜线/折线会出现大角度失配的粗框,与 EDA 客户端
      // 的沿线高亮习惯不符;其余图元(元件/焊盘/文本…)保持 bbox 控制框
      const pts = obj.pathPts;
      // 旋转非零的框类图元(元件/焊盘/文本)按渲染层标注的旋转外框四角
      // 闭合绘制(首尾相接),贴合图元实际旋转姿态;0° 图元无 selPoly,四角
      // 退化为轴对齐矩形,继续走下方 bbox 框,零回归(#select-box-rot)
      const poly = obj.selPoly;
      if (poly && poly.length >= 3) {
        const flat: number[] = [];
        for (const [x, y] of poly) flat.push(x, y);
        const ln = new Line({ points: flat, closed: true, ...common });
        this.selShapes.push(ln);
        this.overlay.add(ln);
      } else if (pts && pts.length >= 2) {
        const flat: number[] = [];
        for (const [x, y] of pts) flat.push(x, y);
        const ln = new Line({ points: flat, ...common });
        this.selShapes.push(ln);
        this.overlay.add(ln);
      } else if (obj.bbox) {
        const b = obj.bbox;
        const rect = new Rect({
          x: b.minX, y: b.minY,
          width: Math.max(2, b.maxX - b.minX), height: Math.max(2, b.maxY - b.minY),
          ...common,
        } as any);
        this.selShapes.push(rect);
        this.overlay.add(rect);
      }
    }
    this.applyChrome(); // properties panel appears on first pick (#1)
    this.events.onSelect?.(obj);
  }

  private clearSelShapes(): void {
    for (const n of this.selShapes) n.remove();
    this.selShapes = [];
  }

  private updateSelStroke(): void {
    const s = this.camera.scale;
    for (const n of this.selShapes) {
      (n as any).strokeWidth = 2 / s;
      (n as any).dashPattern = [4 / s, 3 / s];
    }
  }

  // ---------- misc ----------

  fitCurrent(): void {
    if (this.model && this.currentRoot) {
      const b = this.objBBoxUnion();
      if (b) this.camera.fit(b);
      this.userView = false; // an explicit fit re-arms the auto re-fit
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
    this.statusMsgEl.textContent = text;
    this.statusEl.classList.toggle('ev-err', error);
  }

  /** live cursor position at the status-bar bottom-left (#cursor-pos) */
  private showCursorPos(e: PointerEvent): void {
    this.lastCursor = { x: e.clientX, y: e.clientY };
    this.renderCursorPos();
  }

  /** 由最近指针位置刷新状态栏坐标:文档坐标按当前显示单位换算(#unit-toggle) */
  private renderCursorPos(): void {
    if (!this.lastCursor || !this.model || !this.docLoaded) { this.statusPosEl.textContent = ''; return; }
    const r = this.canvasHost.getBoundingClientRect();
    const wx = (this.lastCursor.x - r.left - this.camera.tx) / this.camera.scale;
    const wy = (this.lastCursor.y - r.top - this.camera.ty) / this.camera.scale;
    // PCB-family docs render with a Y-flip (file space is Y-up) — report file coordinates
    const flipped = this.docKind === 'pcb' || this.docKind === 'panel' || this.docKind === 'footprint';
    const dx = wx, dy = flipped ? -wy : wy;
    const u = unitSuffix();
    this.statusPosEl.textContent = `X: ${fmtCoord(dx)} ${u}  Y: ${fmtCoord(dy)} ${u}`;
  }

  getModel(): ProjectModel | null {
    return this.model;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.offUnit?.();
    this.dnd.destroy();
    this.measure.destroy();
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

/** layer-panel display rank — the order a person expects, mirroring the
 *  嘉立创EDA专业版 layer list (NOT the renderer's paint order):
 *  top face silk → pad numbers → paste → mask → copper, inner1..N, bottom face
 *  copper → mask → paste → pad numbers → silk, drill, board outline, multi-layer,
 *  document, misc overlays, mechanical/panel utility layers last, tools at the end.
 *  Lower rank = higher in the list; ties keep the render stack order (stable sort). */
const UI_LAYER_RANK: Record<string, number> = {
  TOP_SILK: 0, TOP_PASTE_MASK: 2, TOP_SOLDER_MASK: 3, TOP: 4,
  BOTTOM: 20, BOT_SOLDER_MASK: 21, BOT_PASTE_MASK: 22, BOT_SILK: 23,
  HOLE: 30, DRILL: 30, OUTLINE: 31, MULTI: 32, DOCUMENT: 40,
  TOP_ASSEMBLY: 41, BOT_ASSEMBLY: 42,
  COMPONENT_SHAPE: 50, COMPONENT_MARKING: 51, COMPONENT_MODEL: 52,
  PIN_FLOATING: 53, PIN_SOLDERING: 54, DRILL_DRAWING: 55, OTHER: 56, NET: 57,
  TOP_STIFFENER: 58, BOTTOM_STIFFENER: 59, SUBSTRATE: 60,
  MECHANICAL: 70,
};
/** fallback when a layer has no file layerType — same ids the renderer maps */
const UI_LAYER_RANK_BY_ID: Record<number, number> = {
  1: 4, 2: 20, 3: 0, 4: 23, 5: 3, 6: 21, 7: 2, 8: 22, 9: 41, 10: 42,
  11: 31, 12: 32, 13: 40, 14: 70, 47: 30,
};

/** which copper face (1=top, 2=bottom) a layer belongs to — drives the
 *  active-layer raise: the face's pad-number / net-name overlays go topmost.
 *  Inner faces / multi / hole / outline / tools belong to neither face. */
function activeLayerFace(l: RenderLayer): 1 | 2 | null {
  if (l.id === 'pn:1' || l.id === 'nn:1') return 1;
  if (l.id === 'pn:2' || l.id === 'nn:2') return 2;
  const t = String(l.type ?? '').toUpperCase();
  const n = Number(l.id);
  if (t.startsWith('TOP') || (!t && [1, 3, 5, 7, 9].includes(n))) return 1;
  if (t.startsWith('BOTTOM') || t.startsWith('BOT_') || (!t && [2, 4, 6, 8, 10].includes(n))) return 2;
  return null;
}

function uiLayerRank(id: string, name: string, type?: string): number {
  // synthetic renderer layers
  if (id === 'pn:1') return 1; // top pad-number overlay, just under top silk
  if (id === 'pn:2') return 24; // bottom pad-number overlay, just under bottom silk
  if (id === 'nn:1') return 1.5; // top net-name overlay: under the top pad numbers
  if (id === 'nn:2') return 24.5; // bottom net-name overlay: under the bottom pad numbers
  if (id === 'panel') return 800;
  if (id === 'axes' || id === 'rats') return 900;
  const n = Number(id);
  const ty = String(type ?? '').toUpperCase();
  // inner signal faces: 15..46 = Inner1..Inner32 in this format (name wins when parseable)
  const inner = /^Inner(\d+)$/i.exec(name);
  if (ty === 'SIGNAL' || ty === 'PLANE' || ty.startsWith('INNER') || inner || (!ty && n >= 15 && n <= 46)) {
    return 10 + (inner ? Number(inner[1]) : n >= 15 && n <= 46 ? n - 14 : 99);
  }
  if (ty) return UI_LAYER_RANK[ty] ?? (ty.startsWith('3D_') ? 52 : ty.includes('PANEL') ? 70 : 50);
  return UI_LAYER_RANK_BY_ID[n] ?? 50;
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
