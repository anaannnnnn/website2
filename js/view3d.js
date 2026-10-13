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
/* stacked contour layers, stepped by contour interval */
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
  const geos = [];
  for (const b of M.buildings) {
    if (!b.inFrame || (onlyKnown !== null && b.known !== onlyKnown)) continue;
    const sh = new THREE.Shape(b.loc[0].slice(0, -1).map(p => new THREE.Vector2(p[0], p[1])));
    for (const h of b.loc.slice(1)) sh.holes.push(new THREE.Path(h.slice(0, -1).map(p => new THREE.Vector2(p[0], p[1]))));
    const g = new THREE.ExtrudeGeometry(sh, { depth: b.h, bevelEnabled: false, curveSegments: 1 });
    g.rotateX(-Math.PI / 2); g.translate(0, (b.base - M.dem.min) * exag + (b.minHeight || 0) - 0.2, 0);
    g.deleteAttribute('uv'); geos.push(g);
  }
  return geos.length ? mergeGeometries(geos) : null;
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
    c.putImageData(img, 0, 0); mos.cv.width = mos.cv.height = 0;
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
  if (o.buildings) {
    const known = buildingGeometry(M, exag, true), unknown = buildingGeometry(M, exag, false);
    if (known) { const m = new THREE.Mesh(known, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.8 })); m.name = 'buildings'; m.castShadow = m.receiveShadow = true; root.add(m); }
    if (unknown) { const m = new THREE.Mesh(unknown, new THREE.MeshStandardMaterial({ color: '#e4e0d8', roughness: 0.9 })); m.name = 'buildings_height_unknown'; m.castShadow = m.receiveShadow = true; root.add(m); }
    const tg = treeGeometry(M, exag); if (tg) { const m = new THREE.Mesh(tg, new THREE.MeshStandardMaterial({ color: '#e9e6df', roughness: 1, flatShading: true })); m.name = 'trees'; m.castShadow = true; root.add(m); }
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
  let model = null, need = true, first = true;
  const resize = () => { const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); need = true; };
  new ResizeObserver(resize).observe(host);
  controls.addEventListener('change', () => { need = true; });
  (function loop() { requestAnimationFrame(loop); if (controls.update() || need) { need = false; renderer.render(scene, camera); } })();
  return {
    async show(M, o) {
      const tex = o.style === 'smooth' ? await surfaceTexture(M, o.surface) : null;
      if (model) { scene.remove(model.root); model.root.traverse(x => { x.geometry && x.geometry.dispose(); }); }
      model = buildScene(M, o, tex || {}); scene.add(model.root);
      const s = model.size, d = sunDir(M, o.date, o.hour);
      sun.position.copy(d.multiplyScalar(s * 1.5)); const sc = sun.shadow.camera; sc.left = sc.bottom = -s * 0.75; sc.right = sc.top = s * 0.75; sc.near = 1; sc.far = s * 4; sc.updateProjectionMatrix(); sun.shadow.bias = -0.0004; sun.shadow.normalBias = s / 3000;
      scene.background = new THREE.Color('#eef1f4');
      if (first) { camera.near = s / 2000; camera.far = s * 30; camera.position.set(-s * 0.45, s * 0.55, s * 0.75); controls.target.set(0, (M.dem.max - M.dem.min) * 0.3, 0); camera.updateProjectionMatrix(); first = false; }
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
  // free everything now: geometry, materials, textures and the off-screen WebGL context itself
  m.root.traverse(x => { x.geometry && x.geometry.dispose(); for (const mt of [].concat(x.material || [])) { mt.map && mt.map.dispose(); mt.dispose(); } });
  if (tex.canvas) tex.canvas.width = tex.canvas.height = 0;
  sun.shadow.map && sun.shadow.map.dispose();
  off.dispose(); off.forceContextLoss(); off = null;
  return { url, w: Wp, h: Hp };
}
