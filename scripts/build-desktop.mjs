// Build the install-free desktop exe: vite bundle -> desktop/dist -> go build.
// Usage: node scripts/build-desktop.mjs   (then desktop/build/easyeda-viewer.exe)
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version ?? '0.0.0';

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: false, ...opts });

console.log(`[1/3] vite build (viewer ${version})`);
sh('node', ['node_modules/vite/bin/vite.js', 'build']);

console.log('[2/3] copy dist -> desktop/dist');
rmSync(resolve(root, 'desktop/dist'), { recursive: true, force: true });
mkdirSync(resolve(root, 'desktop/dist'), { recursive: true });
cpSync(resolve(root, 'dist'), resolve(root, 'desktop/dist'), { recursive: true });

console.log('[3/3] go build desktop exe');
const outDir = resolve(root, 'desktop/build');
mkdirSync(outDir, { recursive: true });
sh('go', ['build', '-ldflags', `-s -w -H windowsgui -X main.version=${version} -X main.platform=windows`,
  '-o', resolve(outDir, 'easyeda-viewer.exe'), '.'], { cwd: resolve(root, 'desktop'), env: { ...process.env, CGO_ENABLED: '1' } });

console.log('done ->', resolve(outDir, 'easyeda-viewer.exe'));
