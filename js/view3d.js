// 3D site model (three.js): clay / analysis surfaces, contour-layer model, blocks; real footprints with courtyards.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bilinear, clamp, latToY, lonToX, sunPosition } from './geo.js';
import { lut, percentiles, contourLevels, CMAPS } from './analysis.js';
import { fetchMosaic } from './data/dem.js';
import { buildContext } from './context3d.js';

export const triangulate = ring => THREE.ShapeUtils.triangulateShape(ring.map(p => new THREE.Vector2(p[0], p[1])), []);

/* closed terrain solid in frame metres (x east-ish along frame, y up = elevation, z = -frame y) */
function terrainSolid(M, exag, base) {
  const d = M.dem, f = M.frame, step = Math.max(1, Math.ceil(Math.max(d.W, d.H) / 600)), W = Math.floor((d.W - 1) / step) + 1, H = Math.floor((d.H - 1) / step) + 1;
  const sx = f.w / (W - 1), sz = f.h / (H - 1), hAt = (i, j) => (M.smooth[Math.min(j * step, d.H - 1) * d.W + Math.min(i * step, d.W - 1)] - d.min) * exag;
  const pos = [], uv = [], idx = [];
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { pos.push(-f.w / 2 + i * sx, hAt(i, j), -f.h / 2 + j * sz); uv.push(i / (W - 1), 1 - j / (H - 1)); }
  for (let j = 0; j < H - 1; j++) for (let i = 0; i < W - 1; i++) { const a = j * W + i, b = a + 1, c = a + W, e = c + 1; idx.push(a, c, b, b, c, e); }
  const top = idx.length;
  if (base > 0) {
    const per = []; for (let i = 0; i < W - 1; i++) per.push([i, 0]); for (let j = 0; j < H - 1; j++) per.push([W - 1, j]); for (let i = W - 1; i > 0; i--) per.push([i, H - 1]); for (let j = H - 1; j > 0; j--) per.push([0, j]);
    const s0 = pos.length / 3, n = per.length;
    for (const [i, j] of per) { pos.push(-f.w / 2 + i * sx, hAt(i, j), -f.h / 2 + j * sz, -f.w / 2 + i * sx, -base, -f.h / 2 + j * sz); uv.push(0, 0, 0, 0); }
    for (let k = 0; k < n; k++) { const pT = s0 + 2 * k, pB = pT + 1, qT = s0 + 2 * ((k + 1) % n), qB = qT + 1; idx.push(pT, qT, qB, pT, qB, pB); }
    const cc = pos.length / 3; pos.push(0, -base, 0); uv.push(0, 0);
    for (let k = 0; k < n; k++) idx.push(cc, s0 + 2 * k + 1, s0 + 2 * ((k + 1) % n) + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  g.addGroup(0, top, 0); if (idx.length > top) g.addGroup(top, idx.length - top, 1);
  g.computeVertexNormals();
  return g;
}
/* stacked contour layers, exactly like the laser-cut model */
function contourLayers(M, exag, iv, base) {
  const d = M.dem, f = M.frame, levels = contourLevels(d.min, d.max, iv), geos = [];
  geos.push(new THREE.BoxGeometry(f.w, Math.max(0.01, base + (levels[0] - d.min) * exag), f.h).translate(0, (-base + (levels[0] - d.min) * exag) / 2, 0));
  const toLocal = (gx, gy) => [-f.w / 2 + clamp(gx - 0.5, 0, d.W - 1) * d.dx, f.h / 2 - clamp(gy - 0.5, 0, d.H - 1) * d.dy];
  for (const c of d3.contours().size([d.W, d.H]).thresholds(levels)(M.smooth)) {
    for (const poly of c.coordinates) {
      const sh = new THREE.Shape(poly[0].map(p => new THREE.Vector2(...toLocal(...p))));
      for (const hole of poly.slice(1)) sh.holes.push(new THREE.Path(hole.map(p => new THREE.Vector2(...toLocal(...p)))));
      const g = new THREE.ExtrudeGeometry(sh, { depth: iv * exag, bevelEnabled: false, curveSegments: 1 });
      g.rotateX(-Math.PI / 2); g.translate(0, (c.value - d.min) * exag, 0); geos.push(g.toNonIndexed());
    }
  }
  return mergeGeometries(geos.map(g => { g.deleteAttribute('uv'); if (g.index) g = g.toNonIndexed(); return g; }));
}
function blocks(M, exag, base, cols) {
  const f = M.frame, d = M.dem, cs = Math.max(f.w, f.h) / cols, BW = Math.round(f.w / cs), BH = Math.round(f.h / cs), cw = f.w / BW, ch = f.h / BH, geos = [];
  for (let j = 0; j < BH; j++) for (let i = 0; i < BW; i++) {
    const x = -f.w / 2 + (i + 0.5) * cw, y = f.h / 2 - (j + 0.5) * ch, top = Math.max(0.05, (M.zAt(x, y) - d.min) * exag);
    geos.push(new THREE.BoxGeometry(cw * 0.94, top + base, ch * 0.94).translate(x, (top - base) / 2, -y));
  }
  return mergeGeometries(geos);
}
export function buildingGeometry(M, exag, onlyKnown = null) {
  return buildingModelGeometry(M, exag, onlyKnown).walls;
}
const roofColor = (value, fallback) => { try { return new THREE.Color(value || fallback); } catch { return new THREE.Color(fallback); } };
function addVertexColor(g, color) {
  const c = color.isColor ? color : roofColor(color, '#ffffff'), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.Float32BufferAttribute(a, 3));
  g.deleteAttribute('uv');
  return g;
}
function convex(ring) {
  let sign = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], c = ring[(i + 2) % ring.length];
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(z) < 1e-6) continue;
    const s = Math.sign(z); if (sign && s !== sign) return false; sign = s;
  }
  return !!sign;
}
function roofAxis(points, b, frame) {
  if (Number.isFinite(b.roofDirection)) {
    const r = b.roofDirection * Math.PI / 180, v = frame.enToFrame(Math.sin(r), Math.cos(r)), n = Math.hypot(...v) || 1;
    return [v[0] / n, v[1] / n];
  }
  const c = points.reduce((a, p) => [a[0] + p[0] / points.length, a[1] + p[1] / points.length], [0, 0]);
  let xx = 0, yy = 0, xy = 0;
  for (const p of points) { const x = p[0] - c[0], y = p[1] - c[1]; xx += x * x; yy += y * y; xy += x * y; }
  let a = Math.atan2(2 * xy, xx - yy) / 2, axis = [Math.cos(a), Math.sin(a)];
  if (b.roofOrientation === 'across') axis = [-axis[1], axis[0]];
  return axis;
}
function roofTriangles(ring, height, zAt) {
  const verts = ring.map(p => new THREE.Vector2(p[0], p[1]));
  const faces = THREE.ShapeUtils.triangulateShape(verts, []), pos = [];
  for (const face of faces) for (const i of face) { const p = ring[i]; pos.push(p[0], zAt(p), -p[1]); }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals();
  return g;
}
function flatRoof(rings, y) {
  const outer = rings[0].slice(0, -1).map(p => new THREE.Vector2(p[0], p[1]));
  const holes = rings.slice(1).map(r => r.slice(0, -1).map(p => new THREE.Vector2(p[0], p[1])));
  const vertices = [...outer, ...holes.flat()], faces = THREE.ShapeUtils.triangulateShape(outer, holes), pos = [];
  for (const face of faces) for (const i of face) { const p = vertices[i]; pos.push(p.x, y, -p.y); }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals(); return g;
}
function clipRoofHalf(ring, axis, mid, high) {
  const value = p => p[0] * axis[0] + p[1] * axis[1], out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], va = value(a), vb = value(b), ia = high ? va >= mid - 1e-7 : va <= mid + 1e-7, ib = high ? vb >= mid - 1e-7 : vb <= mid + 1e-7;
    if (ia) out.push(a);
    if (ia !== ib && Math.abs(vb - va) > 1e-8) { const t = (mid - va) / (vb - va); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
  }
  return out.filter((p, i) => !i || Math.hypot(p[0] - out[i - 1][0], p[1] - out[i - 1][1]) > 1e-5);
}
function roofSurface(b, wallHeight, roofHeight, frame) {
  const ring = b.loc?.[0]?.slice(0, -1); if (!ring || ring.length < 3) return null;
  const shape = String(b.roofShape || '').toLowerCase().replaceAll('-', '_');
  if (shape === 'flat' || !shape || roofHeight <= 0) return flatRoof(b.loc, wallHeight + 0.015);
  if (b.loc.length > 1 || !convex(ring)) return null;
  const axis = roofAxis(ring, b, frame), cross = [-axis[1], axis[0]], proj = p => p[0] * cross[0] + p[1] * cross[1];
  const vals = ring.map(proj), lo = Math.min(...vals), hi = Math.max(...vals), mid = (lo + hi) / 2, span = Math.max(0.1, (hi - lo) / 2);
  const baseY = wallHeight + 0.015;
  if (['gabled', 'saltbox', 'gambrel', 'half_hipped', 'mansard'].includes(shape)) {
    const roofs = [clipRoofHalf(ring, cross, mid, false), clipRoofHalf(ring, cross, mid, true)].filter(r => r.length >= 3);
    const gs = roofs.map(r => roofTriangles(r, roofHeight, p => baseY + roofHeight * Math.max(0, 1 - Math.abs(proj(p) - mid) / span))).filter(Boolean);
    return gs.length ? mergeGeometries(gs) : null;
  }
  if (shape === 'skillion' || shape === 'sawtooth') {
    return roofTriangles(ring, roofHeight, p => baseY + roofHeight * clamp((proj(p) - lo) / Math.max(0.1, hi - lo), 0, 1));
  }
  if (['dome', 'round', 'spherical', 'onion'].includes(shape)) {
    const c = ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]), bands = 5, pos = [];
    const point = (i, k) => { const p = ring[i], t = k / bands, f = 1 - t, y = baseY + roofHeight * Math.sin(t * Math.PI / 2); return [c[0] + (p[0] - c[0]) * f, y, -(c[1] + (p[1] - c[1]) * f)]; };
    for (let k = 0; k < bands; k++) for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length, a = point(i, k), b0 = point(j, k), d = point(i, k + 1), e = point(j, k + 1);
      pos.push(...a, ...d, ...b0, ...b0, ...d, ...e);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals(); return g;
  }
  // Hipped, pyramidal and unknown complex roof families get a faceted hip cap.
  const center = ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]), pos = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b0 = ring[(i + 1) % ring.length];
    pos.push(a[0], baseY, -a[1], center[0], baseY + roofHeight, -center[1], b0[0], baseY, -b0[1]);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals(); return g;
}
function buildingModelGeometry(M, exag, onlyKnown = null) {
  const walls = [], roofs = [], childIds = new Set((M.buildingParts || []).map(p => p.buildingId).filter(Boolean));
  const records = [...M.buildings.filter(b => !(b.hasParts && childIds.has(b.id))), ...(M.buildingParts || [])];
  for (const b of records) {
    if (!b.loc?.[0] || (!b.isPart && !b.inFrame) || (onlyKnown !== null && b.known !== onlyKnown)) continue;
    let shape = String(b.roofShape || '').toLowerCase().replaceAll('-', '_');
    let inferred = false;
    if (!shape && b.known && b.h <= 16) {
      const ring = b.loc[0].slice(0, -1), xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
      const aspect = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / Math.max(1, Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)));
      shape = aspect > 1.45 ? 'gabled' : 'hipped'; inferred = true;
    }
    let roofH = Number.isFinite(b.roofHeight) && b.roofHeight > 0 ? b.roofHeight : 0;
    if (!roofH && shape && shape !== 'flat' && b.known) roofH = Math.min(b.h * 0.3, inferred ? Math.max(1.2, b.h * 0.2) : Math.max(1.2, b.h * (b.floors > 3 ? 0.12 : 0.24)));
    roofH = Math.min(roofH, Math.max(0, b.h - 0.5));
    const wallH = Math.max(0.2, b.h - roofH), sh = new THREE.Shape(b.loc[0].slice(0, -1).map(p => new THREE.Vector2(p[0], p[1])));
    for (const h of b.loc.slice(1)) sh.holes.push(new THREE.Path(h.slice(0, -1).map(p => new THREE.Vector2(p[0], p[1]))));
    const lift = (b.base - M.dem.min) * exag + (b.minHeight || 0) - 0.2;
    const wall = new THREE.ExtrudeGeometry(sh, { depth: wallH, bevelEnabled: false, curveSegments: 1 });
    wall.rotateX(-Math.PI / 2); wall.translate(0, lift, 0); addVertexColor(wall, b.facadeColor || (b.known ? '#e8e5df' : '#d7d2ca')); walls.push(wall);
    const roof = roofSurface(shape === b.roofShape ? b : { ...b, roofShape: shape }, wallH, roofH, M.frame);
    if (roof) { roof.translate(0, lift, 0); addVertexColor(roof, b.roofColor || (b.known ? '#bdb4a8' : '#cbc5bb')); roofs.push(roof); }
  }
  return { walls: walls.length ? mergeGeometries(walls) : null, roofs: roofs.length ? mergeGeometries(roofs) : null };
}
function treeGeometry(M, exag) {
  const proto = mergeGeometries([new THREE.SphereGeometry(1, 8, 6).toNonIndexed(), new THREE.CylinderGeometry(0.12, 0.15, 1, 6).translate(0, -0.9, 0).toNonIndexed()]), geos = [];
  for (const t of M.osm.trees) { if (!M.frame.inside(...t.loc)) continue; const h = t.h || 8, r = h * 0.3, g = proto.clone(); g.scale(r, r, r); g.translate(t.loc[0], (M.zAt(...t.loc) - M.dem.min) * exag + h * 0.65, -t.loc[1]); geos.push(g); }
  return geos.length ? mergeGeometries(geos) : null;
}

/* surface textures (crisp per-texel sampling) */
const texSize = M => { const L = 2048; return M.frame.w >= M.frame.h ? [L, Math.round(L * M.frame.h / M.frame.w)] : [Math.round(L * M.frame.w / M.frame.h), L]; };
export async function surfaceTexture(M, mode) {
  const [TW, TH] = texSize(M), cv = document.createElement('canvas'); cv.width = TW; cv.height = TH; const c = cv.getContext('2d'), d = M.dem;
  if (mode === 'satellite') {
    const b = M.frame.bbox(20), z = Math.min(18, Math.ceil(Math.log2(156543 * Math.cos(M.frame.lat * Math.PI / 180) / (Math.max(M.frame.w, M.frame.h) / 2048))));
    const mos = await fetchMosaic(b, z, (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`, null, true);
    const src = mos.ctx.getImageData(0, 0, mos.cv.width, mos.cv.height), img = c.createImageData(TW, TH);
    for (let y = 0, p = 0; y < TH; y++) for (let x = 0; x < TW; x++, p += 4) {
      const [lon, lat] = M.frame.toLonLat(-M.frame.w / 2 + x / (TW - 1) * M.frame.w, M.frame.h / 2 - y / (TH - 1) * M.frame.h);
      const px = Math.round(lonToX(lon, z) - mos.x0 * 256), py = Math.round(latToY(lat, z) - mos.y0 * 256), q = (clamp(py, 0, mos.cv.height - 1) * mos.cv.width + clamp(px, 0, mos.cv.width - 1)) * 4;
      img.data[p] = src.data[q]; img.data[p + 1] = src.data[q + 1]; img.data[p + 2] = src.data[q + 2]; img.data[p + 3] = 255;
    }
    c.putImageData(img, 0, 0);
    return { canvas: cv, legend: null };
  }
  const defs = {
    clay: null,
    elevation: { arr: M.smooth, lo: d.min, hi: d.max, cmap: 'terrain', unit: 'm', label: 'Elevation' },
    slope: { arr: M.der.slope, lo: 0, hi: Math.max(5, percentiles(M.der.slope)[1]), cmap: 'slope', unit: '°', label: 'Slope' },
    aspect: { arr: M.der.aspect, lo: 0, hi: 360, cmap: 'aspect', unit: '°', label: 'Aspect (from north)' },
    solar: { arr: M.der.solar, ...(([a, b]) => ({ lo: a, hi: b }))(percentiles(M.der.solar)), cmap: 'inferno', unit: '% of flat', label: 'Solar exposure' },
    flow: (() => { const a = M.flowArr(), l = a.map(v => Math.log10(v)); const [lo, hi] = percentiles(l, 0.02, 0.995); return { arr: l, lo, hi, cmap: 'blues', unit: 'log₁₀ m²', label: 'Runoff (upslope area)' }; })
  };
  let h = defs[mode]; if (typeof h === 'function') h = h();
  const img = c.createImageData(TW, TH), t = h ? lut(h.cmap) : null, span = h ? (h.hi - h.lo) || 1 : 1;
  for (let y = 0, p = 0; y < TH; y++) { const gy = y / (TH - 1) * (d.H - 1); for (let x = 0; x < TW; x++, p += 4) {
    const gx = x / (TW - 1) * (d.W - 1), sh = 0.55 + 0.6 * bilinear(M.der.shade, d.W, d.H, gx, gy);
    if (!h) { const v = Math.min(255, 236 * (0.82 + 0.2 * sh)); img.data[p] = v; img.data[p + 1] = v * 0.985; img.data[p + 2] = v * 0.96; img.data[p + 3] = 255; continue; }
    const k = Math.round(clamp((bilinear(h.arr, d.W, d.H, gx, gy) - h.lo) / span, 0, 1) * 11) / 11 * 255 | 0, q = k * 3;
    img.data[p] = Math.min(255, t[q] * sh); img.data[p + 1] = Math.min(255, t[q + 1] * sh); img.data[p + 2] = Math.min(255, t[q + 2] * sh); img.data[p + 3] = 255;
  } }
  c.putImageData(img, 0, 0);
  return { canvas: cv, legend: h && { label: `${h.label} (${h.unit})`, lo: h.lo, hi: h.hi, colors: CMAPS[h.cmap] } };
}

/* ── scene ── */
export function buildScene(M, o, tex) {
  const root = new THREE.Group(), f = M.frame, size = Math.max(f.w, f.h), exag = o.exag || 1, base = o.base ? Math.max(4, (M.dem.max - M.dem.min) * exag * 0.15 + size * 0.01) : 0;
  const clay = new THREE.MeshStandardMaterial({ color: '#f1efea', roughness: 0.95 }), side = new THREE.MeshStandardMaterial({ color: '#cfc9be', roughness: 1 });
  let terrain;
  if (o.style === 'terraced') terrain = new THREE.Mesh(contourLayers(M, exag, o.iv, base), clay);
  else if (o.style === 'blocks') terrain = new THREE.Mesh(blocks(M, exag, base, 90), clay);
  else { const t = new THREE.CanvasTexture(tex.canvas); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; terrain = new THREE.Mesh(terrainSolid(M, exag, base), [new THREE.MeshStandardMaterial({ map: t, roughness: 0.95 }), side]); }
  terrain.name = 'terrain'; terrain.castShadow = terrain.receiveShadow = true; root.add(terrain);
  const explode = Math.max(0, o.explosion || 0);
  if (o.buildings) {
    const known = buildingModelGeometry(M, exag, true), unknown = buildingModelGeometry(M, exag, false);
    for (const [group, name, fallback, roughness] of [[known, 'buildings', '#ffffff', 0.8], [unknown, 'buildings_height_unknown', '#ffffff', 0.9]]) {
      for (const [key, suffix, color] of [['walls', '', fallback], ['roofs', '_roofs', '#ffffff']]) if (group[key]) {
        const m = new THREE.Mesh(group[key], new THREE.MeshStandardMaterial({ color, vertexColors: true, roughness }));
        m.name = name + suffix; m.position.y = explode; m.castShadow = m.receiveShadow = true; root.add(m);
      }
    }
    const tg = treeGeometry(M, exag); if (tg) { const m = new THREE.Mesh(tg, new THREE.MeshStandardMaterial({ color: '#e9e6df', roughness: 1, flatShading: true })); m.name = 'trees'; m.position.y = explode * 1.65; m.castShadow = true; root.add(m); }
  }
  return { root, size, base, exag };
}
function sunDir(M, date, hour) {
  const ms = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) + (hour - M.frame.lon / 15) * 3600000;
  let p = sunPosition(ms, M.frame.lat, M.frame.lon); if (p.alt < 0.05) p = { alt: 0.05, az: p.az };
  const [x, y] = M.frame.enToFrame(Math.sin(p.az) * Math.cos(p.alt), Math.cos(p.az) * Math.cos(p.alt));
  return new THREE.Vector3(x, Math.sin(p.alt), -y).normalize();
}

/* interactive viewer */
export function createViewer(host) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(40, 1, 1, 1e6), controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.49;
  scene.add(new THREE.HemisphereLight('#ffffff', '#b9b2a6', 1.4));
  const sun = new THREE.DirectionalLight('#fff6e8', 2.6); sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096); scene.add(sun, sun.target);
  let model = null, ctx = null, need = true, first = true;
  const resize = () => { const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); need = true; };
  new ResizeObserver(resize).observe(host);
  controls.addEventListener('change', () => { need = true; });
  (function loop() { requestAnimationFrame(loop); if (controls.update() || need) { need = false; renderer.render(scene, camera); } })();
  return {
    async show(M, o) {
      const tex = o.style === 'smooth' ? await surfaceTexture(M, o.surface) : null;
      if (model) { scene.remove(model.root); model.root.traverse(x => { x.geometry && x.geometry.dispose(); }); }
      if (ctx) { scene.remove(ctx); ctx.traverse(x => { x.geometry && x.geometry.dispose(); }); ctx = null; }
      model = buildScene(M, o, tex || {}); scene.add(model.root);
      if (o.context && Object.values(o.context).some(Boolean)) { ctx = buildContext(M, o); scene.add(ctx); }
      const s = model.size, d = sunDir(M, o.date, o.hour);
      sun.position.copy(d.multiplyScalar(s * 1.5)); const sc = sun.shadow.camera; sc.left = sc.bottom = -s * 0.75; sc.right = sc.top = s * 0.75; sc.near = 1; sc.far = s * 4; sc.updateProjectionMatrix(); sun.shadow.bias = -0.0004; sun.shadow.normalBias = s / 3000;
      scene.background = new THREE.Color(o.clean ? '#ffffff' : '#eef1f4');
      if (first) { camera.near = s / 2000; camera.far = s * 30; /* context ring extends beyond the site */ camera.position.set(-s * 0.45, s * 0.55, s * 0.75); controls.target.set(0, (M.dem.max - M.dem.min) * 0.3, 0); camera.updateProjectionMatrix(); first = false; }
      resize(); need = true;
      return tex && tex.legend;
    },
    get root() { return model && model.root; },
    renderer, scene, camera,
    png() { renderer.render(scene, camera); return new Promise(r => renderer.domElement.toBlob(r)); }
  };
}

/* exports */
function wrapExport(root, scale, zUp, fn) {
  const w = new THREE.Group(); w.scale.setScalar(scale); if (zUp) w.rotation.x = Math.PI / 2;
  const parent = root.parent; parent && parent.remove(root); w.add(root); w.updateMatrixWorld(true);
  try { return fn(w); } finally { w.remove(root); parent && parent.add(root); }
}
export const toSTL = (root, scale = 1) => wrapExport(root, scale, true, w => new Blob([new STLExporter().parse(w, { binary: true })], { type: 'model/stl' }));
export const toOBJ = (root, scale = 1) => wrapExport(root, scale, false, w => new OBJExporter().parse(w));
export async function toGLB(root, scale = 1) {
  const w = new THREE.Group(); w.scale.setScalar(scale); const parent = root.parent; parent && parent.remove(root); w.add(root); w.updateMatrixWorld(true);
  try { return new Blob([await new GLTFExporter().parseAsync(w, { binary: true })], { type: 'model/gltf-binary' }); } finally { w.remove(root); parent && parent.add(root); }
}

/* offscreen clay axonometric for the topography sheet */
let off = null;
export async function axonometricPNG(M, o) {
  if (!off) { off = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); off.outputColorSpace = THREE.SRGBColorSpace; off.shadowMap.enabled = true; off.shadowMap.type = THREE.PCFSoftShadowMap; }
  const Wp = o.width || 2400, Hp = o.height || 1600; off.setPixelRatio(1); off.setSize(Wp, Hp, false); off.setClearColor('#ffffff', 1);
  const scene = new THREE.Scene(), tex = o.style === 'smooth' ? await surfaceTexture(M, o.surface || 'clay') : {};
  const m = buildScene(M, { ...o, buildings: true, base: true }, tex); scene.add(m.root);
  scene.add(new THREE.HemisphereLight('#ffffff', '#c9c2b6', 1.5));
  const s = m.size, sun = new THREE.DirectionalLight('#ffffff', 2.2); sun.position.set(-s, s * 1.4, s * 0.6); sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera; sc.left = sc.bottom = -s * 0.8; sc.right = sc.top = s * 0.8; sc.far = s * 5; sun.shadow.bias = -0.0004; scene.add(sun);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, s * 20);
  cam.position.set(-s * 1.2, s * 1.0, s * 1.2); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
  const box = new THREE.Box3().setFromObject(m.root); let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < 8; i++) { const v = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(cam.matrixWorldInverse); x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); }
  let w = (x1 - x0) * 1.05, h = (y1 - y0) * 1.05; if (w / h < Wp / Hp) w = h * Wp / Hp; else h = w * Hp / Wp;
  Object.assign(cam, { left: (x0 + x1) / 2 - w / 2, right: (x0 + x1) / 2 + w / 2, top: (y0 + y1) / 2 + h / 2, bottom: (y0 + y1) / 2 - h / 2 }); cam.updateProjectionMatrix();
  off.render(scene, cam);
  const url = off.domElement.toDataURL('image/png');
  m.root.traverse(x => { x.geometry && x.geometry.dispose(); });
  return { url, w: Wp, h: Hp };
}
