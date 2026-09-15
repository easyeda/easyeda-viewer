/**
 * Embeddable API (PRD §4.6):
 *
 *   import { createViewer } from 'easyeda-viewer';
 *   const v = createViewer(document.getElementById('box'));
 *   v.loadFiles(files);            // File[] from your own picker
 *   v.loadMap(new Map([['a.esch2', bytes]]));
 *   v.open('nodeId');
 *   v.destroy();
 */
import { Shell, type Theme, type ChromeFlags } from './ui/shell';
import type { Lang } from './ui/i18n';
import type { ProjectModel, TreeNode } from './core/types';
import type { RenderObject } from './core/render/layers';

export interface CreateViewerOptions {
  /** start with these files immediately (drag-drop UI stays active as well) */
  files?: File[];
  /** UI chrome theme, default 'light'. Canvas always keeps document colors. */
  theme?: Theme;
  /** show/hide toolbar & side panels, e.g. {toolbar:false,left:false,right:false} for a pure canvas */
  chrome?: Partial<ChromeFlags>;
  /** UI language, default 'zh' */
  lang?: Lang;
  onSelect?(obj: RenderObject | null): void;
  onLoaded?(model: ProjectModel): void;
  onError?(err: Error): void;
}

export interface EextViewer {
  /** load File[] (eprj3 folder contents, .epro2 file, or single doc files) */
  loadFiles(files: File[]): Promise<void>;
  /** load an already-read path→bytes map */
  loadMap(map: Map<string, Uint8Array>): void;
  /** open a document by tree-node id (see onLoaded model.openables) */
  open(nodeId: string): boolean;
  fit(): void;
  /** switch chrome theme at runtime (canvas keeps document colors) */
  setTheme(theme: Theme): void;
  /** switch UI language at runtime (rebuilds all labels) */
  setLang(lang: Lang): void;
  /** show/hide toolbar & side panels at runtime */
  setChrome(flags: Partial<ChromeFlags>): void;
  getModel(): ProjectModel | null;
  destroy(): void;
}

export function createViewer(host: HTMLElement, opts: CreateViewerOptions = {}): EextViewer {
  const shell = new Shell(host, {
    theme: opts.theme,
    chrome: opts.chrome,
    lang: opts.lang,
    onSelect: opts.onSelect,
    onLoaded: opts.onLoaded,
    onError: opts.onError,
  });
  if (opts.files?.length) void shell.loadFiles(opts.files);
  return {
    loadFiles: (files) => shell.loadFiles(files),
    loadMap: (map) => shell.loadMap(map),
    open: (nodeId) => shell.openNodeId(nodeId),
    fit: () => shell.fitCurrent(),
    setTheme: (theme) => shell.setTheme(theme),
    setLang: (lang) => shell.setLang(lang),
    setChrome: (flags) => shell.setChrome(flags),
    getModel: () => shell.getModel(),
    destroy: () => shell.destroy(),
  };
}

export type { ProjectModel, TreeNode, RenderObject, Theme, ChromeFlags, Lang };
