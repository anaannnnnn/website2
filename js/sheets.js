// True-scale drawing sheets, authored in millimetres (SVG viewBox = paper size in mm).
// Plans are drawn at the chosen scale: 1 m on the ground = 1000/scale mm on paper.
import { D2R, clamp, sheetLayout, sunPosition } from './geo.js';
import { esc, fmt, niceStep, r2 } from './util.js';
import { contourPolylines, contourLevels, gridToLocal, isMajor, autoInterval, CMAPS, percentiles, lut } from './analysis.js';
import { computeSection, renderSection, sectionDXF } from './sections.js';

const FONT = 'Inter, Helvetica, Arial, sans-serif';
const PEN = { xf: 0.09, f: 0.13, m: 0.18, n: 0.25, b: 0.35, h: 0.5, x: 0.7 };

/* ── context ── */
export function sheetCtx(M, o) {
  const L = sheetLayout(o.paper, o.orient), scale = o.scale, k = 1000 / scale, f = M.frame;
  const cx = L.vx + L.vw / 2, cy = L.vy + L.vh / 2, fs = L.W >= 590 ? 1 : L.W >= 400 ? 0.8 : 0.64;
  const P = (x, y) => [cx + x * k, cy - y * k];
  return { M, o, L, scale, k, f, cx, cy, fs, P, pts: arr => arr.map(p => { const q = P(p[0], p[1]); return r2(q[0]) + ',' + r2(q[1]); }).join(' ') };
}
const clipId = () => 'c' + Math.random().toString(36).slice(2, 8);
/* Many shapes → one SVG path. Every outer ring is wound the same way and holes the opposite way, so with
   the default non-zero fill overlaps stay solid and holes stay open. Thousands of separate elements made
   sheets (the shadow study reached 26 MB / 319,000 elements) heavy enough to crash the tab. */
const sArea = r => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return a; };
function ringD(r, outer) {
  if (r.length < 3) return '';
  const pts = (sArea(r) > 0) === outer ? r : r.slice().reverse();
  let d = 'M' + r2(pts[0][0]) + ',' + r2(pts[0][1]);
  for (let i = 1; i < pts.length; i++) d += 'L' + r2(pts[i][0]) + ',' + r2(pts[i][1]);
  return d + 'Z';
}
/** polygons: arrays of rings (first = outer) already in sheet mm */
const polysD = polys => polys.map(rs => rs.map((r, i) => ringD(r, i === 0)).join('')).join('');

/* ── text helpers ── */
function wrap(text, maxW, size) { const words = String(text).split(/\s+/), lines = []; let cur = ''; const cw = size * 0.52; for (const w of words) { if ((cur + ' ' + w).trim().length * cw > maxW && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); } if (cur) lines.push(cur); return lines; }
const T = (x, y, s, txt, a = '') => `<text x="${r2(x)}" y="${r2(y)}" font-size="${r2(s)}" ${a}>${esc(txt)}</text>`;

/* ── sheet frame + title block ── */
export function sheet(c, { title, subtitle = '', body, legend = [], notes = [], scaleLabel, scaleBar = true, north = true, no = '', defs = '' }) {
  const { L, fs } = c, M = c.M, tx = L.W - L.margin - L.title, tw = L.title, y0 = L.vy;
  const proj = c.o.project || 'Site analysis', author = c.o.author || '', place = (M.site && M.site.name) || '';
  let tb = `<rect x="${r2(tx)}" y="${y0}" width="${tw}" height="${L.vh}" fill="#fff" stroke="#000" stroke-width="${PEN.b}"/>`;
  let y = y0 + 8 * fs; const pad = 4 * fs, inner = tw - 2 * pad;
  tb += T(tx + pad, y, 2.4 * fs, 'TERRAKIT · SITE STUDIO', `font-weight="700" letter-spacing=".3" fill="#ff4f1a"`); y += 7 * fs;
  for (const ln of wrap(proj, inner, 4.6 * fs)) { tb += T(tx + pad, y, 4.6 * fs, ln, 'font-weight="800"'); y += 5.4 * fs; }
  if (author) { tb += T(tx + pad, y, 2.6 * fs, author, 'fill="#444"'); y += 4 * fs; }
  for (const ln of wrap(place, inner, 2.6 * fs)) { tb += T(tx + pad, y, 2.6 * fs, ln, 'fill="#444"'); y += 3.4 * fs; }
  const lat = M.frame.lat, lon = M.frame.lon;
  tb += T(tx + pad, y, 2.1 * fs, `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? 'N' : 'S'}  ${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? 'E' : 'W'}`, `fill="#666" font-family="JetBrains Mono, Courier, monospace"`); y += 3 * fs;
  tb += T(tx + pad, y, 2.1 * fs, `UTM ${M.frame.zone}${M.frame.south ? 'S' : 'N'} (EPSG:${M.frame.epsg}) · frame ${fmt(M.frame.bearing, 1)}°`, `fill="#666"`); y += 5 * fs;
  tb += `<line x1="${r2(tx)}" x2="${r2(tx + tw)}" y1="${r2(y)}" y2="${r2(y)}" stroke="#000" stroke-width="${PEN.m}"/>`; y += 8 * fs;
  for (const ln of wrap(title.toUpperCase(), inner, 5 * fs)) { tb += T(tx + pad, y, 5 * fs, ln, 'font-weight="800" letter-spacing=".2"'); y += 5.8 * fs; }
  for (const ln of wrap(subtitle, inner, 2.4 * fs)) { tb += T(tx + pad, y, 2.4 * fs, ln, 'fill="#444"'); y += 3.2 * fs; }
  y += 3 * fs;
  for (const it of legend) {
    const sw = 7 * fs, sh = 3.6 * fs;
    if (it.line) tb += `<line x1="${r2(tx + pad)}" x2="${r2(tx + pad + sw)}" y1="${r2(y - sh / 2 + 0.3)}" y2="${r2(y - sh / 2 + 0.3)}" stroke="${it.stroke || '#000'}" stroke-width="${it.w || PEN.b}" ${it.dash ? `stroke-dasharray="${it.dash}"` : ''}/>`;
    else tb += `<rect x="${r2(tx + pad)}" y="${r2(y - sh)}" width="${r2(sw)}" height="${r2(sh)}" fill="${it.fill}" stroke="${it.stroke || '#000'}" stroke-width="${PEN.f}"/>`;
    const lines = wrap(it.label, inner - sw - 2.5 * fs, 2.3 * fs);
    lines.forEach((ln, i) => { tb += T(tx + pad + sw + 2.5 * fs, y - 0.7 * fs + i * 3 * fs, 2.3 * fs, ln); });
    y += Math.max(5, lines.length * 3 + 2) * fs;
  }
  // bottom part: notes, north, scale, footer (anchored to the bottom)
  let yb = y0 + L.vh - 4 * fs;
  const foot = `${new Date().toISOString().slice(0, 10)}${no ? '  ·  SHEET ' + no : ''}`;
  tb += T(tx + pad, yb, 2.1 * fs, foot, 'fill="#666"'); yb -= 6 * fs;
  if (scaleLabel !== null) {
    const lbl = scaleLabel || `1:${fmt(c.scale)} @ ${c.o.paper}`;
    if (scaleBar && c.k) {
      const len = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].filter(v => v * c.k <= inner * 0.95).pop() || 5, bw = len * c.k;
      for (let i = 0; i < 4; i++) tb += `<rect x="${r2(tx + pad + i * bw / 4)}" y="${r2(yb - 2.2 * fs)}" width="${r2(bw / 4)}" height="${r2(1.6 * fs)}" fill="${i % 2 ? '#fff' : '#000'}" stroke="#000" stroke-width="${PEN.f}"/>`;
      tb += T(tx + pad, yb - 3.6 * fs, 2.2 * fs, '0') + T(tx + pad + bw, yb - 3.6 * fs, 2.2 * fs, `${len} m`, 'text-anchor="end"');
      yb -= 9 * fs;
    }
    tb += T(tx + pad, yb, 5.2 * fs, lbl, 'font-weight="800"'); yb -= 9 * fs;
  }
  if (north) {
    const r = 6 * fs, ncx = tx + tw - pad - r, ncy = yb + 2 * fs;
    tb += `<g transform="translate(${r2(ncx)},${r2(ncy)}) rotate(${r2(-M.frame.bearing)})"><circle r="${r2(r)}" fill="none" stroke="#000" stroke-width="${PEN.m}"/><path d="M0,${r2(-r * 1.15)} L${r2(r * 0.42)},${r2(r * 0.55)} L0,${r2(r * 0.25)} L${r2(-r * 0.42)},${r2(r * 0.55)}Z" fill="#000"/>${T(0, -r * 1.35, 2.6 * fs, 'N', 'text-anchor="middle" font-weight="800"')}</g>`;
  }
  const allNotes = [...notes, ...dataNotes(M)];
  let ny = yb - 10 * fs;
  const noteLines = allNotes.flatMap(n => wrap(n, inner, 1.9 * fs));
  ny -= noteLines.length * 2.5 * fs;
  if (ny > y) { tb += `<line x1="${r2(tx)}" x2="${r2(tx + tw)}" y1="${r2(ny - 4 * fs)}" y2="${r2(ny - 4 * fs)}" stroke="#000" stroke-width="${PEN.f}"/>`; noteLines.forEach((ln, i) => { tb += T(tx + pad, ny + i * 2.5 * fs, 1.9 * fs, ln, 'fill="#555"'); }); }
  const border = `<rect x="${L.margin / 2}" y="${L.margin / 2}" width="${r2(L.W - L.margin)}" height="${r2(L.H - L.margin)}" fill="none" stroke="#000" stroke-width="${PEN.h}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${L.W}mm" height="${L.H}mm" viewBox="0 0 ${L.W} ${L.H}" font-family="${FONT}"><defs>${defs}</defs><rect width="${L.W}" height="${L.H}" fill="#fff"/>${body}${border}${tb}</svg>`;
}
function dataNotes(M) {
  const t = M.terrain, hs = M.buildings.length ? M.buildings.filter(b => b.how === 'recorded height' || b.how === 'floors × 3.5 m').length / M.buildings.length * 100 : 0;
  return [
    `Terrain: ${t.name} via AWS Terrain Tiles; ${t.res}, ${t.acc}.`,
    `Buildings: ${M.bsource}${M.release ? ' ' + M.release : ''}; ${fmt(hs, 0)}% with recorded height or floors, others ${fmt(M.defaultH || 9)} m (marked ~ / dashed).`,
    'Streets, water, land use, trees: © OpenStreetMap contributors (ODbL). Coordinates: UTM grid metres.'
  ];
}

/* ── plan layers ── */
function viewportClip(c) { const id = clipId(); return { id, def: `<clipPath id="${id}"><rect x="${r2(c.L.vx)}" y="${r2(c.L.vy)}" width="${r2(c.L.vw)}" height="${r2(c.L.vh)}"/></clipPath>` }; }
const polyAttr = (c, ring) => `points="${c.pts(ring)}"`;
function buildingsSVG(c, style) {
  // one path per distinct style (fill, stroke) instead of one element per building
  const groups = new Map();
  for (const b of c.M.buildings) { const st = style(b); if (!groups.has(st)) groups.set(st, []); groups.get(st).push(b.loc.map(r => r.map(p => c.P(p[0], p[1])))); }
  const out = [];
  for (const [st, polys] of groups) {
    const m = st.match(/fill="(url\(#[^"]+\))"/);
    if (m) out.unshift(`<path d="${polysD(polys)}" fill="${m[1]}" stroke="none"/>`), out.push(`<path d="${polysD(polys)}" ${st.replace(m[0], 'fill="none"')}/>`);
    else out.push(`<path d="${polysD(polys)}" ${st}/>`);
  }
  return out.join('');
}
function roadsSVG(c, { casing = '#000', fill = '#fff', minW = 0.35, cw = PEN.f } = {}) {
  const rs = c.M.osm.roads.slice().sort((a, b) => a.width - b.width), w = r => Math.max(minW, r.width * c.k);
  return `<g fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="${casing}">${rs.map(r => `<polyline points="${c.pts(r.loc)}" stroke-width="${r2(w(r) + cw * 2)}"/>`).join('')}</g><g stroke="${fill}">${rs.map(r => `<polyline points="${c.pts(r.loc)}" stroke-width="${r2(w(r))}"/>`).join('')}</g></g>`;
}
function waterSVG(c, fill = '#dfeaf2', stroke = '#000') {
  const o = c.M.osm;
  return `<g fill="${fill}" stroke="${stroke}" stroke-width="${PEN.f}">${o.water.map(w => `<polygon ${polyAttr(c, w.loc)}/>`).join('')}</g><g fill="none" stroke="${fill === 'none' ? stroke : '#9cc0da'}" stroke-linecap="round">${o.waterways.map(w => `<polyline points="${c.pts(w.loc)}" stroke-width="${r2(Math.max(0.3, w.width * c.k))}"/>`).join('')}</g>`;
}
function treesSVG(c, stroke = '#000') { return `<g fill="#fff" stroke="${stroke}" stroke-width="${PEN.f}">${c.M.osm.trees.map(t => { const [x, y] = c.P(...t.loc); return `<circle cx="${r2(x)}" cy="${r2(y)}" r="${r2(Math.max(0.6, (t.h ? t.h * 0.3 : 2.5) * c.k))}"/>`; }).join('')}</g>`; }
function contoursSVG(c, iv, { labels = true, minor = PEN.xf, major = PEN.m, color = '#000' } = {}) {
  const M = c.M, levels = contourLevels(M.dem.min, M.dem.max, iv), g2l = gridToLocal(M.dem, M.frame);
  const lines = contourPolylines(M.smooth, M.dem.W, M.dem.H, levels).map(l => ({ v: l.v, pts: l.pts.map(g2l) }));
  let s = `<g fill="none" stroke="${color}" stroke-linejoin="round">`;
  for (const l of lines) s += `<polyline points="${c.pts(l.pts)}" stroke-width="${isMajor(l.v, iv) ? major : minor}"${isMajor(l.v, iv) ? '' : ' stroke-opacity=".75"'}/>`;
  s += '</g>';
  if (labels) {
    const step = 140 * c.fs, fz = 1.9 * c.fs;
    for (const l of lines.filter(l => isMajor(l.v, iv))) {
      const P = l.pts.map(p => c.P(...p)); let acc = step * 0.5;
      for (let i = 1; i < P.length; i++) {
        const sl = Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); acc += sl;
        if (acc < step) continue; acc = 0;
        let ang = Math.atan2(P[i][1] - P[i - 1][1], P[i][0] - P[i - 1][0]) / D2R; if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
        const x = (P[i][0] + P[i - 1][0]) / 2, y = (P[i][1] + P[i - 1][1]) / 2;
        if (x < c.L.vx + 8 || x > c.L.vx + c.L.vw - 8 || y < c.L.vy + 6 || y > c.L.vy + c.L.vh - 6) continue;
        s += `<text transform="translate(${r2(x)},${r2(y)}) rotate(${r2(ang)})" font-size="${r2(fz)}" text-anchor="middle" dy="${r2(fz * 0.35)}" paint-order="stroke" stroke="#fff" stroke-width="${r2(fz * 0.45)}" fill="${color}">${fmt(l.v, iv < 1 ? 1 : 0)}</text>`;
      }
    }
  }
  return s;
}
function spotHeights(c) {
  const M = c.M, sp = 45 * c.fs / c.k, fz = 1.8 * c.fs; let s = '';
  for (let y = -M.frame.h / 2 + sp / 2; y < M.frame.h / 2; y += sp) for (let x = -M.frame.w / 2 + sp / 2; x < M.frame.w / 2; x += sp) {
    if (M.buildings.some(b => pip(x, y, b.loc[0]))) continue;
    const [X, Y] = c.P(x, y), z = M.zAt(x, y), a = 0.7 * c.fs;
    s += `<path d="M${r2(X - a)},${r2(Y)}h${r2(2 * a)}M${r2(X)},${r2(Y - a)}v${r2(2 * a)}" stroke="#000" stroke-width="${PEN.f}"/><text x="${r2(X + a * 1.3)}" y="${r2(Y - a * 0.6)}" font-size="${r2(fz)}" paint-order="stroke" stroke="#fff" stroke-width="${r2(fz * 0.4)}">${z >= 0 ? '+' : ''}${z.toFixed(1)}</text>`;
  }
  return s;
}
function pip(x, y, ring) { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
function sectionMarks(c, sections) {
  let s = '';
  for (const sec of sections) {
    const A = c.M.frame.toLocal(...sec.a), B = c.M.frame.toLocal(...sec.b), [ax, ay] = c.P(...A), [bx, by] = c.P(...B);
    const L = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / L, uy = (by - ay) / L, nx = uy, ny = -ux; // view direction on paper (left of A→B, y down)
    const r = 3.2 * c.fs;
    s += `<line x1="${r2(ax)}" y1="${r2(ay)}" x2="${r2(bx)}" y2="${r2(by)}" stroke="#000" stroke-width="${PEN.h}" stroke-dasharray="${r2(8 * c.fs)} ${r2(1.5 * c.fs)} ${r2(1 * c.fs)} ${r2(1.5 * c.fs)}"/>`;
    for (const [px, py, t] of [[ax, ay, sec.n], [bx, by, sec.n + '′']]) {
      s += `<path d="M${r2(px + nx * r * 0.9 - ny * r * 0.55)},${r2(py + ny * r * 0.9 + nx * r * 0.55)} L${r2(px + nx * r * 2.1)},${r2(py + ny * r * 2.1)} L${r2(px + nx * r * 0.9 + ny * r * 0.55)},${r2(py + ny * r * 0.9 - nx * r * 0.55)}Z" fill="#000"/>`;
      s += `<circle cx="${r2(px)}" cy="${r2(py)}" r="${r2(r)}" fill="#fff" stroke="#000" stroke-width="${PEN.b}"/>${T(px, py + r * 0.4, r * 1.05, t, 'text-anchor="middle" font-weight="800"')}`;
    }
  }
  return s;
}
function planSheet(c, { title, subtitle, layers, legend, notes, no, defs = '', over = '' }) {
  const cl = viewportClip(c);
  const body = `<g clip-path="url(#${cl.id})"><rect x="${c.L.vx}" y="${c.L.vy}" width="${c.L.vw}" height="${c.L.vh}" fill="#fff"/>${layers}</g><rect x="${c.L.vx}" y="${c.L.vy}" width="${c.L.vw}" height="${c.L.vh}" fill="none" stroke="#000" stroke-width="${PEN.b}"/>${over}`;
  return sheet(c, { title, subtitle, body, legend, notes, no, defs: cl.def + defs });
}

/* ── plans ── */
const HATCH = (id, color = '#888', bg = '#fff', s = 1.6, w = PEN.f) => `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${s}" height="${s}" patternTransform="rotate(45)"><rect width="${s}" height="${s}" fill="${bg}"/><line x1="0" y1="0" x2="0" y2="${s}" stroke="${color}" stroke-width="${w}"/></pattern>`;
export function sitePlan(c, sections) {
  const M = c.M, iv = contourIntervalFor(c);
  const layers = waterSVG(c) + `<g fill="#eef2e9" stroke="none">${M.osm.green.map(g => `<polygon ${polyAttr(c, g.loc)}/>`).join('')}</g>` +
    contoursSVG(c, iv) + roadsSVG(c, { casing: '#000', fill: '#fff' }) + treesSVG(c) +
    buildingsSVG(c, b => `fill="${b.known ? '#d9d9d9' : 'url(#hU)'}" stroke="#000" stroke-width="${PEN.n}"`) + spotHeights(c);
  return planSheet(c, { over: sectionMarks(c, sections), title: 'Site plan', subtitle: `Contours every ${iv} m (index every ${iv * 5} m), spot heights in metres above sea level, buildings and streets.`, layers, defs: HATCH('hU', '#999', '#f2f2f2'),
    legend: [{ fill: '#d9d9d9', label: 'Building (recorded height or floors)' }, { fill: 'url(#hU)', label: 'Building, height not recorded' }, { line: true, w: PEN.m, label: `Index contour (${iv * 5} m)` }, { line: true, w: PEN.xf, label: `Contour (${iv} m)` }, { fill: '#dfeaf2', label: 'Water' }, { fill: '#eef2e9', stroke: '#eef2e9', label: 'Green space' }, { line: true, w: PEN.h, dash: '3 0.6 0.5 0.6', label: 'Section line' }] });
}
export function contourIntervalFor(c) {
  const r = c.M.dem.max - c.M.dem.min;
  return [0.25, 0.5, 1, 2, 5, 10, 20, 25, 50, 100].find(s => r / s <= 40) || autoInterval(r);
}
export function figureGround(c) {
  const M = c.M, built = M.buildings.reduce((a, b) => a + Math.abs(area(b.loc[0])), 0), site = M.frame.w * M.frame.h;
  return planSheet(c, { title: 'Figure-ground', subtitle: `${fmt(M.buildings.length)} buildings · built coverage ≈ ${fmt(built / site * 100, 1)}% of the ${site >= 1e6 ? fmt(site / 1e6, 2) + ' km²' : fmt(site / 1e4, 1) + ' ha'} frame.`,
    layers: buildingsSVG(c, () => 'fill="#000" stroke="none"'), legend: [{ fill: '#000', label: 'Building footprint' }] });
}
const area = r => { let a = 0; for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return a / 2; };
const H_CLASSES = [[6, '< 6 m', '#fde0d2'], [12, '6–12 m', '#fbb497'], [24, '12–24 m', '#f08068'], [48, '24–48 m', '#d7434a'], [100, '48–100 m', '#a01a3c'], [Infinity, '> 100 m', '#5c0a28']];
export function buildingHeights(c) {
  const M = c.M, kn = M.buildings.filter(b => b.known);
  const layers = roadsSVG(c, { casing: '#bbb', fill: '#fff' }) + buildingsSVG(c, b => b.known ? `fill="${H_CLASSES.find(h => b.h < h[0])[2]}" stroke="#000" stroke-width="${PEN.f}"` : 'fill="url(#hU2)" stroke="#555" stroke-width="' + PEN.f + '"');
  return planSheet(c, { title: 'Building heights', subtitle: `${fmt(kn.length)} of ${fmt(M.buildings.length)} buildings have a recorded height or floor count (floors × 3.5 m). The rest are hatched — unknown, not guessed.`, layers, defs: HATCH('hU2', '#888', '#ececec'),
    legend: [...H_CLASSES.map(h => ({ fill: h[2], label: h[1] })), { fill: 'url(#hU2)', label: 'Height not recorded' }] });
}
const STREET = [[/^(motorway|trunk)(_link)?$/, 'Motorway / trunk', '#b2182b', 1.6], [/^primary(_link)?$/, 'Primary', '#ef6548', 1.3], [/^secondary(_link)?$/, 'Secondary', '#f4a442', 1.05], [/^tertiary(_link)?$/, 'Tertiary', '#555', 0.8], [/^(residential|unclassified|living_street)$/, 'Local', '#999', 0.55], [/^(service|track)$/, 'Service', '#bbb', 0.35], [/^(footway|path|pedestrian|steps|cycleway|bridleway|corridor)$/, 'Pedestrian / cycle', '#2f7fd0', 0.3]];
export function streets(c) {
  const M = c.M, groups = STREET.map(() => []), km = STREET.map(() => 0);
  for (const r of M.osm.roads) { const i = STREET.findIndex(s => s[0].test(r.tags.highway)); if (i < 0) continue; groups[i].push(r); km[i] += r.loc.reduce((a, p, j) => j ? a + Math.hypot(p[0] - r.loc[j - 1][0], p[1] - r.loc[j - 1][1]) : 0, 0) / 1000; }
  const layers = buildingsSVG(c, () => 'fill="#eee" stroke="none"') + STREET.map((s, i) => i).reverse().map(i => `<g fill="none" stroke="${STREET[i][2]}" stroke-width="${STREET[i][3] * c.fs}" stroke-linecap="round" stroke-linejoin="round"${i === 6 ? ` stroke-dasharray="${r2(1.2 * c.fs)} ${r2(0.8 * c.fs)}"` : ''}>${groups[i].map(r => `<polyline points="${c.pts(r.loc)}"/>`).join('')}</g>`).join('') +
    `<g fill="none" stroke="#000" stroke-width="${r2(0.6 * c.fs)}" stroke-dasharray="${r2(2 * c.fs)} ${r2(1 * c.fs)}">${M.osm.rails.map(r => `<polyline points="${c.pts(r.loc)}"/>`).join('')}</g>`;
  return planSheet(c, { title: 'Street hierarchy', subtitle: `${fmt(km.reduce((a, b) => a + b, 0), 1)} km of streets and paths by OpenStreetMap class.`, layers,
    legend: STREET.map((s, i) => ({ line: true, stroke: s[2], w: s[3], label: `${s[1]} · ${fmt(km[i], 1)} km` })).filter((_, i) => groups[i].length).concat(M.osm.rails.length ? [{ line: true, stroke: '#000', w: 0.6, dash: '2 1', label: 'Railway / tram' }] : []) });
}
const LU = { residential: ['Residential', '#f3dfc2'], commercial: ['Commercial / office', '#f2b6b6'], retail: ['Retail', '#f5a6c9'], industrial: ['Industrial', '#d9c6e8'], education: ['Education', '#fff1a8'], religious: ['Religious', '#d8d0b8'], construction: ['Construction', '#c9b79c'], railway: ['Railway land', '#d0d0d0'], farmland: ['Agriculture', '#eef0c6'], health: ['Health', '#f7c8a0'], other: ['Other land use', '#ececec'] };
function luClass(t) { const l = t.landuse, a = t.amenity; if (/^(school|university|college|kindergarten)$/.test(a || '') || l === 'education') return 'education'; if (/^(hospital|clinic)$/.test(a || '')) return 'health'; if (a === 'place_of_worship' || l === 'religious') return 'religious'; if (/^(farmland|farmyard)$/.test(l || '')) return 'farmland'; return LU[l] ? l : 'other'; }
function greenClass(t) { if (t.landuse === 'forest' || t.natural === 'wood') return ['Forest / woodland', '#7fb069']; if (t.leisure === 'pitch' || t.leisure === 'golf_course') return ['Sports & recreation', '#a8d5a2']; if (/^(park|garden|playground|nature_reserve)$/.test(t.leisure || '')) return ['Park / garden', '#b9dc9a']; if (t.landuse === 'cemetery') return ['Cemetery', '#c7d9b7']; return ['Grass / meadow / scrub', '#d6ebbd']; }
export function landUse(c) {
  const o = c.M.osm, used = new Map(), big = (a, b) => Math.abs(area(b.loc)) - Math.abs(area(a.loc));
  const lu = o.landuse.slice().sort(big).map(x => { const k = LU[luClass(x.tags)]; used.set(k[0], k[1]); return `<polygon ${polyAttr(c, x.loc)} fill="${k[1]}"/>`; }).join('');
  const gr = o.green.slice().sort(big).map(x => { const k = greenClass(x.tags); used.set(k[0], k[1]); return `<polygon ${polyAttr(c, x.loc)} fill="${k[1]}"/>`; }).join('');
  if (o.water.length || o.waterways.length) used.set('Water', '#9ec9ea');
  const layers = lu + gr + waterSVG(c, '#9ec9ea', 'none') + roadsSVG(c, { casing: '#fff', fill: '#fff', cw: 0 }) + buildingsSVG(c, () => `fill="none" stroke="#555" stroke-width="${PEN.xf}"`) + (o.trees.length ? treesSVG(c, '#2f7d32') : '');
  if (o.trees.length) used.set(`Mapped trees (${fmt(o.trees.length)})`, '#fff');
  return planSheet(c, { title: 'Land use, green & blue', subtitle: `${fmt(o.landuse.length)} land-use areas, ${fmt(o.green.length)} green spaces, ${fmt(o.water.length + o.waterways.length)} water features (OpenStreetMap).`, layers, legend: [...used.entries()].map(([l, f]) => ({ fill: f, label: l })) });
}

/* ── terrain analysis (vector bands where possible) ── */
function bandsSVG(c, data, th, cols) {
  const M = c.M, g2l = gridToLocal(M.dem, M.frame);
  const path = d3.geoPath(d3.geoTransform({ point(x, y) { const p = c.P(...g2l([x, y])); this.stream.point(p[0], p[1]); } }));
  if (path.digits) path.digits(2);
  return d3.contours().size([M.dem.W, M.dem.H]).thresholds(th)(data).map((cn, i) => cn.coordinates.length ? `<path d="${path(cn)}" fill="${cols[i]}"/>` : '').join('');
}
const interp = (stops, n) => Array.from({ length: n }, (_, k) => { const f = (n === 1 ? 0 : k / (n - 1)) * (stops.length - 1), i = Math.min(Math.floor(f), stops.length - 2); return d3.color(d3.interpolateRgb(stops[i], stops[i + 1])(f - i)).formatHex(); });
export function elevationMap(c) {
  const M = c.M, iv = contourIntervalFor(c), lo = Math.floor(M.dem.min / iv) * iv, hi = Math.ceil(M.dem.max / iv) * iv, n = Math.max(1, Math.round((hi - lo) / iv));
  const step = n > 14 ? Math.ceil(n / 14) * iv : iv, th = []; for (let v = lo; v < hi; v += step) th.push(+v.toFixed(3));
  const cols = interp(['#3f9637', '#9fcf55', '#f2dc4a', '#f4a83c', '#e3584a', '#b8306f'], th.length);
  const layers = bandsSVG(c, M.smooth, th, cols) + contoursSVG(c, iv, { minor: PEN.xf, major: PEN.f, color: '#3a2e1f' }) + waterSVG(c, '#9ec9ea', '#2f6f9f') + buildingsSVG(c, () => `fill="#fff" fill-opacity=".65" stroke="#555" stroke-width="${PEN.xf}"`);
  return planSheet(c, { title: 'Elevation', subtitle: `Hypsometric bands every ${step} m (${fmt(M.dem.min, 1)} to ${fmt(M.dem.max, 1)} m above sea level), contours every ${iv} m.`, layers, legend: th.map((v, i) => ({ fill: cols[i], label: `${fmt(v, step < 1 ? 1 : 0)} – ${fmt(th[i + 1] ?? hi, step < 1 ? 1 : 0)} m` })).reverse() });
}
export function slopeMap(c) {
  const E = [-1, 2, 5, 10, 15, 25], cols = ['#f3f4e9', '#d9eabf', '#f0d065', '#ec9a4a', '#d24a3a', '#7f1d1d'], labels = ['0–2° flat', '2–5° gentle', '5–10° moderate', '10–15° steep', '15–25° very steep', '> 25°'];
  const layers = bandsSVG(c, c.M.der.slope, E, cols) + buildingsSVG(c, () => `fill="none" stroke="#333" stroke-width="${PEN.xf}"`) + waterSVG(c, '#9ec9ea', 'none');
  return planSheet(c, { title: 'Slope analysis', subtitle: `Mean slope ${fmt(c.M.der.meanSlope, 1)}°. In dense cities the terrain model includes some buildings and bridges, which can show as steep patches.`, layers, legend: cols.map((f, i) => ({ fill: f, label: labels[i] })) });
}
function rasterImage(c, rgba) { // embed a classed raster aligned to the frame
  const M = c.M, cv = document.createElement('canvas'); cv.width = M.dem.W; cv.height = M.dem.H; const ctx = cv.getContext('2d'), img = ctx.createImageData(M.dem.W, M.dem.H);
  for (let i = 0; i < M.dem.W * M.dem.H; i++) img.data.set(rgba(i), i * 4);
  ctx.putImageData(img, 0, 0);
  const [x, y] = c.P(-M.frame.w / 2 - M.dem.dx / 2, M.frame.h / 2 + M.dem.dy / 2), url = cv.toDataURL('image/png');
  cv.width = cv.height = 0;   // release the canvas now (Safari caps total canvas memory)
  return `<image x="${r2(x)}" y="${r2(y)}" width="${r2((M.frame.w + M.dem.dx) * c.k)}" height="${r2((M.frame.h + M.dem.dy) * c.k)}" preserveAspectRatio="none" style="image-rendering:pixelated" href="${url}"/>`;
}
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];
export function aspectMap(c) {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'], cols = ['#e41a1c', '#ff7f00', '#ffd92f', '#4daf4a', '#1fb5d6', '#377eb8', '#984ea3', '#f781bf'].map(hex), flat = hex('#e6e6e6'), M = c.M;
  const layers = rasterImage(c, i => M.der.slope[i] < 2 ? flat : cols[Math.round(M.der.aspect[i] / 45) % 8]) + buildingsSVG(c, () => `fill="none" stroke="#222" stroke-width="${PEN.xf}"`);
  return planSheet(c, { title: 'Aspect', subtitle: 'Direction each slope faces (true north). Flatter than 2° shown grey.', layers, legend: [...names.map((n, i) => ({ fill: '#' + cols[i].slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join(''), label: `Faces ${n}` })), { fill: '#e6e6e6', label: 'Flat (< 2°)' }] });
}
export function solarMap(c) {
  const [lo, hi] = percentiles(c.M.der.solar, 0.01, 0.99), E = [-1, 80, 90, 97, 103, 110], cols = ['#2c1c5c', '#6a2c70', '#b83b5e', '#f08a4b', '#f9c74f', '#fff3b0'];
  const layers = bandsSVG(c, c.M.der.solar, E, cols) + buildingsSVG(c, () => `fill="none" stroke="#fff" stroke-width="${PEN.xf}"`);
  return planSheet(c, { title: 'Solar exposure', subtitle: `Relative direct sun on the ground surface over solstices and equinoxes, compared with flat ground (= 100%). Range here ${fmt(lo)}–${fmt(hi)}%. Terrain only — building shadows are in the shadow study.`, layers, legend: ['< 80%', '80–90%', '90–97%', '97–103%', '103–110%', '> 110%'].map((l, i) => ({ fill: cols[i], label: l })) });
}
export function runoffMap(c) {
  const M = c.M, acc = M.flowArr(), cell = M.dem.dx * M.dem.dy, col = lut('blues');
  const vmax = Math.log10(percentiles(acc, 0, 0.997)[1] / cell + 1);
  const layers = rasterImage(c, i => { const t = clamp(Math.log10(acc[i] / cell + 1) / vmax, 0, 1); const k = Math.round(t * 255) * 3; return t < 0.25 ? [255, 255, 255, 255] : [col[k], col[k + 1], col[k + 2], 255]; }) + contoursSVG(c, contourIntervalFor(c) * 2, { labels: false, minor: PEN.xf, major: PEN.xf, color: '#999' }) + buildingsSVG(c, () => `fill="none" stroke="#333" stroke-width="${PEN.xf}"`);
  return planSheet(c, { title: 'Surface runoff paths', subtitle: 'Where rain flowing over the ground surface concentrates (D8 flow accumulation on the terrain model). Darker = more upslope area draining through.', layers, legend: [{ fill: col.length ? `rgb(${col[200 * 3]},${col[200 * 3 + 1]},${col[200 * 3 + 2]})` : '#08306b', label: 'Main flow paths' }, { fill: `rgb(${col[110 * 3]},${col[110 * 3 + 1]},${col[110 * 3 + 2]})`, label: 'Minor flow paths' }] });
}

/* ── sections (true scale, packed onto sheets) ── */
const SEC_HL = `<pattern id="hl" patternUnits="userSpaceOnUse" width="1.6" height="1.6" patternTransform="rotate(45)"><rect width="1.6" height="1.6" fill="#fff"/><line x1="0" y1="0" x2="0" y2="1.6" stroke="#000" stroke-width="0.1"/></pattern>`;
export function sectionSheets(c, sections, depth) {
  const M = c.M, out = [], blocks = [];
  let scale = c.scale;
  for (const sec of sections) {
    const sd = computeSection(M, sec, depth);
    while (sd.L * 1000 / scale > c.L.vw + 0.5 && scale < 1e6) scale = [200, 250, 500, 1000, 1250, 2000, 2500, 5000, 10000, 20000, 50000].find(s => s > scale) || scale * 2;
    blocks.push(sd);
  }
  const k = 1000 / scale, cc = { ...c, k, scale };
  const fz = 2.2 * c.fs, gap = 16 * c.fs;
  const layout = blocks.map(sd => { const zTop = sd.zmax + 4, zBot = sd.zmin - Math.max(4, (sd.zmax - sd.zmin) * 0.12); return { sd, zTop, zBot, h: (zTop - zBot) * k + 26 * c.fs }; });
  let page = [], used = 0;
  const flush = () => { if (page.length) out.push(page); page = []; used = 0; };
  for (const b of layout) { if (used + b.h > c.L.vh - 8 && page.length) flush(); page.push(b); used += b.h + gap; }
  flush();
  const crops = [];
  const svgs = out.map((pg, pi) => {
    let body = '', y = c.L.vy + 12 * c.fs;
    const pageCrops = []; crops.push(pageCrops);
    for (const b of pg) {
      const x0 = c.L.vx + (c.L.vw - b.sd.L * k) / 2, r = renderSection(b.sd, { k, exag: 1, pen: 0.13 * c.fs, font: fz, x0, y0: y + 6 * c.fs, zTop: b.zTop, zBot: b.zBot, id: 's' + pi + b.sd.sec.n, labels: true });
      const zs = niceStep(b.zTop - b.zBot, 6);
      const b0 = body.length;
      body += r.svg;
      for (let z = Math.ceil(b.zBot / zs) * zs; z <= b.zTop; z += zs) body += `<line x1="${r2(x0)}" x2="${r2(x0 + 3 * c.fs)}" y1="${r2(r.Y(z))}" y2="${r2(r.Y(z))}" stroke="#000" stroke-width="${PEN.f}"/>${T(x0 + 4 * c.fs, r.Y(z) + fz * 0.35, fz * 0.85, (z >= 0 ? '+' : '') + z.toFixed(1), `paint-order="stroke" stroke="#fff" stroke-width="${r2(fz * 0.4)}"`)}`;
      for (const [x, t] of [[x0, b.sd.sec.n], [r.Xe, b.sd.sec.n + '′']]) body += `<circle cx="${r2(x)}" cy="${r2(y + 2 * c.fs)}" r="${r2(3 * c.fs)}" fill="#fff" stroke="#000" stroke-width="${PEN.b}"/>${T(x, y + 3.1 * c.fs, 3.2 * c.fs, t, 'text-anchor="middle" font-weight="800"')}<line x1="${r2(x)}" x2="${r2(x)}" y1="${r2(y + 5 * c.fs)}" y2="${r2(r.yG)}" stroke="#000" stroke-width="${PEN.f}" stroke-dasharray="2 1"/>`;
      const b1 = body.length;
      body += T(c.L.vx + 4 * c.fs, r.yG + 7 * c.fs, 3.4 * c.fs, `SECTION ${b.sd.sec.n}–${b.sd.sec.n}′`, 'font-weight="800"') + T(c.L.vx + 4 * c.fs, r.yG + 11 * c.fs, 2.1 * c.fs, `${fmt(b.sd.L)} m · ${b.sd.dir} · looking ${b.sd.view} · ${b.sd.cuts.length} buildings cut, ${b.sd.beyond.length} in elevation up to ${fmt(b.sd.depth)} m behind · 1:${fmt(scale)} horizontal and vertical`, 'fill="#444"');
      // the same section on its own — just the drawing, no sheet frame or title block (PNG/SVG/PDF), plus CAD linework
      const cx0 = x0 - 5 * c.fs, cx1 = r.Xe + 5 * c.fs, cy0 = y - 2 * c.fs, cy1 = r.yG + 2 * c.fs, cw = r2(cx1 - cx0), ch = r2(cy1 - cy0);
      pageCrops.push({ n: b.sd.sec.n, L: b.sd.L, scale, sd: b.sd, dxf: sectionDXF(b.sd, { zBot: b.zBot, zTop: b.zTop, scale }), svg: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${cw}mm" height="${ch}mm" viewBox="0 0 ${cw} ${ch}" font-family="${FONT}"><defs>${SEC_HL}</defs><rect width="${cw}" height="${ch}" fill="#fff"/><g transform="translate(${r2(-cx0)} ${r2(-cy0)})">${body.slice(b0, b1)}</g></svg>` });
      y += b.h + gap;
    }
    const cl = viewportClip(c);
    return sheet(cc, { title: pg.length > 1 ? `Sections ${pg.map(b => b.sd.sec.n).join(', ')}` : `Section ${pg[0].sd.sec.n}–${pg[0].sd.sec.n}′`, subtitle: 'Buildings in section solid black; buildings and terrain beyond in lighter lines, fading with distance. Dashed outlines: height not recorded.',
      body: `<g clip-path="url(#${cl.id})">${body}</g><rect x="${c.L.vx}" y="${c.L.vy}" width="${c.L.vw}" height="${c.L.vh}" fill="none" stroke="#000" stroke-width="${PEN.b}"/>`, defs: cl.def, north: false,
      legend: [{ fill: '#000', label: 'Cut: building' }, { fill: 'url(#hl)', label: 'Cut: ground (terrain model)' }, { fill: '#fff', label: 'Elevation beyond' }, { fill: '#fff', stroke: '#000', label: 'Dashed: height not recorded' }, { fill: '#e3eef6', label: 'Water' }],
      notes: ['Numbers above cut buildings are heights in metres; “~” = height not recorded (default used).'], scaleLabel: `1:${fmt(scale)} @ ${c.o.paper}` })
      .replace('<defs>', `<defs>${SEC_HL}`);
  });
  svgs.crops = crops;
  return svgs;
}

/* ── sun & climate ── */
export function sunPathSheet(c) {
  const M = c.M, lat = M.frame.lat, lon = M.frame.lon, L = c.L, R = Math.min(L.vw, L.vh) * 0.4, cx = L.vx + L.vw / 2, cy = L.vy + L.vh / 2 + 4 * c.fs, year = new Date().getUTCFullYear(), fs = c.fs;
  const pos = (mo, dd, h) => sunPosition(Date.UTC(year, mo, dd) + (h - lon / 15) * 3600000, lat, lon);
  const XY = p => { const r = R * (90 - p.alt / D2R) / 90; return [cx + r * Math.sin(p.az), cy - r * Math.cos(p.az)]; };
  let b = `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(R)}" fill="#fbfaf7" stroke="#000" stroke-width="${PEN.b}"/>`;
  for (const a of [15, 30, 45, 60, 75]) { const r = R * (90 - a) / 90; b += `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r)}" fill="none" stroke="#bbb" stroke-width="${PEN.xf}"/>${T(cx + 1, cy - r - 0.8, 2 * fs, a + '°', 'fill="#888"')}`; }
  for (let az = 0; az < 360; az += 15) { const a = az * D2R, big = az % 90 === 0; b += `<line x1="${r2(cx)}" y1="${r2(cy)}" x2="${r2(cx + R * Math.sin(a))}" y2="${r2(cy - R * Math.cos(a))}" stroke="#ccc" stroke-width="${big ? PEN.f : PEN.xf}"/>${T(cx + (R + 5 * fs) * Math.sin(a), cy - (R + 5 * fs) * Math.cos(a) + 1.2 * fs, (big ? 4 : 2.2) * fs, big ? 'NESW'[az / 90] : az + '°', `text-anchor="middle" ${big ? 'font-weight="800"' : 'fill="#777"'}`)}`; }
  const DATES = [[11, 21, '#2c7bb6', PEN.h], [0, 21, '#aaa', PEN.f], [1, 21, '#aaa', PEN.f], [2, 20, '#1a9850', PEN.h], [3, 21, '#aaa', PEN.f], [4, 21, '#aaa', PEN.f], [5, 21, '#d7191c', PEN.h]];
  for (const [mo, dd, col, w] of DATES) { let seg = [], segs = []; for (let h = 0; h <= 24.001; h += 0.1) { const p = pos(mo, dd, h); if (p.alt > 0) seg.push(XY(p)); else if (seg.length) { segs.push(seg); seg = []; } } if (seg.length) segs.push(seg); b += segs.map(s => `<polyline points="${s.map(q => r2(q[0]) + ',' + r2(q[1])).join(' ')}" fill="none" stroke="${col}" stroke-width="${w}"/>`).join(''); }
  for (let h = 4; h <= 20; h++) { const pts = DATES.map(([mo, dd]) => pos(mo, dd, h)).filter(p => p.alt > 0).map(XY); if (pts.length < 2) continue; b += `<polyline points="${pts.map(q => r2(q[0]) + ',' + r2(q[1])).join(' ')}" fill="none" stroke="#555" stroke-width="${PEN.xf}" stroke-dasharray="1 1"/>`; const p = pos(5, 21, h); if (p.alt > 0) { const [x, y] = XY(p); b += `<circle cx="${r2(x)}" cy="${r2(y)}" r="${r2(0.8 * fs)}" fill="#d7191c"/>${T(x, y - 2 * fs, 2.2 * fs, h + ':00', 'text-anchor="middle"')}`; } }
  const rows = [[11, 21, '21 Dec'], [2, 20, '20 Mar'], [5, 21, '21 Jun'], [8, 22, '22 Sep']].map(([mo, dd, n]) => { let rise = null, set = null, mx = -90; for (let m = 0; m <= 1440; m++) { const a = pos(mo, dd, m / 60).alt / D2R; if (a > mx) mx = a; if (a > -0.83 && rise === null) rise = m; if (a > -0.83) set = m; } const hm = m => m == null ? '–' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; return `${n}: sunrise ${hm(rise)}, sunset ${hm(set)}, daylight ${rise == null ? 0 : fmt((set - rise) / 60, 1)} h, max altitude ${fmt(mx, 1)}°`; });
  return sheet({ ...c, k: 0 }, { title: 'Sun path diagram', subtitle: 'Polar projection: centre = overhead, rim = horizon. Times in local solar time.', body: b, north: false, scaleLabel: null,
    legend: [{ line: true, stroke: '#d7191c', w: PEN.h, label: '21 June' }, { line: true, stroke: '#1a9850', w: PEN.h, label: '20 Mar / 22 Sep (equinox)' }, { line: true, stroke: '#2c7bb6', w: PEN.h, label: '21 December' }, { line: true, stroke: '#aaa', w: PEN.f, label: '21st of other months' }, { line: true, stroke: '#555', w: PEN.xf, dash: '1 1', label: 'Hour lines' }], notes: rows });
}
export function shadowStudy(c) {
  const M = c.M, L = c.L, fs = c.fs, lat = M.frame.lat, lon = M.frame.lon, year = new Date().getUTCFullYear();
  const dates = [[2, 20, '20 March / 22 Sept'], [5, 21, '21 June'], [11, 21, '21 December']], hours = [9, 12, 15];
  const cw = L.vw / 3, ch = (L.vh - 10 * fs) / 3, sc = Math.min((cw - 6) / M.frame.w, (ch - 12 * fs) / M.frame.h), cols = [];
  let body = '';
  dates.forEach(([mo, dd, dn], r) => hours.forEach((h, ci) => {
    const p = sunPosition(Date.UTC(year, mo, dd) + (h - lon / 15) * 3600000, lat, lon), ox = L.vx + ci * cw + cw / 2, oy = L.vy + 6 * fs + r * ch + (ch - 6 * fs) / 2;
    const P = (x, y) => [ox + x * sc, oy - y * sc];
    const fps = [];   // footprints in panel mm, simplified to what the pen can show
    for (const b of M.buildings) {
      const pts = [];
      for (const v of b.loc[0].slice(0, -1)) { const t = P(v[0], v[1]), l = pts[pts.length - 1]; if (!l || Math.abs(t[0] - l[0]) + Math.abs(t[1] - l[1]) > 0.08) pts.push(t); }
      if (pts.length >= 3) fps.push({ pts, h: b.h, sgn: sArea(pts) > 0 ? 1 : -1 });
    }
    let g = `<rect x="${r2(ox - M.frame.w * sc / 2)}" y="${r2(oy - M.frame.h * sc / 2)}" width="${r2(M.frame.w * sc)}" height="${r2(M.frame.h * sc)}" fill="#fff" stroke="#000" stroke-width="${PEN.f}"/>`;
    if (p.alt > 0.02) {
      const [se, sn] = M.frame.enToFrame(Math.sin(p.az), Math.cos(p.az)), len = 1 / Math.tan(p.alt);
      // Shadow of a prism = roof outline moved by the shadow vector + the swept quads of the walls that face
      // away from the sun (the other walls lie inside that). Worked in panel millimetres, with corners closer
      // than 0.08 mm merged — finer than the pen can draw at this scale.
      const D = [-se * len * sc, sn * len * sc], shadows = [];
      for (const r of fps) {
        const h = r.h, dx = D[0] * h, dy = D[1] * h, ring = r.pts;
        shadows.push([ring.map(v => [v[0] + dx, v[1] + dy])]);
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], q = ring[(i + 1) % ring.length], nx = (q[1] - a[1]) * r.sgn, ny = -(q[0] - a[0]) * r.sgn;
          if (nx * dx + ny * dy > 0) shadows.push([[a, q, [q[0] + dx, q[1] + dy], [a[0] + dx, a[1] + dy]]]);
        }
      }
      g += `<path d="${polysD(shadows)}" fill="#7d8796"/>`;
    }
    g += `<path d="${polysD(fps.map(r => [r.pts]))}" fill="#000"/>`;
    const id = clipId();
    body += `<clipPath id="${id}"><rect x="${r2(ox - M.frame.w * sc / 2)}" y="${r2(oy - M.frame.h * sc / 2)}" width="${r2(M.frame.w * sc)}" height="${r2(M.frame.h * sc)}"/></clipPath><g clip-path="url(#${id})">${g}</g>`;
    body += T(ox - M.frame.w * sc / 2, oy - M.frame.h * sc / 2 - 1.5 * fs, 2.4 * fs, `${dn} · ${String(h).padStart(2, '0')}:00${p.alt > 0.02 ? ` · sun ${fmt(p.alt / D2R)}° high` : ' · sun below horizon'}`, 'font-weight="700"');
  }));
  return sheet({ ...c, k: sc }, { title: 'Shadow study', subtitle: 'Building shadows on flat ground at 09:00, 12:00 and 15:00 local solar time. Unknown building heights use the default height; terrain is not included.', body, legend: [{ fill: '#000', label: 'Building' }, { fill: '#7d8796', label: 'Shadow' }], scaleLabel: `1:${fmt(Math.round(1000 / sc))} (approx.)` });
}
export function windRoseSheet(c) {
  const wd = c.M.climate.wind, L = c.L, fs = c.fs, BINS = [0.5, 2, 4, 6, 8, 11, Infinity], COLS = ['#c6dbef', '#6baed6', '#3182bd', '#08519c', '#54278f', '#2d004b'];
  const counts = Array.from({ length: 16 }, () => new Array(6).fill(0)); let calm = 0, total = 0, sum = 0;
  for (let i = 0; i < wd.spd.length; i++) { const s = wd.spd[i], d = wd.dir[i]; if (s == null || d == null) continue; total++; sum += s; if (s < BINS[0]) { calm++; continue; } counts[Math.round(d / 22.5) % 16][BINS.findIndex((b, k) => k > 0 && s < b) - 1]++; }
  const pct = counts.map(r => r.map(v => v / total * 100)), tot = pct.map(r => r.reduce((a, b) => a + b, 0)), maxP = Math.max(...tot, 1), ring = niceStep(maxP, 5), maxR = Math.ceil(maxP / ring) * ring;
  const R = Math.min(L.vw, L.vh) * 0.4, cx = L.vx + L.vw / 2, cy = L.vy + L.vh / 2, r0 = R * 0.08, rr = p => r0 + (R - r0) * p / maxR, pt = (r, a) => `${r2(cx + r * Math.sin(a))},${r2(cy - r * Math.cos(a))}`;
  let b = `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(R)}" fill="#fbfbfb" stroke="#000" stroke-width="${PEN.b}"/>`;
  for (let p = ring; p <= maxR + 1e-9; p += ring) b += `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(rr(p))}" fill="none" stroke="#ccc" stroke-width="${PEN.xf}"/>${T(cx + 1, cy - rr(p) - 0.8, 2 * fs, fmt(p, ring < 1 ? 1 : 0) + '%', 'fill="#777"')}`;
  const NM = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  for (let k = 0; k < 16; k++) {
    const a = k * 22.5 * D2R; b += `<line x1="${r2(cx)}" y1="${r2(cy)}" x2="${r2(cx + R * Math.sin(a))}" y2="${r2(cy - R * Math.cos(a))}" stroke="#e2e2e2" stroke-width="${PEN.xf}"/>${T(cx + (R + 5 * fs) * Math.sin(a), cy - (R + 5 * fs) * Math.cos(a) + 1.2 * fs, (k % 4 ? 2.2 : 4) * fs, NM[k], `text-anchor="middle"${k % 4 ? '' : ' font-weight="800"'}`)}`;
    let acc = 0; for (let j = 0; j < 6; j++) { const p = pct[k][j]; if (p <= 0) continue; const ra = rr(acc), rb = rr(acc + p), a0 = a - 10.5 * D2R, a1 = a + 10.5 * D2R; acc += p; b += `<path d="M${pt(ra, a0)} L${pt(rb, a0)} A${r2(rb)},${r2(rb)} 0 0 1 ${pt(rb, a1)} L${pt(ra, a1)} A${r2(ra)},${r2(ra)} 0 0 0 ${pt(ra, a0)}Z" fill="${COLS[j]}" stroke="#fff" stroke-width="0.1"/>`; }
  }
  b += `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r0)}" fill="#fff" stroke="#999" stroke-width="${PEN.f}"/>${T(cx, cy + 0.8 * fs, 2 * fs, `calm ${fmt(calm / total * 100, 1)}%`, 'text-anchor="middle"')}`;
  const prev = tot.indexOf(Math.max(...tot));
  return sheet({ ...c, k: 0 }, { title: 'Wind rose', subtitle: `Hourly 10 m wind at the site, ${c.M.climate.year}. Bars show where the wind blows FROM. Prevailing: ${NM[prev]} (${fmt(tot[prev], 1)}% of hours), mean ${fmt(sum / total, 1)} m/s.`, body: b, north: false, scaleLabel: null,
    legend: ['0.5–2 m/s', '2–4 m/s', '4–6 m/s', '6–8 m/s', '8–11 m/s', '> 11 m/s'].map((l, i) => ({ fill: COLS[i], label: l })), notes: ['Wind: Open-Meteo ERA5 reanalysis (≈25 km grid) — regional, not affected by local buildings.'] });
}
export function climateSheet(c) {
  const cl = c.M.climate, L = c.L, fs = c.fs, x0 = L.vx + 22 * fs, y0 = L.vy + 18 * fs, cw = L.vw - 44 * fs, ch = L.vh * 0.55, Mn = 'JFMAMJJASOND';
  const rs = niceStep(Math.max(...cl.monthly, 1), 6), rmax = Math.max(rs, Math.ceil(Math.max(...cl.monthly, 1) / rs) * rs);
  const tlo = Math.floor(Math.min(...cl.mTmin) / 5) * 5, thi = Math.ceil(Math.max(...cl.mTmax) / 5) * 5 || tlo + 5;
  const bw = cw / 12, Yr = v => y0 + ch - v / rmax * ch, Yt = v => y0 + ch - (v - tlo) / (thi - tlo) * ch, Xm = k => x0 + bw * (k + 0.5);
  let b = '';
  for (let v = 0; v <= rmax + 1e-9; v += rs) b += `<line x1="${r2(x0)}" x2="${r2(x0 + cw)}" y1="${r2(Yr(v))}" y2="${r2(Yr(v))}" stroke="#e5e5e5" stroke-width="${PEN.xf}"/>${T(x0 - 2 * fs, Yr(v) + 0.8 * fs, 2.4 * fs, fmt(v), 'text-anchor="end" fill="#2166ac"')}`;
  for (let v = tlo; v <= thi; v += 5) b += T(x0 + cw + 2 * fs, Yt(v) + 0.8 * fs, 2.4 * fs, v + '°', 'fill="#b2182b"');
  b += `<polygon points="${cl.mTmax.map((v, k) => `${r2(Xm(k))},${r2(Yt(v))}`).join(' ')} ${cl.mTmin.map((v, k) => `${r2(Xm(k))},${r2(Yt(v))}`).reverse().join(' ')}" fill="#f4a582" fill-opacity=".35"/>`;
  b += cl.monthly.map((v, k) => `<rect x="${r2(x0 + bw * k + bw * 0.2)}" y="${r2(Yr(v))}" width="${r2(bw * 0.6)}" height="${r2(Yr(0) - Yr(v))}" fill="#4a90d9"/>${T(Xm(k), y0 + ch + 5 * fs, 2.8 * fs, Mn[k], 'text-anchor="middle"')}${T(Xm(k), Yr(v) - 1.2 * fs, 2 * fs, fmt(v), 'text-anchor="middle" fill="#2166ac"')}`).join('');
  b += `<polyline points="${cl.mTemp.map((v, k) => `${r2(Xm(k))},${r2(Yt(v))}`).join(' ')}" fill="none" stroke="#b2182b" stroke-width="${PEN.h}"/><line x1="${r2(x0)}" x2="${r2(x0 + cw)}" y1="${r2(y0 + ch)}" y2="${r2(y0 + ch)}" stroke="#000" stroke-width="${PEN.m}"/>`;
  const st = [['Annual rainfall', `${fmt(cl.annual)} mm`], ['Wet days (≥ 1 mm)', fmt(cl.wetDays)], ['Wettest day', `${fmt(cl.maxDay, 1)} mm`], ['Mean temperature', `${fmt(cl.temp, 1)} °C`], ['Snowfall', `${fmt(cl.snow, 1)} cm`], ['Evapotranspiration', `${fmt(cl.et0)} mm`]];
  st.forEach(([k, v], i) => { const x = x0 + (i % 3) * cw / 3, y = y0 + ch + 18 * fs + Math.floor(i / 3) * 14 * fs; b += T(x, y, 2.4 * fs, k, 'fill="#666"') + T(x, y + 6 * fs, 5 * fs, v, 'font-weight="800"'); });
  return sheet({ ...c, k: 0 }, { title: 'Climate summary', subtitle: `Monthly rainfall (bars, mm) and temperature (line = mean, band = min–max, °C), ${cl.year}.`, body: b, north: false, scaleLabel: null, legend: [{ fill: '#4a90d9', label: 'Rainfall (mm / month)' }, { line: true, stroke: '#b2182b', w: PEN.h, label: 'Mean temperature' }, { fill: '#f4a582', label: 'Min–max temperature' }], notes: ['Climate: Open-Meteo ERA5 reanalysis (≈10–25 km grid) — regional values for the year shown.'] });
}

/** an image sheet (3D render) */
export function imageSheet(c, { title, subtitle, url, iw, ih, legend = [], notes = [] }) {
  const L = c.L, s = Math.min(L.vw / iw, L.vh / ih), w = iw * s, h = ih * s, x = L.vx + (L.vw - w) / 2, y = L.vy + (L.vh - h) / 2;
  return sheet({ ...c, k: 0 }, { title, subtitle, body: `<image x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" href="${url}"/>`, legend, notes, scaleLabel: 'NOT TO SCALE', scaleBar: false });
}
