// Overture Maps buildings, read straight from Overture's public cloud files.
// data/overture-index.json (rebuilt monthly by a GitHub Action) says which file covers which area;
// only that file's footer and the few row groups touching the site are downloaded.
import { asyncBufferFromUrl, cachedAsyncBuffer, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

const COLUMNS = ['id', 'building_id', 'geometry', 'bbox', 'height', 'min_height', 'num_floors', 'roof_shape', 'roof_height', 'roof_direction', 'roof_orientation', 'roof_color', 'roof_material', 'facade_color', 'facade_material', 'has_parts', 'class', 'subtype', 'names', 'sources', 'is_underground'];

function polygonsOf(g) {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

/**
 * @param {{w:number,s:number,e:number,n:number}} b  bbox in degrees
 * @returns {Promise<{release:string, buildings:Array, parts:Array}>}
 */
export async function loadOvertureBuildings(b, { indexUrl = 'data/overture-index.json', log = () => {}, fetchImpl = fetch } = {}) {
  const idx = await (await fetchImpl(indexUrl)).json();
  const loadType = async (files, prefix, part = false) => {
    const out = [], seen = new Set();
    const hits = (files || []).filter(f => f[2] <= b.e && f[4] >= b.w && f[3] <= b.n && f[5] >= b.s);
    for (const [name, bytes] of hits) {
      const file = cachedAsyncBuffer(await asyncBufferFromUrl({ url: idx.bucket + prefix + name, byteLength: bytes }));
      const md = await parquetMetadataAsync(file);
      const cols = md.row_groups[0].columns.map(c => c.meta_data.path_in_schema.join('.'));
      const ci = ['bbox.xmin', 'bbox.ymin', 'bbox.xmax', 'bbox.ymax'].map(n => cols.indexOf(n));
      if (ci.some(n => n < 0)) continue;
      let start = 0;
      const ranges = [];
      for (const rg of md.row_groups) {
        const n = Number(rg.num_rows), st = k => rg.columns[ci[k]].meta_data.statistics;
        const x0 = Number(st(0).min_value), y0 = Number(st(1).min_value), x1 = Number(st(2).max_value), y1 = Number(st(3).max_value);
        if (x0 <= b.e && x1 >= b.w && y0 <= b.n && y1 >= b.s) {
          const last = ranges[ranges.length - 1];
          if (last && last[1] === start) last[1] = start + n; else ranges.push([start, start + n]);
        }
        start += n;
      }
      if (!ranges.length) continue;
      log(`Overture ${part ? 'parts' : 'buildings'} ${idx.release}: reading ${ranges.length} block(s) of ${name.slice(0, 10)}…`);
      for (const [rowStart, rowEnd] of ranges) {
        const available = new Set(cols);
        const columns = COLUMNS.filter(n => available.has(n) || cols.some(c => c.startsWith(n + '.')));
        const rows = await parquetReadObjects({ file, metadata: md, columns, rowStart, rowEnd, compressors });
        for (const r of rows) {
          const bb = r.bbox;
          if (!bb || bb.xmin > b.e || bb.xmax < b.w || bb.ymin > b.n || bb.ymax < b.s || r.is_underground || seen.has(r.id)) continue;
          seen.add(r.id);
          const datasets = [...new Set((r.sources || []).map(s => s.dataset).filter(Boolean))];
          const sourceIds = [...new Set((r.sources || []).map(s => s.record_id).filter(Boolean))];
          for (const poly of polygonsOf(r.geometry)) {
            out.push({
              id: r.id,
              buildingId: r.building_id || null,
              rings: poly.map(ring => ring.map(p => [p[0], p[1]])),
              height: r.height != null ? Number(r.height) : null,
              minHeight: r.min_height != null ? Number(r.min_height) : 0,
              floors: r.num_floors != null ? Number(r.num_floors) : null,
              roofShape: r.roof_shape || null,
              roofHeight: r.roof_height != null ? Number(r.roof_height) : null,
              roofDirection: r.roof_direction != null ? Number(r.roof_direction) : null,
              roofOrientation: r.roof_orientation || null,
              roofColor: r.roof_color || null,
              roofMaterial: r.roof_material || null,
              facadeColor: r.facade_color || null,
              facadeMaterial: r.facade_material || null,
              hasParts: !!r.has_parts,
              class: r.class || r.subtype || null,
              name: r.names && r.names.primary || null,
              sources: datasets,
              sourceIds,
            });
          }
        }
      }
    }
    return out;
  };

  const [buildings, parts] = await Promise.all([
    loadType(idx.files, idx.prefix),
    loadType(idx.partFiles, idx.partPrefix, true),
  ]);
  return { release: idx.release, buildings, parts };
}
