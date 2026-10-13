// Overture Maps buildings, read straight from Overture's public cloud files.
// data/overture-index.json (rebuilt monthly by a GitHub Action) says which file covers which area;
// only that file's footer and the few row groups touching the site are downloaded.
import { asyncBufferFromUrl, cachedAsyncBuffer, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

const COLUMNS = ['id', 'geometry', 'bbox', 'height', 'min_height', 'num_floors', 'roof_shape', 'roof_height', 'class', 'subtype', 'names', 'is_underground'];
// 'sources' (which survey each footprint came from) is a deeply nested column: decoding it costs ~300 MB
// per block against ~20 MB for geometry, so it is only read for small sites.
const MAX_SOURCE_BLOCKS = 2;

function polygonsOf(g) {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

/**
 * @param {{w:number,s:number,e:number,n:number}} b  bbox in degrees
 * @returns {Promise<{release:string, buildings:Array}>}
 */
export async function loadOvertureBuildings(b, { indexUrl = 'data/overture-index.json', log = () => {}, fetchImpl = fetch } = {}) {
  const idx = await (await fetchImpl(indexUrl)).json();
  const hits = idx.files.filter(f => f[2] <= b.e && f[4] >= b.w && f[3] <= b.n && f[5] >= b.s);
  const inBox = bb => bb && !(bb.xmin > b.e || bb.xmax < b.w || bb.ymin > b.n || bb.ymax < b.s);
  // 1) plan: row groups (blocks of ~50,000 buildings) whose bbox statistics touch the site
  const plans = [];
  for (const [name, bytes] of hits) {
    const raw = await asyncBufferFromUrl({ url: idx.bucket + idx.prefix + name, byteLength: bytes });
    const md = await parquetMetadataAsync(cachedAsyncBuffer(raw));
    const cols = md.row_groups[0].columns.map(c => c.meta_data.path_in_schema.join('.'));
    const ci = ['bbox.xmin', 'bbox.ymin', 'bbox.xmax', 'bbox.ymax'].map(n => cols.indexOf(n));
    const groups = [];
    let start = 0;
    for (const rg of md.row_groups) {
      const n = Number(rg.num_rows), st = k => rg.columns[ci[k]].meta_data.statistics;
      if (inBox({ xmin: Number(st(0).min_value), ymin: Number(st(1).min_value), xmax: Number(st(2).max_value), ymax: Number(st(3).max_value) })) groups.push([start, start + n]);
      start += n;
    }
    if (groups.length) plans.push({ raw, md, groups });
  }
  const total = plans.reduce((a, p) => a + p.groups.length, 0);
  const lowMem = typeof navigator !== 'undefined' && navigator.deviceMemory && navigator.deviceMemory < 4;
  const withSources = total <= MAX_SOURCE_BLOCKS && !lowMem, columns = withSources ? [...COLUMNS, 'sources'] : COLUMNS;
  // 2) read block by block, each released before the next, so memory stays flat however big the area
  //    (reading them all at once used >1.5 GB for a 4 × 3 km site and crashed the tab)
  const buildings = [], seen = new Set();
  let done = 0;
  for (const { raw, md, groups } of plans) {
    for (const [g0, g1] of groups) {
      log(`Overture ${idx.release}: block ${++done} of ${total}…`);
      const file = cachedAsyncBuffer(raw);   // byte cache lives only for this block
      const boxes = await parquetReadObjects({ file, metadata: md, columns: ['bbox'], rowStart: g0, rowEnd: g1, compressors });
      const runs = [];
      boxes.forEach((r, k) => {
        if (!inBox(r.bbox)) return;
        const row = g0 + k, last = runs[runs.length - 1];
        if (last && row - last[1] < 256) last[1] = row + 1; else runs.push([row, row + 1]);
      });
      for (const [rowStart, rowEnd] of runs) {
        const rows = await parquetReadObjects({ file, metadata: md, columns, rowStart, rowEnd, compressors });
        for (const r of rows) {
          if (!inBox(r.bbox) || r.is_underground || seen.has(r.id)) continue;
          seen.add(r.id);
          const datasets = withSources ? [...new Set((r.sources || []).map(s => s.dataset).filter(Boolean))] : [];
          for (const poly of polygonsOf(r.geometry)) {
            buildings.push({
              id: r.id,
              rings: poly.map(ring => ring.map(p => [p[0], p[1]])),
              height: r.height != null ? Number(r.height) : null,
              minHeight: r.min_height != null ? Number(r.min_height) : 0,
              floors: r.num_floors != null ? Number(r.num_floors) : null,
              roofShape: r.roof_shape || null,
              roofHeight: r.roof_height != null ? Number(r.roof_height) : null,
              class: r.class || r.subtype || null,
              name: r.names && r.names.primary || null,
              sources: datasets
            });
          }
        }
      }
      await new Promise(r => setTimeout(r, 0));   // let the page breathe (and collect) between blocks
    }
  }
  return { release: idx.release, buildings, sourcesRead: withSources, blocks: total };
}
