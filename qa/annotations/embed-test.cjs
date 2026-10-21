const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const config = require('./config.cjs');

(async () => {
  const { createServer } = await import('vite');
  const server = await createServer({
    root: path.resolve(__dirname, '../..'),
    server: { host: '127.0.0.1', port: 0 }
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.resolvedUrls.local[0]);
    await page.waitForFunction(() => window.easyedaViewer);
    await page.evaluate(async () => {
      __ev.shell.destroy();
      const { createViewer } = await import('/src/embed.ts');
      const addListener = window.addEventListener;
      window.annotationSignals = [];
      window.addEventListener = function (type, fn, options) {
        if (type === 'keydown' && options?.signal) annotationSignals.push(options.signal);
        return addListener.call(this, type, fn, options);
      };
      const NativeObserver = window.ResizeObserver;
      window.annotationObservers = [];
      window.ResizeObserver = class extends NativeObserver {
        constructor(callback) { super(callback); annotationObservers.push(this); }
        disconnect() { this.disconnected = true; super.disconnect(); }
      };
      window.embedded = createViewer(document.querySelector('#app'));
      window.ResizeObserver = NativeObserver;
      window.addEventListener = addListener;
      const input = document.createElement('input');
      input.id = 'files'; input.type = 'file'; input.webkitdirectory = true;
      document.body.append(input);
    });
    await page.locator('#files').setInputFiles(config.primary);
    const result = await page.evaluate(async () => {
      const api = embedded.annotations;
      await api.loadProject(document.querySelector('#files').files, { projectId: 'source-embed' });
      let notifications = 0;
      api.onChange(() => notifications++);
      api.createAnnotation({ type: 'text', text: 'Embedded annotation', geometry: { x: 100, y: 200 } });
      api.setTheme('dark');
      api.setChrome({ right: true });
      const result = { version: api.version, count: api.exportAnnotations().annotations.length, notifications };
      embedded.destroy();
      embedded.destroy();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      return { ...result, shells: document.querySelectorAll('.ev-shell').length,
        aborted: annotationSignals.length === 1 && annotationSignals[0].aborted,
        disconnected: annotationObservers.at(-1).disconnected === true };
    });
    assert.deepEqual(result, { version: '1.1.0', count: 1, notifications: 1, shells: 0, aborted: true, disconnected: true });
    assert.deepEqual(errors, []);
    console.log('PASS source embedding and annotation cleanup');
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
