const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const config = require('./config.cjs');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.goto(config.url);
    await page.waitForFunction(() => window.easyedaViewer);
    await page.evaluate(() => {
      const input = document.createElement('input'); input.type = 'file'; input.webkitdirectory = true; input.id = 'files'; document.body.append(input);
    });
    await page.locator('#files').setInputFiles(config.primary);
    await page.evaluate(() => easyedaViewer.loadProject(document.querySelector('#files').files));
    const info = await page.evaluate(() => {
      const s = __ev.shell;
      const component = s.objects.find(o => o.rec.type === 'COMPONENT' && o.bbox && o.bbox.maxX-o.bbox.minX < 120 && o.bbox.maxX-o.bbox.minX > 15);
      const b = component.bbox;
      window.wheelItem = easyedaViewer.createAnnotation({ type: 'rectangle', text: 'Wheel alignment', geometry: { x: b.minX, y: b.minY, width: b.maxX-b.minX, height: b.maxY-b.minY } });
      s.userView = true;
      s.camera.scale = 2;
      s.camera.centerOn((b.minX+b.maxX)/2, (b.minY+b.maxY)/2);
      return { id: wheelItem.id };
    });
    const sample = () => page.evaluate(() => {
      const s = __ev.shell, c = s.camera, w = c.world;
      const p = { x: wheelItem.geometry.x, y: wheelItem.geometry.y };
      w.innerToWorld(p);
      return { scale:c.scale, tx:c.tx, ty:c.ty, actual:p, expected:{x:wheelItem.geometry.x*c.scale+c.tx,y:wheelItem.geometry.y*c.scale+c.ty}, root:{x:s.leafer.x,y:s.leafer.y,scale:s.leafer.scaleX}, world:{x:w.x,y:w.y,scale:w.scaleX}, zoom:s.leafer.zoomLayer && {x:s.leafer.zoomLayer.x,y:s.leafer.zoomLayer.y,scale:s.leafer.zoomLayer.scaleX} };
    });
    console.log('BEFORE', await sample());
    await page.evaluate(() => {
      const s = __ev.shell;
      let rendered = { scale:s.camera.scale, tx:s.camera.tx, ty:s.camera.ty };
      s.leafer.on('render.end', () => { rendered = { scale:s.camera.scale, tx:s.camera.tx, ty:s.camera.ty }; });
      window.wheelFrames = [];
      s.canvasHost.addEventListener('wheel', () => {
        const mark = document.querySelector(`[data-ann-id="${wheelItem.id}"] rect`);
        wheelFrames.push({ rendered, annotationX:Number(mark.getAttribute('x')), renderedX:wheelItem.geometry.x*rendered.scale+rendered.tx });
      });
    });
    await page.screenshot({path:path.join(config.output,'wheel-before.png')});
    const box = await page.locator('.ev-canvas').boundingBox();
    await page.mouse.move(box.x+box.width*0.7,box.y+box.height*0.6);
    await page.mouse.wheel(0,-400);
    await page.waitForTimeout(700);
    console.log('AFTER CANVAS', await sample());
    await page.screenshot({path:path.join(config.output,'wheel-after.png')});
    const b = await page.locator(`[data-ann-id="${info.id}"] rect`).first().boundingBox();
    await page.mouse.move(b.x+2,b.y+2);
    await page.mouse.wheel(0,-250);
    await page.waitForTimeout(700);
    console.log('AFTER ANNOTATION', await sample());
    console.log('WHEEL FRAMES', await page.evaluate(() => wheelFrames));
    const result = await sample();
    assert(Math.abs(result.actual.x-result.expected.x)<1 && Math.abs(result.actual.y-result.expected.y)<1, 'world and annotation coordinates match');
    assert((await page.evaluate(() => wheelFrames)).every(f => Math.abs(f.annotationX-f.renderedX)<0.1), 'overlay and painted canvas share the same frame');
    for (const group of ['schematic','pcb']) {
      await page.evaluate(async group => {
        const doc = easyedaViewer.getContext().documents.find(d => d.group === group);
        await easyedaViewer.open(doc.nodeId);
        const s = __ev.shell;
        const components = s.objects.filter(o => o.rec.type === 'COMPONENT' && o.bbox && o.bbox.maxX>o.bbox.minX && o.bbox.maxY>o.bbox.minY);
        const component = components.find(o => {
          const size = Math.max(o.bbox.maxX-o.bbox.minX,o.bbox.maxY-o.bbox.minY);
          return size > 15 && size < 120;
        }) || components[0];
        const b = component.bbox;
        const data = easyedaViewer.exportAnnotations(); data.annotations = []; easyedaViewer.importAnnotations(data);
        const g = { x:b.minX, y:b.minY, width:b.maxX-b.minX, height:b.maxY-b.minY };
        window.wheelItem = easyedaViewer.createAnnotation({type:'rectangle',text:'Component bounds',geometry:g});
        const size = Math.max(g.width,g.height);
        easyedaViewer.createAnnotation({type:'circle',text:'Circle bounds',geometry:{...g,width:size,height:size}});
        easyedaViewer.createAnnotation({type:'text',text:'文字缩放 Text',geometry:{x:g.x+size/2,y:g.y+size/2}});
        s.userView = true;
        s.camera.scale = Math.min(s.canvasHost.clientWidth,s.canvasHost.clientHeight) / size / 3;
        s.camera.centerOn(g.x+g.width/2,g.y+g.height/2);
      }, group);
      await page.waitForTimeout(100);
      const saved = await page.evaluate(() => easyedaViewer.exportAnnotations());
      const labelSizes = () => page.evaluate(() => ({
        scale: __ev.shell.camera.scale,
        labels: [...document.querySelectorAll('[data-ann-label]')].map(label => {
          const text = label.querySelector('text').getBoundingClientRect();
          const box = label.querySelector('rect').getBoundingClientRect();
          return { textWidth:text.width, textHeight:text.height, boxWidth:box.width, boxHeight:box.height,
            textLength:Number(label.querySelector('text').getAttribute('textLength')),
            transformScale:label.getScreenCTM().a };
        })
      }));
      const initialLabels = await labelSizes();
      for (const delta of [-220, -180, 240, 160, -100, 100]) {
        await page.mouse.move(box.x+box.width/2, box.y+box.height/2);
        await page.mouse.wheel(0,delta);
        await page.waitForTimeout(100);
        const alignment = await page.evaluate(() => {
          const c = __ev.shell.camera;
          return easyedaViewer.exportAnnotations().annotations.filter(a => a.type !== 'text').map(a => {
            const top={x:a.geometry.x,y:a.geometry.y}; c.world.innerToWorld(top);
            const shape=document.querySelector(`[data-ann-id="${a.id}"] ${a.type==='circle'?'ellipse':'rect'}`);
            const x=Number(shape.getAttribute(a.type==='circle'?'cx':'x'))-(a.type==='circle'?Number(shape.getAttribute('rx')):0);
            const y=Number(shape.getAttribute(a.type==='circle'?'cy':'y'))-(a.type==='circle'?Number(shape.getAttribute('ry')):0);
            const width=Number(shape.getAttribute(a.type==='circle'?'rx':'width'))*(a.type==='circle'?2:1);
            return Math.max(Math.abs(x-top.x),Math.abs(y-top.y),Math.abs(width-a.geometry.width*c.scale));
          });
        });
        assert(alignment.every(error=>error<0.1), `${group} aligns after wheel ${delta}`);
        const currentLabels = await labelSizes();
        const ratio = currentLabels.scale / initialLabels.scale;
        currentLabels.labels.forEach((label, index) => {
          assert(Math.abs(label.transformScale-currentLabels.scale)<0.0001, 'text uses exact drawing transform');
          for (const key of ['textWidth','textHeight','boxWidth','boxHeight']) {
            // Chromium rounds glyph bounds at small raster sizes; the SVG transform remains exact.
            const tolerance = key.startsWith('text') ? 2 : 0.15;
            assert(Math.abs(label[key] - initialLabels.labels[index][key]*ratio)<tolerance, `${group} label ${index} ${key}: actual ${label[key]}, expected ${initialLabels.labels[index][key]*ratio}, ratio ${ratio}`);
          }
        });
      }
      assert.deepEqual(await page.evaluate(() => easyedaViewer.exportAnnotations()),saved,'zoom does not change stored coordinates');
      await page.screenshot({path:path.join(config.output,`wheel-${group}.png`)});
      // At overview zoom glyph raster bounds are rounded, but document sizes must remain fixed.
      for (const scale of [0.1, 0.2, 0.5]) {
        await page.evaluate(scale => { __ev.shell.camera.scale = scale; __ev.shell.camera.centerOn(wheelItem.geometry.x,wheelItem.geometry.y); }, scale);
        await page.waitForTimeout(100);
        const overview = await labelSizes();
        overview.labels.forEach((label,index) => {
          assert(Math.abs(label.transformScale-scale)<0.0001, 'overview text transform matches drawing');
          assert(Math.abs(label.textLength-initialLabels.labels[index].textLength)<0.001, 'text layout length remains fixed in document units');
          for (const key of ['boxWidth','boxHeight']) {
            assert(Math.abs(label[key]-initialLabels.labels[index][key]*scale/initialLabels.scale)<0.15, 'overview background scales proportionally');
          }
        });
      }
      console.log('PASS component alignment',group);
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode=1; });
