import fs from 'node:fs';

function scan(file) {
  const t = fs.readFileSync(file, 'utf8');
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  let n = 0;
  let outline = null, canvas = null;
  const add = (x, y) => {
    x = +x; y = +y;
    if (!isFinite(x) || !isFinite(y)) return;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const line of t.split('\n')) {
    const i = line.indexOf('||');
    if (i < 0) continue;
    let head, d;
    try { head = JSON.parse(line.slice(0, i)); d = JSON.parse(line.slice(i + 2).replace(/\|\s*$/, '')); } catch { continue; }
    if (head.type === 'COMPONENT') { add(d.x, d.y); n++; }
    if (head.type === 'POLY' && d.polyType === 'BOARD_OUTLINE') outline = d;
    if (head.type === 'CANVAS' && d.unit === 'mil') canvas = d;
  }
  console.log(file.split('/').pop(), 'components:', n,
    'comp bbox:', minX.toFixed(1), minY.toFixed(1), maxX.toFixed(1), maxY.toFixed(1));
  console.log(' outline path:', JSON.stringify(outline?.path));
  console.log(' canvas:', JSON.stringify(canvas));
}

scan('samples/RA6E2-eprj3/RA6E2-eprj3-unzip/pcb/PCB1.epcb2');
scan('samples/RA6E2-eprj3/RA6E2-eprj3-unzip/pcb/PCB2.epcb2');
