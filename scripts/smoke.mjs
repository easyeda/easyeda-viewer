// Headless render smoke-test: push every openable sample doc through renderDoc.
// minimal DOM shim so leafer-ui's web build can be imported headlessly
globalThis.CanvasRenderingContext2D = class {};
globalThis.Path2D = class {};
globalThis.OffscreenCanvas = class { getContext() { return {}; } };
globalThis.Image = class {};
globalThis.HTMLCanvasElement = class {};
globalThis.document = {
  createElement: () => ({ style: {}, classList: { add() {} }, getContext: () => ({}), appendChild() {} }),
  body: { appendChild() {} },
};
globalThis.window = globalThis;

const { readdirSync, readFileSync, statSync } = await import('node:fs');
const path = await import('node:path');
const { loadFromMap } = await import('./src/core/parse/container.ts');
const { openDoc } = await import('./src/core/model.ts');
const { renderDoc } = await import('./src/core/render/layers.ts');

function loadFile(file) {
  const map = new Map([[path.basename(file), new Uint8Array(readFileSync(file))]]);
  return loadFromMap(map);
}
/** folder-form project: read the directory tree like a drag&drop upload would */
function loadDir(dir, prefix = '') {
  const map = new Map();
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const key = prefix ? `${prefix}/${name}` : name;
    if (statSync(p).isDirectory()) {
      for (const [k, b] of loadDir(p, key)) map.set(k, b);
    } else {
      map.set(key, new Uint8Array(readFileSync(p)));
    }
  }
  return map;
}
const models = [loadFromMap(loadDir('samples/RA6E2-eprj3')), loadFile('samples/RA6E2-epro2/RA6E2.epro2'), loadFile('samples/viewer_fulltest-epro2/viewer_fulltest.epro2'), loadFile('samples/ReuseBlock_A3967-epro2/ReuseBlock_A3967.epro2')];
let total = 0, errs = 0;
for (const m of models) {
  console.log('==', m.name, m.format, 'openables:', m.openables.size);
  for (const n of m.openables.values()) {
    total++;
    try {
      const r = renderDoc(openDoc(m, n));
      const diag = [...new Set(r.diagnostics.map((d) => d.split(' ')[0]))].slice(0, 3);
      console.log(
        `   ✓ ${n.docType.padEnd(12)} ${String(n.title).slice(0, 24).padEnd(26)} obj=${String(r.objects.length).padStart(5)} lay=${String(r.layers.length).padStart(3)} unk=${r.report.unknownTypes.length}${r.report.placeholders ? ' ph=' + r.report.placeholders : ''}${diag.length ? ' diag:' + diag.join(',') : ''}`,
      );
    } catch (e) {
      errs++;
      console.log(`   ✗ ${n.docType} ${n.title}: ${e.stack?.split('\n').slice(0, 3).join(' | ')}`);
    }
  }
}
console.log(`\n${total - errs}/${total} docs rendered without throwing`);
process.exit(errs ? 1 : 0);
