import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new', args: ['--hide-scrollbars'],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('PAGEERROR:', e.message));
await page.goto(process.argv[2], { waitUntil: 'networkidle0', timeout: 30000 });
await page.waitForFunction('window.__qaReady === true', { timeout: 15000 });
const info = await page.evaluate(() => {
  const model = window.__ev?.shell?.model;
  const lines = [];
  const opened = model.opened instanceof Map ? model.opened : new Map(Object.entries(model.opened ?? {}));
  for (const [id, od] of opened) {
    for (const r of od.self?.recs ?? []) {
      if (r.type !== 'TABLE') continue;
      lines.push(`TABLE ${r.id} data keys: ${Object.keys(r.data).join(',')}`);
      lines.push(JSON.stringify(r.data).slice(0, 4000));
    }
  }
  return lines.join('\n');
});
console.log(info.slice(0, 6000));
await browser.close();
