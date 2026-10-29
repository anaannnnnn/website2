// Optional 3D context layer: sun path, current sun, wind, people, north arrow, scale bar, site outline. Added to the viewer scene (not the exported model).
import * as THREE from 'three';
import { sunPosition } from './geo.js';

export const CONTEXT_ITEMS = ['people', 'cars', 'sunpath', 'solar', 'sun', 'wind', 'north', 'scale', 'outline'];

const mat = (c, o = {}) => new THREE.MeshBasicMaterial({ color: c, ...o });
function label(text, size, color = '#222') {
  const lines = String(text).split('\n'), fnt = '700 54px system-ui, sans-serif', cv = document.createElement('canvas'), c = cv.getContext('2d');
  c.font = fnt; const w = Math.ceil(Math.max(...lines.map(l => c.measureText(l).width))) + 24, lh = 64; cv.width = w; cv.height = lh * lines.length + 16;
  c.font = fnt; c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineWidth = 10; c.strokeStyle = 'rgba(255,255,255,.9)'; c.fillStyle = color;
  lines.forEach((l, i) => { const y = 8 + lh * (i + 0.5); c.strokeText(l, w / 2, y); c.fillText(l, w / 2, y); });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true })); s.scale.set(size * cv.width / lh, size * cv.height / lh, 1); s.renderOrder = 10; return s;
}
function inPoly(x, y, ring) { let r = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) r = !r; } return r; }
function rng(seed) { let s = seed >>> 0 || 1; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function arrow(len, w, color) {
  const g = new THREE.Group(), sh = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.18, w * 0.18, len * 0.7, 8).rotateZ(-Math.PI / 2).translate(len * 0.35, 0, 0), mat(color));
  const hd = new THREE.Mesh(new THREE.ConeGeometry(w * 0.5, len * 0.3, 10).rotateZ(-Math.PI / 2).translate(len * 0.85, 0, 0), mat(color)); g.add(sh, hd); return g;
}
const niceLen = v => { const p = 10 ** Math.floor(Math.log10(v)), n = v / p; return (n >= 5 ? 5 : n >= 2 ? 2 : 1) * p; };

export function windStats(wind, months = null) {
  if (!wind) return null;
  const bins = new Array(16).fill(0), spd = new Array(16).fill(0); let n = 0;
  for (let i = 0; i < wind.spd.length; i++) { if (months && !months.includes(new Date(Date.UTC(2001, 0, 1 + Math.floor(i / 24))).getUTCMonth())) continue; const s = wind.spd[i], d = wind.dir[i]; if (s == null || d == null || s < 0.5) continue; const k = Math.round(d / 22.5) % 16; bins[k]++; spd[k] += s; n++; }
  if (!n) return null;
  return bins.map((c, k) => ({ k, freq: c / n, mean: c ? spd[k] / c : 0 }));
}

export function buildContext(M, o) {
  const g = new THREE.Group(), f = M.frame, d = M.dem, size = Math.max(f.w, f.h), exag = o.exag || 1, on = o.context || {};
  const hAt = (x, y) => (M.zAt(x, y) - d.min) * exag, top = hAt(0, 0), relief = (d.max - d.min) * exag, R = size * 0.62;
  const topAbove = Math.max(relief, ...[...M.buildings, ...(M.buildingParts || [])].filter(b => b.inFrame).map(b => (b.base - d.min) * exag + (b.minHeight || 0) + b.h)) || size * 0.1;
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
  if (on.solar) {
    const lat = f.lat, lon = f.lon, year = new Date().getUTCFullYear(), south = lat < 0, C = new THREE.Vector3(0, ground, 0);
    const at = (mo, dd, h) => { const p = sunPosition(Date.UTC(year, mo, dd) + (h - lon / 15) * 3600000, lat, lon), [x, y] = f.enToFrame(Math.sin(p.az) * Math.cos(p.alt), Math.cos(p.az) * Math.cos(p.alt)); return { p, v: new THREE.Vector3(x, Math.sin(p.alt), -y) }; };
    const hm = h => `${Math.floor(h)}:${String(Math.round(h % 1 * 60) % 60).padStart(2, '0')}`.replace(/^(\d):/, '0$1:');
    const info = (mo, dd) => { let rise = null, set = null, noon = 0, prev = false; for (let m = 0; m <= 1440; m += 2) { const s = at(mo, dd, m / 60), up = s.p.alt > 0; if (up && !prev && rise === null) rise = m / 60; if (!up && prev) set = m / 60; prev = up; noon = Math.max(noon, s.p.alt); } return { rise, set, noon: noon * 180 / Math.PI }; };
    const seasons = [{ n: 'SUMMER', mo: south ? 11 : 5, col: '#e8a200' }, { n: 'WINTER', mo: south ? 5 : 11, col: '#e8a200' }];
    const win = seasons[1];
    for (const s of seasons) {
      const dd = 21, I = info(s.mo, dd), pts = []; for (let h = 0; h <= 24.001; h += 0.1) { const q = at(s.mo, dd, h); if (q.p.alt > 0) pts.push(q.v.clone().multiplyScalar(R * 1.12).add(C)); }
      if (pts.length > 1) g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: s.col, dashSize: size * 0.012, gapSize: size * 0.01 })).computeLineDistances());
      let best = null; for (let h = 0; h <= 24; h += 0.1) { const q = at(s.mo, dd, h); if (!best || q.p.alt > best.p.alt) best = q; }
      const pos = best.v.clone().multiplyScalar(R * 1.12).add(C), sun = new THREE.Mesh(new THREE.SphereGeometry(size * 0.022, 20, 14), mat('#ffb300')), halo = new THREE.Mesh(new THREE.SphereGeometry(size * 0.036, 20, 14), mat('#ffd54f', { transparent: true, opacity: 0.35 }));
      sun.position.copy(pos); halo.position.copy(pos); g.add(sun, halo);
      const t = label(`${s.n} SOLSTICE ${Math.round(I.noon)}°\nSunrise ${I.rise == null ? '—' : hm(I.rise)} · Sunset ${I.set == null ? '—' : hm(I.set)} (solar time)`, fs * 0.8, '#222'); t.position.copy(pos).add(new THREE.Vector3(0, fs * 2.4, 0)); g.add(t);
      if (s === win) { s.I = I; }
    }
    // optimal orientation: arc on the equator-facing rim between winter sunrise and sunset azimuths
    const I = win.I, a0 = I.rise == null ? 90 : at(win.mo, 21, I.rise).p.az * 180 / Math.PI, a1 = I.set == null ? 270 : at(win.mo, 21, I.set).p.az * 180 / Math.PI;
    const lo = Math.min(a0, a1), hi = Math.max(a0, a1), arc = [], Rr = R * 0.96;
    for (let i = 0; i <= 40; i++) { const a = (lo + (hi - lo) * i / 40) * Math.PI / 180, [x, y] = f.enToFrame(Math.sin(a), Math.cos(a)); arc.push(new THREE.Vector3(x * Rr, 1, -y * Rr).add(C)); }
    const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(arc), 60, size * 0.006, 6), mat('#e8a200')); g.add(tube);
    const mid = arc[20].clone(), tl = label('OPTIMAL ORIENTATION\nFOR SOLAR MANAGEMENT', fs * 0.8, '#b07a00'); tl.position.copy(mid).add(new THREE.Vector3(0, fs * 1.8, 0)); tl.position.sub(C).multiplyScalar(1.12).add(C); tl.position.y = ground + fs * 1.8; g.add(tl);
    // seasonal winds
    const hot = [5, 6, 7], cold = [11, 0, 1], wd = M.climate && M.climate.wind;
    for (const [nm, ms, col] of [['SUMMER WIND', south ? cold : hot, '#3a6ea5'], ['WINTER WIND', south ? hot : cold, '#3a6ea5']]) {
      const st = windStats(wd, ms); if (!st) continue; const top = st.reduce((a, b) => b.freq > a.freq ? b : a), a = top.k * 22.5 * Math.PI / 180, [ex, ey] = f.enToFrame(-Math.sin(a), -Math.cos(a));
      const ar = arrow(size * 0.16, size * 0.02, col), ox = -ex * R * 0.9, oy = -ey * R * 0.9; ar.rotation.y = Math.atan2(ey, ex); ar.position.set(ox, ground + topAbove * 0.7 + size * 0.03, oy * -1); g.add(ar);
      const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'], t = label(`${nm} ${dirs[top.k]}\n${top.mean.toFixed(1)} m/s`, fs * 0.8, col); t.position.set(ox, ground + topAbove * 0.7 + size * 0.03 + fs * 2, -oy); g.add(t);
    }
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
  if (on.cars) {
    const rg = rng(23), sc = Math.max(1, size / 250), n = Math.min(24, Math.round(5 + size / 60)), rings = M.buildings.filter(b => b.inFrame).map(b => b.loc[0]);
    const cols = ['#e9e6df', '#cfd3d6', '#b8bcc0', '#f4f4f2'], body = new THREE.BoxGeometry(4.2, 0.8, 1.8).translate(0, 0.65, 0), cab = new THREE.BoxGeometry(2.2, 0.7, 1.6).translate(-0.2, 1.4, 0);
    const bm = new THREE.InstancedMesh(body, new THREE.MeshStandardMaterial({ color: '#d8d8d6', roughness: 0.8 }), n), cm = new THREE.InstancedMesh(cab, new THREE.MeshStandardMaterial({ color: '#9aa3aa', roughness: 0.6 }), n), m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    let k = 0, tries = 0;
    while (k < n && tries++ < n * 40) {
      const x = (rg() - 0.5) * f.w * 0.8, y = (rg() - 0.5) * f.h * 0.8; if (rings.some(r => inPoly(x, y, r))) continue;
      const e = 1.5 * sc, a = rg() < 0.5 ? 0 : Math.PI / 2; if ([[e, 0], [-e, 0], [0, e], [0, -e]].some(([dx, dy]) => Math.abs(hAt(x + dx, y + dy) - hAt(x, y)) > 0.6 * sc)) continue;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a); m4.compose(new THREE.Vector3(x, hAt(x, y), -y), q, new THREE.Vector3(sc, sc, sc)); bm.setMatrixAt(k, m4); cm.setMatrixAt(k, m4); bm.setColorAt(k, new THREE.Color(cols[k % 4])); k++;
    }
    bm.count = cm.count = k; bm.castShadow = cm.castShadow = true; g.add(bm, cm);
  }
  g.name = 'context3d';
  return g;
}
