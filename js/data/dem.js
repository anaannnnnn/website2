// Elevation from AWS Terrain Tiles (Mapzen "terrarium"), resampled onto a frame-aligned metric grid.
import { bilinear, clamp, latToY, lonToX } from '../geo.js';
import { sleep } from '../util.js';

const TILE = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

async function loadTile(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { mode: 'cors' });
      if (!r.ok) throw new Error(r.status);
      return await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    } catch (e) { if (i === 2) throw e; await sleep(400 * (i + 1)); }
  }
}

export async function fetchMosaic(b, z, urlFn, onProgress, tolerant = false) {
  const x0 = Math.floor(lonToX(b.w, z) / 256), x1 = Math.floor(lonToX(b.e, z) / 256), y0 = Math.floor(latToY(b.n, z) / 256), y1 = Math.floor(latToY(b.s, z) / 256);
  const cv = document.createElement('canvas'); cv.width = (x1 - x0 + 1) * 256; cv.height = (y1 - y0 + 1) * 256;
  const ctx = cv.getContext('2d', { willReadFrequently: true }), jobs = [];
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) jobs.push([tx, ty]);
  let next = 0, done = 0, failed = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const [tx, ty] = jobs[next++];
      try { ctx.drawImage(await loadTile(urlFn(z, tx, ty)), (tx - x0) * 256, (ty - y0) * 256); }
      catch (e) { failed++; if (!tolerant) throw new Error(`tile ${z}/${tx}/${ty} failed`); }
      onProgress && onProgress(++done / jobs.length);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { cv, ctx, x0, y0, z, failed, tiles: jobs.length };
}

/** Terrain tiles occasionally contain deep dropout holes; mask far-below-range cells (+halo) and refill from neighbours. */
function despike(data, W, H) {
  const s = []; for (let i = 0; i < data.length; i += Math.max(1, Math.floor(data.length / 20000))) s.push(data[i]);
  s.sort((a, b) => a - b);
  const p2 = s[Math.floor(0.02 * (s.length - 1))], p98 = s[Math.floor(0.98 * (s.length - 1))], fence = p2 - Math.max(15, 2 * (p98 - p2));
  let mask = new Uint8Array(W * H), n = 0;
  for (let k = 0; k < data.length; k++) if (data[k] < fence) { mask[k] = 1; n++; }
  if (!n || n > data.length * 0.25) return 0;
  for (let pass = 0; pass < 2; pass++) {
    const m2 = mask.slice();
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (mask[j * W + i]) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const a = i + di, b = j + dj; if (a >= 0 && b >= 0 && a < W && b < H) m2[b * W + a] = 1; }
    mask = m2;
  }
  let left = mask.reduce((a, v) => a + v, 0); const total = left;
  for (let it = 0; left && it < 4 * (W + H); it++) {
    const fill = [];
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const k = j * W + i; if (!mask[k]) continue;
      let sum = 0, c = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const a = i + di, b = j + dj; if (a >= 0 && b >= 0 && a < W && b < H && !mask[b * W + a]) { sum += data[b * W + a]; c++; } }
      if (c) fill.push([k, sum / c]);
    }
    for (const [k, v] of fill) { data[k] = v; mask[k] = 0; left--; }
    if (!fill.length) break;
  }
  return total;
}

/** Which surveys feed AWS Terrain Tiles at this location (Mapzen/Tilezen documentation), for the quality stamp. */
export function terrainSourceNote(lon, lat) {
  const inBox = (w, s, e, n) => lon >= w && lon <= e && lat >= s && lat <= n;
  if (inBox(-125, 24, -66, 50) || inBox(-170, 51, -129, 72) || inBox(-161, 18, -154, 23)) return { name: 'USGS 3DEP / NED (USA)', res: '≈3–10 m', acc: '±1–3 m' };
  if (inBox(-8.7, 49.8, 1.8, 59)) return { name: 'Environment Agency LIDAR (UK, where flown) + SRTM', res: '≈2 m where LIDAR', acc: '±0.2–5 m' };
  if (inBox(4.5, 57.8, 31.5, 71.5)) return { name: 'Kartverket DEM (Norway) + EU-DEM', res: '≈10 m', acc: '±2–5 m' };
  if (inBox(9.5, 46.3, 17.2, 49.1)) return { name: 'Austrian DEM 10 m + EU-DEM', res: '≈10 m', acc: '±2–5 m' };
  if (inBox(166, -47.5, 179, -34)) return { name: 'LINZ 8 m DEM (New Zealand)', res: '≈8 m', acc: '±2–5 m' };
  if (inBox(-118.5, 14.5, -86.5, 32.8)) return { name: 'INEGI (Mexico) + SRTM', res: '≈15–30 m', acc: '±5 m' };
  if (inBox(-141, 41.6, -52, 83)) return { name: 'CDEM (Canada) + SRTM', res: '≈20–30 m', acc: '±5 m' };
  if (inBox(-25, 34, 45, 72)) return { name: 'EU-DEM (Copernicus) + SRTM', res: '≈25–30 m', acc: '±2–7 m' };
  if (lat > -56 && lat < 60) return { name: 'SRTM (NASA)', res: '≈30 m', acc: '±5–10 m, includes buildings/trees' };
  return { name: 'GMTED / ETOPO', res: '≈90–500 m', acc: '±10–30 m' };
}

/**
 * Sample the DEM on a frame-aligned grid.
 * @param frame makeFrame(...) object; N = grid points on the long side
 */
export async function buildDEM(frame, N, onProgress) {
  let W, H;
  if (frame.w >= frame.h) { W = N; H = Math.max(8, Math.round(N * frame.h / frame.w)); } else { H = N; W = Math.max(8, Math.round(N * frame.w / frame.h)); }
  const dx = frame.w / (W - 1), dy = frame.h / (H - 1), b = frame.bbox(Math.max(dx, dy) * 2);
  const mpp0 = 156543.034 * Math.cos(frame.lat * Math.PI / 180);
  let z = clamp(Math.ceil(Math.log2(mpp0 / Math.min(dx, dy))), 1, 15);
  const tiles = z => (Math.floor(lonToX(b.e, z) / 256) - Math.floor(lonToX(b.w, z) / 256) + 1) * (Math.floor(latToY(b.s, z) / 256) - Math.floor(latToY(b.n, z) / 256) + 1);
  while (z > 1 && tiles(z) > 300) z--;
  const mos = await fetchMosaic(b, z, TILE, onProgress);
  const CW = mos.cv.width, CH = mos.cv.height, px = mos.ctx.getImageData(0, 0, CW, CH).data, elev = new Float32Array(CW * CH);
  for (let k = 0, p = 0; k < elev.length; k++, p += 4) elev[k] = px[p] * 256 + px[p + 1] + px[p + 2] / 256 - 32768;
  const data = new Float32Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const [lon, lat] = frame.toLonLat(-frame.w / 2 + i * dx, frame.h / 2 - j * dy);
    data[j * W + i] = bilinear(elev, CW, CH, lonToX(lon, z) - mos.x0 * 256 - 0.5, latToY(lat, z) - mos.y0 * 256 - 0.5);
  }
  const repaired = despike(data, W, H);
  let min = Infinity, max = -Infinity, sum = 0;
  for (const v of data) { if (v < min) min = v; if (v > max) max = v; sum += v; }
  return { W, H, data, min, max, mean: sum / data.length, dx, dy, zoom: z, repaired, groundRes: mpp0 / 2 ** z };
}

/** elevation at frame metres */
export function demAt(dem, frame, x, y, data = dem.data) {
  return bilinear(data, dem.W, dem.H, (x + frame.w / 2) / dem.dx, (frame.h / 2 - y) / dem.dy);
}
