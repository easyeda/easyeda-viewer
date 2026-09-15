import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new', args: ['--hide-scrollbars'],
  defaultViewport: { width: 2476, height: 1199 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('PAGEERROR:', e.message));
await page.goto(process.argv[2], { waitUntil: 'networkidle0', timeout: 30000 });
await page.waitForFunction('window.__qaReady === true', { timeout: 15000 });
await new Promise((r) => setTimeout(r, 800));
const info = await page.evaluate(() => {
  const shell = window.__ev?.shell;
  if (!shell) return 'no shell';
  const lines = [];
  const cam = shell.camera;
  lines.push('camera: ' + JSON.stringify({ x: cam.x, y: cam.y, zoom: cam.zoom ?? cam.scale, w: cam.width ?? cam.viewWidth, h: cam.height ?? cam.viewHeight }));
  const u = shell.objBBoxUnion?.();
  lines.push('union: ' + JSON.stringify(u));
  // find objects whose bbox touches extreme left/right
  const objs = shell.objects ?? [];
  const arr = objs instanceof Map ? [...objs.values()] : objs;
  lines.push('n objects: ' + arr.length);
  const withB = arr.filter((o) => o.bbox);
  lines.push('with bbox: ' + withB.length);
  const leftmost = withB.slice().sort((a, b) => a.bbox.minX - b.bbox.minX).slice(0, 5);
  const rightmost = withB.slice().sort((a, b) => b.bbox.maxX - a.bbox.maxX).slice(0, 5);
  for (const o of leftmost) lines.push(`LEFT id=${o.id} kind=${o.kind} title=${(o.title ?? '').slice(0, 20)} bbox=${JSON.stringify(o.bbox)}`);
  for (const o of rightmost) lines.push(`RIGHT id=${o.id} kind=${o.kind} title=${(o.title ?? '').slice(0, 20)} bbox=${JSON.stringify(o.bbox)}`);
  return lines.join('\n');
});
console.log(info.slice(0, 3000));
await browser.close();
