#!/usr/bin/env node
/**
 * Headless image export (#image-export).
 *
 *   node scripts/export.mjs <project> [--out file.png|file.svg] [--doc <title|id|index>]
 *                          [--format png|svg] [--width N] [--height N] [--scale N]
 *                          [--padding N] [--background <color|transparent>] [--pixel-ratio N]
 *                          [--list] [--all --out-dir dir]
 *
 * <project> is a .epro2 / .elibz2 / single document file, or a folder / zip
 * (folder-form .eprj3). The command runs a headless Chrome (no window is
 * opened) against the built `dist/index.html` and calls the viewer's
 * `easyedaViewer.exportImage()` API, so PNG/SVG look exactly like the viewer.
 *
 * Use `--dev` to serve the TypeScript sources with Vite instead of dist/
 * (useful while developing the viewer itself).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- args ----------

function usage(exitCode = 0) {
  console.log(`用法: node scripts/export.mjs <工程> [选项]

  <工程>                 .epro2 / .elibz2 / 单个文档，或 .eprj3 工程文件夹 / .zip
  -o, --out <文件>       输出文件（默认 <文档标题>.<png|svg>）
      --doc <标题|ID|序号>  导出指定文档（默认第一个；--list 可查看）
      --format <png|svg> 输出格式（默认按 --out 扩展名，否则 png）
      --width <px>       按宽度等比适配（与 --height 同时给出时取更小缩放）
      --height <px>      按高度等比适配
      --scale <倍数>      1 世界单位 = N 像素（默认 1；指定 width/height 时忽略）
      --padding <px>     内容四周留白像素（默认 16）
      --background <颜色|transparent>  背景色（默认文档底色；transparent = 透明）
      --pixel-ratio <N>  PNG 额外栅格倍率（默认 1，2 即两倍清晰度）
      --list             只列出可导出文档
      --all              导出全部文档到 --out-dir
      --out-dir <目录>    --all 的输出目录（默认 ./export）
      --dev              用 Vite 启动源码页面（默认使用已构建的 dist/index.html）
      --chrome <路径>     指定 Chrome/Edge 可执行文件（也可用 CHROME_PATH 环境变量）
      --port <端口>       内部预览端口（默认 5197）
  -h, --help             显示本帮助`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = { format: '', background: undefined, padding: undefined, scale: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`缺少参数值: ${a}`);
      return v;
    };
    if (a === '-h' || a === '--help') usage(0);
    else if (a === '-o' || a === '--out') opts.out = next();
    else if (a === '--doc') opts.doc = next();
    else if (a === '--format') opts.format = next().toLowerCase();
    else if (a === '--width') opts.width = Number(next());
    else if (a === '--height') opts.height = Number(next());
    else if (a === '--scale') opts.scale = Number(next());
    else if (a === '--padding') opts.padding = Number(next());
    else if (a === '--background') opts.background = next();
    else if (a === '--pixel-ratio') opts.pixelRatio = Number(next());
    else if (a === '--list') opts.list = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--out-dir') opts.outDir = next();
    else if (a === '--dev') opts.dev = true;
    else if (a === '--chrome') opts.chrome = next();
    else if (a === '--port') opts.port = Number(next());
    else if (a.startsWith('-')) throw new Error(`未知参数: ${a}`);
    else if (!opts.input) opts.input = a;
    else throw new Error(`多余参数: ${a}`);
  }
  if (!opts.input) usage(1);
  return opts;
}

// ---------- helpers ----------

/** collect project files as [relativePath, bytes] */
function readInput(input) {
  const abs = path.resolve(input);
  if (!existsSync(abs)) throw new Error(`找不到工程: ${input}`);
  const stat = statSync(abs);
  if (!stat.isDirectory()) return [[path.basename(abs), readFileSync(abs)]];
  const out = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(p).isDirectory()) walk(p, rel);
      else out.push([rel, readFileSync(p)]);
    }
  };
  walk(abs, '');
  if (!out.length) throw new Error(`文件夹为空: ${input}`);
  return out;
}

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA || ''}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
];

function findChrome(explicit) {
  const candidates = [explicit, process.env.CHROME_PATH, ...CHROME_CANDIDATES].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error('未找到 Chrome/Edge，可用 --chrome 或 CHROME_PATH 指定可执行文件');
}

const safeName = (s) => String(s).replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'doc';

async function waitServer(url, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('页面服务启动超时');
}

// ---------- main ----------

async function main() {
const opts = parseArgs(process.argv.slice(2));
const format = opts.format || (opts.out && /\.svg$/i.test(opts.out) ? 'svg' : 'png');
if (!['png', 'svg'].includes(format)) throw new Error(`不支持的格式: ${format}`);

const files = readInput(opts.input);
const payload = files.map(([name, bytes]) => ({ name, dataBase64: bytes.toString('base64') }));

let server = null;
let baseUrl;
if (opts.dev) {
  const port = opts.port || 5197;
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  await waitServer(baseUrl);
} else {
  const dist = path.join(ROOT, 'dist/index.html');
  if (!existsSync(dist)) throw new Error('未找到 dist/index.html，请先执行 npm run build（或加 --dev 用源码运行）');
  baseUrl = `file:///${dist.replace(/\\/g, '/').replace(/^\//, '')}`;
}

const browser = await puppeteer.launch({
  executablePath: findChrome(opts.chrome),
  headless: 'new',
  args: ['--hide-scrollbars', '--disable-gpu', '--force-device-scale-factor=1'],
  defaultViewport: { width: 1280, height: 900 },
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[viewer]', e.message));
  await page.goto(`${baseUrl}?chrome=canvas`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForFunction('window.easyedaViewer && typeof window.easyedaViewer.exportImage === "function"', { timeout: 30000 });

  const loaded = await page.evaluate(async (entries) => {
    const files = entries.map(({ name, dataBase64 }) => {
      const bin = atob(dataBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const f = new File([bytes], name.split('/').pop() || name);
      Object.defineProperty(f, 'webkitRelativePath', { value: name });
      return f;
    });
    await window.easyedaViewer.loadProject(files, {});
    return window.easyedaViewer.listDocuments();
  }, payload);

  const docs = loaded ?? [];
  if (!docs.length) throw new Error('工程中没有可导出的文档');

  if (opts.list) {
    docs.forEach((d, i) => console.log(`${String(i + 1).padStart(3)}  ${d.title}  [${d.docType}]  ${d.nodeId}`));
  } else {
    const pick = () => {
      if (!opts.doc) return 0;
      if (/^\d+$/.test(opts.doc)) {
        const i = Number(opts.doc) - 1;
        if (i < 0 || i >= docs.length) throw new Error(`--doc 序号超出范围（共 ${docs.length} 个）`);
        return i;
      }
      const byId = docs.findIndex((d) => d.nodeId === opts.doc);
      if (byId >= 0) return byId;
      const byTitle = docs.findIndex((d) => d.title === opts.doc);
      if (byTitle >= 0) return byTitle;
      const byLoose = docs.filter((d) => d.title.toLowerCase().includes(String(opts.doc).toLowerCase()));
      if (byLoose.length === 1) return docs.indexOf(byLoose[0]);
      throw new Error(`找不到文档「${opts.doc}」，可先运行 --list 查看`);
    };
    const targets = opts.all ? docs.map((_, i) => i) : [pick()];
    const outDir = path.resolve(opts.outDir || 'export');
    if (opts.all) mkdirSync(outDir, { recursive: true });
    for (const i of targets) {
      const doc = docs[i];
      const background = opts.background === undefined ? undefined
        : ['transparent', 'none', 'null'].includes(String(opts.background).toLowerCase()) ? null : opts.background;
      const result = await page.evaluate(async ({ nodeId, format, width, height, scale, padding, background, pixelRatio }) => {
        const r = await window.easyedaViewer.exportImage({ nodeId, format, width, height, scale, padding, background, pixelRatio });
        return { width: r.width, height: r.height, dataURL: r.dataURL };
      }, {
        nodeId: doc.nodeId,
        format,
        width: opts.width,
        height: opts.height,
        scale: opts.scale,
        padding: opts.padding,
        background,
        pixelRatio: opts.pixelRatio,
      });
      const out = opts.all
        ? path.join(outDir, `${String(i + 1).padStart(2, '0')}-${safeName(doc.title)}.${format}`)
        : path.resolve(opts.out || `${safeName(doc.title)}.${format}`);
      const comma = result.dataURL.indexOf(',');
      const body = result.dataURL.slice(comma + 1);
      const data = format === 'svg' ? Buffer.from(decodeURIComponent(body), 'utf8') : Buffer.from(body, 'base64');
      writeFileSync(out, data);
      console.log(`${out}  ${result.width}x${result.height}  ${doc.title} [${doc.docType}]`);
    }
  }
} catch (err) {
  console.error('导出失败:', err?.message ?? err);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
}
}

main().catch((err) => {
  console.error('导出失败:', err?.message ?? err);
  process.exitCode = 1;
});
