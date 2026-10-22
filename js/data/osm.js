// Live OpenStreetMap data via the Overpass API (several public mirrors), fetched in small groups.
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

export const emptyOSM = () => ({ buildings: [], roads: [], rails: [], water: [], waterways: [], green: [], landuse: [], trees: [], places: [], pois: [], parcels: [] });
const samePt = (a, b) => a[0] === b[0] && a[1] === b[1];

async function overpass(q, log) {
  let last;
  for (const ep of OVERPASS) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 70000);
    try {
      const r = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const js = await r.json();
      if (js.remark && /error|timed out|out of memory/i.test(js.remark) && !(js.elements || []).length) throw new Error(js.remark.slice(0, 80));
      return js;
    } catch (e) { last = e.name === 'AbortError' ? new Error('timed out') : e; log && log(`${new URL(ep).host}: ${last.message}, trying next mirror`); }
    finally { clearTimeout(t); }
  }
  throw last || new Error('no server');
}

export function joinRings(lines) {
  const pool = lines.map(l => l.slice()), rings = [];
  while (pool.length) {
    let cur = pool.shift(), guard = 0;
    while (!samePt(cur[0], cur[cur.length - 1]) && guard++ < 10000) {
      const end = cur[cur.length - 1], k = pool.findIndex(l => samePt(l[0], end) || samePt(l[l.length - 1], end));
      if (k < 0) break;
      let nx = pool.splice(k, 1)[0]; if (!samePt(nx[0], end)) nx = nx.reverse();
      cur = cur.concat(nx.slice(1));
    }
    if (cur.length > 3 && samePt(cur[0], cur[cur.length - 1])) rings.push(cur);
  }
  return rings;
}

export const ROAD_W = { motorway: 14, trunk: 12, primary: 11, secondary: 9, tertiary: 8, motorway_link: 7, trunk_link: 7, primary_link: 7, secondary_link: 6, tertiary_link: 6, residential: 6, unclassified: 6, living_street: 5, service: 4, track: 3, pedestrian: 4, footway: 2, path: 1.5, cycleway: 2, steps: 2, bridleway: 2 };
const GREEN_RE = { leisure: /^(park|garden|pitch|golf_course|nature_reserve|playground)$/, landuse: /^(grass|forest|meadow|recreation_ground|village_green|cemetery|orchard|vineyard|allotments)$/, natural: /^(wood|scrub|grassland|heath|wetland)$/ };
const isGreen = t => GREEN_RE.leisure.test(t.leisure || '') || GREEN_RE.landuse.test(t.landuse || '') || GREEN_RE.natural.test(t.natural || '');
const isWater = t => t.natural === 'water' || t.landuse === 'reservoir' || t.waterway === 'riverbank' || t.waterway === 'dock' || t.water;

export function osmHeight(t) {
  const h = parseFloat(String(t.height || '').replace(',', '.'));
  if (Number.isFinite(h) && h > 0) return { h, how: 'recorded height' };
  const lv = parseFloat(t['building:levels']);
  if (Number.isFinite(lv) && lv > 0) return { h: lv * 3.5 + (parseFloat(t['roof:levels']) || 0) * 2.5, how: 'floors × 3.5 m' };
  return null;
}

export function parseOSM(js) {
  const res = emptyOSM();
  for (const el of js.elements || []) {
    const t = el.tags || {};
    if (el.type === 'node') {
      if (t.natural === 'tree') res.trees.push({ lon: el.lon, lat: el.lat, tags: t });
      else if (t.place && t.name) res.places.push({ lon: el.lon, lat: el.lat, name: t['name:en'] || t.name, kind: t.place });
      if (t.amenity || t.shop || t.tourism || t.leisure || t.public_transport || t.highway === 'bus_stop' || t.railway === 'station') {
        res.pois.push({ id: `n${el.id}`, lon: el.lon, lat: el.lat, name: t['name:en'] || t.name || null, kind: t.amenity || t.shop || t.tourism || t.leisure || t.public_transport || t.highway || t.railway, tags: t });
      }
      continue;
    }
    let rings = [], line = null;
    if (el.type === 'way' && el.geometry) {
      line = el.geometry.filter(Boolean).map(g => [g.lon, g.lat]);
      if (line.length > 3 && samePt(line[0], line[line.length - 1])) rings = [line];
    } else if (el.type === 'relation' && el.members) {
      rings = joinRings(el.members.filter(m => m.type === 'way' && m.role !== 'inner' && m.geometry).map(m => m.geometry.filter(Boolean).map(g => [g.lon, g.lat])));
    }
    const centre = ring => ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]);
    if (t.building) rings.forEach(r => res.buildings.push({ id: `${el.type[0]}${el.id}`, rings: [r], tags: t }));
    else if (t.boundary === 'parcel' || t.cadastre === 'parcel' || t['parcel:id']) rings.forEach(r => res.parcels.push({ id: `${el.type[0]}${el.id}`, ring: r, tags: t }));
    else if (t.highway && line && t.area !== 'yes') res.roads.push({ pts: line, tags: t, width: ROAD_W[t.highway] || 4, name: t['name:en'] || t.name || t.ref || '' });
    else if (t.railway && line) res.rails.push({ pts: line, tags: t });
    else if (isWater(t)) rings.forEach(r => res.water.push({ ring: r, tags: t }));
    else if (t.waterway && line) res.waterways.push({ pts: line, tags: t, width: t.waterway === 'river' ? 12 : t.waterway === 'canal' ? 8 : 2.5 });
    else if (isGreen(t)) rings.forEach(r => res.green.push({ ring: r, tags: t, forest: t.landuse === 'forest' || t.natural === 'wood' }));
    else if (t.landuse || t.amenity) rings.forEach(r => res.landuse.push({ ring: r, tags: t }));
    if ((t.amenity || t.shop || t.tourism || t.leisure || t.public_transport) && rings[0]) {
      const p = centre(rings[0]);
      res.pois.push({ id: `${el.type[0]}${el.id}`, lon: p[0], lat: p[1], name: t['name:en'] || t.name || null, kind: t.amenity || t.shop || t.tourism || t.leisure || t.public_transport, tags: t });
    }
  }
  return res;
}

/**
 * @param b bbox, o {buildings, streets, water, green, trees}
 * @returns {Promise<{data, failed:string[]}>}
 */
export async function fetchOSM(b, o, log) {
  const bb = `(${b.s},${b.w},${b.n},${b.e})`, pad = 0.015 / Math.max(0.25, Math.cos(((b.s + b.n) / 2) * Math.PI / 180)), accessBB = `(${b.s - 0.015},${b.w - pad},${b.n + 0.015},${b.e + pad})`, groups = [];
  if (o.buildings) groups.push(['buildings', `way["building"]${bb};relation["building"]["type"="multipolygon"]${bb};`]);
  if (o.streets) groups.push(['streets', `way["highway"]${bb};way["railway"~"^(rail|tram|subway|light_rail|narrow_gauge|monorail|funicular)$"]${bb};`]);
  let misc = '';
  if (o.water) misc += `way["natural"="water"]${bb};relation["natural"="water"]${bb};way["waterway"]${bb};way["landuse"="reservoir"]${bb};relation["waterway"="riverbank"]${bb};`;
  if (o.green) misc += `way["leisure"~"^(park|garden|pitch|golf_course|nature_reserve|playground)$"]${bb};way["natural"~"^(wood|scrub|grassland|heath|wetland)$"]${bb};relation["landuse"="forest"]${bb};relation["leisure"="park"]${bb};way["landuse"]${bb};way["amenity"~"^(school|university|college|kindergarten|hospital|clinic|place_of_worship)$"]${bb};`;
  if (o.trees) misc += `node["natural"="tree"]${bb};`;
  misc += `node["amenity"]${accessBB};node["shop"]${accessBB};node["tourism"]${accessBB};node["leisure"~"^(park|garden|playground|nature_reserve)$"]${accessBB};node["public_transport"]${accessBB};node["highway"="bus_stop"]${accessBB};node["railway"="station"]${accessBB};way["boundary"="parcel"]${bb};relation["boundary"="parcel"]${bb};`;
  misc += `node["place"~"^(suburb|neighbourhood|quarter|city_block|locality|island|village|town)$"](${b.s - 0.02},${b.w - 0.02},${b.n + 0.02},${b.e + 0.02});`;
  groups.push(['land', misc]);
  const all = { elements: [] }, failed = [];
  for (const [label, q] of groups) {
    try { const js = await overpass(`[out:json][timeout:90];(${q});out geom;`, log); all.elements.push(...(js.elements || [])); }
    catch (e) { failed.push(label); log && log(`OpenStreetMap ${label} failed: ${e.message}`); }
  }
  return { data: parseOSM(all), failed };
}
