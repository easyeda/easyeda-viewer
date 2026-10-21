const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const config = require('./config.cjs');

(async () => {
  const root = path.resolve(__dirname, '..');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  try {
    for (const viewport of [{ width: 1440, height: 960 }, { width: 900, height: 700 }, { width: 520, height: 800 }]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(config.url);
      await page.waitForFunction(() => window.easyedaViewer);
      assert.equal(await page.locator('.ann-visibility').getAttribute('aria-pressed'), 'true');
      assert(await page.locator('.ann-visibility').evaluate(el => el.classList.contains('ev-on')), 'visibility active at startup');
      assert.equal(await page.getByRole('button', { name: '选择批注', exact: true }).count(), 0);
      await page.evaluate(() => {
        const input = document.createElement('input');
        input.type = 'file'; input.multiple = true; input.webkitdirectory = true; input.id = 'folder'; input.hidden = true;
        document.body.append(input);
      });
      await page.locator('#folder').setInputFiles(config.primary);
      await page.evaluate(() => easyedaViewer.loadProject(document.querySelector('#folder').files, { projectId: 'qa', revision: '1' }));
      const state = await page.evaluate(() => ({ context: easyedaViewer.getContext(), scroll: { width: document.body.scrollWidth, height: document.body.scrollHeight } }));
      assert(state.context.documents.some(d => d.group === 'schematic'));
      assert(state.context.documents.some(d => d.group === 'pcb'));
      assert.deepEqual(state.scroll, { width: viewport.width, height: viewport.height }, `viewport overflow ${viewport.width}`);
      assert.deepEqual(await page.locator('.ann-tabs button').allTextContents(), ['属性 / 图层', '批注记录']);
      assert.equal(await page.locator('.ann-feedback').count(), 0, 'annotation footer removed');
      const toggle = async (name, expectedAnn, expectedProps) => {
        await page.getByRole('button', { name }).click();
        const actual = await page.evaluate(() => ({ ann: getComputedStyle(document.querySelector('.ann-panel')).display, props: getComputedStyle(document.querySelector('.ev-props')).display }));
        assert.equal(actual.ann, expectedAnn, `${name}: annotation display`);
        assert.equal(actual.props, expectedProps, `${name}: properties display`);
      };
      await toggle('属性 / 图层', 'none', 'block');
      await toggle('批注记录', 'flex', 'none');
      const sch = state.context.documents.find(d => d.group === 'schematic');
      const pcb = state.context.documents.find(d => d.group === 'pcb');
      await page.evaluate(nodeId => easyedaViewer.open(nodeId), sch.nodeId);
      const bounds = await page.locator('.ev-canvas').boundingBox();
      assert(bounds && bounds.width > 0 && bounds.height > 0);
      const center = { x: bounds.x + bounds.width * 0.48, y: bounds.y + bounds.height * 0.48 };
      await page.getByRole('button', { name: '添加批注', exact: true }).click();
      assert.equal(await page.locator('.ann-add-menu-popup [role="menuitem"] svg').count(), 3);
      await page.getByRole('menuitem', { name: '矩形框', exact: true }).click();
      await page.mouse.move(center.x - 42, center.y - 32);
      await page.mouse.down();
      await page.mouse.move(center.x + 42, center.y + 32, { steps: 5 });
      await page.mouse.up();
      assert.equal(await page.locator('.ann-editor').isVisible(), true, 'drawing opens editor');
      await page.locator('.ann-editor textarea').fill('Mouse rectangle');
      await page.locator('.ann-editor').getByRole('button', { name: '保存', exact: true }).click();
      const created = await page.evaluate(() => easyedaViewer.exportAnnotations().annotations.at(-1));
      assert.equal(created.type, 'rectangle');
      assert.equal(await page.locator(`[data-ann-id="${created.id}"]`).count(), 1);
      const beforeZoom = await page.locator(`[data-ann-id="${created.id}"] rect`).first().boundingBox();
      await page.locator('[data-act="zoomin"]').click();
      await page.waitForFunction(id => {
        const item = easyedaViewer.exportAnnotations().annotations.find(a => a.id === id);
        const rect = document.querySelector(`[data-ann-id="${id}"] rect`);
        return rect && Math.abs(Number(rect.getAttribute('width')) - item.geometry.width * __ev.shell.camera.scale) < 0.01;
      }, created.id);
      const afterZoom = await page.locator(`[data-ann-id="${created.id}"] rect`).first().boundingBox();
      assert(afterZoom.width > beforeZoom.width, 'annotation scales with camera');
      await page.locator('[data-act="fit"]').click();
      const beforeMove = await page.evaluate(id => easyedaViewer.exportAnnotations().annotations.find(a => a.id === id).geometry, created.id);
      const card = page.locator(`[data-ann-card="${created.id}"]`);
      assert.equal(await page.locator('.ann-card-head').filter({ hasText: '· 定位' }).count(), 0);
      await card.getByRole('button', { name: '矩形', exact: true }).click();
      const afterFocus = await page.evaluate(id => easyedaViewer.exportAnnotations().annotations.find(a => a.id === id).geometry, created.id);
      assert.deepEqual(afterFocus, beforeMove, 'focus does not mutate annotation');
      await page.evaluate(() => __ev.shell.camera.panBy(50, 30));
      const panned = await page.evaluate(() => ({ x: __ev.shell.camera.tx, y: __ev.shell.camera.ty }));
      await card.getByRole('button', { name: '编辑', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => ({ x: __ev.shell.camera.tx, y: __ev.shell.camera.ty })), panned, 'edit must not locate');
      await page.locator('.ann-editor').getByRole('button', { name: '取消', exact: true }).click();
      await card.locator('.ann-content').first().click();
      const centered = await page.evaluate(id => {
        const g = easyedaViewer.exportAnnotations().annotations.find(a => a.id === id).geometry;
        const c = __ev.shell.camera, host = __ev.shell.canvasHost;
        return Math.abs((g.x + g.width / 2) * c.scale + c.tx - host.clientWidth / 2) < 1 &&
          Math.abs((g.y + g.height / 2) * c.scale + c.ty - host.clientHeight / 2) < 1;
      }, created.id);
      assert(centered, 'card body click locates annotation');
      const savedBeforeDeselect = await page.evaluate(() => easyedaViewer.exportAnnotations());
      await page.mouse.click(bounds.x + 10, bounds.y + 10);
      assert.equal(await page.locator('.ann-selected').count(), 0, 'blank click deselects annotation');
      assert.deepEqual(await page.evaluate(() => easyedaViewer.exportAnnotations()), savedBeforeDeselect, 'deselection preserves data');
      await card.locator('.ann-content').first().click();
      assert.equal(await card.evaluate(el => el.classList.contains('ann-selected')), true, 'card reselects annotation');
      const mark = await page.locator(`[data-ann-id="${created.id}"] rect`).first().boundingBox();
      await page.mouse.move(mark.x + 10, mark.y + 10);
      await page.mouse.down();
      await page.mouse.move(mark.x + 60, mark.y + 40, { steps: 6 });
      await page.mouse.up();
      assert.deepEqual(await page.evaluate(id => easyedaViewer.exportAnnotations().annotations.find(a => a.id === id).geometry, created.id), beforeMove, 'saved geometry is locked');
      assert.equal(await page.locator('[data-ann-resize]').count(), 0);
      const dataBeforeHide = await page.evaluate(() => easyedaViewer.exportAnnotations());
      await page.locator('.ann-visibility').click();
      assert.equal(await page.locator('.ann-layer [data-ann-id]').count(), 0);
      assert.equal(await page.getByRole('button', { name: '添加批注', exact: true }).isDisabled(), true);
      assert.deepEqual(await page.evaluate(() => easyedaViewer.exportAnnotations()), dataBeforeHide);
      await page.locator('.ann-visibility').click();
      assert.equal(await page.locator('.ann-layer [data-ann-id]').count(), 1);
      for (const [type, name] of [['text', '文字'], ['circle', '圆形框']]) {
        await page.getByRole('button', { name: '添加批注', exact: true }).click();
        await page.getByRole('menuitem', { name, exact: true }).click();
        await page.mouse.move(center.x - 30, center.y - 20);
        await page.mouse.down();
        if (type === 'circle') await page.mouse.move(center.x + 20, center.y + 30, { steps: 5 });
        await page.mouse.up();
        await page.locator('.ann-editor textarea').fill(`Mouse ${type}`);
        await page.locator('.ann-editor').getByRole('button', { name: '保存', exact: true }).click();
        assert.equal(await page.evaluate(() => easyedaViewer.exportAnnotations().annotations.at(-1).type), type);
      }
      await page.evaluate(nodeId => easyedaViewer.open(nodeId), pcb.nodeId);
      assert.equal(await page.locator('.ann-layer [data-ann-id]').count(), 0, 'annotation hidden on other document');
      await page.evaluate((id) => easyedaViewer.focusAnnotation(id), created.id);
      assert.equal(await page.evaluate(id => easyedaViewer.getContext().currentDocument.id === easyedaViewer.exportAnnotations().annotations.find(a => a.id === id).documentId, created.id), true);
      assert.equal(await page.locator('.ann-layer [data-ann-id]').count(), 3, 'focus returns to annotation document');
      const editItems = await page.evaluate(() => easyedaViewer.exportAnnotations().annotations);
      for (const item of editItems) {
        await page.evaluate(id => easyedaViewer.focusAnnotation(id), item.id);
        const record = page.locator(`[data-ann-card="${item.id}"]`);
        const drag = async () => {
          const label = await page.locator(`[data-ann-id="${item.id}"] [data-ann-label] rect`).boundingBox();
          await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2);
          await page.mouse.down();
          await page.mouse.move(label.x + label.width / 2 + 25, label.y + label.height / 2 + 20, { steps: 5 });
          await page.mouse.up();
        };
        await record.getByRole('button', { name: '编辑', exact: true }).click();
        await drag();
        assert.deepEqual(await page.evaluate(id => easyedaViewer.exportAnnotations().annotations.find(a => a.id === id).geometry, item.id), item.geometry, 'drag is draft only');
        await page.locator('.ann-editor').getByRole('button', { name: '取消', exact: true }).click();
        assert.deepEqual(await page.evaluate(id => easyedaViewer.exportAnnotations().annotations.find(a => a.id === id).geometry, item.id), item.geometry, 'cancel restores original');
        await record.getByRole('button', { name: '编辑', exact: true }).click();
        await drag();
        await page.locator('.ann-editor').getByRole('button', { name: '保存', exact: true }).click();
        const moved = await page.evaluate(id => easyedaViewer.exportAnnotations().annotations.find(a => a.id === id).geometry, item.id);
        assert.notEqual(moved.x, item.geometry.x, 'editing can move saved annotation');
        await drag();
        assert.deepEqual(await page.evaluate(id => easyedaViewer.exportAnnotations().annotations.find(a => a.id === id).geometry, item.id), moved, 'save relocks annotation');
        await page.evaluate(() => easyedaViewer.undo());
        assert.deepEqual(await page.evaluate(id => easyedaViewer.exportAnnotations().annotations.find(a => a.id === id).geometry, item.id), item.geometry, 'undo restores position');
      }
      await page.screenshot({ path: path.join(config.output, `verified-${viewport.width}.png`) });
      assert.equal(errors.length, 0, errors.join('; '));
      await page.close();
      console.log(`PASS viewport ${viewport.width}x${viewport.height}`);
    }
  } finally { await browser.close(); }
})();
