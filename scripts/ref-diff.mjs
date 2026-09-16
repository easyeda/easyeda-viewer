/**
 * Reference-diff pipeline (方案 A): compare our viewer's render against the
 * EDA-exported PNGs shipped with the sample project.
 *
 *   npx vite-node -c vite.smoke.config.ts scripts/ref-diff.mjs [--only=Display,PCB] [--out=qa/diff]
 *
 * Per case:
 *   1. open the page in the QA viewer (chrome off) at the reference PNG's size
 *   2. two-pass camera alignment: rough fit from the world bbox, then measure the
 *      frame/content rect in our own screenshot and correct scale+offset
 *   3. pixel diff (pixelmatch headline + own structural mask), cluster into regions,
 *      draw boxes on the heatmap, save magnified ref/ours crops for the top regions
 * Output: <out>/<case>/{ours,diff,r< i >,o< i >}.png + <out>/report.json
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const SAMPLE_DIR = 'samples/ESP32S31-epro2';
const FILE = '/samples/ESP32S31-epro2/ESP32S31.epro2';
const PORT = 5189;

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
const outDir = args.find((a) => a.startsWith('--out='))?.slice(6) ?? 'qa/diff';

const CASES = [
  { name: 'ESP32-S31', ref: '立创·Candis-ESP32S31开发板_copy_image-sch_v0.5-Beta1_Schematic_ESP32-S31.png', open: 'ESP32-S31', kind: 'sch' },
  { name: 'Power', ref: '立创·Candis-ESP32S31开发板_copy_image-sch_v0.5-Beta1_Schematic_Power.png', open: 'Power', kind: 'sch' },
  { name: 'Display', ref: '立创·Candis-ESP32S31开发板_copy_image-sch_v0.5-Beta1_Schematic_Display.png', open: 'Display', kind: 'sch' },
  { name: 'Audio', ref: '立创·Candis-ESP32S31开发板_copy_image-sch_v0.5-Beta1_Schematic_Audio.png', open: 'Audio', kind: 'sch' },
  { name: 'Camera', ref: '立创·Candis-ESP32S31开发板_copy_image-sch_v0.5-Beta1_Schematic_Camera.png', open: 'Camera', kind: 'sch' },
  { name: 'MicroSD', ref: '立创·Candis-ESP32S31开发板_copy_image-sch_v0.5-Beta1_Schematic_MicroSD.png', open: 'MicroSD', kind: 'sch' },
  { name: 'Keys-RGB-EXT', ref: '立创·Candis-ESP32S31开发板_copy_image-sch_v0.5-Beta1_Schematic_Keys-RGB-EXT.png', open: 'Keys/RGB/EXT', kind: 'sch' },
  { name: 'USB-C1', ref: '立创·Candis-ESP32S31开发板_copy_image-sch_v0.5-Beta1_Schematic_USB-C1.png', open: 'USB-C1', kind: 'sch' },
  { name: 'USB-C2 OTG', ref: '立创·Candis-ESP32S31开发板_copy_image-sch_v0.5-Beta1_Schematic_USB-C2 OTG.png', open: 'USB-C2 OTG', kind: 'sch' },
  { name: 'PCB', ref: 'PCB_PCB_2026-09-16.png', open: 'PCB', kind: 'pcb' },
];

// ---------- image helpers (pngjs RGBA) ----------
const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/** SCH: outermost long dark lines = sheet frame */
function schRect(img) {
  const { width: W, height: H, data } = img;
  const rows = [], cols = [];
  for (let y = 0; y < H; y++) {
    let c = 0;
    for (let x = 0; x < W; x++) if (lum(data, (y * W + x) * 4) < 150) c++;
    if (c > W * 0.55) rows.push(y);
  }
  for (let x = 0; x < W; x++) {
    let c = 0;
    for (let y = 0; y < H; y++) if (lum(data, (y * W + x) * 4) < 150) c++;
    if (c > H * 0.55) cols.push(x);
  }
  if (!rows.length || !cols.length) return null;
  return { x0: cols[0], y0: rows[0], x1: cols[cols.length - 1], y1: rows[rows.length - 1] };
}

/** PCB: bright content bbox on a dark background.
 *  70 keeps both sides' copper reds in (#ff0000 lum 76, export mask red ≈97)
 *  while excluding both dark canvases (export black 0, viewer #14161a lum 22). */
function pcbRect(img) {
  const { width: W, height: H, data } = img;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (lum(data, (y * W + x) * 4) > 70) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/** PCB alignment anchor: strongly-red pixels (copper pour / mask red). The bright
 *  rect above also catches the imported-screenshot dialog and its light outline,
 *  which differ between the export (drawn with a window outline) and our render —
 *  anchoring on the board itself removes that systematic ~2% scale error. */
function pcbBoardRect(img) {
  const { width: W, height: H, data } = img;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 120 && g < r * 0.45 && b < r * 0.6) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? pcbRect(img) : { x0, y0, x1, y1 };
}

const rectOf = (img, kind) => (kind === 'pcb' ? pcbBoardRect(img) : schRect(img));

/** structural diff mask: big per-channel deltas (AA halos stay below) */
function diffMask(a, b) {
  const { width: W, height: H } = a;
  const mask = new Uint8Array(W * H);
  for (let i = 0, p = 0; p < mask.length; p++, i += 4) {
    const dr = Math.abs(a.data[i] - b.data[i]);
    const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
    const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
    const dl = Math.abs(lum(a.data, i) - lum(b.data, i));
    if (dl > 40 || (dr > 60 && dg > 60) || (dr > 60 && db > 60) || (dg > 60 && db > 60)) mask[p] = 1;
  }
  return mask;
}

/** grid-cluster the mask into regions, largest first */
function cluster(mask, W, H, cell = 20, minCount = 25) {
  const gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
  const counts = new Uint32Array(gw * gh);
  for (let y = 0; y < H; y++) {
    const gy = (y / cell) | 0;
    for (let x = 0; x < W; x++) if (mask[y * W + x]) counts[gy * gw + ((x / cell) | 0)]++;
  }
  const seen = new Uint8Array(gw * gh);
  const regions = [];
  for (let i = 0; i < counts.length; i++) {
    if (seen[i] || counts[i] < minCount) continue;
    // BFS merge
    const stack = [i];
    seen[i] = 1;
    let cx0 = i % gw, cx1 = cx0, cy0 = (i / gw) | 0, cy1 = cy0, total = 0;
    while (stack.length) {
      const c = stack.pop();
      total += counts[c];
      const cx = c % gw, cy = (c / gw) | 0;
      if (cx < cx0) cx0 = cx; if (cx > cx1) cx1 = cx;
      if (cy < cy0) cy0 = cy; if (cy > cy1) cy1 = cy;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const n = ny * gw + nx;
        if (!seen[n] && counts[n] >= minCount) { seen[n] = 1; stack.push(n); }
      }
    }
    regions.push({ x: cx0 * cell, y: cy0 * cell, w: (cx1 - cx0 + 1) * cell, h: (cy1 - cy0 + 1) * cell, count: total });
  }
  return regions.sort((a, b) => b.count - a.count);
}

function crop3x(img, r, file) {
  const pad = 6;
  const x0 = Math.max(0, r.x - pad), y0 = Math.max(0, r.y - pad);
  const x1 = Math.min(img.width, r.x + r.w + pad), y1 = Math.min(img.height, r.y + r.h + pad);
  const w = x1 - x0, h = y1 - y0, K = 3;
  const out = new PNG({ width: w * K, height: h * K });
  for (let y = 0; y < h * K; y++) {
    for (let x = 0; x < w * K; x++) {
      const si = ((y0 + ((y / K) | 0)) * img.width + x0 + ((x / K) | 0)) * 4;
      const di = (y * out.width + x) * 4;
      for (let k = 0; k < 4; k++) out.data[di + k] = img.data[si + k];
    }
  }
  fs.writeFileSync(file, PNG.sync.write(out));
}

function drawBoxes(img, regions) {
  const { width: W, data } = img;
  const box = (r, R, G, B) => {
    for (let t = 0; t < 2; t++) {
      const x0 = r.x + t, x1 = r.x + r.w - 1 - t, y0 = r.y + t, y1 = r.y + r.h - 1 - t;
      for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) {
        for (const y of [y0, y1]) {
          if (y < 0 || y >= img.height) continue;
          const i = (y * W + x) * 4;
          data[i] = R; data[i + 1] = G; data[i + 2] = B;
        }
      }
      for (let y = Math.max(0, y0); y <= Math.min(img.height - 1, y1); y++) {
        for (const x of [x0, x1]) {
          if (x < 0 || x >= W) continue;
          const i = (y * W + x) * 4;
          data[i] = R; data[i + 1] = G; data[i + 2] = B;
        }
      }
    }
  };
  regions.forEach((r, i) => box(r, i === 0 ? 255 : 255, i === 0 ? 0 : 160, 0));
}

// ---------- camera drive ----------
async function setCamera(page, { s, tx, ty }) {
  await page.evaluate(({ s, tx, ty }) => {
    const sh = window.__ev.shell;
    sh.userView = true;
    sh.camera.scale = s;
    sh.camera.tx = tx;
    sh.camera.ty = ty;
    sh.camera.apply();
  }, { s, tx, ty });
  await new Promise((r) => setTimeout(r, 350));
}

async function worldBBox(page) {
  return page.evaluate(() => {
    const sh = window.__ev.shell;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const o of sh.objects) {
      if (!o.bbox) continue;
      minX = Math.min(minX, o.bbox.minX); minY = Math.min(minY, o.bbox.minY);
      maxX = Math.max(maxX, o.bbox.maxX); maxY = Math.max(maxY, o.bbox.maxY);
    }
    return isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  });
}

// ---------- main ----------
const up = async () => { try { return (await fetch(`http://127.0.0.1:${PORT}/`)).ok; } catch { return false; } };
const vite = spawn('node', ['node_modules/vite/bin/vite.js', 'dev', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const report = [];
let browser;
try {
  const t0 = Date.now();
  while (!(await up())) {
    if (Date.now() - t0 > 30000) throw new Error('vite timeout');
    await new Promise((r) => setTimeout(r, 300));
  }
  browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', args: ['--no-sandbox', '--force-device-scale-factor=1'],
  });

  for (const c of CASES) {
    if (only && !only.includes(c.name)) continue;
    const refPath = path.join(SAMPLE_DIR, c.ref);
    const ref = PNG.sync.read(fs.readFileSync(refPath));
    const caseDir = path.join(outDir, c.name.replaceAll(' ', '_'));
    fs.mkdirSync(caseDir, { recursive: true });

    const url = `http://127.0.0.1:${PORT}/qa/viewer.html?file=${encodeURIComponent(FILE)}&open=${encodeURIComponent(c.open)}&toolbar=0&left=0&right=0&status=0`;
    const page = await browser.newPage();
    await page.setViewport({ width: ref.width, height: ref.height, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => console.log(`  [${c.name}] PAGEERROR:`, e.message.slice(0, 120)));
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForFunction('window.__qaReady === true', { timeout: 30000 });
    const opened = await page.evaluate(() => document.getElementById('open-result')?.textContent ?? 'no-open-div');
    if (!/ok:true/.test(opened)) console.log(`  [${c.name}] OPEN PROBLEM: ${opened}`);
    await new Promise((r) => setTimeout(r, 1200));

    const wb = await worldBBox(page);
    const shot = async () => PNG.sync.read(await page.screenshot({ type: 'png' }));

    // pass 1: rough alignment (world bbox -> ref content rect)
    let rect = rectOf(ref, c.kind);
    if (!wb || !rect) { console.log(`  [${c.name}] SKIP: no world bbox or no ref rect`); await page.close(); continue; }
    const rw = rect.x1 - rect.x0, rh = rect.y1 - rect.y0;
    const ww = wb.maxX - wb.minX, wh = wb.maxY - wb.minY;
    let s = Math.min(rw / ww, rh / wh);
    let tx = (rect.x0 + rect.x1) / 2 - ((wb.minX + wb.maxX) / 2) * s;
    let ty = (rect.y0 + rect.y1) / 2 - ((wb.minY + wb.maxY) / 2) * s;
    await setCamera(page, { s, tx, ty });
    let ours = await shot();

    // pass 2: measure our own content rect and correct.
    // screen = world*s + t → world = (measured - t)/s; want measured center to land
    // on the ref rect center at the corrected scale, so t' = refC - (measured - t)*r
    // with r = s'/s (both the scale ratio and the t ratio — omitting it on t breaks
    // whenever pass-1 lands far from the final scale).
    const ourRect = rectOf(ours, c.kind);
    if (ourRect) {
      const ow = ourRect.x1 - ourRect.x0, oh = ourRect.y1 - ourRect.y0;
      const cam = await page.evaluate(() => ({ s: window.__ev.shell.camera.scale, tx: window.__ev.shell.camera.tx, ty: window.__ev.shell.camera.ty }));
      s = cam.s * ((rw / ow + rh / oh) / 2);
      const r = s / cam.s;
      const owc = (ourRect.x0 + ourRect.x1) / 2, ohc = (ourRect.y0 + ourRect.y1) / 2;
      tx = ((rect.x0 + rect.x1) / 2 - (owc - cam.tx) * r);
      ty = ((rect.y0 + rect.y1) / 2 - (ohc - cam.ty) * r);
      await setCamera(page, { s, tx, ty });
      ours = await shot();
    }
    fs.writeFileSync(path.join(caseDir, 'ours.png'), PNG.sync.write(ours));

    // diff
    const pm = pixelmatch(ref.data, ours.data, null, ref.width, ref.height, { threshold: 0.12, includeAA: false });
    const mask = diffMask(ref, ours);
    const maskCount = mask.reduce((a, b) => a + b, 0);
    const regions = cluster(mask, ref.width, ref.height);
    const heat = new PNG({ width: ours.width, height: ours.height });
    heat.data.set(ours.data);
    drawBoxes(heat, regions.slice(0, 8));
    fs.writeFileSync(path.join(caseDir, 'diff.png'), PNG.sync.write(heat));
    regions.slice(0, 6).forEach((r, i) => {
      crop3x(ref, r, path.join(caseDir, `r${i}.png`));
      crop3x(ours, r, path.join(caseDir, `o${i}.png`));
    });

    const entry = {
      name: c.name, kind: c.kind,
      size: `${ref.width}x${ref.height}`,
      pixelmatchDiff: pm, maskDiff: maskCount,
      diffPct: +((maskCount / (ref.width * ref.height)) * 100).toFixed(2),
      regions: regions.slice(0, 10).map((r) => ({
        ...r,
        doc: `(${Math.round((r.x - tx) / s)}, ${Math.round((c.kind === 'pcb' ? -(r.y - ty) : (r.y - ty)) / s)})`,
      })),
    };
    report.push(entry);
    console.log(`${entry.diffPct > 1 ? '✗' : '✓'} ${c.name.padEnd(12)} diff=${String(entry.diffPct).padStart(6)}%  pm=${String(pm).padStart(7)}  regions=${regions.length}${regions.length ? '  top=' + JSON.stringify(entry.regions[0]) : ''}`);
    await page.close();
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
  console.log(`report -> ${path.join(outDir, 'report.json')}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  vite.kill();
  await new Promise((r) => setTimeout(r, 300));
}
