/**
 * Measure tool (#measure) — PCB-family documents only (pcb / footprint / panel).
 *
 * A screen-space <canvas> overlay paints, at constant 1 px CSS width:
 *  - full-viewport crosshair lines following the cursor while measuring,
 *  - right-triangle rulers: the hypotenuse is the measured segment, the two
 *    legs through the START point (horizontal + vertical) carry equally
 *    spaced ticks at a round mm step; labels report |ΔX| / |ΔY| / distance
 *    in mm (2-3 decimals).
 *
 * Rulers are stored in document mil; every camera change re-projects and
 * repaints, so geometry follows zoom/pan while stroke width and font size
 * stay constant on screen. The overlay itself is pointer-events:none — all
 * input still reaches the canvas host, so wheel zoom / drag pan keep working;
 * the shell's click-selection is gated while the mode is active. White 1 px
 * lines/text get a thin dark halo so they read on both dark PCB and white
 * panel backgrounds.
 *
 * Exit paths: right-click without drag = clear ALL rulers + exit; toolbar
 * button again or Esc = exit keeping the rulers. Opening another document
 * resets everything (rulers belong to the old doc).
 */
import type { Camera } from './camera';
import { t } from './i18n';

const MM_PER_MIL = 0.0254;
/** round tick steps (mm) — pick the smallest whose screen spacing ≥ MIN_TICK_PX */
const TICK_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
const MIN_TICK_PX = 10;
/** below this screen length a leg/tick row is skipped (degenerate triangle) */
const MIN_LEG_PX = 2;
const WHITE = '#ffffff';
const HALO = 'rgba(0,0,0,0.55)';
const FONT = '11px "Segoe UI", "Microsoft YaHei", sans-serif';

interface Pt { x: number; y: number } // document mil (camera/world space)
interface ScreenPt { x: number; y: number }
interface Ruler { a: Pt; b: Pt }

export interface MeasureOptions {
  /** canvas host (.ev-canvas) — also the event source (leafer events bubble here) */
  host: HTMLElement;
  camera: Camera;
  /** mode entered/exited — button highlight, crosshair cursor, status hint */
  onActive?: (active: boolean) => void;
}

export class MeasureController {
  private host: HTMLElement;
  private camera: Camera;
  private onActive?: (active: boolean) => void;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;
  private rulers: Ruler[] = [];
  /** first point of the ruler currently being drawn (null = idle) */
  private start: Pt | null = null;
  /** cursor position in host-local CSS px (null = pointer outside) */
  private cursor: ScreenPt | null = null;
  private rightDown: ScreenPt | null = null;
  private available = false;
  private activeState = false;

  constructor(opts: MeasureOptions) {
    this.host = opts.host;
    this.camera = opts.camera;
    this.onActive = opts.onActive;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ev-measure-layer';
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
    this.host.appendChild(this.canvas);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.host);
    this.resize();

    // the overlay never intercepts input; events bubble up from the leafer
    // view to the host — zoom/pan run untouched, we only observe
    this.host.addEventListener('pointermove', this.onMove);
    this.host.addEventListener('pointerleave', this.onLeave);
    this.host.addEventListener('pointerdown', this.onDown);
    this.host.addEventListener('pointerup', this.onUp);
    this.host.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKey);
  }

  // ---------- public API (shell wiring) ----------

  get active(): boolean {
    return this.activeState;
  }

  /** number of committed rulers (QA hook) */
  get count(): number {
    return this.rulers.length;
  }

  toggle(): void {
    if (this.activeState) this.setActive(false);
    else if (this.available) this.setActive(true);
  }

  /** document switched — leave the mode and drop all rulers (old doc's coords) */
  reset(): void {
    this.rulers = [];
    this.start = null;
    this.cursor = null;
    this.setActive(false);
    this.draw();
  }

  /** enable/disable for the current document kind; disabling resets */
  setAvailable(v: boolean): void {
    this.available = v;
    if (!v) this.reset();
  }

  /** re-project + repaint (camera.onView, lang change) */
  redraw(): void {
    this.draw();
  }

  /** re-fit the backing store to the viewport (DPR aware) */
  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.host.clientWidth, h = this.host.clientHeight;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  destroy(): void {
    this.ro.disconnect();
    this.host.removeEventListener('pointermove', this.onMove);
    this.host.removeEventListener('pointerleave', this.onLeave);
    this.host.removeEventListener('pointerdown', this.onDown);
    this.host.removeEventListener('pointerup', this.onUp);
    this.host.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKey);
    this.canvas.remove();
  }

  // ---------- events ----------

  private onMove = (e: PointerEvent): void => {
    if (!this.activeState) return;
    const r = this.host.getBoundingClientRect();
    this.cursor = { x: e.clientX - r.left, y: e.clientY - r.top };
    this.draw();
  };

  private onLeave = (): void => {
    if (!this.activeState) return;
    this.cursor = null;
    this.draw();
  };

  private onDown = (e: PointerEvent): void => {
    // remember where the right button went down to tell a click from a pan drag
    if (e.button === 2) this.rightDown = { x: e.clientX, y: e.clientY };
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.activeState || e.button !== 0 || this.camera.didPan) return;
    const r = this.host.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const p: Pt = { x: (sx - this.camera.tx) / this.camera.scale, y: (sy - this.camera.ty) / this.camera.scale };
    if (!this.start) {
      this.start = p;
    } else {
      // degenerate click (same screen point as the start) — keep waiting
      const s = this.toScreen(this.start);
      if (Math.hypot(sx - s.x, sy - s.y) >= MIN_LEG_PX) {
        this.rulers.push({ a: this.start, b: p });
        this.start = null;
      }
    }
    this.draw();
  };

  private onContextMenu = (e: MouseEvent): void => {
    if (!this.activeState) return;
    const d = this.rightDown ? Math.hypot(e.clientX - this.rightDown.x, e.clientY - this.rightDown.y) : 0;
    this.rightDown = null;
    if (d > 4) return; // right-drag pan, not a click
    this.rulers = []; // right-click = clear all + exit
    this.start = null;
    this.setActive(false);
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !this.activeState) return;
    this.setActive(false); // Esc = exit, rulers kept
  };

  private setActive(active: boolean): void {
    if (this.activeState === active) return;
    this.activeState = active;
    if (!active) { this.start = null; this.cursor = null; }
    this.host.classList.toggle('ev-measure', active);
    this.onActive?.(active);
    this.draw();
  }

  // ---------- projection ----------

  private toScreen(p: Pt): ScreenPt {
    return { x: p.x * this.camera.scale + this.camera.tx, y: p.y * this.camera.scale + this.camera.ty };
  }

  private toDoc(p: ScreenPt): Pt {
    return { x: (p.x - this.camera.tx) / this.camera.scale, y: (p.y - this.camera.ty) / this.camera.scale };
  }

  // ---------- painting ----------

  private draw(): void {
    const ctx = this.ctx;
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    ctx.clearRect(0, 0, w, h);
    for (const r of this.rulers) this.drawRuler(r.a, r.b);
    if (this.activeState) {
      if (this.start && this.cursor) this.drawRuler(this.start, this.toDoc(this.cursor));
      this.drawCrosshair();
    }
  }

  /** white 1 px pass over a thin dark halo — legible on dark and light canvas */
  private stroke(build: () => void): void {
    const ctx = this.ctx;
    ctx.beginPath(); build();
    ctx.strokeStyle = HALO; ctx.lineWidth = 3; ctx.stroke();
    ctx.strokeStyle = WHITE; ctx.lineWidth = 1; ctx.stroke();
  }

  private line(p: ScreenPt, q: ScreenPt): void {
    this.stroke(() => {
      // +0.5 centers the 1 px line on the pixel grid
      this.ctx.moveTo(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5);
      this.ctx.lineTo(Math.round(q.x) + 0.5, Math.round(q.y) + 0.5);
    });
  }

  private label(text: string, x: number, y: number, align: CanvasTextAlign, baseline: CanvasTextBaseline): void {
    const ctx = this.ctx;
    ctx.font = FONT;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = HALO;
    ctx.lineWidth = 3;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = WHITE;
    ctx.fillText(text, x, y);
  }

  /** mm text with 2-3 decimals from a mil length */
  private fmtMm(mil: number): string {
    const mm = Math.abs(mil) * MM_PER_MIL;
    return mm.toFixed(mm >= 10 ? 2 : 3);
  }

  private drawCrosshair(): void {
    if (!this.cursor) return;
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    const { x, y } = this.cursor;
    this.line({ x: 0, y }, { x: w, y });
    this.line({ x, y: 0 }, { x, y: h });
  }

  private drawRuler(aDoc: Pt, bDoc: Pt): void {
    const a = this.toScreen(aDoc), b = this.toScreen(bDoc);
    const c: ScreenPt = { x: b.x, y: a.y }; // right-angle corner at the start point's row/column
    const dxMil = bDoc.x - aDoc.x, dyMil = bDoc.y - aDoc.y;
    const legH = Math.abs(c.x - a.x), legV = Math.abs(b.y - c.y);

    // hypotenuse + the two legs through the start point
    this.line(a, b);
    if (legH >= MIN_LEG_PX) this.line(a, c);
    if (legV >= MIN_LEG_PX) this.line(c, b);

    // endpoint dots (3 px, haloed)
    const dot = (p: ScreenPt): void => {
      this.stroke(() => {
        this.ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      });
    };
    dot(a); dot(b);

    // equally spaced ticks on both legs — round mm step, ~≥10 px apart
    const pxPerMm = this.camera.scale / MM_PER_MIL;
    let step = TICK_STEPS[TICK_STEPS.length - 1];
    for (const s of TICK_STEPS) { if (s * pxPerMm >= MIN_TICK_PX) { step = s; break; } }
    const tickPx = step * pxPerMm;
    if (tickPx >= MIN_TICK_PX * 0.6) {
      const tick = (p: ScreenPt, vertical: boolean, major: boolean): void => {
        const tl = major ? 5 : 3;
        if (vertical) this.line({ x: p.x, y: p.y - tl }, { x: p.x, y: p.y + tl });
        else this.line({ x: p.x - tl, y: p.y }, { x: p.x + tl, y: p.y });
      };
      if (legH >= MIN_LEG_PX) {
        const dirX = c.x >= a.x ? 1 : -1;
        let i = 0;
        for (let x = a.x + dirX * tickPx; (x - c.x) * dirX < -MIN_LEG_PX * 0.5; x += dirX * tickPx, i++) {
          tick({ x, y: a.y }, true, i % 5 === 4);
        }
      }
      if (legV >= MIN_LEG_PX) {
        const dirY = b.y >= c.y ? 1 : -1;
        let i = 0;
        for (let y = c.y + dirY * tickPx; (y - b.y) * dirY < -MIN_LEG_PX * 0.5; y += dirY * tickPx, i++) {
          tick({ x: c.x, y }, false, i % 5 === 4);
        }
      }
    }

    // labels — |ΔX| above/below the horizontal leg, |ΔY| beside the vertical
    // leg, distance offset from the hypotenuse midpoint away from the corner
    if (legH >= MIN_LEG_PX) {
      const mx = (a.x + c.x) / 2;
      const above = b.y >= a.y; // interior of the triangle is below → label above
      this.label(`ΔX ${this.fmtMm(dxMil)} mm`, mx, above ? a.y - 6 : a.y + 15, 'center', above ? 'bottom' : 'top');
    }
    if (legV >= MIN_LEG_PX) {
      const my = (c.y + b.y) / 2;
      const right = b.x >= a.x; // interior is left of the vertical leg → label right
      this.label(`ΔY ${this.fmtMm(dyMil)} mm`, right ? c.x + 6 : c.x - 6, my, right ? 'left' : 'right', 'middle');
    }
    const hyp = Math.hypot(b.x - a.x, b.y - a.y);
    if (hyp >= MIN_LEG_PX) {
      let nx = -(b.y - a.y), ny = b.x - a.x;
      const len = Math.hypot(nx, ny) || 1;
      nx /= len; ny /= len;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if ((c.x - mx) * nx + (c.y - my) * ny > 0) { nx = -nx; ny = -ny; } // point away from the corner
      this.label(`${t('measureDist')} ${this.fmtMm(Math.hypot(dxMil, dyMil))} mm`, mx + nx * 9, my + ny * 9, 'center', 'middle');
    }
  }
}
