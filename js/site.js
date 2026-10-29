// Builds the normalised site model from conflated and supplementary footprints.
import { bilinear } from './geo.js';

const ringArea = ring => { let a = 0; for (let k = 0; k < ring.length - 1; k++) a += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1]; return a / 2; };
export const absArea = ring => Math.abs(ringArea(ring));

const osmHeightTags = t => {
  const h = parseFloat(String(t.height || '').replace(',', '.'));
  if (Number.isFinite(h) && h > 0) return { h, how: 'recorded height' };
  const levels = parseFloat(t['building:levels']), roofLevels = parseFloat(t['roof:levels']);
  if (Number.isFinite(levels) && levels > 0) return { h: levels * 3 + (Number.isFinite(roofLevels) ? roofLevels * 2.5 : 0), how: 'floors × 3 m' };
  return null;
};
const osmRoofDirection = t => {
  const d = parseFloat(t['roof:direction']);
  return Number.isFinite(d) ? (d + 90) % 360 : null;
};

const osmSourceId = id => String(id || '').split('@')[0].replace(/^way\//, 'w').replace(/^node\//, 'n').replace(/^relation\//, 'r');

export function normaliseBuildings(frame, { overture, parts, osm, vt }, defaultH) {
  const buildings = [], buildingParts = [];
  const localise = rings => rings.map(r => r.map(p => frame.toLocal(p[0], p[1])));
  const stats = rings => {
    const r = rings?.[0]; if (!r?.length) return null;
    const pts = r.slice(0, -1), xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const c = pts.reduce((a, p) => [a[0] + p[0] / pts.length, a[1] + p[1] / pts.length], [0, 0]);
    return { c, area: absArea(r), x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };
  // Tight overlap plus centroid checks prevent nearby metadata being assigned to
  // the wrong building while still matching slightly different source outlines.
  const sameFootprint = (aRings, bRings) => {
    const a = stats(aRings), b = stats(bRings); if (!a || !b || !a.area || !b.area) return false;
    const intersection = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    const minBox = Math.max(1, Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0)));
    const tolerance = Math.max(3, Math.min(8, Math.sqrt(Math.min(a.area, b.area)) * 0.5));
    return intersection / minBox > 0.55 && Math.hypot(a.c[0] - b.c[0], a.c[1] - b.c[1]) < tolerance;
  };
  const osmRecords = (osm || []).map(b => ({ b, loc: localise(b.rings) })).filter(x => x.loc[0]?.length);
  const add = (rings, record) => {
    const loc = localise(rings), outer = loc[0]; if (!outer || outer.length < 4 || absArea(outer) < 4) return null;
    const xs = outer.map(p => p[0]), ys = outer.map(p => p[1]);
    // Bbox intersection retains large footprints that completely contain the
    // frame, which the former vertex-only check incorrectly dropped.
    if (Math.max(...xs) < -frame.w / 2 - 30 || Math.min(...xs) > frame.w / 2 + 30 || Math.max(...ys) < -frame.h / 2 - 30 || Math.min(...ys) > frame.h / 2 + 30) return null;
    let cx = 0, cy = 0; for (const p of outer) { cx += p[0]; cy += p[1]; } cx /= outer.length; cy /= outer.length;
    const inFrame = frame.inside(cx, cy) || outer.some(p => frame.inside(p[0], p[1])) || (Math.min(...xs) <= 0 && Math.max(...xs) >= 0 && Math.min(...ys) <= 0 && Math.max(...ys) >= 0);
    const b = { ...record, rings, loc, h: record.h ?? defaultH, known: record.h != null, inFrame };
    buildings.push(b); return b;
  };
  const matchingOsm = (rings, sourceIds = []) => {
    for (const id of sourceIds) { const found = osmRecords.find(x => x.b.id === osmSourceId(id)); if (found) return found; }
    const local = localise(rings);
    return osmRecords.find(x => sameFootprint(local, x.loc)) || null;
  };
  const osmRecord = b => {
    const t = b.tags || {}, height = osmHeightTags(t);
    return {
      id: b.id || 'osm', h: height?.h ?? null, how: height?.how || 'unknown — default used', floors: parseFloat(t['building:levels']) || null,
      minHeight: parseFloat(t.min_height) || 0, roofShape: t['roof:shape'] || null,
      roofHeight: parseFloat(t['roof:height']) || (parseFloat(t['roof:levels']) || 0) * 2.5 || null,
      roofDirection: osmRoofDirection(t), roofOrientation: t['roof:orientation'] || null,
      roofColor: t['roof:colour'] || t['roof:color'] || null, facadeColor: t['building:colour'] || t['building:color'] || null,
      roofMaterial: t['roof:material'] || null, facadeMaterial: t['building:material'] || null,
      cls: t.building, use: t['building:use'] || t.amenity || t.office || t.shop || t.building || null,
      year: t.start_date || t['building:year'] || null, material: t['building:material'] || t.material || null,
      name: t['name:en'] || t.name, metadataSource: 'OpenStreetMap', src: 'OpenStreetMap'
    };
  };

  for (const b of overture || []) {
    let height = null, how = 'unknown — default used';
    if (Number.isFinite(b.height) && b.height > 0) { height = b.height; how = 'recorded height'; }
    else if (Number.isFinite(b.floors) && b.floors > 0) { height = b.floors * 3; how = 'floors × 3 m'; }
    const match = matchingOsm(b.rings, b.sourceIds), tags = match?.b.tags || {}, osmHeight = osmHeightTags(tags);
    add(b.rings, {
      id: b.id, h: height ?? osmHeight?.h ?? null, how: height != null ? how : (osmHeight?.how || how), floors: b.floors || parseFloat(tags['building:levels']) || null,
      minHeight: b.minHeight || parseFloat(tags.min_height) || 0, roofShape: b.roofShape || tags['roof:shape'] || null,
      roofHeight: b.roofHeight ?? (parseFloat(tags['roof:height']) || (parseFloat(tags['roof:levels']) || 0) * 2.5 || null),
      roofDirection: b.roofDirection ?? osmRoofDirection(tags), roofOrientation: b.roofOrientation || tags['roof:orientation'] || null,
      roofColor: b.roofColor || tags['roof:colour'] || tags['roof:color'] || null, roofMaterial: b.roofMaterial || tags['roof:material'] || null,
      facadeColor: b.facadeColor || tags['building:colour'] || tags['building:color'] || null, facadeMaterial: b.facadeMaterial || tags['building:material'] || null,
      hasParts: b.hasParts, cls: b.class || tags.building, use: tags['building:use'] || tags.amenity || tags.office || tags.shop || b.class || tags.building || null,
      year: tags.start_date || tags['building:year'] || null, material: tags['building:material'] || tags.material || null,
      name: b.name || tags['name:en'] || tags.name, metadataSource: match ? 'OpenStreetMap' : null,
      sourceIds: b.sourceIds || [], src: (b.sources || []).join(', ') || 'Overture'
    });
  }

  // Overture is the conflated backbone, but retain OSM and vector-tile features
  // it does not contain instead of treating any Overture hit as complete coverage.
  for (const { b, loc } of osmRecords) if (!buildings.some(x => sameFootprint(x.loc, loc))) add(b.rings, osmRecord(b));
  for (const b of vt || []) {
    const loc = localise(b.rings); if (buildings.some(x => sameFootprint(x.loc, loc))) continue;
    const h = Number.isFinite(b.height) && b.height > 0 ? b.height : null;
    add(b.rings, { id: b.id || 'openfreemap', h, how: h ? 'OpenFreeMap render height (may be estimated)' : 'unknown — default used', floors: null, minHeight: b.minHeight || 0, roofShape: null, use: null, year: null, material: null, src: 'OpenFreeMap tiles' });
  }

  for (const p of parts || []) {
    const loc = localise(p.rings), outer = loc[0]; if (!outer?.length) continue;
    const xs = outer.map(q => q[0]), ys = outer.map(q => q[1]);
    if (Math.max(...xs) < -frame.w / 2 - 30 || Math.min(...xs) > frame.w / 2 + 30 || Math.max(...ys) < -frame.h / 2 - 30 || Math.min(...ys) > frame.h / 2 + 30) continue;
    const h = Number.isFinite(p.height) && p.height > 0 ? p.height : (Number.isFinite(p.floors) && p.floors > 0 ? p.floors * 3 : null);
    const center = outer.reduce((a, q) => [a[0] + q[0] / outer.length, a[1] + q[1] / outer.length], [0, 0]);
    const inFrame = frame.inside(center[0], center[1]) || outer.some(q => frame.inside(q[0], q[1])) || (Math.min(...xs) <= 0 && Math.max(...xs) >= 0 && Math.min(...ys) <= 0 && Math.max(...ys) >= 0);
    buildingParts.push({ ...p, loc, h: h ?? defaultH, known: h != null, isPart: true, inFrame, how: h != null ? (p.height ? 'recorded part height' : 'part floors × 3 m') : 'unknown — default used' });
  }
  const sources = [...new Set(buildings.flatMap(b => String(b.src || '').split(', ')).filter(Boolean))];
  return { buildings, parts: buildingParts, source: sources.join(' + ') || 'none' };
}

/** convert OSM layers to frame metres (keeps lon/lat for GeoJSON export) */
export function localiseOSM(frame, o) {
  const L = p => frame.toLocal(p[0], p[1]);
  return {
    roads: o.roads.map(r => ({ ...r, loc: r.pts.map(L) })),
    rails: o.rails.map(r => ({ ...r, loc: r.pts.map(L) })),
    water: o.water.map(w => ({ ...w, loc: w.ring.map(L) })),
    waterways: o.waterways.map(w => ({ ...w, loc: w.pts.map(L) })),
    green: o.green.map(g => ({ ...g, loc: g.ring.map(L) })),
    landuse: o.landuse.map(g => ({ ...g, loc: g.ring.map(L) })),
    trees: o.trees.map(t => ({ ...t, loc: L([t.lon, t.lat]), h: parseFloat(t.tags.height) || null })),
    places: o.places.map(p => ({ ...p, loc: L([p.lon, p.lat]) })),
    pois: (o.pois || []).map(p => ({ ...p, loc: L([p.lon, p.lat]) })),
    parcels: (o.parcels || []).map(p => ({ ...p, loc: p.ring.map(L) }))
  };
}

/** ground elevation under a building: lowest DEM value at its footprint vertices */
export function buildingBase(b, zAt) { let z = Infinity; for (const p of b.loc[0]) z = Math.min(z, zAt(p[0], p[1])); return z; }

export function makeZAt(dem, frame, data) {
  return (x, y) => bilinear(data || dem.data, dem.W, dem.H, (x + frame.w / 2) / dem.dx, (frame.h / 2 - y) / dem.dy);
}

export function heightStats(buildings) {
  const n = buildings.length, rec = buildings.filter(b => b.how === 'recorded height' || b.how === 'recorded part height').length, fl = buildings.filter(b => b.how === 'floors × 3 m' || b.how === 'part floors × 3 m').length;
  return { n, recorded: rec, floors: fl, unknown: n - rec - fl, pct: n ? (rec + fl) / n * 100 : 0 };
}
