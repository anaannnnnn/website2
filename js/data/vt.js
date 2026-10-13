// OpenFreeMap vector tiles (OpenMapTiles schema, rebuilt weekly from OSM): fallback buildings + sea polygons.
import { latToY, lonToX } from '../geo.js';

let LIB = null;
async function lib() {
  if (!LIB) {
    const [P, V] = await Promise.all([import('pbf'), import('@mapbox/vector-tile')]);
    LIB = { Pbf: P.default || P.Pbf || P, VectorTile: V.VectorTile || (V.default && V.default.VectorTile) };
  }
  return LIB;
}
const samePt = (a, b) => a[0] === b[0] && a[1] === b[1];
const closeRing = r => (r.length && !samePt(r[0], r[r.length - 1]) ? [...r, r[0]] : r);

export async function fetchVectorTiles(b) {
  const { Pbf, VectorTile } = await lib();
  const tj = await (await fetch('https://tiles.openfreemap.org/planet')).json(), tpl = tj.tiles[0], z = 14;
  const x0 = Math.floor(lonToX(b.w, z) / 256), x1 = Math.floor(lonToX(b.e, z) / 256), y0 = Math.floor(latToY(b.n, z) / 256), y1 = Math.floor(latToY(b.s, z) / 256);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 100) throw new Error('area too large for vector tiles');
  const out = { buildings: [], water: [] }, seen = new Set();
  await Promise.all([...Array((x1 - x0 + 1) * (y1 - y0 + 1)).keys()].map(async k => {
    const tx = x0 + k % (x1 - x0 + 1), ty = y0 + Math.floor(k / (x1 - x0 + 1));
    const r = await fetch(tpl.replace('{z}', z).replace('{x}', tx).replace('{y}', ty)); if (!r.ok) return;
    const tile = new VectorTile(new Pbf(new Uint8Array(await r.arrayBuffer())));
    const polys = f => { const g = f.toGeoJSON(tx, ty, z).geometry; return g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []; };
    const bl = tile.layers.building;
    if (bl) for (let i = 0; i < bl.length; i++) {
      const f = bl.feature(i), pr = f.properties;
      for (const poly of polys(f)) {
        const key = poly[0].slice(0, 3).map(p => p[0].toFixed(6) + p[1].toFixed(6)).join();
        if (seen.has(key)) continue; seen.add(key);
        out.buildings.push({ rings: poly.map(closeRing), height: +pr.render_height || null, minHeight: +pr.render_min_height || 0, source: 'OpenFreeMap' });
      }
    }
    const wl = tile.layers.water;
    if (wl) for (let i = 0; i < wl.length; i++) { const f = wl.feature(i); if (!/ocean|sea|river|lake/.test(f.properties.class || '')) continue; for (const poly of polys(f)) out.water.push({ ring: closeRing(poly[0]), tags: { natural: 'water', water: f.properties.class, source: 'OpenFreeMap' } }); }
  }));
  return out;
}
