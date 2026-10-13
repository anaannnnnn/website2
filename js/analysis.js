// Terrain analysis on the frame-aligned DEM grid: slope, aspect, hillshade, solar exposure,
// D8 flow accumulation, smoothing, contours. Directions are converted to true north via the frame.
import { D2R, clamp, sunPosition } from './geo.js';

export function gaussian(data, W, H, sigma) {
  if (sigma <= 0) return Float32Array.from(data);
  const r = Math.ceil(sigma * 3), k = []; let sum = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-i * i / (2 * sigma * sigma)); k.push(v); sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { let a = 0; for (let t = 0; t < k.length; t++) a += data[j * W + clamp(i + t - r, 0, W - 1)] * k[t]; tmp[j * W + i] = a; }
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) { let a = 0; for (let t = 0; t < k.length; t++) a += tmp[clamp(j + t - r, 0, H - 1) * W + i] * k[t]; out[j * W + i] = a; }
  return out;
}

/** slope (deg), aspect (deg from true north), hillshade, solar exposure (% of flat ground) */
export function derive(dem, frame, data = dem.data) {
  const { W, H, dx, dy } = dem, n = W * H;
  const slope = new Float32Array(n), aspect = new Float32Array(n), shade = new Float32Array(n), nE = new Float32Array(n), nN = new Float32Array(n), nU = new Float32Array(n);
  const at = (i, j) => data[clamp(j, 0, H - 1) * W + clamp(i, 0, W - 1)];
  const sAz = 315 * D2R, sAlt = 45 * D2R, sE = Math.sin(sAz) * Math.cos(sAlt), sN = Math.cos(sAz) * Math.cos(sAlt), sU = Math.sin(sAlt);
  let slopeSum = 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const a = at(i - 1, j - 1), b = at(i, j - 1), c = at(i + 1, j - 1), d = at(i - 1, j), f = at(i + 1, j), g = at(i - 1, j + 1), h = at(i, j + 1), k = at(i + 1, j + 1);
    const gx = ((c + 2 * f + k) - (a + 2 * d + g)) / (8 * dx), gy = -((g + 2 * h + k) - (a + 2 * b + c)) / (8 * dy);  // frame x / frame y
    const [gE, gN] = frame.frameToEn(gx, gy), idx = j * W + i, s = Math.atan(Math.hypot(gE, gN));
    slope[idx] = s / D2R; slopeSum += slope[idx];
    aspect[idx] = (Math.atan2(-gE, -gN) / D2R + 360) % 360;
    const len = Math.hypot(gE, gN, 1);
    nE[idx] = -gE / len; nN[idx] = -gN / len; nU[idx] = 1 / len;
    shade[idx] = Math.max(0, nE[idx] * sE + nN[idx] * sN + nU[idx] * sU);
  }
  const suns = [], year = new Date().getUTCFullYear();
  for (const [mo, dd] of [[2, 20], [5, 21], [8, 22], [11, 21]]) for (let h = 0; h < 24; h += 0.5) {
    const p = sunPosition(Date.UTC(year, mo, dd) + (h - frame.lon / 15) * 3600000, frame.lat, frame.lon);
    if (p.alt > 0) suns.push([Math.sin(p.az) * Math.cos(p.alt), Math.cos(p.az) * Math.cos(p.alt), Math.sin(p.alt)]);
  }
  const flat = suns.reduce((t, s) => t + s[2], 0) || 1, solar = new Float32Array(n);
  for (let i = 0; i < n; i++) { let t = 0; for (const s of suns) { const v = nE[i] * s[0] + nN[i] * s[1] + nU[i] * s[2]; if (v > 0) t += v; } solar[i] = t / flat * 100; }
  return { slope, aspect, shade, solar, meanSlope: slopeSum / n };
}

/** D8 flow accumulation (upslope area, m²) */
export function flowAccumulation(dem, weights) {
  const { W, H, data, dx, dy } = dem, n = W * H, order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => data[b] - data[a]);
  const acc = new Float64Array(n), cell = dx * dy, diag = Math.hypot(dx, dy);
  for (let i = 0; i < n; i++) acc[i] = weights ? weights[i] : cell;
  for (let k = 0; k < n; k++) {
    const idx = order[k], i = idx % W, j = (idx / W) | 0, z = data[idx];
    let best = -1, bs = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const s = (z - data[nj * W + ni]) / (di && dj ? diag : di ? dx : dy);
      if (s > bs) { bs = s; best = nj * W + ni; }
    }
    if (best >= 0) acc[best] += acc[idx];
  }
  return Float32Array.from(acc);
}

export function percentiles(arr, lo = 0.02, hi = 0.98) {
  const step = Math.max(1, Math.floor(arr.length / 20000)), s = [];
  for (let i = 0; i < arr.length; i += step) if (Number.isFinite(arr[i])) s.push(arr[i]);
  s.sort((a, b) => a - b);
  return [s[Math.floor(lo * (s.length - 1))], s[Math.floor(hi * (s.length - 1))]];
}

export const autoInterval = range => [0.25, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 500].find(s => range / s <= 40) || 500;

/** d3 contour rings as open polylines in grid coords; segments along the grid border are dropped */
export function contourPolylines(data, W, H, levels) {
  const out = [], onEdge = p => p[0] <= 0 || p[0] >= W || p[1] <= 0 || p[1] >= H;
  if (!levels.length) return out;
  for (const c of d3.contours().size([W, H]).thresholds(levels)(data))
    for (const poly of c.coordinates) for (const ring of poly) {
      let cur = [];
      for (let k = 0; k < ring.length - 1; k++) {
        const p = ring[k], q = ring[k + 1];
        if (onEdge(p) && onEdge(q)) { if (cur.length > 1) out.push({ v: c.value, pts: cur }); cur = []; continue; }
        if (!cur.length) cur.push(p); cur.push(q);
      }
      if (cur.length > 1) out.push({ v: c.value, pts: cur });
    }
  return out;
}
/** grid coord → frame metres */
export const gridToLocal = (dem, frame) => p => [-frame.w / 2 + clamp(p[0] - 0.5, 0, dem.W - 1) * dem.dx, frame.h / 2 - clamp(p[1] - 0.5, 0, dem.H - 1) * dem.dy];

export function contourLevels(min, max, iv, cap = 600) {
  const out = []; for (let v = Math.ceil(min / iv) * iv; v <= max && out.length < cap; v += iv) out.push(+v.toFixed(4)); return out;
}
export const isMajor = (v, iv) => Math.abs(v / (iv * 5) - Math.round(v / (iv * 5))) < 1e-6;

/* colour maps */
export const CMAPS = {
  terrain: ['#24603a', '#4f8f45', '#9fbf63', '#e3d68a', '#c79c62', '#8c6647', '#a49a92', '#f4f4f4'],
  slope: ['#1a9850', '#91cf60', '#d9ef8b', '#fee08b', '#fc8d59', '#d73027', '#7f0000'],
  aspect: ['#e41a1c', '#ff7f00', '#ffff33', '#4daf4a', '#00bfff', '#377eb8', '#984ea3', '#f781bf', '#e41a1c'],
  gray: ['#141414', '#ffffff'], inferno: ['#000004', '#420a68', '#932667', '#dd513a', '#fca50a', '#fcffa4'],
  blues: ['#f7fbff', '#c6dbef', '#6baed6', '#2171b5', '#08306b'], rain: ['#ffffd9', '#c7e9b4', '#41b6c4', '#225ea8', '#081d58'],
  temp: ['#313695', '#74add1', '#e0f3f8', '#fee090', '#f46d43', '#a50026'], plain: ['#e6e1d7', '#e6e1d7']
};
const LUT = {};
export function lut(name) {
  if (LUT[name]) return LUT[name];
  const stops = CMAPS[name].map(h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]), t = new Uint8Array(768);
  for (let k = 0; k < 256; k++) { const f = k / 255 * (stops.length - 1), i = Math.min(Math.floor(f), stops.length - 2), u = f - i; for (let c = 0; c < 3; c++) t[k * 3 + c] = Math.round(stops[i][c] * (1 - u) + stops[i + 1][c] * u); }
  return LUT[name] = t;
}

/** inverse-distance interpolation of climate points onto the grid */
export function idwGrid(dem, frame, points, field) {
  const { W, H } = dem, out = new Float32Array(W * H), pts = points.map(p => [...frame.toLocal(p.lon, p.lat), field(p)]);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const x = -frame.w / 2 + i * dem.dx, y = frame.h / 2 - j * dem.dy; let ws = 0, vs = 0;
    for (const [px, py, v] of pts) { const w = 1 / ((x - px) ** 2 + (y - py) ** 2 + 1); ws += w; vs += w * v; }
    out[j * W + i] = vs / ws;
  }
  return out;
}
