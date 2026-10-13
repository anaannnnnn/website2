// Geodesy for TerraKit: UTM (WGS84) projection, the rotatable site frame, and web-mercator tile maths.
// All drawings and exports work in "frame metres": x along the frame's width, y along its height,
// origin at the frame centre — a rotated UTM grid, so distances and areas are true grid metres.

export const D2R = Math.PI / 180;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ── UTM via Krüger series (sub-millimetre within a zone) ── */
const A_ = 6378137, F_ = 1 / 298.257223563, K0 = 0.9996;
const N_ = F_ / (2 - F_), N2 = N_ * N_, N3 = N2 * N_;
const AA = A_ / (1 + N_) * (1 + N2 / 4 + N2 * N2 / 64);
const ALPHA = [N_ / 2 - 2 / 3 * N2 + 5 / 16 * N3, 13 / 48 * N2 - 3 / 5 * N3, 61 / 240 * N3];
const BETA = [N_ / 2 - 2 / 3 * N2 + 37 / 96 * N3, 1 / 48 * N2 + 1 / 15 * N3, 17 / 480 * N3];
const DELTA = [2 * N_ - 2 / 3 * N2 - 2 * N3, 7 / 3 * N2 - 8 / 5 * N3, 56 / 15 * N3];
const E2N = 2 * Math.sqrt(N_) / (1 + N_);

export const utmZone = lon => clamp(Math.floor((lon + 180) / 6) + 1, 1, 60);
export function utmForward(lon, lat, zone, south) {
  const phi = lat * D2R, lam = (lon - (zone * 6 - 183)) * D2R, s = Math.sin(phi);
  const t = Math.sinh(Math.atanh(s) - E2N * Math.atanh(E2N * s));
  const xi1 = Math.atan2(t, Math.cos(lam)), eta1 = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let xi = xi1, eta = eta1;
  for (let j = 1; j <= 3; j++) { xi += ALPHA[j - 1] * Math.sin(2 * j * xi1) * Math.cosh(2 * j * eta1); eta += ALPHA[j - 1] * Math.cos(2 * j * xi1) * Math.sinh(2 * j * eta1); }
  return [500000 + K0 * AA * eta, K0 * AA * xi + (south ? 10000000 : 0)];
}
export function utmInverse(E, N, zone, south) {
  const xi = (N - (south ? 10000000 : 0)) / (K0 * AA), eta = (E - 500000) / (K0 * AA);
  let xi1 = xi, eta1 = eta;
  for (let j = 1; j <= 3; j++) { xi1 -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); eta1 -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); }
  const chi = Math.asin(Math.sin(xi1) / Math.cosh(eta1));
  let phi = chi; for (let j = 1; j <= 3; j++) phi += DELTA[j - 1] * Math.sin(2 * j * chi);
  return [(zone * 6 - 183) + Math.atan2(Math.sinh(eta1), Math.cos(xi1)) / D2R, phi / D2R];
}

/**
 * Site frame: a rectangle on the ground.
 * @param {{lon:number,lat:number,w:number,h:number,bearing:number}} f  centre, size in metres, bearing (deg clockwise from north) of the frame's "up" edge
 */
export function makeFrame(f) {
  const zone = utmZone(f.lon), south = f.lat < 0, [E0, N0] = utmForward(f.lon, f.lat, zone, south);
  const th = (f.bearing || 0) * D2R, c = Math.cos(th), s = Math.sin(th);
  const fr = {
    ...f, zone, south, E0, N0, epsg: (south ? 32700 : 32600) + zone,
    /** lon/lat → frame metres [x, y] */
    toLocal(lon, lat) { const [E, N] = utmForward(lon, lat, zone, south), dE = E - E0, dN = N - N0; return [dE * c - dN * s, dE * s + dN * c]; },
    /** frame metres → lon/lat */
    toLonLat(x, y) { return utmInverse(E0 + x * c + y * s, N0 - x * s + y * c, zone, south); },
    /** frame metres → UTM easting/northing */
    toUTM(x, y) { return [E0 + x * c + y * s, N0 - x * s + y * c]; },
    /** a direction given as (east, north) components → frame components */
    enToFrame(e, n) { return [e * c - n * s, e * s + n * c]; },
    frameToEn(x, y) { return [x * c + y * s, -x * s + y * c]; },
    corners(m = 0) { const hw = f.w / 2 + m, hh = f.h / 2 + m; return [[-hw, hh], [hw, hh], [hw, -hh], [-hw, -hh]].map(([x, y]) => fr.toLonLat(x, y)); },
    /** lon/lat bounding box of the (rotated) frame, plus a margin in metres */
    bbox(m = 0) { const cs = fr.corners(m), xs = cs.map(p => p[0]), ys = cs.map(p => p[1]); return { w: Math.min(...xs), e: Math.max(...xs), s: Math.min(...ys), n: Math.max(...ys) }; },
    inside(x, y, m = 0) { return Math.abs(x) <= f.w / 2 + m && Math.abs(y) <= f.h / 2 + m; }
  };
  return fr;
}

/* ── web-mercator tiles ── */
export const lonToX = (lon, z) => (lon + 180) / 360 * 256 * 2 ** z;
export const latToY = (lat, z) => { const s = Math.sin(lat * D2R); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z; };

export function bilinear(arr, W, H, x, y) {
  x = clamp(x, 0, W - 1); y = clamp(y, 0, H - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, H - 1), fx = x - x0, fy = y - y0;
  const a = arr[y0 * W + x0], b = arr[y0 * W + x1], c = arr[y1 * W + x0], d = arr[y1 * W + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/* ── sun position (NOAA approximation) ── */
export function sunPosition(ms, lat, lon) {
  const d = (ms - 946728000000) / 86400000, g = (357.529 + 0.98560028 * d) * D2R, q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R, e = (23.439 - 0.00000036 * d) * D2R;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24, H = (gmst * 15 + lon) * D2R - ra, phi = lat * D2R;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H));
  return { alt, az: (az + 2 * Math.PI) % (2 * Math.PI) };
}

/* ── paper & scale ── */
export const PAPER = { A0: [1189, 841], A1: [841, 594], A2: [594, 420], A3: [420, 297], A4: [297, 210] };
export const SCALES = [200, 250, 500, 1000, 1250, 2000, 2500, 5000, 10000];
/** sheet layout in mm: drawing viewport + title column */
export function sheetLayout(paper, orient = 'landscape') {
  let [W, H] = PAPER[paper]; if (orient === 'portrait') [W, H] = [H, W];
  const m = W >= 590 ? 12 : 8, tb = W >= 590 ? 70 : W >= 400 ? 56 : 46;
  return { W, H, margin: m, title: tb, vx: m, vy: m, vw: W - 2 * m - tb - 4, vh: H - 2 * m };
}
