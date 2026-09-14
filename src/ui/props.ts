/** Right-side properties panel: selected object's record fields + raw line. */
import type { RenderObject } from '../core/render/layers';

export class PropsView {
  private host: HTMLElement;

  constructor(host: HTMLElement) {
    this.host = host;
    this.host.className = 'ev-props';
    this.clear();
  }

  clear(): void {
    this.host.innerHTML = '';
    const hint = document.createElement('div');
    hint.className = 'ev-hint';
    hint.textContent = '点击画布图元或对象列表查看属性';
    this.host.appendChild(hint);
  }

  show(obj: RenderObject | null): void {
    this.host.innerHTML = '';
    if (!obj) return this.clear();

    const head = document.createElement('div');
    head.className = 'ev-props-head';
    head.textContent = obj.title || obj.label;
    this.host.appendChild(head);

    const meta = document.createElement('div');
    meta.className = 'ev-props-meta';
    meta.textContent = `${obj.rec.type} · ${obj.rec.id} · 第 ${obj.rec.lineNo} 行`;
    this.host.appendChild(meta);

    const table = document.createElement('table');
    table.className = 'ev-props-table';
    for (const [k, v] of Object.entries(obj.rec.data)) {
      if (v === undefined) continue;
      const tr = document.createElement('tr');
      const tk = document.createElement('td');
      tk.className = 'ev-k';
      tk.textContent = k;
      const tv = document.createElement('td');
      tv.className = 'ev-v';
      tv.textContent = typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (tv.textContent.length > 200) tv.textContent = tv.textContent.slice(0, 200) + '…';
      if (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)) {
        const sw = document.createElement('span');
        sw.className = 'ev-props-color';
        sw.style.background = v;
        tv.prepend(sw);
      }
      tr.append(tk, tv);
      table.appendChild(tr);
    }
    this.host.appendChild(table);

    const raw = document.createElement('details');
    raw.className = 'ev-props-raw';
    const sum = document.createElement('summary');
    sum.textContent = '原始行';
    const pre = document.createElement('pre');
    pre.textContent = obj.rec.raw.length > 2000 ? obj.rec.raw.slice(0, 2000) + '…' : obj.rec.raw;
    raw.append(sum, pre);
    this.host.appendChild(raw);
  }
}
