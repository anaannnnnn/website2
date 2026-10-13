// Optional 3D context layer: sun path, current sun, wind, people, north arrow, scale bar, site outline. Added to the viewer scene (not the exported model).
import * as THREE from 'three';
import { sunPosition } from './geo.js';

export const CONTEXT_ITEMS = ['sunpath', 'sun', 'wind', 'people', 'north', 'scale', 'outline'];

const mat = (c, o = {}) => new THREE.MeshBasicMaterial({ color: c, ...o });
function label(text, size, color = '#222') {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 96; const c = cv.getContext('2d');
  c.font = '700 54px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineWidth = 10; c.strokeStyle = 'rgba(255,255,255,.9)'; c.strokeText(text, 128, 48); c.fillStyle = color; c.fillText(text, 128, 48);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true })); s.scale.set(size * 2.67, size, 1); s.renderOrder = 10; return s;
}
function inPoly(x, y, ring) { let r = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) r = !r; } return r; }
function rng(seed) { let s = seed >>> 0 || 1; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function arrow(len, w, color) {
  const g = new THREE.Group(), sh = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.18, w * 0.18, len * 0.7, 8).rotateZ(-Math.PI / 2).translate(len * 0.35, 0, 0), mat(color));
  const hd = new THREE.Mesh(new THREE.ConeGeometry(w * 0.5, len * 0.3, 10).rotateZ(-Math.PI / 2).translate(len * 0.85, 0, 0), mat(color)); g.add(sh, hd); return g;
}
const niceLen = v => { const p = 10 ** Math.floor(Math.log10(v)), n = v / p; return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * p; };

export function windStats(wind) {
  if (!wind) return null;
  const bins = new Array(16).fill(0), spd = new Array(16).fill(0); let n = 0;
  for (let i = 0; i < wind.spd.length; i++) { const s = wind.spd[i], d = wind.dir[i]; if (s == null || d == null || s < 0.5) continue; const k = Math.round(d / 22.5) % 16; bins[k]++; spd[k] += s; n++; }
  if (!n) return null;
  return bins.map((c, k) => ({ k, freq: c / n, mean: c ? spd[k] / c : 0 }));
}

export function buildContext(M, o) {
  const g = new THREE.Group(), f = M.frame, d = M.dem, size = Math.max(f.w, f.h), exag = o.exag || 1, on = o.context || {};
  const hAt = (x, y) => (M.zAt(x, y) - d.min) * exag, top = hAt(0, 0), relief = (d.max - d.min) * exag, R = size * 0.62;
  const topAbove = Math.max(relief, ...M.buildings.filter(b => b.inFrame).map(b => (b.base - d.min) * exag + b.h)) || size * 0.1;
  const ground = relief * 0.5 + 0.0, fs = size * 0.028;

  if (on.outline) {
    const pts = [[-f.w / 2, -f.h / 2], [f.w / 2, -f.h / 2], [f.w / 2, f.h / 2], [-f.w / 2, f.h / 2]].map(([x, y]) => new THREE.Vector3(x, 0.4, -y));
    const L = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: '#e5483b' })); g.add(L);
  }
  if (on.north) {
    const [nx, ny] = f.enToFrame(0, 1), a = new THREE.Group(), ar = arrow(size * 0.09, size * 0.025, '#111');
    ar.rotation.y = Math.atan2(ny, nx);
    a.add(ar); const t = label('N', fs); t.position.set(nx * size * 0.11, size * 0.01, -ny * size * 0.11); a.add(t);
    a.position.set(-f.w / 2 - size * 0.06, 1, f.h / 2 + size * 0.1);
    g.add(a);
  }
  if (on.scale) {
    const L = niceLen(f.w * 0.35), seg = L / 4, y = 1, z = f.h / 2 + size * 0.05, x0 = f.w / 2 - L;
    for (let i = 0; i < 4; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(seg, size * 0.004, size * 0.008), mat(i % 2 ? '#fff' : '#111')); b.position.set(x0 + seg * (i + 0.5), y, z); g.add(b); }
    const t = label(L >= 1000 ? L / 1000 + ' km' : L + ' m', fs * 0.8); t.position.set(x0 + L / 2, y + fs, z); g.add(t);
  }
  if (on.sunpath) {
    const lat = f.lat, lon = f.lon, year = new Date().getUTCFullYear();
    const vec = (mo, dd, h) => { const p = sunPosition(Date.UTC(year, mo, dd) + (h - lon / 15) * 3600000, lat, lon), [x, y] = f.enToFrame(Math.sin(p.az) * Math.cos(p.alt), Math.cos(p.az) * Math.cos(p.alt)); return { p, v: new THREE.Vector3(x * R, Math.sin(p.alt) * R, -y * R) }; };
    const C = new THREE.Vector3(0, ground, 0);
    for (const [mo, dd, col] of [[11, 21, '#2c7bb6'], [2, 20, '#1a9850'], [5, 21, '#d7191c']]) {
      const pts = []; for (let h = 0; h <= 24.001; h += 0.1) { const s = vec(mo, dd, h); if (s.p.alt > 0) pts.push(s.v.clone().add(C)); }
      if (pts.length > 1) g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: col })));
      for (let h = 6; h <= 18; h += 2) { const s = vec(mo, dd, h); if (s.p.alt > 0) { const m = new THREE.Mesh(new THREE.SphereGeometry(size * 0.006, 8, 6), mat(col)); m.position.copy(s.v).add(C); g.add(m); if (mo === 5 || mo === 11) { const t = label(h + ':00', fs * 0.6, col); t.position.copy(m.position).add(new THREE.Vector3(0, fs * 0.7, 0)); g.add(t); } } }
    }
    const rim = []; for (let i = 0; i <= 96; i++) { const a = i / 96 * Math.PI * 2; rim.push(new THREE.Vector3(Math.sin(a) * R, 0.5, -Math.cos(a) * R).add(new THREE.Vector3(0, ground, 0))); }
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(rim), new THREE.LineBasicMaterial({ color: '#999', transparent: true, opacity: 0.6 })));
    for (const [n, a] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) { const [x, y] = f.enToFrame(Math.sin(a * Math.PI / 180), Math.cos(a * Math.PI / 180)), t = label(n, fs); t.position.set(x * R * 1.06, ground + 1, -y * R * 1.06); g.add(t); }
  }
  if (on.sun) {
    const ms = Date.UTC(o.date.getUTCFullYear(), o.date.getUTCMonth(), o.date.getUTCDate()) + (o.hour - f.lon / 15) * 3600000, p = sunPosition(ms, f.lat, f.lon);
    if (p.alt > 0) {
      const [x, y] = f.enToFrame(Math.sin(p.az) * Math.cos(p.alt), Math.cos(p.az) * Math.cos(p.alt)), dir = new THREE.Vector3(x, Math.sin(p.alt), -y), pos = dir.clone().multiplyScalar(R).add(new THREE.Vector3(0, ground, 0));
      const s = new THREE.Mesh(new THREE.SphereGeometry(size * 0.025, 20, 14), mat('#ffb300')); s.position.copy(pos); g.add(s);
      const halo = new THREE.Mesh(new THREE.SphereGeometry(size * 0.04, 20, 14), mat('#ffd54f', { transparent: true, opacity: 0.35 })); halo.position.copy(pos); g.add(halo);
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([pos, new THREE.Vector3(0, top, 0)]), new THREE.LineDashedMaterial({ color: '#ffb300', dashSize: size * 0.01, gapSize: size * 0.008 })).computeLineDistances());
    }
  }
  if (on.wind) {
    const st = windStats(M.climate && M.climate.wind);
    if (st) {
      const max = Math.max(...st.map(s => s.freq)), y = ground + topAbove * 0.5 + size * 0.02, rg = rng(7);
      for (const s of st) {
        if (s.freq < max * 0.25) continue;
        const a = s.k * 22.5 * Math.PI / 180, [ex, ey] = f.enToFrame(-Math.sin(a), -Math.cos(a)), len = size * (0.08 + 0.12 * s.freq / max), w = size * (0.01 + 0.012 * s.freq / max); // blows towards (dir+180)
        const ang = Math.atan2(ey, ex), ox = -ex, oy = -ey; // upwind side
        for (let i = -1; i <= 1; i++) {
          const ar = arrow(len, w, s.freq === max ? '#08519c' : '#6baed6'), px = ox * size * 0.62 + -oy * i * size * 0.12 + (rg() - 0.5) * size * 0.02, py = oy * size * 0.62 + ox * i * size * 0.12 + (rg() - 0.5) * size * 0.02;
          ar.rotation.y = ang; ar.position.set(px, y + i * 0, -py); g.add(ar);
        }
        if (s.freq === max) { const t = label(`Prevailing wind ${(s.freq * 100).toFixed(0)}% · ${s.mean.toFixed(1)} m/s`, fs * 0.7, '#08519c'); t.position.set(ox * size * 0.62, y + fs * 1.2, -oy * size * 0.62); g.add(t); }
      }
    }
  }
  if (on.people) {
    const rg = rng(11), sc = Math.max(1, size / 250), n = Math.min(60, Math.round(14 + size / 25)), rings = M.buildings.filter(b => b.inFrame).map(b => b.loc[0]);
    const body = new THREE.CylinderGeometry(0.22, 0.28, 1.35, 8).translate(0, 0.9, 0), head = new THREE.SphereGeometry(0.15, 8, 6).translate(0, 1.72, 0);
    const inst = new THREE.InstancedMesh(body, new THREE.MeshStandardMaterial({ color: '#d9d3c7', roughness: 1 }), n), hs = new THREE.InstancedMesh(head, new THREE.MeshStandardMaterial({ color: '#c9382b', roughness: 1 }), n), m4 = new THREE.Matrix4();
    let k = 0, tries = 0;
    while (k < n && tries++ < n * 40) {
      const x = (rg() - 0.5) * f.w * 0.8, y = (rg() - 0.5) * f.h * 0.8; if (rings.some(r => inPoly(x, y, r))) continue;
      m4.compose(new THREE.Vector3(x, hAt(x, y), -y), new THREE.Quaternion(), new THREE.Vector3(sc, sc, sc)); inst.setMatrixAt(k, m4); hs.setMatrixAt(k, m4); k++;
    }
    inst.count = hs.count = k; inst.castShadow = hs.castShadow = true; g.add(inst, hs);
  }
  g.name = 'context3d';
  return g;
}
