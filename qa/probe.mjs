/** Probe: inspect parsed SCH records (TABLE / border) via shell.model. */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=2476,1199'],
  defaultViewport: { width: 2476, height: 1199 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('PAGEERROR:', e.message));
await page.goto(process.argv[2], { waitUntil: 'networkidle0', timeout: 30000 });
await page.waitForFunction('window.__qaReady === true', { timeout: 15000 });
await new Promise((r) => setTimeout(r, 800));
const info = await page.evaluate(() => {
  const shell = window.__ev?.shell;
  const model = shell?.model;
  const lines = [];
  if (!model) return 'no model';
  lines.push('model keys: ' + Object.keys(model).join(','));
  const opened = model.opened instanceof Map ? model.opened : new Map(Object.entries(model.opened ?? {}));
  for (const [id, od] of opened) {
    lines.push(`OPENED ${id} docType=${od.self?.docType} recs=${od.self?.recs?.length}`);
    const types = {};
    for (const r of od.self?.recs ?? []) types[r.type] = (types[r.type] ?? 0) + 1;
    lines.push('  types: ' + JSON.stringify(types));
    for (const r of od.self?.recs ?? []) {
      if (r.type === 'TABLE') lines.push(`  TABLE id=${r.id} z=${r.data.zIndex} cols=${JSON.stringify(r.data.colSizes)?.slice(0, 40)} rows=${JSON.stringify(r.data.rowSizes)?.slice(0, 40)} start=${r.data.startX},${r.data.startY}`);
    }
    const comps = (od.self?.recs ?? []).filter((r) => r.type === 'COMPONENT');
    for (const c of comps) {
      const attrs = (od.self?.recs ?? []).filter((r) => r.type === 'ATTR' && r.data.parentId === c.id);
      const get = (k) => attrs.find((a) => a.data.key === k)?.data?.value;
      lines.push(`  COMP ${c.id} x=${c.data.x} y=${c.data.y} PageSize=${get('Page Size')} Border=${get('Border')} TitleBlock=${get('Title Block')}`);
    }
    lines.push('  unknownTypes: ' + JSON.stringify(od.report?.unknownTypes ?? []));
  }
  return lines.join('\n');
});
console.log(info.slice(0, 4000));
await browser.close();
