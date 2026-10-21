const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const config = require('./config.cjs');

(async () => {
  const root = path.resolve(__dirname, '..');
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/viewer') res.end(fs.readFileSync(config.html));
    else res.end('<!doctype html><html><body style="margin:0"><input id="files" type="file" webkitdirectory multiple hidden><iframe id="viewer" src="/viewer" style="border:0;width:100%;height:900px"></iframe></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => document.querySelector('iframe').contentWindow.easyedaViewer);
    await page.locator('#files').setInputFiles(config.primary);
    const first = await page.evaluate(async () => {
      const viewer = document.querySelector('iframe').contentWindow;
      const api = viewer.easyedaViewer;
      window.dmFiles = Array.from(document.querySelector('#files').files);
      const options = { projectId: 'DM-001', revision: 'R1', user: { id: 'u1', name: '审核者甲' } };
      await api.loadProject(dmFiles, options);
      const events = [];
      const unsubscribe = api.onChange(e => { events.push(e); });
      const sch = api.getContext().documents.find(d => d.group === 'schematic');
      const pcb = api.getContext().documents.find(d => d.group === 'pcb');
      const a = api.createAnnotation({ type: 'text', documentId: sch.id, geometry: { x: 100, y: 200 }, text: '<img src=x onerror=alert(1)>\n中文批注' });
      const b = api.createAnnotation({ type: 'rectangle', documentId: pcb.id, geometry: { x: 100, y: 200, width: 80, height: 60 }, text: 'PCB 检查' });
      api.createAnnotation({ type: 'circle', documentId: sch.id, geometry: { x: 300, y: 200, width: 80, height: 80 }, text: '圆形检查' });
      api.setUser({ id: 'u2', name: '审核者乙' });
      api.addReply(a.id, '回复甲');
      api.updateAnnotation(a.id, { text: '修订文字', status: 'resolved' });
      const saved = api.exportAnnotations();
      const original = JSON.stringify(saved);
      let locked = false;
      try { api.updateAnnotation(a.id, { geometry: { x: 0, y: 0 } }); } catch { locked = JSON.stringify(api.exportAnnotations()) === original; }
      const reasons = events.map(e => e.reason);
      events[0].data.annotations[0].text = 'tampered event';
      const eventDetached = api.exportAnnotations().annotations[0].text === '修订文字';
      unsubscribe();
      const eventCount = events.length;
      api.setAnnotationsVisible(false);
      const hideUnchanged = JSON.stringify(api.exportAnnotations()) === original;
      await api.open(pcb.nodeId);
      const hiddenAcrossDocuments = !api.getAnnotationsVisible() && viewer.document.querySelectorAll('.ann-layer [data-ann-id]').length === 0;
      api.setAnnotationsVisible(true);
      const pcbVisible = viewer.document.querySelectorAll('.ann-layer [data-ann-id]').length === 1;
      api.deleteAnnotation(b.id);
      api.importAnnotations(JSON.stringify(saved));
      const replaced = JSON.stringify(api.exportAnnotations()) === original;
      api.importAnnotations({ ...saved, annotations: [] });
      const emptyReplacement = api.exportAnnotations().annotations.length === 0;
      await api.loadProject(dmFiles, { ...options, annotations: JSON.parse(original) });
      const restored = JSON.stringify(api.exportAnnotations()) === original;
      const bad = [];
      for (const mutate of [d => d.projectId = 'other', d => d.revision = 'R2', d => d.annotations[0].geometry.x = Infinity,
        d => d.annotations[0].replies[0].creator = null, d => d.annotations[0].documentId = 'missing',
        d => d.annotations[2].geometry.width = -1, d => d.annotations.push(d.annotations[0])]) {
        const input = JSON.parse(original); mutate(input);
        try { api.importAnnotations(input); bad.push(false); }
        catch { bad.push(JSON.stringify(api.exportAnnotations()) === original); }
      }
      window.dmSaved = original;
      return { locked, eventDetached, hideUnchanged, hiddenAcrossDocuments, pcbVisible, replaced, emptyReplacement, restored,
        unsubscribed: events.length === eventCount, bad, reasons,
        creatorPreserved: saved.annotations[0].creator.id === 'u1' && saved.annotations[0].replies[0].creator.id === 'u2',
        noInjectedImages: viewer.document.querySelectorAll('.ann-content img').length === 0 };
    });
    for (const [key, value] of Object.entries(first)) {
      if (key === 'bad') assert(value.every(Boolean));
      else if (key === 'reasons') assert.deepEqual(value, ['create', 'create', 'create', 'reply', 'update']);
      else assert.equal(value, true, key);
    }
    await page.locator('#files').setInputFiles(config.secondary);
    const second = await page.evaluate(async () => {
      const api = document.querySelector('iframe').contentWindow.easyedaViewer;
      await api.loadProject(document.querySelector('#files').files, { projectId: 'DM-002', revision: 'R1' });
      const cleared = api.exportAnnotations().annotations.length === 0;
      let rejected = false;
      try { api.importAnnotations(dmSaved); } catch { rejected = true; }
      await api.loadProject(dmFiles, { projectId: 'DM-001', revision: 'R1', annotations: JSON.parse(dmSaved) });
      return { cleared, rejected, restored: JSON.stringify(api.exportAnnotations()) === dmSaved };
    });
    assert(Object.values(second).every(Boolean));
    assert.deepEqual(errors, []);
    console.log('DM IFRAME API PASS', JSON.stringify({ ...first, ...second }));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
