// Builds the normalised "site model": every feature converted to frame metres, buildings with an
// explicit, honest height source. Nothing here is invented — unknown heights stay flagged as unknown.
import { bilinear } from './geo.js';

const ringArea = ring => { let a = 0; for (let k = 0; k < ring.length - 1; k++) a += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1]; return a / 2; };
export const absArea = ring => Math.abs(ringArea(ring));

export function normaliseBuildings(frame, { overture, osm, vt }, defaultH) {
  const out = [];
  const add = (rings, rec) => {
    const loc = rings.map(r => r.map(p => frame.toLocal(p[0], p[1])));
    if (!loc[0] || loc[0].length < 4) return;
    if (!loc[0].some(p => frame.inside(p[0], p[1], 30))) return;
    if (absArea(loc[0]) < 4) return;
    let cx = 0, cy = 0; for (const p of loc[0]) { cx += p[0]; cy += p[1]; } cx /= loc[0].length; cy /= loc[0].length;
    out.push({ ...rec, rings, loc, h: rec.h ?? defaultH, known: rec.h != null, inFrame: frame.inside(cx, cy) });
  };
  if (overture && overture.length) {
    for (const b of overture) {
      let h = null, how = 'unknown — default used';
      if (b.height) { h = b.height - (b.minHeight || 0); how = 'recorded height'; }
      else if (b.floors) { h = b.floors * 3.5; how = 'floors × 3.5 m'; }
      add(b.rings, { id: b.id, h, how, minHeight: b.minHeight || 0, roofShape: b.roofShape, cls: b.class, name: b.name, src: b.sources.join(', ') || 'Overture' });
    }
    return { buildings: out, source: 'Overture Maps' };
  }
  if (osm && osm.length) {
    for (const b of osm) {
      const t = b.tags, oh = osmHeightTags(t);
      add(b.rings, { id: 'osm', h: oh ? oh.h : null, how: oh ? oh.how : 'unknown — default used', cls: t.amenity === 'place_of_worship' ? (t.religion === 'muslim' ? 'mosque' : 'religious') : t.building, name: t['name:en'] || t.name, src: 'OpenStreetMap' });
    }
    return { buildings: out, source: 'OpenStreetMap' };
  }
  if (vt && vt.length) {
    for (const b of vt) add(b.rings, { id: 'vt', h: b.height ? b.height - (b.minHeight || 0) : null, how: b.height ? 'OpenFreeMap render height (may be estimated)' : 'unknown — default used', src: 'OpenFreeMap' });
    return { buildings: out, source: 'OpenFreeMap tiles' };
  }
  return { buildings: out, source: 'none' };
}
function osmHeightTags(t) {
  const h = parseFloat(String(t.height || '').replace(',', '.'));
  if (Number.isFinite(h) && h > 0) return { h, how: 'recorded height' };
  const lv = parseFloat(t['building:levels']);
  if (Number.isFinite(lv) && lv > 0) return { h: lv * 3.5, how: 'floors × 3.5 m' };
  return null;
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
    places: o.places.map(p => ({ ...p, loc: L([p.lon, p.lat]) }))
  };
}

/** ground elevation under a building: lowest DEM value at its footprint vertices */
export function buildingBase(b, zAt) { let z = Infinity; for (const p of b.loc[0]) z = Math.min(z, zAt(p[0], p[1])); return z; }

export function makeZAt(dem, frame, data) {
  return (x, y) => bilinear(data || dem.data, dem.W, dem.H, (x + frame.w / 2) / dem.dx, (frame.h / 2 - y) / dem.dy);
}

export function heightStats(buildings) {
  const n = buildings.length, rec = buildings.filter(b => b.how === 'recorded height').length, fl = buildings.filter(b => b.how === 'floors × 3.5 m').length;
  return { n, recorded: rec, floors: fl, unknown: n - rec - fl, pct: n ? (rec + fl) / n * 100 : 0 };
}
