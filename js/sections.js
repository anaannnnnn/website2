// Section geometry from real data + one renderer used for the live profile and the true-scale sheets.
// Cut = solid black (buildings) / hatched (ground); elevation beyond = white-filled outlines drawn far → near
// (hidden-line by painter's algorithm), pen weight fading with distance; terrain silhouettes behind the cut.
import { D2R, clamp } from './geo.js';
import { esc, fmt, niceStep, r2 } from './util.js';

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
