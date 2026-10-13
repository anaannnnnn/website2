// Section geometry from real data + one renderer used for the live profile and the true-scale sheets.
// Cut = solid black (buildings) / hatched (ground); elevation beyond = white-filled outlines drawn far → near
// (hidden-line by painter's algorithm), pen weight fading with distance; terrain silhouettes behind the cut.
import { D2R, clamp } from './geo.js';
import { esc, fmt, niceStep, r2 } from './util.js';
import { DXF } from './export.js';

const dot = (p, A, v) => (p[0] - A[0]) * v[0] + (p[1] - A[1]) * v[1];
function crossings(rings, A, u, n) {
  const ds = [];
  for (const ring of rings) for (let k = 0; k < ring.length - 1; k++) {
    const P = ring[k], Q = ring[k + 1], sp = dot(P, A, n), sq = dot(Q, A, n);
    if ((sp > 0) === (sq > 0)) continue;
    const t = sp / (sp - sq); ds.push(dot([P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])], A, u));
  }
  return ds.sort((a, b) => a - b);
}
function inside(ds, L) { const out = []; for (let k = 0; k + 1 < ds.length; k += 2) { const a = Math.max(0, ds[k]), b = Math.min(L, ds[k + 1]); if (b > a) out.push([a, b]); } return out; }
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export const compassName = deg => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

export function computeSection(M, sec, depth = 300) {
  const f = M.frame, A = f.toLocal(...sec.a), B = f.toLocal(...sec.b), L = Math.max(1, Math.hypot(B[0] - A[0], B[1] - A[1]));
  const u = [(B[0] - A[0]) / L, (B[1] - A[1]) / L], n = [-u[1], u[0]], zAt = M.zAt;
  const zAlong = s => zAt(A[0] + u[0] * s, A[1] + u[1] * s);
  const N = clamp(Math.round(L / (M.dem.dx / 3)), 200, 1600), profile = [];
  for (let k = 0; k <= N; k++) { const s = L * k / N; profile.push([s, zAlong(s)]); }
  const cuts = [], beyond = [], trees = [], water = [], roads = [];
  for (const b of M.buildings) {
    const base = b.base + (b.minHeight || 0), top = b.base + (b.minHeight || 0) + b.h;
    const iv = inside(crossings(b.loc, A, u, n), L);
    if (iv.length) { for (const [d0, d1] of iv) cuts.push({ d0, d1, base, top, h: b.h, known: b.known, how: b.how, name: b.name, cls: b.cls }); continue; }
    let omin = Infinity, amin = Infinity, amax = -Infinity;
    for (const p of b.loc[0]) { omin = Math.min(omin, dot(p, A, n)); const a = dot(p, A, u); amin = Math.min(amin, a); amax = Math.max(amax, a); }
    if (omin > 0 && omin < depth && amax > 0 && amin < L) beyond.push({ d0: Math.max(0, amin), d1: Math.min(L, amax), base, top, dist: omin, known: b.known });
  }
  for (const t of M.osm.trees) { const ox = dot(t.loc, A, n), ax = dot(t.loc, A, u); if (ax < 0 || ax > L || ox < -4 || ox > depth) continue; trees.push({ d: ax, z: zAt(...t.loc), h: t.h || 8, known: !!t.h, dist: Math.max(0, ox) }); }
  for (const w of M.osm.water) for (const [d0, d1] of inside(crossings([w.loc], A, u, n), L)) water.push({ d0, d1, level: Math.min(zAlong(d0), zAlong(d1)) });
  for (const r of M.osm.roads) for (let k = 0; k < r.loc.length - 1; k++) {
    const P = r.loc[k], Q = r.loc[k + 1], sp = dot(P, A, n), sq = dot(Q, A, n);
    if ((sp > 0) === (sq > 0)) continue;
    const t = sp / (sp - sq), s = dot([P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])], A, u);
    if (s < 0 || s > L || !r.name) continue;
    if (!roads.some(q => q.name === r.name && Math.abs(q.d - s) < 25)) roads.push({ d: s, name: r.name, width: r.width });
  }
  const sil = [];
  for (const d of [20, 50, 100, 170, 260, 380, 520, 700, 900].filter(d => d < depth * 1.05)) {
    const pts = [];
    for (let k = 0; k <= 200; k++) { const s = L * k / 200, x = A[0] + u[0] * s + n[0] * d, y = A[1] + u[1] * s + n[1] * d; pts.push(f.inside(x, y) ? [s, zAt(x, y)] : null); }
    if (pts.filter(Boolean).length > 15) sil.push({ dist: d, pts });
  }
  let zmin = Infinity, zmax = -Infinity;
  for (const p of profile) { zmin = Math.min(zmin, p[1]); zmax = Math.max(zmax, p[1]); }
  for (const c of cuts.concat(beyond)) zmax = Math.max(zmax, c.top);
  for (const t of trees) zmax = Math.max(zmax, t.z + t.h);
  for (const s of sil) for (const p of s.pts) if (p) zmax = Math.max(zmax, p[1]);
  const [nE, nN] = f.frameToEn(n[0], n[1]), view = compassName(Math.atan2(nE, nN) / D2R);
  const [uE, uN] = f.frameToEn(u[0], u[1]), dir = `${compassName(Math.atan2(-uE, -uN) / D2R)} → ${compassName(Math.atan2(uE, uN) / D2R)}`;
  return { sec, A, B, L, u, n, profile, cuts, beyond, trees, water, roads, sil, zmin, zmax, depth, view, dir, zAlong };
}

/**
 * Render a section as an SVG fragment.
 * @param o.k units per metre (horizontal), o.exag vertical factor, o.pen base line weight (units),
 *          o.font text size (units), o.x0,o.y0 top-left, o.zTop,o.zBot vertical extent (m)
 */
export function renderSection(sd, o) {
  const k = o.k, kz = o.k * (o.exag || 1), pen = o.pen, font = o.font, id = o.id || 's';
  const X = s => o.x0 + s * k, Y = z => o.y0 + (o.zTop - z) * kz, Xe = X(sd.L), yG = Y(o.zBot);
  const ink = t => { const g = Math.round(20 + 165 * t); return `rgb(${g},${g},${g})`; }, w = t => r2(pen * (1.6 - 1.2 * t));
  const P = (s, z) => `${r2(X(s))},${r2(Y(z))}`;
  let g = `<defs><clipPath id="clip-${id}"><rect x="${r2(X(0))}" y="${r2(o.y0 - font * 2)}" width="${r2(Xe - X(0))}" height="${r2(yG - o.y0 + font * 2)}"/></clipPath>` +
    `<pattern id="hatch-${id}" patternUnits="userSpaceOnUse" width="${r2(pen * 12)}" height="${r2(pen * 12)}" patternTransform="rotate(45)"><rect width="${r2(pen * 12)}" height="${r2(pen * 12)}" fill="#fff"/><line x1="0" y1="0" x2="0" y2="${r2(pen * 12)}" stroke="#000" stroke-width="${r2(pen * 0.7)}"/></pattern></defs><g clip-path="url(#clip-${id})">`;
  const items = [];
  for (const si of sd.sil) {
    const t = clamp(si.dist / sd.depth, 0, 1); let segs = [], cur = [];
    for (const p of si.pts) { if (p) cur.push(p); else if (cur.length) { segs.push(cur); cur = []; } }
    if (cur.length) segs.push(cur);
    items.push({ dist: si.dist, svg: segs.filter(s => s.length > 2).map(s => { const pl = s.map(p => P(p[0], p[1])).join(' '); return `<polygon points="${pl} ${r2(X(s[s.length - 1][0]))},${r2(yG)} ${r2(X(s[0][0]))},${r2(yG)}" fill="#fff"/><polyline points="${pl}" fill="none" stroke="${ink(t)}" stroke-width="${w(t)}"/>`; }).join('') });
  }
  for (const b of sd.beyond) {
    const t = clamp(b.dist / sd.depth, 0, 1), x = X(b.d0), wd = Math.max(pen, (b.d1 - b.d0) * k), yt = Y(b.top), hh = Math.max(pen, (b.top - b.base) * kz);
    let s = `<rect x="${r2(x)}" y="${r2(yt)}" width="${r2(wd)}" height="${r2(hh + pen * 2)}" fill="#fff" stroke="${ink(t)}" stroke-width="${w(t)}"${b.known ? '' : ` stroke-dasharray="${r2(pen * 6)} ${r2(pen * 3)}"`}/>`;
    items.push({ dist: b.dist, svg: s });
  }
  for (const tr of sd.trees.filter(t => t.dist > 3)) {
    const t = clamp(tr.dist / sd.depth, 0, 1), cx = X(tr.d), r = Math.max(pen * 3, tr.h * 0.3 * k);
    items.push({ dist: tr.dist, svg: `<line x1="${r2(cx)}" y1="${r2(Y(tr.z))}" x2="${r2(cx)}" y2="${r2(Y(tr.z + tr.h * 0.45))}" stroke="${ink(t)}" stroke-width="${w(t)}"/><ellipse cx="${r2(cx)}" cy="${r2(Y(tr.z + tr.h * 0.67))}" rx="${r2(r)}" ry="${r2(tr.h * 0.3 * kz)}" fill="#fff" stroke="${ink(t)}" stroke-width="${w(t)}"/>` });
  }
  g += items.sort((a, b) => b.dist - a.dist).map(i => i.svg).join('');
  const prof = sd.profile.map(p => P(p[0], p[1])).join(' ');
  g += `<polygon points="${prof} ${r2(Xe)},${r2(yG)} ${r2(X(0))},${r2(yG)}" fill="url(#hatch-${id})"/>`;
  for (const wa of sd.water) {
    const seg = sd.profile.filter(p => p[0] >= wa.d0 && p[0] <= wa.d1);
    g += `<polygon points="${P(wa.d0, wa.level)} ${seg.map(p => P(p[0], Math.min(p[1], wa.level))).join(' ')} ${P(wa.d1, wa.level)}" fill="#e3eef6" stroke="#000" stroke-width="${r2(pen * 0.8)}"/>`;
  }
  g += `<polyline points="${prof}" fill="none" stroke="#000" stroke-width="${r2(pen * 2.8)}" stroke-linejoin="round"/>`;
  let last = -1e9;
  for (const c of sd.cuts.slice().sort((a, b) => a.d0 - b.d0)) {
    const x = X(c.d0), wd = Math.max(pen * 1.5, (c.d1 - c.d0) * k);
    g += `<rect x="${r2(x)}" y="${r2(Y(c.top))}" width="${r2(wd)}" height="${r2((c.top - c.base) * kz + pen * 3)}" fill="#000"/>`;
    if (o.labels && wd > font * 1.2 && x + wd / 2 - last > font * 3.6) { last = x + wd / 2; g += `<text x="${r2(x + wd / 2)}" y="${r2(Y(c.top) - font * 0.5)}" font-size="${font}" text-anchor="middle">${c.known ? '' : '~'}${c.h.toFixed(1)}</text>`; }
  }
  for (const tr of sd.trees.filter(t => t.dist <= 3)) { const cx = X(tr.d), r = Math.max(pen * 3, tr.h * 0.3 * k); g += `<line x1="${r2(cx)}" y1="${r2(Y(tr.z))}" x2="${r2(cx)}" y2="${r2(Y(tr.z + tr.h * 0.45))}" stroke="#000" stroke-width="${r2(pen * 1.4)}"/><ellipse cx="${r2(cx)}" cy="${r2(Y(tr.z + tr.h * 0.67))}" rx="${r2(r)}" ry="${r2(tr.h * 0.3 * kz)}" fill="#fff" stroke="#000" stroke-width="${r2(pen * 1.4)}"/>`; }
  if (o.labels) for (const r of sd.roads.filter(r => r.width >= 4)) {
    const x = X(r.d), gy = Y(sd.zAlong(r.d));
    g += `<line x1="${r2(x)}" y1="${r2(o.y0)}" x2="${r2(x)}" y2="${r2(gy)}" stroke="#000" stroke-width="${r2(pen * 0.5)}" stroke-dasharray="${r2(pen * 8)} ${r2(pen * 3)} ${r2(pen * 1.5)} ${r2(pen * 3)}"/><text transform="translate(${r2(x - font * 0.3)},${r2(o.y0 + font * 0.3)}) rotate(90)" font-size="${r2(font * 0.85)}" paint-order="stroke" stroke="#fff" stroke-width="${r2(font * 0.3)}">${esc(String(r.name).slice(0, 34))}</text>`;
  }
  g += '</g>';
  return { svg: g, X, Y, Xe, yG };
}

/** live profile for the map drawer (pixels, auto vertical exaggeration so it stays readable) */
export function profileSVG(sd, W, H) {
  const pad = 28, zTop = sd.zmax + Math.max(3, (sd.zmax - sd.zmin) * 0.08), zBot = sd.zmin - Math.max(4, (sd.zmax - sd.zmin) * 0.15);
  const k = (W - pad - 10) / sd.L, exag = clamp((H - 34) / ((zTop - zBot) * k), 1, 20);
  const r = renderSection(sd, { k, exag, pen: 0.55, font: 10, x0: pad, y0: 8, zTop, zBot, id: 'live', labels: false });
  const zs = niceStep(zTop - zBot, 4); let axis = '';
  for (let z = Math.ceil(zBot / zs) * zs; z <= zTop; z += zs) axis += `<text x="${pad - 4}" y="${r2(r.Y(z) + 3)}" font-size="9" text-anchor="end" fill="#6b7079">${fmt(z)}</text><line x1="${pad}" x2="${r2(r.Xe)}" y1="${r2(r.Y(z))}" y2="${r2(r.Y(z))}" stroke="#000" stroke-opacity=".06"/>`;
  return { svg: `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" font-family="Inter, sans-serif">${axis}${r.svg}<text x="${pad}" y="${H - 4}" font-size="10" fill="#6b7079">0</text><text x="${r2(r.Xe)}" y="${H - 4}" font-size="10" text-anchor="end" fill="#6b7079">${fmt(sd.L)} m</text></svg>`, exag };
}

/* ── CAD export of a section: 1 drawing unit = 1 m, X = distance along the cut line from A,
   Y = real elevation (m). Elevation beyond is clipped against everything nearer (true hidden-line,
   not a painter's overlay), so the linework is clean in CAD. ── */
function pip(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
const bboxOf = poly => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of poly) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); } return [x0, y0, x1, y1]; };
/** parts of segment P→Q that are outside (keep='out') or inside (keep='in') the union of polygons */
function clipSeg(P, Q, occ, keep = 'out') {
  const ts = [0, 1], sx = Q[0] - P[0], sy = Q[1] - P[1];
  const mnx = Math.min(P[0], Q[0]), mxx = Math.max(P[0], Q[0]), mny = Math.min(P[1], Q[1]), mxy = Math.max(P[1], Q[1]);
  const near = occ.filter(o => !(o.bb[0] > mxx || o.bb[2] < mnx || o.bb[1] > mxy || o.bb[3] < mny));
  if (!near.length) return keep === 'out' ? [[P, Q]] : [];
  for (const o of near) {
    const p = o.poly;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const ex = p[i][0] - p[j][0], ey = p[i][1] - p[j][1], den = sx * ey - sy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const wx = p[j][0] - P[0], wy = p[j][1] - P[1], t = (wx * ey - wy * ex) / den, u = (wx * sy - wy * sx) / den;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
    }
  }
  ts.sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k + 1 < ts.length; k++) {
    const a = ts[k], b = ts[k + 1]; if (b - a < 1e-9) continue;
    const m = [P[0] + sx * (a + b) / 2, P[1] + sy * (a + b) / 2], hid = near.some(o => pip(m, o.poly));
    if ((keep === 'out') !== hid) {
      const A = [P[0] + sx * a, P[1] + sy * a], B = [P[0] + sx * b, P[1] + sy * b];
      if (out.length && out[out.length - 1][1][0] === A[0] && out[out.length - 1][1][1] === A[1]) out[out.length - 1][1] = B; else out.push([A, B]);
    }
  }
  return out;
}
/** clip a polyline and emit the visible runs as polylines */
function emitClipped(dx, layer, pts, occ, closed = false, width = 0) {
  const path = closed ? [...pts, pts[0]] : pts;
  let run = null;
  const flush = () => { if (run && run.length > 1) dx.poly2(layer, run, false, width); run = null; };
  for (let k = 0; k + 1 < path.length; k++) {
    for (const [A, B] of clipSeg(path[k], path[k + 1], occ)) {
      if (run && Math.hypot(run[run.length - 1][0] - A[0], run[run.length - 1][1] - A[1]) < 1e-6) run.push(B);
      else { flush(); run = [A, B]; }
    }
  }
  flush();
}

export function sectionDXF(sd, { zBot, zTop, scale = 1000, label = 'A' } = {}) {
  const dx = new DXF(), u = scale / 1000;        // u = 1 mm on paper, in metres
  const tH = 2.2 * u, L = sd.L, n = sd.sec.n || label;
  [['SEC_CUT_GROUND', 7], ['SEC_GROUND_HATCH', 8], ['SEC_CUT_BUILDING', 7], ['SEC_CUT_BUILDING_FILL', 250], ['SEC_BEYOND_NEAR', 251], ['SEC_BEYOND_MID', 252], ['SEC_BEYOND_FAR', 253],
    ['SEC_BEYOND_HEIGHT_UNKNOWN', 30], ['SEC_TERRAIN_BEYOND', 8], ['SEC_TREES', 3], ['SEC_WATER', 5], ['SEC_ROADS', 9], ['SEC_LEVELS', 8], ['SEC_TEXT', 7], ['SEC_MARKERS', 7]].forEach(([l, c]) => dx.layer(l, c));
  const band = d => (d < sd.depth / 3 ? 'SEC_BEYOND_NEAR' : d < sd.depth * 2 / 3 ? 'SEC_BEYOND_MID' : 'SEC_BEYOND_FAR');
  const rect = (x0, x1, b, t) => [[x0, b], [x1, b], [x1, t], [x0, t]];
  const mk = poly => ({ poly, bb: bboxOf(poly) });

  // nearest layer: ground cut and cut buildings
  const ground = [...sd.profile.map(p => [p[0], p[1]]), [L, zBot], [0, zBot]];
  const cutPolys = sd.cuts.map(c => rect(c.d0, Math.max(c.d1, c.d0 + 0.3), c.base, c.top));
  const front = [mk(ground), ...cutPolys.map(mk)];

  // beyond: buildings, trees and terrain silhouettes, near → far, each clipped by everything nearer
  const items = [];
  for (const b of sd.beyond) items.push({ dist: b.dist, poly: rect(b.d0, Math.max(b.d1, b.d0 + 0.3), b.base, b.top), layer: b.known ? band(b.dist) : 'SEC_BEYOND_HEIGHT_UNKNOWN', closed: true });
  for (const si of sd.sil) {
    let cur = [];
    const segs = []; for (const p of si.pts) { if (p) cur.push(p); else if (cur.length) { segs.push(cur); cur = []; } } if (cur.length) segs.push(cur);
    for (const s of segs.filter(s => s.length > 2)) items.push({ dist: si.dist, poly: [...s, [s[s.length - 1][0], zBot], [s[0][0], zBot]], line: s, layer: 'SEC_TERRAIN_BEYOND' });
  }
  for (const tr of sd.trees) {
    const cx = tr.d, cy = tr.z + tr.h * 0.67, rx = Math.max(1, tr.h * 0.3), ry = tr.h * 0.3, canopy = [];
    for (let k = 0; k < 24; k++) { const a = k / 24 * Math.PI * 2; canopy.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
    items.push({ dist: Math.max(0.01, tr.dist), poly: canopy, layer: 'SEC_TREES', closed: true, trunk: [[cx, tr.z], [cx, tr.z + tr.h * 0.45]] });
  }
  items.sort((a, b) => a.dist - b.dist);
  const occ = front.slice();
  for (const it of items) {
    emitClipped(dx, it.layer, it.line || it.poly, occ, !it.line && it.closed);
    if (it.trunk) emitClipped(dx, it.layer, it.trunk, occ);
    occ.push(mk(it.poly));
  }

  // ground: cut line, closing edges, 45° hatch (outside cut buildings)
  const cutOcc = cutPolys.map(mk);
  emitClipped(dx, 'SEC_CUT_GROUND', sd.profile.map(p => [p[0], p[1]]), cutOcc, false, 0.5 * u);
  dx.poly2('SEC_CUT_GROUND', [[L, sd.profile[sd.profile.length - 1][1]], [L, zBot], [0, zBot], [0, sd.profile[0][1]]], false);
  const gp = [mk(ground)], hs = 1.6 * u, zmaxG = Math.max(...sd.profile.map(p => p[1]));
  for (let c = -(zmaxG - zBot); c < L; c += hs) {      // lines z - zBot = s - c
    const P = [c, zBot], Q = [c + (zmaxG - zBot) + 1, zmaxG + 1];
    for (const [A, B] of clipSeg(P, Q, gp, 'in')) for (const [C, D] of clipSeg(A, B, cutOcc)) dx.line('SEC_GROUND_HATCH', C, D);
  }
  // cut buildings: solid fill + outline + height label
  let last = -1e9;
  for (const [i, c] of sd.cuts.entries()) {
    const r = cutPolys[i];
    dx.solid('SEC_CUT_BUILDING_FILL', r[0], r[1], r[2], r[3]);
    dx.poly2('SEC_CUT_BUILDING', r, true);
    const mid = (c.d0 + c.d1) / 2;
    if (c.d1 - c.d0 > tH * 1.2 && mid - last > tH * 3.6) { last = mid; dx.textJ('SEC_TEXT', [mid, c.top + tH * 0.5], tH, `${c.known ? '' : '~'}${c.h.toFixed(1)}`, 1); }
  }
  for (const w of sd.water) dx.line('SEC_WATER', [w.d0, w.level], [w.d1, w.level]);
  for (const r of sd.roads.filter(r => r.width >= 4)) { const g = sd.zAlong(r.d); dx.line('SEC_ROADS', [r.d, g], [r.d, zTop]); if (r.name) dx.textJ('SEC_ROADS', [r.d + tH * 0.4, zTop - tH * 1.5], tH * 0.85, r.name, 0); }
  // levels + section marks + note
  const zs = niceStep(zTop - zBot, 6);
  for (let z = Math.ceil(zBot / zs) * zs; z <= zTop; z += zs) { dx.line('SEC_LEVELS', [0, z], [3 * u, z]); dx.textJ('SEC_LEVELS', [4 * u, z - tH * 0.35], tH * 0.85, (z >= 0 ? '+' : '') + z.toFixed(1), 0); }
  for (const [x, t] of [[0, n], [L, n + "'"]]) { const cy = zTop + 4 * u; dx.circle('SEC_MARKERS', [x, cy], 3 * u); dx.textJ('SEC_MARKERS', [x, cy - 1.1 * u], 3.2 * u, t, 1); dx.line('SEC_MARKERS', [x, cy - 3 * u], [x, zBot]); }
  dx.textJ('SEC_TEXT', [0, zBot - 8 * u], 3.4 * u, `SECTION ${n}-${n}'`, 0);
  dx.textJ('SEC_TEXT', [0, zBot - 12 * u], 2 * u, `${Math.round(L)} m, ${sd.dir}, looking ${sd.view}. Units: metres. X = distance from ${n}, Y = elevation (m). Plot at 1:${scale}: 1 m = ${1000 / scale} mm on paper.`, 0);
  return dx.toString();
}
