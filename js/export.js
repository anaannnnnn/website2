// File writers: GeoTIFF (UTM, rotated frame), ASCII grid, XYZ, 16-bit PNG, DXF, GeoJSON, KML, sheet PDF/PNG.
import { contourPolylines, contourLevels, gridToLocal, isMajor } from './analysis.js';
import { canvasBlob } from './util.js';
import { clamp } from './geo.js';

/* ── GeoTIFF float32 with ModelTransformation in UTM (handles the rotated frame exactly) ── */
export function geoTiff(M, data = M.dem.data) {
  const { W, H, dx, dy } = M.dem, f = M.frame, th = (f.bearing || 0) * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
  // pixel (col,row) → frame (x = -w/2 + col*dx, y = h/2 - row*dy) → UTM: E = E0 + x c + y s, N = N0 - x s + y c
  const E0 = f.E0 + (-f.w / 2) * c + (f.h / 2) * s, N0 = f.N0 - (-f.w / 2) * s + (f.h / 2) * c;
  const mt = [dx * c, -dy * s, 0, E0, -dx * s, -dy * c, 0, N0, 0, 0, 0, 0, 0, 0, 0, 1];
  const entries = [[256, 4, [W]], [257, 4, [H]], [258, 3, [32]], [259, 3, [1]], [262, 3, [1]], [273, 4, [0]], [277, 3, [1]], [278, 4, [H]], [279, 4, [W * H * 4]], [284, 3, [1]], [339, 3, [3]],
    [34264, 12, mt], [34735, 3, [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 2, 3072, 0, 1, f.epsg]], [42113, 2, [...'-9999'].map(ch => ch.charCodeAt(0)).concat(0)]];
  const size = { 2: 1, 3: 2, 4: 4, 12: 8 }, ifd = 2 + entries.length * 12 + 4;
  let extra = 8 + ifd; const off = entries.map(([, t, v]) => { const n = size[t] * v.length; if (n <= 4) return null; const o = extra; extra += n + (n % 2); return o; });
  const img = Math.ceil(extra / 4) * 4, buf = new ArrayBuffer(img + W * H * 4), dv = new DataView(buf);
  dv.setUint16(0, 0x4949); dv.setUint16(2, 42, true); dv.setUint32(4, 8, true); dv.setUint16(8, entries.length, true);
  const put = (o, t, v) => v.forEach((x, i) => t === 2 ? dv.setUint8(o + i, x) : t === 3 ? dv.setUint16(o + i * 2, x, true) : t === 4 ? dv.setUint32(o + i * 4, x, true) : dv.setFloat64(o + i * 8, x, true));
  entries.forEach(([tag, t, v], k) => { if (tag === 273) v = [img]; const e = 10 + k * 12; dv.setUint16(e, tag, true); dv.setUint16(e + 2, t, true); dv.setUint32(e + 4, v.length, true); if (off[k] == null) put(e + 8, t, v); else { dv.setUint32(e + 8, off[k], true); put(off[k], t, v); } });
  dv.setUint32(10 + entries.length * 12, 0, true);
  new Float32Array(buf, img, W * H).set(data);
  return new Blob([buf], { type: 'image/tiff' });
}
export function ascGrid(M) {
  const { W, H, dx, data } = M.dem, f = M.frame;
  const lines = [`ncols ${W}`, `nrows ${H}`, `xllcorner ${(-f.w / 2 - dx / 2).toFixed(3)}`, `yllcorner ${(-f.h / 2 - M.dem.dy / 2).toFixed(3)}`, `dx ${dx.toFixed(4)}`, `dy ${M.dem.dy.toFixed(4)}`, 'NODATA_value -9999'];
  for (let j = 0; j < H; j++) lines.push(Array.from(data.subarray(j * W, (j + 1) * W), v => v.toFixed(2)).join(' '));
  return lines.join('\n');
}
export function xyzCSV(M) {
  const { W, H, dx, dy, data } = M.dem, f = M.frame, out = ['x_site_m,y_site_m,easting_utm,northing_utm,lon,lat,elevation_m'];
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const x = -f.w / 2 + i * dx, y = f.h / 2 - j * dy, [E, N] = f.toUTM(x, y), [lon, lat] = f.toLonLat(x, y);
    out.push(`${x.toFixed(2)},${y.toFixed(2)},${E.toFixed(2)},${N.toFixed(2)},${lon.toFixed(7)},${lat.toFixed(7)},${data[j * W + i].toFixed(2)}`);
  }
  return out.join('\n');
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = u8 => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export async function png16(M) {
  const { W, H, data, min, max } = M.dem, raw = new Uint8Array(H * (1 + W * 2)), span = (max - min) || 1;
  for (let j = 0; j < H; j++) { const r = j * (1 + W * 2); for (let i = 0; i < W; i++) { const v = Math.round(clamp((data[j * W + i] - min) / span, 0, 1) * 65535); raw[r + 1 + i * 2] = v >> 8; raw[r + 2 + i * 2] = v & 255; } }
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const chunk = (type, body) => { const o = new Uint8Array(12 + body.length), dv = new DataView(o.buffer); dv.setUint32(0, body.length); for (let i = 0; i < 4; i++) o[4 + i] = type.charCodeAt(i); o.set(body, 8); dv.setUint32(8 + body.length, crc32(o.subarray(4, 8 + body.length))); return o; };
  const ih = new Uint8Array(13), dv = new DataView(ih.buffer); dv.setUint32(0, W); dv.setUint32(4, H); ih[8] = 16;
  return new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))], { type: 'image/png' });
}

/* ── DXF (R12 ASCII: opens in AutoCAD, Rhino, SketchUp, Revit, ArchiCAD, QGIS, Blender) ── */
// R12 text is not Unicode: map common symbols to ASCII and escape the rest as \U+XXXX (read by AutoCAD, BricsCAD, Rhino)
const dxfText = s => String(s).replace(/[\r\n]/g, ' ').replace(/→/g, 'to').replace(/[′’‘]/g, "'").replace(/[–—]/g, '-').replace(/[“”]/g, '"').replace(/×/g, 'x').replace(/·/g, '-').replace(/°/g, '%%d')
  .replace(/[^\x20-\x7e]/gu, ch => '\\U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'));
export class DXF {
  constructor() { this.layers = new Map(); this.e = []; }
  layer(n, c) { this.layers.set(n, c); }
  n(v) { return (Math.round(v * 1000) / 1000).toString(); }
  poly(layer, pts, closed) { const e = this.e; e.push('0', 'POLYLINE', '8', layer, '66', '1', '10', '0', '20', '0', '30', '0', '70', closed ? '9' : '8'); for (const p of pts) e.push('0', 'VERTEX', '8', layer, '10', this.n(p[0]), '20', this.n(p[1]), '30', this.n(p[2] || 0), '70', '32'); e.push('0', 'SEQEND', '8', layer); }
  face(layer, a, b, c, d = c) { const e = this.e; e.push('0', '3DFACE', '8', layer); [a, b, c, d].forEach((p, i) => e.push('1' + i, this.n(p[0]), '2' + i, this.n(p[1]), '3' + i, this.n(p[2]))); }
  /** 2D polyline (flat drawings such as sections) */
  poly2(layer, pts, closed, width = 0) { const e = this.e; e.push('0', 'POLYLINE', '8', layer, '66', '1', '10', '0', '20', '0', '30', '0', '70', closed ? '1' : '0'); if (width) e.push('40', this.n(width), '41', this.n(width)); for (const p of pts) e.push('0', 'VERTEX', '8', layer, '10', this.n(p[0]), '20', this.n(p[1]), '30', '0'); e.push('0', 'SEQEND', '8', layer); }
  line(layer, a, b) { this.e.push('0', 'LINE', '8', layer, '10', this.n(a[0]), '20', this.n(a[1]), '30', '0', '11', this.n(b[0]), '21', this.n(b[1]), '31', '0'); }
  /** filled quad (R12 SOLID; vertex order a, b, d, c as the format requires) */
  solid(layer, a, b, c, d) { this.e.push('0', 'SOLID', '8', layer); [a, b, d, c].forEach((p, i) => this.e.push('1' + i, this.n(p[0]), '2' + i, this.n(p[1]), '3' + i, '0')); }
  /** text with horizontal justification: 0 left, 1 centre, 2 right */
  textJ(layer, p, h, s, j = 0) { this.e.push('0', 'TEXT', '8', layer, '10', this.n(p[0]), '20', this.n(p[1]), '30', '0', '40', this.n(h), '1', dxfText(s), '72', String(j), '11', this.n(p[0]), '21', this.n(p[1]), '31', '0'); }
  circle(layer, p, r) { this.e.push('0', 'CIRCLE', '8', layer, '10', this.n(p[0]), '20', this.n(p[1]), '30', this.n(p[2] || 0), '40', this.n(r)); }
  text(layer, p, h, s) { this.e.push('0', 'TEXT', '8', layer, '10', this.n(p[0]), '20', this.n(p[1]), '30', this.n(p[2] || 0), '40', this.n(h), '1', dxfText(s)); }
  toString() {
    const out = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '0', 'ENDSEC', '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', String(this.layers.size)];
    for (const [n, c] of this.layers) out.push('0', 'LAYER', '2', n, '70', '0', '62', String(c), '6', 'CONTINUOUS');
    out.push('0', 'ENDTAB', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES');
    return out.join('\n') + '\n' + this.e.join('\n') + '\n0\nENDSEC\n0\nEOF\n';
  }
}
export function contourLines(M, iv) {
  const g2l = gridToLocal(M.dem, M.frame);
  return contourPolylines(M.smooth, M.dem.W, M.dem.H, contourLevels(M.dem.min, M.dem.max, iv)).map(l => ({ v: l.v, major: isMajor(l.v, iv), pts: l.pts.map(g2l) }));
}
/** coordinate mode: 'site' = frame-aligned metres (origin at frame centre), 'utm' = real-world UTM metres */
export function siteDXF(M, iv, mode = 'site') {
  const f = M.frame, T = mode === 'utm' ? (x, y) => f.toUTM(x, y) : (x, y) => [x, y], dx = new DXF();
  [['TERRAIN', 33], ['CONTOURS_MINOR', 8], ['CONTOURS_MAJOR', 1], ['BUILDINGS_FOOTPRINT', 7], ['BUILDINGS_3D', 9], ['BUILDINGS_HEIGHT_UNKNOWN', 30], ['ROADS', 2], ['RAILWAYS', 250], ['WATER', 5], ['GREEN', 3], ['TREES', 94], ['FRAME', 6], ['LABELS', 7]].forEach(l => dx.layer(...l));
  const d = M.dem, step = Math.max(1, Math.ceil(Math.max(d.W, d.H) / 180));
  const P = (i, j) => { i = Math.min(i, d.W - 1); j = Math.min(j, d.H - 1); return [...T(-f.w / 2 + i * d.dx, f.h / 2 - j * d.dy), M.smooth[j * d.W + i]]; };
  for (let j = 0; j < d.H - 1; j += step) for (let i = 0; i < d.W - 1; i += step) dx.face('TERRAIN', P(i, j), P(i + step, j), P(i + step, j + step), P(i, j + step));
  for (const c of contourLines(M, iv)) dx.poly(c.major ? 'CONTOURS_MAJOR' : 'CONTOURS_MINOR', c.pts.map(p => [...T(...p), c.v]), false);
  for (const b of M.buildings.filter(q => q.inFrame)) {
    const z0 = b.base, z1 = b.base + b.h, ring = b.loc[0].slice(0, -1);
    dx.poly('BUILDINGS_FOOTPRINT', ring.map(p => [...T(...p), z0]), true);
    const lay = b.known ? 'BUILDINGS_3D' : 'BUILDINGS_HEIGHT_UNKNOWN';
    for (let k = 0; k < ring.length; k++) { const a = ring[k], q = ring[(k + 1) % ring.length]; dx.face(lay, [...T(...a), z0], [...T(...q), z0], [...T(...q), z1], [...T(...a), z1]); }
    for (const t of THREE_triangulate(ring)) dx.face(lay, [...T(...ring[t[0]]), z1], [...T(...ring[t[1]]), z1], [...T(...ring[t[2]]), z1]);
  }
  const drape = p => [...T(...p), M.zAt(...p)];
  for (const r of M.osm.roads) dx.poly('ROADS', r.loc.map(drape), false);
  for (const r of M.osm.rails) dx.poly('RAILWAYS', r.loc.map(drape), false);
  for (const w of M.osm.water) dx.poly('WATER', w.loc.slice(0, -1).map(drape), true);
  for (const g of M.osm.green) dx.poly('GREEN', g.loc.slice(0, -1).map(drape), true);
  for (const t of M.osm.trees) dx.circle('TREES', drape(t.loc), (t.h || 8) * 0.3);
  dx.poly('FRAME', [[-f.w / 2, -f.h / 2], [f.w / 2, -f.h / 2], [f.w / 2, f.h / 2], [-f.w / 2, f.h / 2]].map(p => [...T(...p), M.dem.min]), true);
  return dx.toString();
}
/* clip to the frame rectangle (frame-local metres): polylines → visible runs, polygons → Sutherland–Hodgman */
function clipLineRect(pts, X, Y) {
  const out = []; let run = null;
  for (let k = 0; k + 1 < pts.length; k++) {
    let [x0, y0] = pts[k], [x1, y1] = pts[k + 1], t0 = 0, t1 = 1; const dx = x1 - x0, dy = y1 - y0;
    const ok = [[-dx, x0 + X], [dx, X - x0], [-dy, y0 + Y], [dy, Y - y0]].every(([p, q]) => { if (p === 0) return q >= 0; const r = q / p; if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; } return true; });
    if (!ok) { if (run) out.push(run); run = null; continue; }
    const A = [x0 + t0 * dx, y0 + t0 * dy], B = [x0 + t1 * dx, y0 + t1 * dy];
    if (run && t0 === 0) run.push(B); else { if (run) out.push(run); run = [A, B]; }
    if (t1 < 1) { out.push(run); run = null; }
  }
  if (run) out.push(run);
  return out;
}
function clipPolyRect(ring, X, Y) {
  let poly = ring.slice(0, -1);
  for (const [ax, sgn] of [[0, 1], [0, -1], [1, 1], [1, -1]]) {
    const lim = ax ? Y : X, inn = p => sgn * p[ax] <= lim, out = [];
    for (let i = 0; i < poly.length; i++) {
      const P = poly[i], Q = poly[(i + 1) % poly.length];
      if (inn(P)) out.push(P);
      if (inn(P) !== inn(Q)) { const t = (sgn * lim - P[ax]) / (Q[ax] - P[ax]); out.push([P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])]); }
    }
    poly = out; if (!poly.length) break;
  }
  return poly;
}
/** flat 2D site plan for drafting over: footprints, contours with labels, streets, water, green, land use,
    trees, section lines, north arrow. 1 unit = 1 m; 'site' = frame-aligned, 'utm' = real UTM coordinates. */
export function sitePlanDXF(M, iv, sections = [], scale = 1000, mode = 'site') {
  const f = M.frame, T = mode === 'utm' ? (x, y) => f.toUTM(x, y) : (x, y) => [x, y], dx = new DXF(), u = scale / 1000, tH = 2 * u;
  [['FRAME', 7], ['CONTOURS_MINOR', 8], ['CONTOURS_MAJOR', 1], ['CONTOUR_LABELS', 1], ['BUILDINGS', 7], ['BUILDINGS_HEIGHT_UNKNOWN', 30], ['BUILDING_HEIGHTS', 7], ['ROADS', 2], ['ROAD_NAMES', 2],
    ['RAILWAYS', 250], ['WATER', 5], ['WATERWAYS', 5], ['GREEN', 3], ['LANDUSE', 9], ['TREES', 3], ['SECTION_LINES', 6], ['NORTH', 7]].forEach(([l, c]) => dx.layer(l, c));
  const P = p => T(p[0], p[1]);
  dx.poly2('FRAME', [[-f.w / 2, -f.h / 2], [f.w / 2, -f.h / 2], [f.w / 2, f.h / 2], [-f.w / 2, f.h / 2]].map(P), true);
  for (const c of contourLines(M, iv)) {
    dx.poly2(c.major ? 'CONTOURS_MAJOR' : 'CONTOURS_MINOR', c.pts.map(P), false);
    if (c.major && c.pts.length > 10) dx.textJ('CONTOUR_LABELS', P(c.pts[Math.floor(c.pts.length / 2)]), tH * 0.9, c.v.toFixed(c.v % 1 ? 1 : 0), 1);
  }
  for (const b of M.buildings.filter(q => q.inFrame)) {
    for (const ring of b.loc) dx.poly2(b.known ? 'BUILDINGS' : 'BUILDINGS_HEIGHT_UNKNOWN', ring.slice(0, -1).map(P), true);
    let cx = 0, cy = 0; const r0 = b.loc[0].slice(0, -1); for (const p of r0) { cx += p[0]; cy += p[1]; }
    dx.textJ('BUILDING_HEIGHTS', P([cx / r0.length, cy / r0.length]), tH * 0.7, `${b.known ? '' : '~'}${b.h.toFixed(1)}`, 1);
  }
  const X = f.w / 2, Y = f.h / 2, lines = (lay, l) => clipLineRect(l, X, Y).forEach(r => dx.poly2(lay, r.map(P), false)), polys = (lay, ring) => { const q = clipPolyRect(ring, X, Y); if (q.length > 2) dx.poly2(lay, q.map(P), true); };
  const named = new Set();
  for (const r of M.osm.roads) {
    const runs = clipLineRect(r.loc, X, Y); runs.forEach(q => dx.poly2('ROADS', q.map(P), false));
    const lng = runs.sort((a, b) => b.length - a.length)[0];
    if (r.name && lng && !named.has(r.name)) { named.add(r.name); dx.textJ('ROAD_NAMES', P(lng[Math.floor(lng.length / 2)]), tH, r.name, 1); }
  }
  for (const r of M.osm.rails) lines('RAILWAYS', r.loc);
  for (const w of M.osm.water) polys('WATER', w.loc);
  for (const w of M.osm.waterways) lines('WATERWAYS', w.loc);
  for (const g of M.osm.green) polys('GREEN', g.loc);
  for (const g of M.osm.landuse) polys('LANDUSE', g.loc);
  for (const t of M.osm.trees) if (f.inside(t.loc[0], t.loc[1])) dx.circle('TREES', P(t.loc), (t.h || 8) * 0.3);
  for (const sec of sections) {
    const A = f.toLocal(...sec.a), B = f.toLocal(...sec.b);
    dx.poly2('SECTION_LINES', [P(A), P(B)], false);
    for (const [p, t] of [[A, sec.n], [B, sec.n + "'"]]) { dx.circle('SECTION_LINES', P(p), 3 * u); dx.textJ('SECTION_LINES', P([p[0], p[1] - 1.1 * u]), 3 * u, t, 1); }
  }
  // north arrow in the top-right corner
  const nv = f.enToFrame(0, 1), o = [f.w / 2 - 15 * u, f.h / 2 - 20 * u], tip = [o[0] + nv[0] * 10 * u, o[1] + nv[1] * 10 * u], side = [-nv[1], nv[0]];
  dx.poly2('NORTH', [P([o[0] + side[0] * 3 * u, o[1] + side[1] * 3 * u]), P(tip), P([o[0] - side[0] * 3 * u, o[1] - side[1] * 3 * u]), P(o)], true);
  dx.textJ('NORTH', P([tip[0] + nv[0] * 2 * u, tip[1] + nv[1] * 2 * u]), 3 * u, 'N', 1);
  dx.textJ('FRAME', P([-f.w / 2, -f.h / 2 - 6 * u]), tH, `Units: metres. ${mode === 'utm' ? `UTM zone ${f.zone}${f.south ? 'S' : 'N'} (EPSG:${f.epsg})` : 'Site-aligned: origin at frame centre, Y = frame up'}. Heights in m; ~ = not recorded (default used).`, 0);
  return dx.toString();
}
let THREE_triangulate = ring => { const r = []; for (let i = 1; i < ring.length - 1; i++) r.push([0, i, i + 1]); return r; };
export function useTriangulator(fn) { THREE_triangulate = fn; }

export function contoursDXF(M, iv, mode = 'site') {
  const f = M.frame, T = mode === 'utm' ? (x, y) => f.toUTM(x, y) : (x, y) => [x, y], dx = new DXF();
  dx.layer('CONTOURS_MINOR', 8); dx.layer('CONTOURS_MAJOR', 1);
  for (const c of contourLines(M, iv)) dx.poly(c.major ? 'CONTOURS_MAJOR' : 'CONTOURS_MINOR', c.pts.map(p => [...T(...p), c.v]), false);
  return dx.toString();
}
export function contoursGeoJSON(M, iv) {
  const f = M.frame;
  return JSON.stringify({ type: 'FeatureCollection', features: contourLines(M, iv).map(c => ({ type: 'Feature', properties: { elevation: c.v, type: c.major ? 'major' : 'minor' }, geometry: { type: 'LineString', coordinates: c.pts.map(p => { const [lo, la] = f.toLonLat(...p); return [+lo.toFixed(7), +la.toFixed(7), c.v]; }) } })) });
}
export function contoursKML(M, iv) {
  const f = M.frame;
  const pm = contourLines(M, iv).map(c => `<Placemark><name>${c.v} m</name><LineString><altitudeMode>absolute</altitudeMode><coordinates>${c.pts.map(p => { const [lo, la] = f.toLonLat(...p); return `${lo.toFixed(7)},${la.toFixed(7)},${c.v}`; }).join(' ')}</coordinates></LineString></Placemark>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Contours</name>${pm}</Document></kml>`;
}
export function featuresGeoJSON(M) {
  const F = [];
  for (const b of M.buildings) F.push({ type: 'Feature', properties: { layer: 'building', height_m: +b.h.toFixed(2), height_source: b.known ? b.how : 'unknown (default used)', base_elevation_m: +b.base.toFixed(2), name: b.name || null, class: b.cls || null, source: b.src }, geometry: { type: 'Polygon', coordinates: b.rings } });
  for (const r of M.osm.roads) F.push({ type: 'Feature', properties: { layer: 'road', ...r.tags }, geometry: { type: 'LineString', coordinates: r.pts } });
  for (const r of M.osm.rails) F.push({ type: 'Feature', properties: { layer: 'railway', ...r.tags }, geometry: { type: 'LineString', coordinates: r.pts } });
  for (const w of M.osm.water) F.push({ type: 'Feature', properties: { layer: 'water', ...w.tags }, geometry: { type: 'Polygon', coordinates: [w.ring] } });
  for (const g of M.osm.green) F.push({ type: 'Feature', properties: { layer: 'green', ...g.tags }, geometry: { type: 'Polygon', coordinates: [g.ring] } });
  for (const g of M.osm.landuse) F.push({ type: 'Feature', properties: { layer: 'landuse', ...g.tags }, geometry: { type: 'Polygon', coordinates: [g.ring] } });
  for (const t of M.osm.trees) F.push({ type: 'Feature', properties: { layer: 'tree', ...t.tags }, geometry: { type: 'Point', coordinates: [t.lon, t.lat] } });
  return JSON.stringify({ type: 'FeatureCollection', features: F });
}
export function readme(M) {
  const f = M.frame;
  return `TerraKit export — ${new Date().toISOString()}
Site: ${M.site ? M.site.name : ''}  (${f.lat.toFixed(6)}, ${f.lon.toFixed(6)})
Frame: ${f.w} m × ${f.h} m, rotated ${f.bearing}° from north (frame "up" bearing).
Coordinate systems
- "site" files (DXF *_site.dxf, ASC, OBJ/STL/GLB): metres on the UTM grid, rotated so x runs along the frame width and y along its height, origin at the frame centre.
- "utm" files (*_utm.dxf): real UTM ${f.zone}${f.south ? 'S' : 'N'} coordinates, EPSG:${f.epsg}.
- GeoTIFF: EPSG:${f.epsg} with a rotation matrix (ModelTransformationTag) — opens correctly in QGIS/ArcGIS/GDAL.
- Frame centre in UTM: E ${f.E0.toFixed(3)}  N ${f.N0.toFixed(3)}.
Elevations are metres above sea level (EGM96-based terrain tiles).

Data sources and reliability
- Terrain: ${M.terrain.name} via AWS Terrain Tiles; ${M.terrain.res}, ${M.terrain.acc}.
- Buildings: ${M.bsource}${M.release ? ' release ' + M.release : ''}. Each building carries height_source: "recorded height", "floors × 3.5 m" or "unknown (default used)". Unknown heights are on separate CAD layers.
- Streets, water, land use, trees, places: © OpenStreetMap contributors, ODbL 1.0 (attribution required; share-alike for derived databases).
- Climate: Open-Meteo ERA5 reanalysis (CC-BY 4.0), regional ≈10–25 km.
Nothing in these files is invented: missing data is reported, not filled.
`;
}

/* ── sheets → PDF / PNG ── */
let pdfLib = null;
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('could not load ' + src)); document.head.appendChild(s); }); }
async function pdfLibs() {
  if (!pdfLib) { await loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js'); await loadScript('https://cdn.jsdelivr.net/npm/svg2pdf.js@2.2.3/dist/svg2pdf.umd.min.js'); pdfLib = window.jspdf.jsPDF; }
  return pdfLib;
}
const sizeOf = svg => { const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/); return [+m[1], +m[2]]; };
async function addSvgPage(doc, svg, first) {
  const [w, h] = sizeOf(svg);
  if (!first) doc.addPage([w, h], w > h ? 'landscape' : 'portrait');
  const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:-99999px;top:0;width:10px;height:10px;overflow:hidden';
  host.innerHTML = svg; document.body.appendChild(host);
  try { await doc.svg(host.firstElementChild, { x: 0, y: 0, width: w, height: h }); } finally { host.remove(); }
}
export async function sheetsToPDF(svgs) {
  const jsPDF = await pdfLibs(), [w, h] = sizeOf(svgs[0]);
  const doc = new jsPDF({ unit: 'mm', format: [w, h], orientation: w > h ? 'landscape' : 'portrait', compress: true });
  for (let i = 0; i < svgs.length; i++) await addSvgPage(doc, svgs[i], i === 0);
  return doc.output('blob');
}
/* ── high-resolution PNG: the SVG is rasterised in horizontal strips (each strip re-renders the vector
   drawing through its own viewBox, so lines stay crisp) and streamed into a PNG with the browser's
   native deflate. No canvas-size ceiling; the file carries its DPI so it prints at true scale. ── */
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function pngChunk(type, data) {
  const head = new Uint8Array(8), dv = new DataView(head.buffer), tail = new Uint8Array(4);
  dv.setUint32(0, data.length); for (let i = 0; i < 4; i++) head[4 + i] = type.charCodeAt(i);
  let c = 0xffffffff;
  for (let i = 4; i < 8; i++) c = CRC_T[(c ^ head[i]) & 255] ^ (c >>> 8);
  for (let i = 0; i < data.length; i++) c = CRC_T[(c ^ data[i]) & 255] ^ (c >>> 8);
  new DataView(tail.buffer).setUint32(0, (c ^ 0xffffffff) >>> 0);
  return [head, data, tail];
}
const loadSVG = svg => new Promise((res, rej) => {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), img = new Image();
  img.onload = () => { URL.revokeObjectURL(url); res(img); };
  img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('render failed')); };
  img.src = url;
});
/** px size of a PNG render: region in drawing mm (default whole sheet), at dpi or a fixed pixel width */
export function pngSize(svg, { dpi = 300, region = null, width = null } = {}) {
  const [sw, sh] = sizeOf(svg), r = region || { x: 0, y: 0, w: sw, h: sh }, ppmm = width ? width / r.w : dpi / 25.4;
  return { W: Math.round(r.w * ppmm), H: Math.round(r.h * ppmm), ppmm, r, dpi: ppmm * 25.4 };
}
export async function renderPNG(svg, opts = {}, onProgress) {
  const { W, H, ppmm, r } = pngSize(svg, opts);
  if (W > 32000 || H > 32000) throw new Error('image too large');
  const rows = Math.max(1, Math.min(2048, Math.floor(6e6 / W)));
  const strip = (y0, n) => svg.replace(/<svg\b[^>]*>/, m => m.replace(/\swidth="[^"]*"/, ` width="${W}"`).replace(/\sheight="[^"]*"/, ` height="${n}"`)
    .replace(/\sviewBox="[^"]*"/, ` viewBox="${r.x} ${r.y + y0 / ppmm} ${r.w} ${n / ppmm}" preserveAspectRatio="none"`));
  const cv = document.createElement('canvas'); cv.width = W;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (typeof CompressionStream === 'undefined') {   // old browsers: single canvas, size-capped
    const k = Math.min(1, 16000 / Math.max(W, H), Math.sqrt(2.5e8 / (W * H))), w = Math.round(W * k), h = Math.round(H * k);
    cv.width = w; cv.height = h; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(await loadSVG(strip(0, H).replace(/\swidth="\d+"/, ` width="${w}"`).replace(/\sheight="\d+"/, ` height="${h}"`)), 0, 0, w, h);
    return canvasBlob(cv);
  }
  const cs = new CompressionStream('deflate'), wr = cs.writable.getWriter(), zipped = new Response(cs.readable).arrayBuffer();
  for (let y0 = 0; y0 < H; y0 += rows) {
    const n = Math.min(rows, H - y0);
    cv.height = n; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, n);
    ctx.drawImage(await loadSVG(strip(y0, n)), 0, 0, W, n);
    const px = ctx.getImageData(0, 0, W, n).data, line = 1 + W * 3, buf = new Uint8Array(n * line);
    for (let j = 0; j < n; j++) {               // filter 1 (Sub) on RGB rows
      const o = j * line, p = j * W * 4; buf[o] = 1;
      for (let i = 0; i < W; i++) for (let c = 0; c < 3; c++) buf[o + 1 + i * 3 + c] = px[p + i * 4 + c] - (i ? px[p + (i - 1) * 4 + c] : 0);
    }
    await wr.write(buf);
    onProgress && onProgress(Math.min(1, (y0 + n) / H));
  }
  await wr.close();
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer); dv.setUint32(0, W); dv.setUint32(4, H); ihdr.set([8, 2, 0, 0, 0], 8);
  const phys = new Uint8Array(9), dp = new DataView(phys.buffer), ppm = Math.round(ppmm * 1000); dp.setUint32(0, ppm); dp.setUint32(4, ppm); phys[8] = 1;
  return new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ...pngChunk('IHDR', ihdr), ...pngChunk('pHYs', phys), ...pngChunk('IDAT', new Uint8Array(await zipped)), ...pngChunk('IEND', new Uint8Array(0))], { type: 'image/png' });
}
export const svgToPNG = (svg, dpi = 300) => renderPNG(svg, { dpi });
