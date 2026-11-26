import { describe, expect, it } from 'vitest';
import { sceneToSvg } from '../src/core/render/svg';

const opts = { width: 100, height: 50, viewBox: { x: 0, y: 0, width: 100, height: 50 } };

function node(tag: string, data: Record<string, any> = {}, children: any[] = []) {
  return { tag, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, visible: true, children, ...data };
}

describe('SVG scene export', () => {
  it('writes shapes with their local transform and paint', () => {
    const svg = sceneToSvg(node('Group', { x: 10, y: 20, rotation: 90 }, [
      node('Rect', { width: 30, height: 10, fill: '#ff0000', stroke: '#000', strokeWidth: 2, cornerRadius: 4 }),
      node('Ellipse', { width: 8, height: 8, fill: '#00ff00' }),
      node('Line', { points: [0, 0, 5, 5], stroke: '#123456', strokeWidth: 1, strokeCap: 'round' }),
    ]), opts);
    expect(svg).toContain('transform="translate(10 20) rotate(90)"');
    expect(svg).toContain('<rect x="0" y="0" width="30" height="10" rx="4" fill="#ff0000" stroke="#000" stroke-width="2"/>');
    expect(svg).toContain('<ellipse cx="4" cy="4" rx="4" ry="4" fill="#00ff00"/>');
    expect(svg).toContain('<polyline points="0,0 5,5" fill="none" stroke="#123456" stroke-width="1" stroke-linecap="round"/>');
  });

  it('uses laid-out text rows so alignment and baselines match the canvas', () => {
    const svg = sceneToSvg(node('Text', {
      text: 'AB', fontSize: 10, fontFamily: 'Arial', fill: '#0000ff',
      textAlign: 'center', verticalAlign: 'middle',
      textDrawData: { rows: [{ x: -6, y: 3.5, text: 'AB' }] },
    }), opts);
    expect(svg).toContain('<text x="-6" y="3.5"');
    expect(svg).toContain('font-family="Arial" font-size="10"');
    expect(svg).toContain('>AB</text>');
  });

  it('falls back to line-box math when text is not laid out', () => {
    const svg = sceneToSvg(node('Text', {
      text: 'L1\nL2', fontSize: 10, lineHeight: 10, fill: '#000', verticalAlign: 'top', textAlign: 'left',
    }), opts);
    // baseline = 10 - (10 - 7) / 2 = 8.5; rows 10 apart
    expect(svg).toContain('<text x="0" y="8.5"');
    expect(svg).toContain('<text x="0" y="18.5"');
    expect(svg).toContain('text-anchor="start"');
  });

  it('embeds images and escapes markup in text', () => {
    const svg = sceneToSvg(node('Group', {}, [
      node('Image', { width: 20, height: 10, fill: { type: 'image', url: 'data:image/png;base64,AAAA' } }),
      node('Text', { text: 'a<b&c', fontSize: 8, fill: '#000', textDrawData: { rows: [{ x: 0, y: 6, text: 'a<b&c' }] } }),
    ]), { ...opts, background: '#ffffff' });
    expect(svg).toContain('<image x="0" y="0" width="20" height="10" preserveAspectRatio="none" href="data:image/png;base64,AAAA"');
    expect(svg).toContain('a&lt;b&amp;c');
    expect(svg).toContain('<rect x="0" y="0" width="100" height="50" fill="#ffffff"/>');
  });

  it('skips hidden nodes', () => {
    const svg = sceneToSvg(node('Group', {}, [
      node('Rect', { width: 5, height: 5, fill: '#000', visible: false }),
    ]), opts);
    expect(svg).not.toContain('<rect x="0" y="0" width="5"');
  });
});
