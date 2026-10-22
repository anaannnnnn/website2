import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fetchOSM } from '../js/data/osm.js';

const originalFetch = globalThis.fetch;
let active = 0, peak = 0, calls = 0;
globalThis.fetch = async () => {
  calls++; active++; peak = Math.max(peak, active);
  await new Promise(resolve => setTimeout(resolve, 15));
  active--;
  return { ok: true, json: async () => ({ elements: [] }) };
};

try {
  await fetchOSM({ w: 55, s: 25, e: 55.001, n: 25.001 }, { buildings: true, streets: true, water: true, green: true, trees: true });
  assert.equal(calls, 3, 'one request should be made for each independent OSM group');
  assert.ok(peak >= 2, 'independent OSM groups should load concurrently');
} finally {
  globalThis.fetch = originalFetch;
}

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
assert.doesNotMatch(html, /<script[^>]+(?:d3|jszip)[^>]*>/i, 'optional studio libraries must not block initial page load');
assert.match(html, /vendor\/maplibre-gl-4\.7\.1\.js/, 'the critical map runtime should be served locally');

const main = await readFile(new URL('../js/main.js', import.meta.url), 'utf8');
assert.doesNotMatch(main, /^import .*data\/overture\.js/m, 'the Parquet stack must load only when site data is requested');

console.log('loading performance tests passed');
