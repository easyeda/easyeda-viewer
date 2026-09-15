/** Reliable headless screenshot via puppeteer-core + system Chrome.
 *  Usage: node shot.mjs <url> <out.png> [width] [height]
 */
import puppeteer from 'puppeteer-core';

const [url, out, w = '2476', h = '1235'] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=' + w + ',' + h],
  defaultViewport: { width: +w, height: +h },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('PAGEERROR:', e.message));
await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
// wait until the QA harness finished and leafer painted a settled frame
await page.waitForFunction('window.__qaReady === true', { timeout: 15000 });
await new Promise((r) => setTimeout(r, 700));
await page.screenshot({ path: out });
await browser.close();
console.log('saved', out);
