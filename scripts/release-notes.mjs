// Extract one version's section from CHANGELOG.md, for use as GitHub Release notes.
// Usage: node scripts/release-notes.mjs [version]     (default: package.json version)
// Prints the section to stdout; missing section degrades to a one-line notice
// (a release must never fail just because the changelog lags behind).
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = process.argv[2] ?? pkg.version;

const lines = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
const esc = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const start = lines.findIndex((l) => new RegExp(`^##\\s*\\[?v?${esc}\\]?`).test(l));
if (start < 0) {
  console.log(`easyeda-viewer v${version}\n\nCHANGELOG 中暂无本版条目。`);
  process.exit(0);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (/^##\s/.test(lines[i])) { end = i; break; }
}
console.log(lines.slice(start, end).join('\n').trim());