import fs from 'node:fs';

const file = process.argv[2] || 'samples/RA6E2-eprj3/RA6E2-eprj3-unzip/sch/Schematic2/P1.esch2';
const t = fs.readFileSync(file, 'utf8');
const recs = [];
for (const line of t.split('\n')) {
  const i = line.indexOf('||');
  if (i < 0) continue;
  try {
    const head = JSON.parse(line.slice(0, i));
    const d = JSON.parse(line.slice(i + 2).replace(/\|\s*$/, ''));
    recs.push({ head, d, id: head.id });
  } catch {}
}

// find COMPONENT records and their attrs
const comps = recs.filter((r) => r.head.type === 'COMPONENT');
console.log('COMPONENTS:', comps.map((c) => `${c.id} uuid=${c.d.symbol ?? c.d.head?.symbol ?? ''}`).join('\n  '));
for (const c of comps) {
  const attrs = recs.filter((r) => r.head.type === 'ATTR' && r.d.parentId === c.id);
  if (!attrs.length) continue;
  console.log(`\n--- component ${c.id} attrs:`);
  for (const a of attrs) console.log(`  ${a.d.key} = ${JSON.stringify(a.d.value)} x=${a.d.x} y=${a.d.y}`);
}

// TABLE record
for (const r of recs) {
  if (r.head.type === 'TABLE') {
    console.log('\n--- TABLE record', r.id);
    console.log(' sizes:', JSON.stringify(r.d.colSizes), JSON.stringify(r.d.rowSizes), 'start', r.d.startX, r.d.startY, 'rot', r.d.rotation);
    for (const c of r.d.tableCell ?? []) {
      console.log(`  cell [${c.rowIndex},${c.columnIndex}] span=${c.rowSpan ?? 1}x${c.colSpan ?? 1} value=${JSON.stringify(c.value)} align=${c.align ?? c.fontStyle?.hAlign}`);
    }
  }
}
// OBJ record heads
console.log('\nOBJ records:', recs.filter((r) => r.head.type === 'OBJ').map((r) => r.id).join(', '));
// page-level (parentId-free) ATTRs
console.log('\nfree ATTRs:');
for (const r of recs) {
  if (r.head.type === 'ATTR' && !r.d.parentId) console.log(`  ${r.d.key} = ${JSON.stringify(r.d.value)}`);
}
