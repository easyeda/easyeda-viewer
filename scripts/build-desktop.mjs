// Build the install-free desktop exe: vite bundle -> desktop/dist -> go build.
// Produces two artifacts in desktop/build: the standard exe and the Windows 7
// variant (Go 1.20 toolchain). Usage: node scripts/build-desktop.mjs
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version ?? '0.0.0';

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: false, ...opts });

console.log(`[1/4] vite build (viewer ${version})`);
sh('node', ['node_modules/vite/bin/vite.js', 'build']);

console.log('[2/4] copy dist -> desktop/dist');
rmSync(resolve(root, 'desktop/dist'), { recursive: true, force: true });
mkdirSync(resolve(root, 'desktop/dist'), { recursive: true });
cpSync(resolve(root, 'dist'), resolve(root, 'desktop/dist'), { recursive: true });

// refresh Windows resources (exe icon + version info) when a resource compiler
// is available; the committed rsrc_windows_amd64.syso is the fallback.
try {
  console.log('[*] windres -> rsrc_windows_amd64.syso');
  sh('windres', ['-c', '65001', '-i', 'versioninfo.rc', '-O', 'coff', '-o', 'rsrc_windows_amd64.syso'],
    { cwd: resolve(root, 'desktop'), stdio: 'pipe' });
} catch {
  console.log('[*] windres not found — using committed .syso');
}

console.log('[3/4] go build desktop exe');
const outDir = resolve(root, 'desktop/build');
mkdirSync(outDir, { recursive: true });
// artifact names carry the version so multiple builds stay side by side
const ldflags = `-s -w -H windowsgui -X main.version=${version} -X main.platform=windows`;
const build = (outName, env) => {
  sh('go', ['build', '-ldflags', ldflags, '-o', resolve(outDir, outName), '.'], {
    cwd: resolve(root, 'desktop'),
    env: { ...process.env, CGO_ENABLED: '1', ...env },
  });
  console.log('  ->', resolve(outDir, outName));
};
build(`easyeda-viewer_v${version}.exe`, {});

// Go 1.21 dropped Windows 7 support — the win7 variant pins the last
// Win7-capable toolchain (runs on Win7 SP1 + WebView2 109 and on 10/11).
console.log('[4/4] go build Windows 7 variant (go1.20.14)');
const GO_FOR_WIN7 = 'go1.20.14';
build(`easyeda-viewer_win7_v${version}.exe`, { GOTOOLCHAIN: process.env.GOTOOLCHAIN || GO_FOR_WIN7 });

console.log('done');
