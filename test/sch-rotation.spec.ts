import { describe, expect, it, vi } from 'vitest';
import type { DocSegment, OpenedDoc, Rec } from '../src/core/types';
import { emptyReport } from '../src/core/types';

// Inspect the renderer's scene graph without requiring a browser/canvas.
vi.mock('leafer-ui', () => {
  class Node {
    children: Node[] = [];
    x = 0; y = 0; rotation = 0; scaleX = 1; scaleY = 1;
    constructor(data: object = {}) { Object.assign(this, data); }
    add(node: Node) { this.children.push(node); }
  }
  return Object.fromEntries(['Group', 'Line', 'Rect', 'Path', 'Text', 'Ellipse', 'Image'].map(k => [k, Node]));
});

import { renderSch } from '../src/core/render/sch';
import { ang, textFramePoly, xfOf } from '../src/core/render/geom';
import type { RenderApi, RenderObject } from '../src/core/render/layers';

function rec(type: string, id: string, data: Record<string, any>): Rec {
  return { type, id, idVal: id, data, ticket: 0, lineNo: 1, raw: '' };
}

function segment(uuid: string, docType: string, recs: Rec[], up: boolean, meta = {}): DocSegment {
  return { uuid, docType, recs, startLine: 1, meta,
    canvas: { originX: 0, originY: 0, ...(up ? { yAxisDirection: 'up' } : {}) } };
}

function render(self: DocSegment, symbols: DocSegment[]) {
  let page: any;
  const objects: RenderObject[] = [];
  const opened: OpenedDoc = {
    self, libs: new Map(symbols.map(s => [s.uuid, s])), blobs: new Map(), fileKey: 'rotation.esch2',
    node: { id: self.uuid, kind: 'sheet', title: 'Rotation' },
    bbox: { minX: 0, minY: 0, maxX: 200, maxY: 200 }, report: emptyReport(),
  };
  const api: RenderApi = {
    addGroup: (_s, g) => { page = g; }, addObject: o => { objects.push(o); },
    layer: () => { throw new Error('unexpected PCB layer'); }, bgColor: '#fff',
    addConstantText() {}, addConstantStroke() {}, reportDiagnostics: [],
  };
  renderSch(opened, api);
  return { page, objects };
}

function walk(node: any): any[] {
  return [node, ...(node.children ?? []).flatMap(walk)];
}

/** Apply the same T·R·S nesting as the scene graph to a local point. */
function pointsInWorld(node: any, point: [number, number], parents: any[] = []): [number, number][] {
  const here = [...parents, node];
  const out: [number, number][] = [];
  if (node.points) {
    let [x, y] = point;
    for (const n of [...here].reverse()) {
      x *= n.scaleX ?? 1; y *= n.scaleY ?? 1;
      const a = (n.rotation ?? 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      [x, y] = [x * c - y * s + (n.x ?? 0), x * s + y * c + (n.y ?? 0)];
    }
    out.push([x, y]);
  }
  for (const child of node.children ?? []) out.push(...pointsInWorld(child, point, here));
  return out;
}

function expectPoint(actual: [number, number], expected: [number, number]) {
  expect(actual[0]).toBeCloseTo(expected[0]);
  expect(actual[1]).toBeCloseTo(expected[1]);
}

describe('schematic placement rotations', () => {
  it.each([false, true])('keeps screen angle independent of Y-up migration (up=%s)', up => {
    const xf = xfOf({ originX: 0, originY: 0 }, up);
    expect(ang(90, xf)).toBe(-90);
    expect(ang(270, xf)).toBe(-270);
    const corners = textFramePoly({ type: 'TEXT', data: {
      value: 'D1', x: 64, y: up ? 470 : -470, rotation: 90, align: 'LEFT_MIDDLE', fontSize: 12,
    } }, xf)!;
    // The baseline points upward, not downward, in either stored Y convention.
    expect(corners[1][1]).toBeLessThan(corners[0][1]);
  });

  it('lands the rotated LED pins on the wires and rotates its designator upward', () => {
    const sym = segment('led', 'SYMBOL', [
      rec('PIN', 'k', { partId: 'p', x: -20, y: -14, length: 15, rotation: 0 }),
      rec('PIN', 'a', { partId: 'p', x: 20, y: -14, length: 15, rotation: 180 }),
    ], true);
    const self = segment('sheet', 'SCH_PAGE', [
      rec('COMPONENT', 'led1', { partId: 'p', x: 86, y: 470, rotation: 90 }),
      rec('ATTR', 'symbol', { parentId: 'led1', key: 'Symbol', value: 'led' }),
      rec('ATTR', 'designator', { parentId: 'led1', key: 'Designator', value: 'D1',
        x: 64, y: 470, rotation: 90, align: 'LEFT_MIDDLE', valueVisible: true }),
      rec('ATTR', 'nc', { parentId: 'led1-k', key: 'NO_CONNECT', value: 'yes' }),
    ], true);
    const { page, objects } = render(self, [sym]);
    const comp = objects.find(o => o.id === 'led1')!;
    const pins = pointsInWorld(comp.node, [0, 0]);
    // Use each line's first point (the electrical pin anchor).
    const lines = walk(comp.node).filter(n => n.points);
    lines.forEach((line, i) => {
      const pts = pointsInWorld(comp.node, [line.points[0], line.points[1]]);
      expectPoint(pts[i], i === 0 ? [100, -450] : [100, -490]);
    });
    expect(pins).toHaveLength(2);
    expect(walk(page).find(n => n.text === 'D1').rotation).toBe(-90);
    expect(comp.bbox!.minX).toBeGreaterThan(90);
    // NO_CONNECT must use the same transform as the symbol and selection box.
    const cross = page.children.find((n: any) => n.children?.length === 2 && n.children[0].points?.length === 4);
    expectPoint([cross.children[0].points[0] + 4.5, cross.children[0].points[1] + 4.5], [100, -450]);
  });

  it.each([false, true])('rotates a port toward its label without rotating the page-space label (up=%s)', up => {
    const sy = (y: number) => up ? y : -y;
    const sym = segment('port', 'SYMBOL', [rec('POLY', 'shape', {
      partId: 'p', points: [{ x: 10, y: sy(5) }, { x: 30, y: sy(5) },
        { x: 40, y: 0 }, { x: 30, y: sy(-5) }, { x: 10, y: sy(-5) }], closed: true,
    })], up, { docType: 19 });
    const self = segment('sheet', 'SCH_PAGE', [
      rec('COMPONENT', 'port1', { partId: 'p', x: 100, y: sy(585), rotation: 90 }),
      rec('ATTR', 'symbol', { parentId: 'port1', key: 'Symbol', value: 'port' }),
      rec('ATTR', 'name', { parentId: 'port1', key: 'Name', value: 'N_OUT', x: 100, y: sy(630),
        rotation: 0, align: 'CENTER_BOTTOM', valueVisible: true }),
    ], up);
    const { page, objects } = render(self, [sym]);
    expectPoint(pointsInWorld(objects[0].node, [40, 0])[0], [100, -625]);
    const label = walk(page).find(n => n.text === 'N_OUT');
    expectPoint([label.x, label.y], [100, -630]);
    expect(label.rotation).toBe(0);
  });

  it('keeps Y-up PIN direction separate from placement/text angle conversion', () => {
    const self = segment('symbol', 'SYMBOL', [rec('PIN', 'pin', {
      x: 0, y: 0, length: 10, rotation: 90,
    })], true);
    const { page } = render(self, []);
    const line = walk(page).find(n => n.points);
    expectPoint([line.points[2], line.points[3]], [0, -10]);
  });

  it('falls back to record-level yAxisDirection when CANVAS has no flag', () => {
    const self: DocSegment = {
      uuid: 'sheet', docType: 'SCH_PAGE', startLine: 1, meta: {},
      canvas: { originX: 0, originY: 0 },
      recs: [rec('TEXT', 't', { value: 'UPFLAG', x: 0, y: 100, fontSize: 10, yAxisDirection: 'up' })],
    };
    const { page } = render(self, []);
    const upLabel = walk(page).find(n => (n.children ?? []).some((c: any) => c.text === 'UPFLAG'));
    expect(upLabel.y).toBeCloseTo(-100.5);
  });

  it('lets an explicit CANVAS flag win over record-level yAxisDirection', () => {
    const self: DocSegment = {
      uuid: 'sheet', docType: 'SCH_PAGE', startLine: 1, meta: {},
      canvas: { originX: 0, originY: 0, yAxisDirection: 'down' },
      recs: [rec('TEXT', 't', { value: 'DOWNFLAG', x: 0, y: 100, fontSize: 10, yAxisDirection: 'up' })],
    };
    const { page } = render(self, []);
    const downLabel = walk(page).find(n => (n.children ?? []).some((c: any) => c.text === 'DOWNFLAG'));
    expect(downLabel.y).toBeCloseTo(99.5);
  });

  function pinLabelScene(rotation: number) {
    const sym = segment('pin-sym', 'SYMBOL', [
      rec('PIN', 'p', { partId: 'p', x: -20, y: 0, length: 10, rotation: 0 }),
      rec('ATTR', 'pn', { parentId: 'p', key: 'Pin Name', value: 'OUT', x: -6, y: 1,
        rotation: 0, align: 'LEFT_BOTTOM', valueVisible: true }),
    ], true);
    const self = segment('sheet', 'SCH_PAGE', [
      rec('COMPONENT', 'c1', { partId: 'p', x: 0, y: 0, rotation }),
      rec('ATTR', 's', { parentId: 'c1', key: 'Symbol', value: 'pin-sym' }),
    ], true);
    const { page } = render(self, [sym]);
    const label = walk(page).find(n => n.text === 'OUT')!;
    return { page, label };
  }

  it('rotates pin labels with the symbol at 90° (client behavior)', () => {
    const { page, label } = pinLabelScene(90);
    // no counter-rotation: the label turns together with the component group
    expect(label.rotation).toBeCloseTo(0);
    expect(walk(page).some(n => n.rotation === -90)).toBe(true);
  });

  it('keeps 180° pin labels upright and mirrors their alignment', () => {
    const { page, label } = pinLabelScene(180);
    // label and group rotations cancel out; both alignments are swapped so
    // the text still extends inward from the pin
    expect(label.rotation).toBe(180);
    expect(walk(page).some(n => n.rotation === -180)).toBe(true);
    expect(label.textAlign).toBe('right');
    expect(label.verticalAlign).toBe('top');
  });

  it('does not synthesize a description value when Design Value is painted', () => {
    const sym = segment('cap-sym', 'SYMBOL', [
      rec('PIN', 'p', { partId: 'p', x: -20, y: 0, length: 10, rotation: 0 }),
    ], true);
    const dev = segment('cap-dev', 'DEVICE', [], true, { description: '10uF ±10% 25V' } as any);
    const self = segment('sheet', 'SCH_PAGE', [
      rec('COMPONENT', 'c1', { partId: 'p', x: 100, y: 100, rotation: 0 }),
      rec('ATTR', 's', { parentId: 'c1', key: 'Symbol', value: 'cap-sym' }),
      rec('ATTR', 'd', { parentId: 'c1', key: 'Device', value: 'cap-dev' }),
      rec('ATTR', 'des', { parentId: 'c1', key: 'Designator', value: 'C62',
        x: 100, y: 108, rotation: 0, align: 'LEFT_MIDDLE', valueVisible: true }),
      rec('ATTR', 'dv', { parentId: 'c1', key: 'Design Value', value: '100nF',
        x: 100, y: 104, rotation: 0, align: 'LEFT_MIDDLE', valueVisible: true }),
    ], true);
    const { page } = render(self, [sym, dev]);
    const texts = walk(page).map(n => n.text).filter(Boolean);
    expect(texts).toContain('100nF');
    expect(texts).not.toContain('10uF');
  });
});
