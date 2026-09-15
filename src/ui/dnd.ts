/**
 * File input: drag-and-drop (with folder expansion), file picker, folder picker.
 * Emits collected File[] to a callback. See PRD FR-1.
 */
import { icon } from './icons';
import { t } from './i18n';

export interface DndOptions {
  /** host element the overlay + canvas drop zone listens on (drop works app-wide) */
  overlay?: HTMLElement;
  onFiles: (files: File[]) => void;
  /** true while a file drag is over the app (for drop-zone styling) */
  onDragState?(active: boolean): void;
}

export interface DndController {
  destroy(): void;
}

export function setupDnd(root: HTMLElement, opts: DndOptions): DndController {
  const overlay = opts.overlay ?? document.body;
  const mask = document.createElement('div');
  mask.className = 'ev-drop-mask';
  mask.style.display = 'none';
  root.appendChild(mask);

  let depth = 0;
  const showMask = (): void => {
    depth++;
    mask.innerHTML = `<div class="ev-drop-pill">${icon('scanSearch', 22)}<span>${t('dropHint')}</span></div>`;
    mask.style.display = 'flex';
    opts.onDragState?.(true);
  };
  const hideMask = (): void => {
    depth = Math.max(0, depth - 1);
    if (!depth) {
      mask.style.display = 'none';
      opts.onDragState?.(false);
    }
  };

  const onDragOver = (e: DragEvent) => { e.preventDefault(); };
  const onDragEnter = (e: DragEvent) => { e.preventDefault(); showMask(); };
  const onDragLeave = (e: DragEvent) => { e.preventDefault(); hideMask(); };
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    hideMask();
    const files: File[] = [];
    const items = e.dataTransfer?.items;
    if (items && items.length && 'webkitGetAsEntry' in items[0]) {
      // WebView2/Edge can return null from webkitGetAsEntry() for Explorer drops —
      // collect whatever entries DO resolve, then fall through to dataTransfer.files.
      const entries = [...items]
        .map((it) => {
          try {
            return (it as DataTransferItem & { webkitGetAsEntry(): FileSystemEntry | null }).webkitGetAsEntry();
          } catch {
            return null;
          }
        })
        .filter((x): x is FileSystemEntry => !!x);
      await Promise.all(entries.map((en) => walkEntry(en, files).catch(() => { /* per-entry failure: keep others */ })));
    }
    if (!files.length) {
      const dt = e.dataTransfer;
      if (dt) for (const f of [...dt.files]) files.push(f);
    }
    if (files.length) opts.onFiles(files);
    else opts.onFiles([]); // surface "nothing readable" to the caller
  };

  window.addEventListener('dragover', onDragOver);
  overlay.addEventListener('dragenter', onDragEnter);
  overlay.addEventListener('dragleave', onDragLeave);
  overlay.addEventListener('drop', onDrop);

  return {
    destroy() {
      window.removeEventListener('dragover', onDragOver);
      overlay.removeEventListener('dragenter', onDragEnter);
      overlay.removeEventListener('dragleave', onDragLeave);
      overlay.removeEventListener('drop', onDrop);
      mask.remove();
    },
  };
}

/** recursively read a dropped file-system entry (file or directory) */
async function walkEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    // keep relative path for project association (drop of a folder)
    try {
      Object.defineProperty(file, 'webkitRelativePath', { value: entry.fullPath.replace(/^\//, '') });
    } catch { /* frozen in some engines; ignore */ }
    out.push(file);
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    let entries: FileSystemEntry[] = [];
    // readEntries returns in batches until empty
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      entries = entries.concat(batch);
    }
    await Promise.all(entries.map((e) => walkEntry(e, out)));
  }
}

/**
 * Desktop bridge (desktop/easyeda-viewer.exe, webview bindings).
 * When running inside the Go shell these functions exist and provide native
 * dialogs + local file reading; in a plain browser we fall back to <input>.
 */
interface DesktopBridge {
  openFileDialog?(): Promise<string>;
  openFolderDialog?(): Promise<string>;
  /** JSON [{name, rel, b64}] for a file or a whole folder tree */
  readProjectFiles?(path: string): Promise<string>;
}
export function desktopBridge(): DesktopBridge | null {
  const w = window as unknown as DesktopBridge;
  return typeof w.openFileDialog === 'function' ? w : null;
}

function b64ToFile(name: string, rel: string, b64: string): File {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const f = new File([bytes], name);
  try {
    Object.defineProperty(f, 'webkitRelativePath', { value: rel.replace(/\\/g, '/') });
  } catch { /* frozen in some engines; name still usable */ }
  return f;
}

async function bridgeLoad(dialog: 'openFileDialog' | 'openFolderDialog'): Promise<File[]> {
  const b = desktopBridge()!;
  const path = await b[dialog]!();
  if (!path) return [];
  const items = JSON.parse(await b.readProjectFiles!(path)) as { name: string; rel: string; b64: string }[];
  return items.map((it) => b64ToFile(it.name, it.rel, it.b64));
}

/** open native file picker (multiple, filtered extensions) */
export function pickFiles(accept = '.eprj3,.epro2,.esch2,.epcb2,.epan2,.elib2,.epru,.esym2,.zip'): Promise<File[]> {
  if (desktopBridge()) return bridgeLoad('openFileDialog');
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (accept) input.accept = accept;
    input.addEventListener('change', () => resolve([...(input.files ?? [])]));
    input.click();
  });
}

/** open folder picker via webkitdirectory input; resolves with every file under the folder */
export function pickFolder(): Promise<File[]> {
  if (desktopBridge()) return bridgeLoad('openFolderDialog');
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    (input as any).webkitdirectory = true;
    input.multiple = true;
    input.addEventListener('change', () => resolve([...(input.files ?? [])]));
    input.click();
  });
}
