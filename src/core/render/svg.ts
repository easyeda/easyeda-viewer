/**
 * Scene-graph → SVG serializer for the document export API (#image-export).
 *
 * The viewer paints a Leafer scene graph; this walks that graph and emits the
 * same primitives as SVG so a rendered document can be saved as a vector file
 * without a screenshot. Only the node types the renderers actually create are
 * handled (Group / Rect / Ellipse / Line / Path / Text / Image).
 *
 * Text is emitted line-by-line from Leafer's laid-out rows (`textDrawData`),
 * which keeps alignment and baselines identical to the canvas. When a node has
 * not been laid out (detached scene), it falls back to the same line-box math
 * Leafer uses.
 */

export interface SvgViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SvgSceneOptions {
  /** output size in CSS pixels */
  width: number;
  height: number;
  /** world-space content box (screen coords, same as the viewer camera) */
  viewBox: SvgViewBox;
  /** page background; null/undefined = transparent */
  background?: string | null;
}

const XML_ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => XML_ESCAPE[c]);
}

/** trim float noise; -0 → 0 */
function num(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

function attr(name: string, value: unknown): string {
  return value === undefined || value === null || value === '' ? '' : ` ${name}="${esc(value)}"`;
}

/** solid color from a Leafer paint value; image/gradient paints are not colors */
function paint(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (value && typeof value === 'object') {
    const v = value as { type?: string; color?: string };
    if (v.type === 'solid') return v.color;
  }
  return undefined;
}

/** SVG transform attribute for a Leafer node (T·R·S around its own origin) */
function transform(node: any): string {
  const x = Number(node.x) || 0;
  const y = Number(node.y) || 0;
  const r = Number(node.rotation) || 0;
  const sx = node.scaleX === undefined ? 1 : Number(node.scaleX);
  const sy = node.scaleY === undefined ? 1 : Number(node.scaleY);
  const parts: string[] = [];
  if (x || y) parts.push(`translate(${num(x)} ${num(y)})`);
  if (r) parts.push(`rotate(${num(r)})`);
  if (sx !== 1 || sy !== 1) parts.push(`scale(${num(sx)} ${num(sy)})`);
  return parts.length ? ` transform="${parts.join(' ')}"` : '';
}

/** common paint/stroke/dash attributes shared by shapes and text */
function style(node: any, opts: { fill?: string; stroke?: string } = {}): string {
  let out = '';
  const fill = opts.fill ?? paint(node.fill);
  const stroke = opts.stroke ?? paint(node.stroke);
  out += ` fill="${fill ?? 'none'}"`;
  if (stroke) {
    out += ` stroke="${stroke}"`;
    out += attr('stroke-width', num(node.strokeWidth ?? 1));
    if (node.strokeCap && node.strokeCap !== 'none') out += attr('stroke-linecap', node.strokeCap);
    if (node.strokeJoin && node.strokeJoin !== 'miter') out += attr('stroke-linejoin', node.strokeJoin);
    if (Array.isArray(node.dashPattern) && node.dashPattern.length) {
      out += attr('stroke-dasharray', node.dashPattern.map(num).join(' '));
    }
  }
  if (typeof node.opacity === 'number' && node.opacity !== 1) out += attr('opacity', num(node.opacity));
  return out;
}

/** Leafer lineHeight: number = absolute px, {percent:n} = n×fontSize */
function lineHeight(node: any): number {
  const fs = Number(node.fontSize) || 12;
  const lh = node.lineHeight;
  if (lh && typeof lh === 'object') return (Number(lh.value) || 0) * (lh.type === 'percent' ? fs : 1);
  const n = Number(lh);
  return Number.isFinite(n) && n > 0 ? n : fs * 1.5;
}

/** one <text> per laid-out row (row.x/row.y are baseline coords in node space) */
function textSvg(node: any): string {
  const value = String(node.text ?? '');
  if (!value) return '';
  const fs = Number(node.fontSize) || 12;
  const family = String(node.fontFamily || 'sans-serif');
  const weight = node.bold ? 'bold' : node.fontWeight && node.fontWeight !== 'normal' ? String(node.fontWeight) : '';
  const fill = paint(node.fill) ?? 'none';
  const stroke = paint(node.stroke);
  const base = ` font-family="${esc(family)}" font-size="${num(fs)}"` +
    (weight ? ` font-weight="${esc(weight)}"` : '') +
    (node.italic ? ' font-style="italic"' : '');
  let attrs = ` fill="${esc(fill)}"`;
  if (stroke) {
    attrs += ` stroke="${esc(stroke)}"`;
    attrs += attr('stroke-width', num(node.strokeWidth ?? 1));
  }
  if (typeof node.opacity === 'number' && node.opacity !== 1) attrs += attr('opacity', num(node.opacity));
  let layout: { x: number; y: number; text: string }[] | null = null;
  try {
    const rows = node.textDrawData?.rows;
    if (Array.isArray(rows) && rows.length) layout = rows.map((r: any) => ({ x: Number(r.x) || 0, y: Number(r.y) || 0, text: String(r.text ?? '') }));
  } catch {
    layout = null;
  }
  if (!layout) {
    const lh = lineHeight(node);
    const baseline = lh - (lh - fs * 0.7) / 2;
    const lines = value.split('\n');
    const blockH = lh * lines.length;
    const va = String(node.verticalAlign ?? 'top');
    const top = va === 'bottom' ? -blockH : va === 'middle' ? -blockH / 2 : 0;
    const anchor = node.textAlign === 'center' ? 'middle' : node.textAlign === 'right' ? 'end' : 'start';
    attrs += ` text-anchor="${anchor}"`;
    layout = lines.map((line, i) => ({ x: 0, y: top + i * lh + baseline, text: line }));
  }
  return layout
    .filter((row) => row.text !== '')
    .map((row) => `<text x="${num(row.x)}" y="${num(row.y)}"${base}${attrs}>${esc(row.text)}</text>`)
    .join('');
}

function nodeSvg(node: any): string {
  if (!node || node.visible === false) return '';
  const tag = node.tag;
  const t = transform(node);
  let body = '';
  if (tag === 'Text') body = textSvg(node);
  else if (tag === 'Rect') {
    const radius = Array.isArray(node.cornerRadius) ? Math.max(...node.cornerRadius.map(Number)) : Number(node.cornerRadius) || 0;
    body = `<rect x="0" y="0" width="${num(node.width)}" height="${num(node.height)}"${radius ? attr('rx', num(radius)) : ''}${style(node)}/>`;
  } else if (tag === 'Ellipse') {
    const w = Math.max(0, Number(node.width) || 0), h = Math.max(0, Number(node.height) || 0);
    body = `<ellipse cx="${num(w / 2)}" cy="${num(h / 2)}" rx="${num(w / 2)}" ry="${num(h / 2)}"${style(node)}/>`;
  } else if (tag === 'Line') {
    const pts = Array.isArray(node.points) ? node.points : [];
    if (pts.length >= 4) {
      const pairs: string[] = [];
      for (let i = 0; i + 1 < pts.length; i += 2) pairs.push(`${num(pts[i])},${num(pts[i + 1])}`);
      body = `<polyline points="${pairs.join(' ')}"${style(node, { fill: 'none' })}/>`;
    }
  } else if (tag === 'Path') {
    const d = typeof node.path === 'string' ? node.path : '';
    if (d) {
      const rule = node.windingRule === 'evenodd' ? ' evenodd' : '';
      body = `<path d="${esc(d)}" fill-rule="${rule ? 'evenodd' : 'nonzero'}"${style(node)}/>`;
    }
  } else if (tag === 'Image') {
    const url = typeof node.url === 'string' ? node.url : node.fill && typeof node.fill === 'object' ? node.fill.url : undefined;
    if (typeof url === 'string' && url) {
      const w = Math.max(0, Number(node.width) || 0), h = Math.max(0, Number(node.height) || 0);
      const op = typeof node.opacity === 'number' && node.opacity !== 1 ? attr('opacity', num(node.opacity)) : '';
      body = `<image x="0" y="0" width="${num(w)}" height="${num(h)}" preserveAspectRatio="none" href="${esc(url)}" xlink:href="${esc(url)}"${op}/>`;
    }
  }
  if (body) return `<g${t}>${body}</g>`;
  // group / unknown container: paint its children in its local space
  const children = node.children;
  if (!children || typeof children.length !== 'number') return '';
  let inner = '';
  for (const child of children) inner += nodeSvg(child);
  if (!inner) return '';
  const op = typeof node.opacity === 'number' && node.opacity !== 1 ? attr('opacity', num(node.opacity)) : '';
  return `<g${t}${op}>${inner}</g>`;
}

export function sceneToSvg(root: any, opts: SvgSceneOptions): string {
  const vb = opts.viewBox;
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${num(opts.width)}" height="${num(opts.height)}" ` +
    `viewBox="${num(vb.x)} ${num(vb.y)} ${num(vb.width)} ${num(vb.height)}">`;
  if (opts.background) {
    out += `<rect x="${num(vb.x)}" y="${num(vb.y)}" width="${num(vb.width)}" height="${num(vb.height)}" fill="${esc(opts.background)}"/>`;
  }
  out += nodeSvg(root);
  return out + '</svg>';
}
