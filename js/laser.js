// Laser-cut contour model: one piece per contour layer (contour step = board thickness at model scale),
// engraved with the next layer's outline and the footprints of buildings standing on it; shelf-packed onto boards.
import { clamp } from './geo.js';
import { esc, fmt, r2 } from './util.js';
import { DXF } from './export.js';

const ringArea = r => { let a = 0; for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return a / 2; };
function pip(x, y, ring) { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }

export function laserModel(M, { scale, board, sheetW, sheetH }) {
  const f = M.frame, d = M.dem, k = 1000 / scale, iv = board * scale / 1000;
  const lv0 = Math.floor(d.min / iv) * iv, levels = []; for (let v = lv0; v <= d.max + 1e-9 && levels.length < 400; v += iv) levels.push(+v.toFixed(4));
  const toMM = (gx, gy) => [(clamp(gx - 0.5, 0, d.W - 1) * d.dx) * k, (clamp(gy - 0.5, 0, d.H - 1) * d.dy) * k];   // origin = frame top-left
  const locMM = p => [(p[0] + f.w / 2) * k, (f.h / 2 - p[1]) * k];
  const W = f.w * k, H = f.h * k;
  const regions = levels.map((v, i) => i === 0 ? [[[[0, 0], [W, 0], [W, H], [0, H], [0, 0]]]] : d3.contours().size([d.W, d.H]).thresholds([v])(M.smooth)[0].coordinates.map(poly => poly.map(r => r.map(p => toMM(...p)))));
  const pieces = [];
  regions.forEach((polys, i) => {
    const next = regions[i + 1] || [], top = levels[i + 1] ?? Infinity;
    const bld = M.buildings.filter(b => b.inFrame && b.base >= levels[i] && b.base < top).map(b => b.loc[0].map(locMM));
    for (const poly of polys) {
      const outer = poly[0]; if (Math.abs(ringArea(outer)) < 4) continue;   // < 4 mm² — too small to cut
      const xs = outer.map(p => p[0]), ys = outer.map(p => p[1]), bx = Math.min(...xs), by = Math.min(...ys), bw = Math.max(...xs) - bx, bh = Math.max(...ys) - by;
      const inside = r => pip(r[0][0], r[0][1], outer) || pip(...r[Math.floor(r.length / 2)], outer);
      const eng = next.flatMap(p => p).filter(inside), bl = bld.filter(inside);
      let lx = bx + bw / 2, ly = by + bh / 2; if (!pip(lx, ly, outer)) { lx = outer[0][0]; ly = outer[0][1]; }
      pieces.push({ layer: i, level: levels[i], cut: poly, engrave: eng, buildings: bl, bx, by, bw, bh, label: [lx, ly] });
    }
  });
  // shelf packing
  const m = 5, gap = 3, boards = []; let cur = null;
  const newBoard = (w = sheetW, h = sheetH) => { cur = { w, h, x: m, y: m, row: 0, items: [], oversize: w !== sheetW || h !== sheetH }; boards.push(cur); };
  for (const p of pieces.slice().sort((a, b) => b.bh - a.bh)) {
    if (p.bw + 2 * m > sheetW || p.bh + 2 * m > sheetH) { newBoard(Math.max(sheetW, p.bw + 2 * m), Math.max(sheetH, p.bh + 2 * m)); cur.items.push({ p, ox: m - p.bx, oy: m - p.by }); cur = null; continue; }
    if (!cur || cur.oversize) newBoard();
    if (cur.x + p.bw + m > cur.w) { cur.x = m; cur.y += cur.row + gap; cur.row = 0; }
    if (cur.y + p.bh + m > cur.h) { newBoard(); }
    cur.items.push({ p, ox: cur.x - p.bx, oy: cur.y - p.by }); cur.x += p.bw + gap; cur.row = Math.max(cur.row, p.bh);
  }
  const fz = 3.5;
  const out = boards.map((b, bi) => {
    const path = (ring, ox, oy) => 'M' + ring.map(q => `${r2(q[0] + ox)},${r2(q[1] + oy)}`).join(' L') + 'Z';
    let svg = '', dx = new DXF(); dx.layer('CUT', 1); dx.layer('ENGRAVE', 5); dx.layer('LABEL', 7);
    for (const { p, ox, oy } of b.items) {
      svg += `<path d="${p.cut.map(r => path(r, ox, oy)).join(' ')}" fill="none" stroke="#ff0000" stroke-width="0.1" fill-rule="evenodd"/>`;
      for (const r of p.cut) dx.poly('CUT', r.map(q => [q[0] + ox, b.h - (q[1] + oy)]), true);
      for (const r of p.engrave) { svg += `<path d="${path(r, ox, oy)}" fill="none" stroke="#0000ff" stroke-width="0.1"/>`; dx.poly('ENGRAVE', r.map(q => [q[0] + ox, b.h - (q[1] + oy)]), true); }
      for (const r of p.buildings) { svg += `<path d="${path(r, ox, oy)}" fill="none" stroke="#0000ff" stroke-width="0.1" stroke-dasharray="1 0.6"/>`; dx.poly('ENGRAVE', r.map(q => [q[0] + ox, b.h - (q[1] + oy)]), true); }
      const t = `L${String(p.layer).padStart(2, '0')}  ${p.level >= 0 ? '+' : ''}${fmt(p.level, iv < 1 ? 2 : 1)} m`;
      svg += `<text x="${r2(p.label[0] + ox)}" y="${r2(p.label[1] + oy)}" font-size="${fz}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" fill="#000">${esc(t)}</text>`;
      dx.text('LABEL', [p.label[0] + ox, b.h - (p.label[1] + oy)], fz, t);
    }
    svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${r2(b.w)}mm" height="${r2(b.h)}mm" viewBox="0 0 ${r2(b.w)} ${r2(b.h)}"><rect width="${r2(b.w)}" height="${r2(b.h)}" fill="#fff" stroke="#cccccc" stroke-width="0.2"/>${svg}</svg>`;
    return { svg, dxf: dx.toString(), w: b.w, h: b.h, n: b.items.length, oversize: b.oversize };
  });
  return { boards: out, interval: iv, layers: levels.length, pieces: pieces.length, size: [W, H], oversize: out.filter(b => b.oversize).length };
}
