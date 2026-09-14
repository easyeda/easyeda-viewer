/** Standalone page entry: create the viewer + postMessage bridge for embedding. */
import { createViewer, type EextViewer } from './embed';
import type { ChromeFlags, Theme } from './ui/shell';

const VIEWER_VERSION = '0.1.0';

const host = document.getElementById('app');
if (!host) throw new Error('missing #app root');

/**
 * URL params (also used by the Go desktop shell):
 *   ?theme=light|dark          chrome theme, default light (canvas keeps document colors)
 *   ?toolbar=0|left=0|right=0|status=0   hide individual panes
 *   ?chrome=canvas             shortcut for toolbar/left/right/status all off
 */
function parseOptions(q: URLSearchParams): { theme: Theme; chrome: Partial<ChromeFlags> } {
  const flag = (name: string): boolean | undefined => {
    const v = q.get(name);
    if (v == null) return undefined;
    return !(v === '0' || v.toLowerCase() === 'false' || v.toLowerCase() === 'off');
  };
  const theme: Theme = q.get('theme') === 'dark' ? 'dark' : 'light';
  const chrome: Partial<ChromeFlags> = {};
  if (q.get('chrome') === 'canvas') {
    chrome.toolbar = false; chrome.left = false; chrome.right = false; chrome.status = false;
  }
  for (const k of ['toolbar', 'left', 'right', 'status'] as const) {
    const v = flag(k);
    if (v !== undefined) chrome[k] = v;
  }
  return { theme, chrome };
}

const params = new URLSearchParams(location.search);
const { theme, chrome } = parseOptions(params);
// mirror theme on <html> so the page background matches before/around the shell
document.documentElement.dataset.theme = theme;

const viewer: EextViewer = createViewer(host, { theme, chrome });

/** file↔base64 for host pages that cannot hand over File objects */
function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface LoadMsg {
  source: 'easyeda-viewer';
  cmd: 'load';
  files: { name: string; dataBase64: string }[];
}
interface OpenMsg {
  source: 'easyeda-viewer';
  cmd: 'open';
  nodeId: string;
}
interface FitMsg {
  source: 'easyeda-viewer';
  cmd: 'fit';
}
interface ThemeMsg {
  source: 'easyeda-viewer';
  cmd: 'theme';
  theme: Theme;
}
interface ChromeMsg {
  source: 'easyeda-viewer';
  cmd: 'chrome';
  chrome: Partial<ChromeFlags>;
}
type HostMsg = LoadMsg | OpenMsg | FitMsg | ThemeMsg | ChromeMsg;

function post(event: string, payload: Record<string, unknown> = {}): void {
  window.parent?.postMessage({ source: 'easyeda-viewer', event, ...payload }, '*');
}

window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as HostMsg;
  if (!msg || msg.source !== 'easyeda-viewer') return;
  try {
    if (msg.cmd === 'load') {
      const map = new Map<string, Uint8Array>();
      for (const f of msg.files ?? []) map.set(f.name.replace(/\\/g, '/'), b64ToBytes(f.dataBase64));
      viewer.loadMap(map);
      post('load-ok', { count: map.size });
    } else if (msg.cmd === 'open') {
      const ok = viewer.open(msg.nodeId);
      post('open-result', { nodeId: msg.nodeId, ok });
    } else if (msg.cmd === 'fit') {
      viewer.fit();
    } else if (msg.cmd === 'theme') {
      viewer.setTheme(msg.theme === 'dark' ? 'dark' : 'light');
      document.documentElement.dataset.theme = msg.theme === 'dark' ? 'dark' : 'light';
    } else if (msg.cmd === 'chrome') {
      viewer.setChrome(msg.chrome ?? {});
    }
  } catch (err) {
    post('error', { message: err instanceof Error ? err.message : String(err) });
  }
});

post('ready', { version: VIEWER_VERSION });
