// Evidence-led advanced site analysis. The single public interface is analyseSite(model).
// Every returned value includes its method/source class so the UI can distinguish measured,
// mapped, modelled and indicative results. No missing input is silently substituted.
import { sunPosition } from './geo.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const finite = v => Number.isFinite(v);
const sum = a => a.reduce((s, v) => s + v, 0);
const percentile = (values, p) => {
  const a = values.filter(finite).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.round((a.length - 1) * p)];
};
const area = ring => {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(a) / 2;
};
const contains = (ring, x, y) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / ((b[1] - a[1]) || 1e-12) + a[0]) inside = !inside;
  }
  return inside;
};

/** Sutherland–Hodgman clip against the exact rectangular project frame. */
export function clipToFrame(ring, frame) {
  let out = ring.slice(), bounds = [
    { inside: p => p[0] >= -frame.w / 2, cross: (p, q) => { const v = -frame.w / 2; return [v, p[1] + (q[1] - p[1]) * (v - p[0]) / ((q[0] - p[0]) || 1e-12)]; } },
    { inside: p => p[0] <= frame.w / 2, cross: (p, q) => { const v = frame.w / 2; return [v, p[1] + (q[1] - p[1]) * (v - p[0]) / ((q[0] - p[0]) || 1e-12)]; } },
    { inside: p => p[1] >= -frame.h / 2, cross: (p, q) => { const v = -frame.h / 2; return [p[0] + (q[0] - p[0]) * (v - p[1]) / ((q[1] - p[1]) || 1e-12), v]; } },
    { inside: p => p[1] <= frame.h / 2, cross: (p, q) => { const v = frame.h / 2; return [p[0] + (q[0] - p[0]) * (v - p[1]) / ((q[1] - p[1]) || 1e-12), v]; } }
  ];
  for (const edge of bounds) {
    const input = out; out = [];
    if (!input.length) break;
    let p = input[input.length - 1], pin = edge.inside(p);
    for (const q of input) {
      const qin = edge.inside(q);
      if (qin !== pin) out.push(edge.cross(p, q));
      if (qin) out.push(q);
      p = q; pin = qin;
    }
  }
  return out;
}

const clippedArea = (feature, frame) => area(clipToFrame(feature.loc || [], frame));
const classifyUse = b => {
  const s = String(b.use || b.cls || '').toLowerCase();
  if (/house|residential|apart|dorm|bungalow|terrace/.test(s)) return 'Residential';
  if (/retail|shop|commercial|office|supermarket/.test(s)) return 'Commercial';
  if (/school|college|university|education/.test(s)) return 'Education';
  if (/hospital|clinic|health/.test(s)) return 'Healthcare';
  if (/industrial|warehouse|factory/.test(s)) return 'Industrial';
  if (/relig|mosque|church|temple|synagogue/.test(s)) return 'Religious';
  if (/civic|public|government|transport/.test(s)) return 'Civic / transport';
  return s ? 'Other mapped use' : 'Unknown';
};

const segmentLengthInFrame = (a, b, f) => {
  // Liang–Barsky; returns the length of only the portion inside the frame.
  const dx = b[0] - a[0], dy = b[1] - a[1], p = [-dx, dx, -dy, dy];
  const q = [a[0] + f.w / 2, f.w / 2 - a[0], a[1] + f.h / 2, f.h / 2 - a[1]];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (!p[i] && q[i] < 0) return 0;
    if (!p[i]) continue;
    const r = q[i] / p[i];
    if (p[i] < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
    if (t0 > t1) return 0;
  }
  return Math.hypot(dx, dy) * (t1 - t0);
};
const lineLength = (pts, f) => sum(pts.slice(1).map((p, i) => segmentLengthInFrame(pts[i], p, f)));

const raySegment = (dx, dy, a, b) => {
  const sx = b[0] - a[0], sy = b[1] - a[1], den = dx * sy - dy * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = (a[0] * sy - a[1] * sx) / den, u = (a[0] * dy - a[1] * dx) / den;
  return t > 0 && u >= 0 && u <= 1 ? t : null;
};

function horizonProfile(M, bins = 72) {
  const out = new Float32Array(bins), originZ = M.zAt(0, 0) + 1.6;
  if (M.buildings.some(b => b.loc?.[0] && contains(b.loc[0], 0, 0) && b.base + b.h > originZ)) {
    out.fill(Math.PI / 2);
    return out;
  }
  for (let k = 0; k < bins; k++) {
    const a = k / bins * Math.PI * 2, dx = Math.sin(a), dy = Math.cos(a);
    let ang = 0;
    // Terrain horizon, sampled at a spacing tied to source grid resolution.
    const maxD = Math.hypot(M.frame.w, M.frame.h) / 2, step = Math.max(M.dem.dx, M.dem.dy) * 1.5;
    for (let d = step; d <= maxD; d += step) {
      const x = dx * d, y = dy * d;
      if (!M.frame.inside(x, y)) break;
      ang = Math.max(ang, Math.atan2(M.zAt(x, y) - originZ, d));
    }
    // Exact ray intersections with mapped building footprint edges.
    for (const b of M.buildings) for (const ring of b.loc) {
      let near = Infinity;
      for (let i = 1; i < ring.length; i++) {
        const t = raySegment(dx, dy, ring[i - 1], ring[i]);
        if (t != null) near = Math.min(near, t);
      }
      if (near < Infinity) ang = Math.max(ang, Math.atan2(b.base + b.h - originZ, near));
    }
    out[k] = clamp(ang, 0, Math.PI / 2);
  }
  return out;
}

function solarAccess(M, horizon) {
  const year = M.climate?.year || new Date().getUTCFullYear() - 1, monthly = [];
  for (let mo = 0; mo < 12; mo++) {
    let daylight = 0, visible = 0;
    for (let h = 0; h < 24; h += 0.25) {
      const p = sunPosition(Date.UTC(year, mo, 21) + (h - M.frame.lon / 15) * 3600000, M.frame.lat, M.frame.lon);
      if (p.alt <= 0) continue;
      daylight += .25;
      const [fx, fy] = M.frame.enToFrame(Math.sin(p.az), Math.cos(p.az));
      const az = (Math.atan2(fx, fy) + Math.PI * 2) % (Math.PI * 2), k = Math.round(az / (Math.PI * 2) * horizon.length) % horizon.length;
      if (p.alt > horizon[k]) visible += .25;
    }
    monthly.push({ month: mo, daylight, visible, access: daylight ? visible / daylight * 100 : 0 });
  }
  return { monthly, annualMeanHours: sum(monthly.map(x => x.visible)) / 12, annualAccess: sum(monthly.map(x => x.visible)) / Math.max(1, sum(monthly.map(x => x.daylight))) * 100 };
}

function terrainViewshed(M) {
  const N = 27, z0 = M.zAt(0, 0) + 1.6; let visible = 0, tested = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = (i / (N - 1) - .5) * M.frame.w, y = (.5 - j / (N - 1)) * M.frame.h, d = Math.hypot(x, y);
    if (d < Math.max(M.dem.dx, M.dem.dy) * 2) continue;
    const target = Math.atan2(M.zAt(x, y) - z0, d); let blocked = false;
    const steps = Math.max(8, Math.min(40, Math.ceil(d / Math.max(M.dem.dx, M.dem.dy))));
    for (let s = 1; s < steps; s++) {
      const q = s / steps, a = Math.atan2(M.zAt(x * q, y * q) - z0, d * q);
      if (a > target + 0.002) { blocked = true; break; }
    }
    tested++; if (!blocked) visible++;
  }
  return tested ? visible / tested * 100 : null;
}

const POI_GROUPS = {
  'Daily needs': /supermarket|convenience|marketplace|greengrocer|bakery|pharmacy/,
  'Public transport': /bus_stop|station|platform|public_transport/,
  'Education': /school|kindergarten|college|university|library/,
  'Health': /hospital|clinic|doctors|dentist|pharmacy/,
  'Food & social': /restaurant|cafe|fast_food|bar|community_centre/,
  'Open space': /park|garden|playground|nature_reserve/
};
function accessAnalysis(pois = []) {
  const groups = Object.entries(POI_GROUPS).map(([name, re]) => {
    const matches = pois.filter(p => re.test(String(p.kind))), ds = matches.map(p => Math.hypot(p.loc[0], p.loc[1]));
    return { name, count: matches.length, nearest: ds.length ? Math.min(...ds) : null };
  });
  const available = groups.filter(g => g.nearest != null);
  const score = available.length ? sum(available.map(g => Math.exp(-g.nearest / 800))) / groups.length * 100 : null;
  return { groups, score };
}

function comfortAnalysis(climate) {
  const h = climate?.hourly;
  if (!h?.apparent?.length) return null;
  const a = h.apparent.filter(finite), r = h.radiation.filter(finite);
  return {
    hours: a.length,
    comfortablePct: a.filter(v => v >= 18 && v <= 26).length / a.length * 100,
    heatStressPct: a.filter(v => v >= 32).length / a.length * 100,
    coldStressPct: a.filter(v => v <= 0).length / a.length * 100,
    p05: percentile(a, .05), p50: percentile(a, .5), p95: percentile(a, .95),
    solarKWhM2: sum(r) / 1000
  };
}

export function analyseSite(M) {
  if (!M?.frame || !M?.dem) throw new Error('A loaded TerraKit site model is required.');
  const f = M.frame, siteArea = f.w * f.h;
  let footprint = 0, grossFloor = 0, knownFloorArea = 0;
  const uses = new Map();
  for (const b of M.buildings.filter(b => b.inFrame)) {
    const a = area(clipToFrame(b.loc[0], f)); if (!a) continue;
    footprint += a;
    const floors = b.floors || (b.known ? Math.max(1, b.h / 3.5) : null);
    if (floors) { grossFloor += a * floors; knownFloorArea += a; }
    const u = classifyUse(b); uses.set(u, (uses.get(u) || 0) + a);
  }
  const polygonRatio = list => clamp(sum((list || []).map(x => clippedArea(x, f))) / siteArea * 100, 0, 100);
  const roadWeights = { motorway: 8, trunk: 7, primary: 6, secondary: 4, tertiary: 3, residential: 1.5, service: 1, living_street: .6, footway: 0, path: 0, cycleway: 0 };
  let roadKm = 0, roadExposure = 0;
  for (const r of M.osm.roads) {
    const len = lineLength(r.loc, f); roadKm += len / 1000;
    roadExposure += len * (roadWeights[r.tags.highway] ?? 1);
  }
  const horizon = horizonProfile(M), solar = solarAccess(M, horizon), svf = sum([...horizon].map(a => Math.cos(a) ** 2)) / horizon.length * 100;
  const access = accessAnalysis(M.osm.pois), comfort = comfortAnalysis(M.climate);
  const inFrameBuildings = M.buildings.filter(b => b.inFrame), years = inFrameBuildings.map(b => parseInt(String(b.year || '').slice(0, 4), 10)).filter(y => y > 1000 && y <= new Date().getFullYear());
  const materials = new Map(); inFrameBuildings.forEach(b => { if (b.material) materials.set(b.material, (materials.get(b.material) || 0) + 1); });
  return {
    generatedAt: new Date().toISOString(), site: { areaM2: siteArea, widthM: f.w, heightM: f.h, latitude: f.lat, longitude: f.lon },
    urban: {
      buildings: inFrameBuildings.length,
      footprintM2: footprint,
      coveragePct: footprint / siteArea * 100,
      grossFloorAreaM2: grossFloor || null,
      floorAreaCoveragePct: footprint ? knownFloorArea / footprint * 100 : 0,
      far: grossFloor ? grossFloor / siteArea : null,
      uses: [...uses].map(([name, areaM2]) => ({ name, areaM2, pct: footprint ? areaM2 / footprint * 100 : 0 })).sort((a, b) => b.areaM2 - a.areaM2),
      yearKnownPct: inFrameBuildings.length ? years.length / inFrameBuildings.length * 100 : 0,
      yearMedian: percentile(years, .5),
      materials: [...materials].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      greenPct: polygonRatio(M.osm.green), waterPct: polygonRatio(M.osm.water), roadKm,
      parcels: { count: M.osm.parcels.length, coveragePct: polygonRatio(M.osm.parcels) }
    },
    environment: {
      skyViewPct: svf,
      terrainVisiblePct: terrainViewshed(M),
      solar,
      comfort,
      roadExposureIndex: roadExposure / Math.max(1, siteArea) * 1000,
      access,
      solarResource: M.solarResource || null,
      airQuality: M.airQuality || null
    },
    evidence: {
      buildings: M.bsource,
      terrain: M.terrain?.name || 'terrain model',
      context: 'OpenStreetMap live data',
      climate: M.climate ? `Open-Meteo ERA5 ${M.climate.year}` : null,
      solarResource: M.solarResource?.source || null,
      airQuality: M.airQuality?.source || null,
      methods: {
        coverage: 'Mapped polygons clipped exactly to the rectangular project frame.',
        floorArea: 'Footprint × recorded floors; recorded height ÷ 3.5 m only where floors are absent. Unknown-height buildings excluded.',
        skyView: '2.5D radial horizon at the site centre using terrain and mapped building heights, 72 azimuths.',
        sunlight: '15-minute sun positions on the 21st of every month tested against the terrain/building horizon at the site centre.',
        viewshed: 'Terrain-only line-of-sight sample from 1.6 m eye height over a 27×27 grid.',
        access: 'Straight-line proximity to mapped OpenStreetMap amenities; not a pedestrian-network travel-time result.',
        roadExposure: 'Relative road-class/length exposure index; not a measured or predicted decibel level.',
        comfort: 'Open-Meteo apparent temperature; comfort band 18–26 °C. This is not a CFD or UTCI simulation.',
        solarResource: 'JRC PVGIS long-term typical-year calculation at the site coordinate; 1 kWp fixed system, optimum tilt, 14% assumed system losses. It is not a roof-specific shading or structural assessment.',
        airQuality: 'First available hourly CAMS forecast value from the nearest Open-Meteo grid cell. Forecast resolution is about 11 km in Europe and 45 km globally; it is not an observation from a local monitoring station.'
      }
    },
    unavailable: [
      !M.osm.parcels.length && 'Authoritative cadastral parcels are not globally open; no parcel result is shown where OSM has no explicit parcel boundaries.',
      !M.climate?.hourly && 'Hourly comfort and radiation data were unavailable from Open-Meteo.',
      M.layers?.solarResource === false && 'Long-term solar resource was not requested.',
      M.layers?.solarResource !== false && !M.solarResource && 'Long-term PV yield and optimum-plane solar resource were unavailable from JRC PVGIS.',
      M.layers?.airQuality === false && 'Air quality was not requested.',
      M.layers?.airQuality !== false && !M.airQuality && 'Air quality is unavailable when the CAMS/Open-Meteo forecast has no result for this location.',
      !M.osm.pois.length && 'No mapped amenities were returned, so accessibility is unavailable.',
      'Population and demographic outputs require an authoritative census or licensed gridded-population source; no population values are inferred from buildings.',
      'Traffic noise in dB requires observed traffic counts, speed, pavement and barrier data; TerraKit reports a transparent relative road-exposure index instead.',
      'Building-resolving wind requires a validated CFD model and boundary conditions; TerraKit reports measured/reanalysis wind climate, not invented local flow.'
    ].filter(Boolean)
  };
}

