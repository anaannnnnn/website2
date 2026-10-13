// OpenFreeMap vector tiles (OpenMapTiles schema, rebuilt weekly from OpenStreetMap, served from a CDN).
// Primary source for streets, water, land use and place names: fast and does not depend on the busy
// Overpass servers. Also fallback buildings and the sea polygons (the sea is not an OSM polygon).
import { latToY, lonToX } from '../geo.js';
import { fetchRetry } from '../util.js';
import { emptyOSM, ROAD_W } from './osm.js';

let LIB = null, TPL = null;
const CACHE = new Map();
async function lib() {
  if (!LIB) {
    const [P, V] = await Promise.all([import('pbf'), import('@mapbox/vector-tile')]);
    LIB = { Pbf: P.default || P.Pbf || P, VectorTile: V.VectorTile || (V.default && V.default.VectorTile) };
  }
  return LIB;
}
async function template() {
  if (!TPL) TPL = fetchRetry('https://tiles.openfreemap.org/planet', {}, { tries: 3, timeout: 15000 }).then(r => r.json()).then(tj => tj.tiles[0]).catch(e => { TPL = null; throw e; });
  return TPL;
}
async function tile(url) {
  if (!CACHE.has(url)) CACHE.set(url, fetchRetry(url, {}, { tries: 3, timeout: 20000 }).then(r => r.arrayBuffer()).catch(e => { CACHE.delete(url); if (/404/.test(e.message)) return null; throw e; }));
  return CACHE.get(url);
}
const samePt = (a, b) => a[0] === b[0] && a[1] === b[1];
const closeRing = r => (r.length && !samePt(r[0], r[r.length - 1]) ? [...r, r[0]] : r);
const key = p => p[0].toFixed(6) + ',' + p[1].toFixed(6);

// OpenMapTiles transportation class → OSM highway value used by the sheets
const MINOR = new Set(['residential', 'unclassified', 'living_street']);
function highwayOf(pr) {
  const c = String(pr.class || '').replace(/_construction$/, ''), s = pr.subclass || '';
  if (/^(motorway|trunk|primary|secondary|tertiary)$/.test(c)) return c + (pr.ramp ? '_link' : '');
  if (c === 'minor') return MINOR.has(s) ? s : 'residential';
  if (c === 'service' || c === 'track' || c === 'busway') return c === 'busway' ? 'service' : c;
  if (c === 'path') return /^(footway|cycleway|steps|pedestrian|bridleway|path)$/.test(s) ? s : 'path';
  return null;
}
const LANDUSE_GREEN = { park: 'park', garden: 'garden', pitch: 'pitch', playground: 'playground', cemetery: null, golf_course: 'golf_course' };

/**
 * Read all OpenMapTiles layers for the bbox and convert them to the same shape as parseOSM().
 * @returns {{osm, buildings, water, zoom, tiles}}
 */
export async function fetchVectorTiles(b) {
  const [{ Pbf, VectorTile }, tpl] = await Promise.all([lib(), template()]);
  // always full detail (z14: every street, path and small feature); 400 tiles covers the largest frame
  const z = 14, x0 = Math.floor(lonToX(b.w, z) / 256), x1 = Math.floor(lonToX(b.e, z) / 256), y0 = Math.floor(latToY(b.n, z) / 256), y1 = Math.floor(latToY(b.s, z) / 256);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) throw new Error('area too large for vector tiles');
  const osm = emptyOSM(), out = { osm, buildings: [], water: [], zoom: z, tiles: 0 }, seenB = new Set();
  const jobs = [];
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) jobs.push([tx, ty]);
  let failed = 0;
  let next = 0;
  const worker = async () => { while (next < jobs.length) await one(...jobs[next++]); };   // 8 at a time
  const one = async (tx, ty) => {
    let buf;
    const url = tpl.replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
    try { buf = await tile(url); } catch (e) { failed++; return; } finally { CACHE.delete(url); }   // the browser's HTTP cache keeps them; don't hold raw tiles in memory
    if (!buf) return;
    out.tiles++;
    const t = new VectorTile(new Pbf(new Uint8Array(buf)));
    const geo = f => f.toGeoJSON(tx, ty, z).geometry;
    const polys = f => { const g = geo(f); return g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []; };
    const lines = f => { const g = geo(f); return g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []; };
    const each = (name, fn) => { const l = t.layers[name]; if (l) for (let i = 0; i < l.length; i++) fn(l.feature(i)); };
    const nm = pr => pr['name:en'] || pr.name_en || pr.name || '';

    each('building', f => {
      const pr = f.properties;
      for (const poly of polys(f)) {
        const k = poly[0].slice(0, 3).map(key).join();
        if (seenB.has(k)) continue; seenB.add(k);
        out.buildings.push({ rings: poly.map(closeRing), height: +pr.render_height || null, minHeight: +pr.render_min_height || 0, source: 'OpenFreeMap' });
      }
    });
    // street names live in a separate layer; match them to street geometry by shared vertices
    const names = new Map();
    each('transportation_name', f => { const n = nm(f.properties) || f.properties.ref; if (n) for (const l of lines(f)) for (const p of l) names.set(key(p), n); });
    each('transportation', f => {
      const pr = f.properties, c = pr.class || '';
      if (c === 'rail' || c === 'transit') {
        const s = pr.subclass || 'rail';
        if (/^(rail|tram|subway|light_rail|narrow_gauge|monorail|funicular)$/.test(s)) for (const l of lines(f)) osm.rails.push({ pts: l, tags: { railway: s, source: 'OpenFreeMap' } });
        return;
      }
      const hw = highwayOf(pr); if (!hw) return;
      for (const l of lines(f)) {
        let name = ''; for (const p of l) { const n = names.get(key(p)); if (n) { name = n; break; } }
        const tags = { highway: hw, source: 'OpenFreeMap' }; if (pr.brunnel) tags[pr.brunnel] = 'yes'; if (name) tags.name = name;
        osm.roads.push({ pts: l, tags, width: ROAD_W[hw] || 4, name });
      }
    });
    each('water', f => {
      const c = f.properties.class || ''; if (c === 'swimming_pool') return;
      for (const poly of polys(f)) { const w = { ring: closeRing(poly[0]), tags: { natural: 'water', water: c, source: 'OpenFreeMap' } }; out.water.push(w); }
    });
    each('waterway', f => {
      const c = f.properties.class || 'stream';
      for (const l of lines(f)) osm.waterways.push({ pts: l, tags: { waterway: c, name: nm(f.properties), source: 'OpenFreeMap' }, width: c === 'river' ? 12 : c === 'canal' ? 8 : 2.5 });
    });
    each('landcover', f => {
      const c = f.properties.class || '', s = f.properties.subclass || '';
      let tags = null, forest = false;
      if (c === 'wood') { tags = { natural: 'wood' }; forest = true; }
      else if (c === 'grass') tags = /^(park|garden|golf_course|playground|pitch)$/.test(s) ? { leisure: s } : { landuse: s === 'meadow' ? 'meadow' : 'grass' };
      else if (c === 'wetland') tags = { natural: 'wetland' };
      else if (c === 'farmland') { for (const poly of polys(f)) osm.landuse.push({ ring: closeRing(poly[0]), tags: { landuse: 'farmland', source: 'OpenFreeMap' } }); return; }
      if (!tags) return;
      for (const poly of polys(f)) osm.green.push({ ring: closeRing(poly[0]), tags: { ...tags, source: 'OpenFreeMap' }, forest });
    });
    each('landuse', f => {
      const c = f.properties.class || '';
      if (/^(suburb|quarter|neighbourhood)$/.test(c)) return; // administrative, not land use
      for (const poly of polys(f)) {
        const ring = closeRing(poly[0]);
        if (c in LANDUSE_GREEN && LANDUSE_GREEN[c]) osm.green.push({ ring, tags: { leisure: LANDUSE_GREEN[c], source: 'OpenFreeMap' }, forest: false });
        else if (c === 'cemetery') osm.green.push({ ring, tags: { landuse: 'cemetery', source: 'OpenFreeMap' }, forest: false });
        else if (/^(school|university|college|kindergarten|hospital)$/.test(c)) osm.landuse.push({ ring, tags: { amenity: c, source: 'OpenFreeMap' } });
        else osm.landuse.push({ ring, tags: { landuse: c, source: 'OpenFreeMap' } });
      }
    });
    each('park', f => {
      const c = f.properties.class || ''; if (!/^(park|nature_reserve|garden)$/.test(c)) return;
      for (const poly of polys(f)) osm.green.push({ ring: closeRing(poly[0]), tags: { leisure: c, source: 'OpenFreeMap' }, forest: false });
    });
    each('place', f => {
      const pr = f.properties, g = geo(f), n = nm(pr);
      if (g.type !== 'Point' || !n || !/^(suburb|neighbourhood|quarter|city_block|locality|island|village|town|hamlet)$/.test(pr.class || '')) return;
      if (!osm.places.some(p => p.name === n)) osm.places.push({ lon: g.coordinates[0], lat: g.coordinates[1], name: n, kind: pr.class });
    });
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  if (failed && !out.tiles) throw new Error('map tiles unavailable');
  out.failed = failed;
  osm.water.push(...out.water);
  return out;
}
