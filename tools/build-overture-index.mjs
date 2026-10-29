// Builds data/overture-index.json: the bounding box of every Overture Maps building file in the
// latest release, so the browser can read only the one or two files that cover a site.
// Usage: node tools/build-overture-index.mjs [outFile]
import { asyncBufferFromUrl, parquetMetadataAsync } from 'hyparquet';
import { writeFileSync } from 'node:fs';

const BUCKET = 'https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/';
const OUT = process.argv[2] || new URL('../data/overture-index.json', import.meta.url).pathname;

async function list(prefix, delimiter) {
  const keys = [], prefixes = [];
  let token = '';
  do {
    const url = `${BUCKET}?list-type=2&prefix=${encodeURIComponent(prefix)}${delimiter ? '&delimiter=/' : ''}${token ? '&continuation-token=' + encodeURIComponent(token) : ''}`;
    const xml = await (await fetch(url)).text();
    for (const m of xml.matchAll(/<Contents><Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>/g)) keys.push({ key: m[1], size: +m[2] });
    for (const m of xml.matchAll(/<CommonPrefixes><Prefix>([^<]+)<\/Prefix><\/CommonPrefixes>/g)) prefixes.push(m[1]);
    token = (xml.match(/<NextContinuationToken>([^<]+)</) || [])[1] || '';
  } while (token);
  return { keys, prefixes };
}

const releases = (await list('release/', true)).prefixes.sort();
const release = releases[releases.length - 1];
const releaseName = release.replace(/^release\/|\/$/g, '');

async function indexType(type) {
  const prefix = `${release}theme=buildings/type=${type}/`;
  const { keys } = await list(prefix, false);
  const files = keys.filter(k => k.key.endsWith('.parquet'));
  console.log(`Release ${releaseName}: ${files.length} ${type} files`);
  const out = new Array(files.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < files.length) {
      const i = next++, f = files[i];
      for (let attempt = 0; ; attempt++) {
        try {
          const file = await asyncBufferFromUrl({ url: BUCKET + f.key, byteLength: f.size });
          const md = await parquetMetadataAsync(file);
          const cols = md.row_groups[0].columns.map(c => c.meta_data.path_in_schema.join('.'));
          const ci = ['bbox.xmin', 'bbox.ymin', 'bbox.xmax', 'bbox.ymax'].map(n => cols.indexOf(n));
          if (ci.some(n => n < 0)) throw new Error(`${type} file has no bbox statistics`);
          let b = [Infinity, Infinity, -Infinity, -Infinity];
          for (const rg of md.row_groups) {
            const st = k => rg.columns[ci[k]].meta_data.statistics;
            b = [Math.min(b[0], Number(st(0).min_value)), Math.min(b[1], Number(st(1).min_value)), Math.max(b[2], Number(st(2).max_value)), Math.max(b[3], Number(st(3).max_value))];
          }
          out[i] = [f.key.slice(prefix.length), f.size, ...b.map((v, k) => +(k < 2 ? Math.floor(v * 1e3) / 1e3 : Math.ceil(v * 1e3) / 1e3).toFixed(3))];
          break;
        } catch (e) {
          if (attempt >= 3) throw e;
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        }
      }
      if (++done % 32 === 0) console.log(`  ${type}: ${done}/${files.length}`);
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));
  return { prefix, files: out };
}

const [building, buildingPart] = await Promise.all([indexType('building'), indexType('building_part')]);
writeFileSync(OUT, JSON.stringify({ release: releaseName, bucket: BUCKET, generated: new Date().toISOString(), fields: ['file', 'bytes', 'xmin', 'ymin', 'xmax', 'ymax'], prefix: building.prefix, files: building.files, partPrefix: buildingPart.prefix, partFiles: buildingPart.files }));
console.log(`Wrote ${OUT}`);
