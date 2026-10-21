const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const config = require('./config.cjs');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  try {
    const page = await browser.newPage({ viewport: { width:1440,height:960 } });
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(config.url);
    await page.waitForFunction(()=>window.easyedaViewer);
    await page.evaluate(()=>{
      const input=document.createElement('input');input.type='file';input.webkitdirectory=true;input.id='files';document.body.append(input);
    });
    await page.locator('#files').setInputFiles(config.primary);
    const ids=await page.evaluate(async()=>{
      window.filesForTest=Array.from(document.querySelector('#files').files);
      const api=easyedaViewer;
      await api.loadProject(filesForTest,{projectId:'edge',revision:'1'});
      const a=api.createAnnotation({type:'text',text:'original',geometry:{x:500,y:-400}});
      const b=api.createAnnotation({type:'text',text:'other',geometry:{x:550,y:-400}});
      let blocked=false, count=0;
      const off=api.onChange(e=>{count++;try{api.importAnnotations(e.data);}catch{blocked=true;}});
      api.updateAnnotation(a.id,{text:'saved'});off();
      return {a:a.id,b:b.id,blocked,count};
    });
    assert(ids.blocked && ids.count===1,'reentrant import rejected');
    const card=page.locator(`[data-ann-card="${ids.a}"]`);
    await card.getByRole('button',{name:'编辑',exact:true}).click();
    await page.locator('.ann-editor textarea').fill('unsaved draft');
    await page.locator(`[data-ann-card="${ids.b}"]`).getByRole('button',{name:'回复 (0)',exact:true}).click();
    assert.equal(await page.locator('.ann-editor textarea').inputValue(),'unsaved draft');
    const blocked=await page.evaluate(async ids=>{
      const api=easyedaViewer, original=JSON.stringify(api.exportAnnotations()),results=[];
      for(const action of [()=>api.importAnnotations(api.exportAnnotations()),()=>api.undo(),()=>api.setAnnotationsVisible(false),
        ()=>api.updateAnnotation(ids.a,{text:'overwrite'}),()=>api.deleteAnnotation(ids.a),()=>api.focusAnnotation(ids.b),
        ()=>api.open(api.getContext().documents.find(d=>d.group==='pcb').nodeId),()=>api.loadProject(filesForTest)]) {
        try{await action();results.push(false);}catch{results.push(JSON.stringify(api.exportAnnotations())===original);}
      }
      return results;
    },ids);
    assert(blocked.every(Boolean),'draft protected across API actions');
    assert.equal(await page.locator('.ann-editor textarea').inputValue(),'unsaved draft');
    await page.locator('.ann-editor').getByRole('button',{name:'保存',exact:true}).click();
    assert.equal(await page.evaluate(id=>easyedaViewer.exportAnnotations().annotations.find(a=>a.id===id).text,ids.a),'unsaved draft');
    const cache=await page.evaluate(async()=>{
      const current=__ev.shell.curNode;
      const fileKey=current.fileKey, uuid=current.uuid;
      const files=filesForTest.map(file=>({file,key:file.webkitRelativePath||file.name}));
      const target=files.find(f=>f.key===fileKey);
      const data=await target.file.text();
      const rows=data.split('\n');let active=false;
      for(let i=0;i<rows.length;i++){
        const split=rows[i].indexOf('||');if(split<0)continue;
        const outer=JSON.parse(rows[i].slice(0,split));
        let inner=rows[i].slice(split+2).trim();if(inner.endsWith('|'))inner=inner.slice(0,-1);
        const record=JSON.parse(inner);
        if(outer.type==='DOCHEAD')active=record.uuid===uuid;
        if(active && outer.type==='META') {record.title='CACHE_RELOAD_VERIFIED'; rows[i]=JSON.stringify(outer)+'||'+JSON.stringify(record)+'|';break;}
      }
      const replacement=files.map(({file,key})=>new File([key===fileKey?rows.join('\n'):file],key));
      await easyedaViewer.loadProject(replacement,{projectId:'edge',revision:'2'});
      return {title:__ev.shell.props.opened?.self?.meta?.title, node:__ev.shell.curNode.uuid,
        hasMarker:[...__ev.shell.model.files.values()].some(bytes=>new TextDecoder().decode(bytes).includes('CACHE_RELOAD_VERIFIED'))};
    });
    assert(cache.hasMarker);
    assert.equal(cache.title,'CACHE_RELOAD_VERIFIED','renderer uses updated file contents');
    // Inspect the renderer input through the properties model, not just the uploaded file bytes.
    console.log('CACHE',cache);
    assert.deepEqual(errors,[]);
    console.log('PASS draft protection and callback reentry');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
