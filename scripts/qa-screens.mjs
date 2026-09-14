// Visual QA: shoot the harness page in several theme/chrome/document combos
// via headless Chrome. Usage: node scripts/qa-screens.mjs [name-substring]
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
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
const EPRJ = '/samples/RA6E2-eprj3/RA6E2-eprj3.zip';
const shots_list = [
  { name: 'welcome-light', url: `${base}?file=none` },
  { name: 'welcome-dark', url: `${base}?file=none&theme=dark` },
  { name: 'sch-light', url: `${base}?file=${encodeURIComponent(EPRJ)}` },
  { name: 'sch-dark', url: `${base}?file=${encodeURIComponent(EPRJ)}&theme=dark` },
  { name: 'pcb', url: `${base}?file=${encodeURIComponent(EPRJ)}&open=PCB` },
  { name: 'canvas-only', url: `${base}?file=${encodeURIComponent(EPRJ)}&toolbar=0&left=0&right=0&status=0` },
  { name: 'epro2-light', url: `${base}?file=${encodeURIComponent(SCH)}` },
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

for (const s of shots_list) {
  if (filter && !s.name.includes(filter)) continue;
  const out = resolve(shots, s.name + '.png');
  try {
    execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--window-size=1500,900', `--screenshot=${out}`,
      '--virtual-time-budget=12000', '--run-all-compositor-stages-before-draw',
      s.url,
    ], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 90000 });
    console.log(existsSync(out) ? '✓ ' + s.name : '✗ ' + s.name + ' (no file)');
  } catch (e) {
    console.log('✗ ' + s.name + ' ' + String(e.message).split('\n')[0]);
  }
}
cleanup();
console.log('shots ->', shots);
