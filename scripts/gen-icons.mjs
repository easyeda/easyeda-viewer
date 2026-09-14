// regenerate src/ui/icons.ts from lucide-static (ISC) after adding icon names
import { readFileSync, writeFileSync } from 'node:fs';

const names = {
  folderOpen: 'folder-open', folderTree: 'folder-tree', fileArchive: 'file-archive',
  zoomIn: 'zoom-in', zoomOut: 'zoom-out', fit: 'maximize',
  sun: 'sun', moon: 'moon', panelLeft: 'panel-left', panelRight: 'panel-right',
  uploadCloud: 'upload-cloud', scanSearch: 'scan-search',
  folder: 'folder', packageOpen: 'package-open', waypoints: 'waypoints', circuitBoard: 'circuit-board',
  layoutTemplate: 'layout-template', activity: 'activity', library: 'library', fileText: 'file-text',
  file: 'file', chevronRight: 'chevron-right', box: 'box', layers: 'layers', list: 'list', eye: 'eye', eyeOff: 'eye-off',
};
const inner = (f) => {
  const s = readFileSync('node_modules/lucide-static/icons/' + f + '.svg', 'utf8');
  const m = s.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
  if (!m) throw new Error('no svg in ' + f);
  return m[1].trim().replace(/>\s+</g, '><');
};
const map = Object.fromEntries(Object.entries(names).map(([k, v]) => [k, inner(v)]));
const tpl = [
  '/**',
  ' * Inline SVG icon set based on Lucide (https://lucide.dev, ISC license).',
  ' * Free for commercial use with attribution kept here per license terms.',
  ' * Generated from lucide-static — do not hand-edit the path data.',
  ' */',
  '',
  'const ICONS: Record<string, string> = ' + JSON.stringify(map, null, 1) + ';',
  '',
  '/** SVG markup for an icon name; stroke follows `currentColor`. */',
  "export function icon(name: string, size = 16): string {",
  "  const p = ICONS[name] ?? ICONS.file;",
  "  return `<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" width=\"${size}\" height=\"${size}\" aria-hidden=\"true\">${p}</svg>`;",
  '}',
  '',
].join('\n');
writeFileSync('src/ui/icons.ts', tpl);
console.log('icons.ts written');
