import assert from 'node:assert/strict';
import { makeFrame } from '../js/geo.js';
import { analyseSite, clipToFrame } from '../js/advanced.js';

const frame = makeFrame({ lon: 0, lat: 0, w: 100, h: 100, bearing: 0 });
const clipped = clipToFrame([[-80, -20], [20, -20], [20, 20], [-80, 20], [-80, -20]], frame);
assert.ok(clipped.every(([x, y]) => Math.abs(x) <= 50.001 && Math.abs(y) <= 50.001));

const W = 9, H = 9, data = new Float32Array(W * H).fill(10);
const base = {
  frame,
  dem: { W, H, dx: 12.5, dy: 12.5, data, min: 10, max: 10 },
  zAt: () => 10,
  buildings: [],
  osm: { roads: [], green: [], water: [], pois: [], parcels: [] },
  terrain: { name: 'synthetic flat surface' }, climate: null, bsource: 'synthetic'
};
const open = analyseSite(base);
assert.equal(open.urban.coveragePct, 0);
assert.equal(open.environment.skyViewPct, 100);
assert.equal(open.environment.terrainVisiblePct, 100);

const building = { inFrame: true, loc: [[[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]]], h: 10, base: 10, known: true, floors: 2, use: 'residential', year: '2000' };
const occupied = analyseSite({ ...base, buildings: [building] });
assert.equal(occupied.urban.footprintM2, 400);
assert.equal(occupied.urban.grossFloorAreaM2, 800);
assert.equal(occupied.urban.coveragePct, 4);
assert.ok(occupied.environment.skyViewPct < 1e-6);

console.log('advanced analysis tests passed');
