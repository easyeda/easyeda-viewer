const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const config = require('./config.cjs');

(async () => {
  const root = path.resolve(__dirname, '..');
  const folders = [
    config.primary,
    config.secondary
  ];
  for (const folder of folders) assert(fs.existsSync(folder), `Missing folder: ${folder}`);
  const browser = await chromium.launch({ headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(config.url);
    await page.waitForFunction(() => window.easyedaViewer);
    const context = await page.evaluate(projectName => {
      const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.webkitdirectory = true; input.id = 'test-file'; input.hidden = true; document.body.append(input);
      return { hasApi: Boolean(window.easyedaViewer) };
    });
    assert(context.hasApi);
    for (const folder of folders) {
      await page.locator('#test-file').setInputFiles(folder);
      const loaded = await page.evaluate(async folderName => easyedaViewer.loadProject(document.querySelector('#test-file').files,
        { projectId: `smoke-${folderName}`, revision: 'A', user: { id: 'test', name: 'Smoke Test' } }), path.basename(folder));
      console.log('PROJECT', JSON.stringify({ folder: path.basename(folder), documents: loaded.documents.length,
        groups: [...new Set(loaded.documents.map(d => d.group))] }));
      assert(loaded.documents.some(d => d.group === 'schematic'));
      if (path.basename(folder) === 'PCB布局布线测试') assert(loaded.documents.some(d => d.group === 'pcb'));
      assert.equal(await page.evaluate(() => easyedaViewer.exportAnnotations().annotations.length), 0);
    }
    // Run the full two-document annotation flow against the first project, which exposes both groups.
    await page.locator('#test-file').setInputFiles(folders[0]);
    await page.evaluate(async () => easyedaViewer.loadProject(document.querySelector('#test-file').files,
      { projectId: 'smoke-primary', revision: 'A', user: { id: 'test', name: 'Smoke Test' } }));
    const result = await page.evaluate(async () => {
      const api = easyedaViewer, docs = api.getContext().documents;
      const sch = docs.find(d => d.group === 'schematic'), pcb = docs.find(d => d.group === 'pcb');
      await api.open(sch.nodeId);
      const b = __ev.shell.objBBoxUnion(), x = (b.minX + b.maxX) / 2, y = (b.minY + b.maxY) / 2, size = Math.max(10, Math.min(b.maxX - b.minX, b.maxY - b.minY) / 8);
      const first = api.createAnnotation({ type: 'text', text: 'Schematic review', geometry: { x, y } });
      const rect = api.createAnnotation({ type: 'rectangle', text: 'Check this circuit', geometry: { x: x - size, y: y - size, width: size, height: size / 2 } });
      api.createAnnotation({ type: 'circle', text: 'Review this area', geometry: { x: x + size, y: y - size, width: size, height: size } });
      api.addReply(first.id, 'Reply from PLM reviewer'); api.updateAnnotation(first.id, { status: 'resolved' });
      const saved = api.exportAnnotations(), rejected = [];
      for (const mutate of [d => d.projectId = 'wrong', d => d.revision = 'wrong', d => d.schemaVersion = 99, d => d.annotations[0].geometry.x = null, d => d.annotations[0].documentId = 'unknown', d => d.annotations.push(d.annotations[0]), d => d.annotations[0].status = 'unknown']) {
        const candidate = JSON.parse(JSON.stringify(saved)); mutate(candidate);
        try { api.importAnnotations(candidate); rejected.push(false); } catch { rejected.push(JSON.stringify(api.exportAnnotations()) === JSON.stringify(saved)); }
      }
      api.deleteAnnotation(rect.id); api.undo();
      const undoRestored = JSON.stringify(api.exportAnnotations()) === JSON.stringify(saved);
      api.redo(); const redoRemoved = api.exportAnnotations().annotations.length === 2;
      api.importAnnotations(JSON.stringify(saved)); const roundtrip = JSON.stringify(saved) === JSON.stringify(api.exportAnnotations());
      await api.open(pcb.nodeId); const pcbEmpty = document.querySelectorAll('.ann-layer [data-ann-id]').length === 0;
      const pb = __ev.shell.objBBoxUnion(); api.createAnnotation({ type: 'text', text: 'PCB review', geometry: { x: (pb.minX + pb.maxX) / 2, y: (pb.minY + pb.maxY) / 2 } });
      await api.focusAnnotation(first.id); const focused = api.getContext().currentDocument.id === sch.id;
      return { rejected, undoRestored, redoRemoved, roundtrip, pcbEmpty, focused };
    });
    console.log('API', JSON.stringify(result));
    assert(result.rejected.every(Boolean)); assert(result.undoRestored && result.redoRemoved && result.roundtrip && result.pcbEmpty && result.focused);
    assert.equal(await page.locator('.ann-content img').count(), 0); assert.equal(errors.length, 0, errors.join('; '));
    console.log('PASS');
    assert.equal(errors.length, 0, errors.join('; '));
  } finally { await browser.close(); }
})();
