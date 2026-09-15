/** Canvas camera: wheel zoom (to cursor), drag pan, fit, animate-free MVP. */
import { Leafer, Group } from 'leafer-ui';

export class Camera {
  private leafer: Leafer;
  world: Group;
  private el: HTMLElement;
  scale = 1;
  tx = 0;
  ty = 0;
  /** called whenever transform changes (for zoom label / constant-width overlays) */
  onView?: () => void;
  private minS = 0.002;
  private maxS = 400;
  private panMoved = false;

  constructor(el: HTMLElement, leafer: Leafer) {
    this.el = el;
    this.leafer = leafer;
    this.world = new Group({ name: 'world', hittable: false });
    leafer.add(this.world);
    this.bind();
  }

  private apply() {
    this.world.x = this.tx;
    this.world.y = this.ty;
    this.world.scaleX = this.scale;
    this.world.scaleY = this.scale;
    this.onView?.();
  }

  zoomAt(px: number, py: number, factor: number) {
    const ns = Math.min(this.maxS, Math.max(this.minS, this.scale * factor));
    this.tx = px - ((px - this.tx) / this.scale) * ns;
    this.ty = py - ((py - this.ty) / this.scale) * ns;
    this.scale = ns;
    this.apply();
  }

  panBy(dx: number, dy: number) {
    this.tx += dx;
    this.ty += dy;
    this.apply();
  }

  /** fit a world bbox into the viewport with margin (px) */
  fit(bbox: { minX: number; minY: number; maxX: number; maxY: number }, margin = 40) {
    const w = this.el.clientWidth || 800, h = this.el.clientHeight || 600;
    const bw = Math.max(1, bbox.maxX - bbox.minX), bh = Math.max(1, bbox.maxY - bbox.minY);
    const s = Math.min((w - margin * 2) / bw, (h - margin * 2) / bh);
    this.scale = Math.min(this.maxS, Math.max(this.minS, s));
    this.tx = (w - (bbox.minX + bbox.maxX) * this.scale) / 2;
    this.ty = (h - (bbox.minY + bbox.maxY) * this.scale) / 2;
    this.apply();
  }

  /** center a world-space point at viewport middle */
  centerOn(wx: number, wy: number) {
    const w = this.el.clientWidth || 800, h = this.el.clientHeight || 600;
    this.tx = w / 2 - wx * this.scale;
    this.ty = h / 2 - wy * this.scale;
    this.apply();
  }

  get didPan(): boolean {
    return this.panMoved;
  }

  private bind() {
    this.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      const factor = Math.pow(1.0015, -e.deltaY * (e.deltaMode === 1 ? 16 : 1));
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, factor);
    }, { passive: false });

    // right-drag pans too; the browser menu never appears over the canvas
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    let down: { x: number; y: number } | null = null;
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
      down = { x: e.clientX, y: e.clientY };
      this.panMoved = false;
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!down) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.panMoved = true;
      this.panBy(e.movementX, e.movementY);
    });
    const up = () => { down = null; };
    this.el.addEventListener('pointerup', up);
    this.el.addEventListener('pointercancel', up);
    this.el.addEventListener('pointerleave', up);
  }
}
