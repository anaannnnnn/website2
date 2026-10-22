// Builds the normalised "site model": every feature converted to frame metres, buildings with an
// explicit, honest height source. Nothing here is invented — unknown heights stay flagged as unknown.
import { bilinear } from './geo.js';

const ringArea = ring => { let a = 0; for (let k = 0; k < ring.length - 1; k++) a += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1]; return a / 2; };
export const absArea = ring => Math.abs(ringArea(ring));

export function normaliseBuildings(frame, { overture, osm, vt }, defaultH) {
  const out = [];
  const centre = rings => {
    const r = rings && rings[0]; if (!r?.length) return null;
    return r.reduce((a, p) => [a[0] + p[0] / r.length, a[1] + p[1] / r.length], [0, 0]);
  };
  const osmMeta = (osm || []).map(b => ({ b, c: centre(b.rings) })).filter(x => x.c);
  const nearbyMeta = rings => {
    const c = centre(rings); if (!c) return null;
    const mx = Math.cos(c[1] * Math.PI / 180) * 111320, my = 110540;
    let best = null, bd = 20;
    for (const x of osmMeta) {
      const d = Math.hypot((x.c[0] - c[0]) * mx, (x.c[1] - c[1]) * my);
      if (d < bd) { bd = d; best = x.b.tags; }
    }
    return best;
  };
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
      const t = nearbyMeta(b.rings) || {};
      add(b.rings, { id: b.id, h, how, floors: b.floors || parseFloat(t['building:levels']) || null, minHeight: b.minHeight || 0, roofShape: b.roofShape || t['roof:shape'], cls: b.class || t.building, use: t['building:use'] || t.amenity || t.office || t.shop || b.class || t.building || null, year: t.start_date || t['building:year'] || null, material: t['building:material'] || t.material || null, name: b.name || t['name:en'] || t.name, metadataSource: Object.keys(t).length ? 'OpenStreetMap, matched within 20 m' : null, src: b.sources.join(', ') || 'Overture' });
    }
    return { buildings: out, source: 'Overture Maps' };
  }
  if (osm && osm.length) {
    for (const b of osm) {
      const t = b.tags, oh = osmHeightTags(t);
      add(b.rings, { id: b.id || 'osm', h: oh ? oh.h : null, how: oh ? oh.how : 'unknown — default used', floors: parseFloat(t['building:levels']) || null, cls: t.amenity === 'place_of_worship' ? (t.religion === 'muslim' ? 'mosque' : 'religious') : t.building, use: t['building:use'] || t.amenity || t.office || t.shop || t.building || null, year: t.start_date || t['building:year'] || null, material: t['building:material'] || t.material || null, name: t['name:en'] || t.name, src: 'OpenStreetMap' });
    }
    return { buildings: out, source: 'OpenStreetMap' };
  }
  if (vt && vt.length) {
    for (const b of vt) add(b.rings, { id: 'vt', h: b.height ? b.height - (b.minHeight || 0) : null, how: b.height ? 'OpenFreeMap render height (may be estimated)' : 'unknown — default used', floors: null, use: null, year: null, material: null, src: 'OpenFreeMap' });
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
  const n = buildings.length, rec = buildings.filter(b => b.how === 'recorded height').length, fl = buildings.filter(b => b.how === 'floors × 3.5 m').length;
  return { n, recorded: rec, floors: fl, unknown: n - rec - fl, pct: n ? (rec + fl) / n * 100 : 0 };
}
