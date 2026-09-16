// Visual QA: shoot the harness page in several theme/chrome/document combos
// via headless Chrome. Usage: node scripts/qa-screens.mjs [name-substring]
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shots = resolve(root, 'qa/shots');
rmSync(shots, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync) ?? 'chrome';

const PORT = 5177;
const base = `http://127.0.0.1:${PORT}/qa/viewer.html`;

/** @type {{name:string, url:string, wait?:number}[]} */
const SCH = '/samples/RA6E2-epro2/RA6E2.epro2';
// folder-form eprj3 project: pass every doc file through the `files=` query param
const eprjDir = resolve(root, 'samples/RA6E2-eprj3');
const listDir = (dir, prefix = '') => readdirSync(dir).flatMap((n) => {
  const p = resolve(dir, n);
  return statSync(p).isDirectory() ? listDir(p, `${prefix}${n}/`) : [`${prefix}${n}`];
});
const EPRJ_Q = 'files=' + encodeURIComponent(
  listDir(eprjDir).filter((p) => /\.(eprj3|esch2|epcb2|epan2|ecfg|evar)$/i.test(p))
    .map((p) => `/samples/RA6E2-eprj3/${p}`).join(','),
);
const shots_list = [
  { name: 'welcome-light', url: `${base}?file=none` },
  { name: 'welcome-dark', url: `${base}?file=none&theme=dark` },
  { name: 'welcome-en', url: `${base}?file=none&lang=en` },
  { name: 'sch-light', url: `${base}?${EPRJ_Q}` },
  { name: 'sch-sel', url: `${base}?${EPRJ_Q}&click=0.55,0.5` },
  { name: 'pcb', url: `${base}?${EPRJ_Q}&open=PCB1` },
  { name: 'pcb-sel', url: `${base}?${EPRJ_Q}&open=PCB1&click=0.5,0.5` },
  { name: 'pcb-dark', url: `${base}?${EPRJ_Q}&open=PCB1&theme=dark` },
  { name: 'pcb-en', url: `${base}?${EPRJ_Q}&open=PCB1&lang=en` },
  { name: 'canvas-only', url: `${base}?${EPRJ_Q}&open=PCB1&toolbar=0&left=0&right=0&status=0` },
  { name: 'epro2-light', url: `${base}?file=${encodeURIComponent(SCH)}` },
  { name: 'panel', url: `${base}?${EPRJ_Q}&open=PANEL` },
  { name: 'drop-proj', url: `${base}?file=none&drop=${encodeURIComponent(SCH)}` },
];
const filter = process.argv[2];

let dev = null;
let cleanup = () => {};
const up = async () => { try { return (await fetch(base)).ok; } catch { return false; } };

if (!(await up())) {
  console.log('starting vite dev :' + PORT);
  dev = spawn('node', ['node_modules/vite/bin/vite.js', 'dev', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'], shell: false });
  cleanup = () => { try { dev.kill(); } catch {} };
  process.on('exit', cleanup);
} else {
  console.log('reusing vite dev already on :' + PORT);
}

const t0 = Date.now();
while (!(await up())) {
  if (Date.now() - t0 > 20000) { console.error('vite dev did not come up'); cleanup(); process.exit(1); }
  await new Promise((r) => setTimeout(r, 400));
}
console.log('vite up');

// puppeteer with real time instead of `--virtual-time-budget`: virtual time races
// the harness's multi-file fetch chain, so `open=` never lands before the shot
const { default: puppeteer } = await import('puppeteer-core');
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--hide-scrollbars', '--force-device-scale-factor=1', '--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 1500, height: 900 },
});
const page = await browser.newPage();
for (const s of shots_list) {
  if (filter && !s.name.includes(filter)) continue;
  const out = resolve(shots, s.name + '.png');
  try {
    await page.goto(s.url, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForFunction('window.__qaReady === true', { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 700)); // settled frame
    await page.screenshot({ path: out });
    console.log('✓ ' + s.name);
  } catch (e) {
    console.log('✗ ' + s.name + ' ' + String(e.message).split('\n')[0]);
  }
}
await browser.close();
cleanup();
console.log('shots ->', shots);
