import { $, $$, countUp, esc, fmt, sleep, toast } from './util.js';
import { makeFrame, sheetLayout, SCALES, PAPER, clamp } from './geo.js';
import { createMap } from './map.js';
import { buildDEM, terrainSourceNote } from './data/dem.js';
import { fetchOSM, emptyOSM } from './data/osm.js';
import { loadOvertureBuildings } from './data/overture.js';
import { fetchVectorTiles } from './data/vt.js';
import { fetchClimate } from './data/climate.js';
import { normaliseBuildings, localiseOSM, buildingBase, makeZAt, heightStats } from './site.js';
import { derive, flowAccumulation, gaussian } from './analysis.js';
import { computeSection, profileSVG } from './sections.js';

/* ───────────── state ───────────── */
const STEPS = ['site', 'frame', 'data', 'sections', 'outputs'];
const S = {
  step: 'site', site: null, paper: 'A1', orient: 'landscape', scale: 500, custom: null, bearing: 0, center: null,
  layers: { terrain: true, buildings: true, streets: true, water: true, trees: true, climate: true },
  model: null, stale: false, loading: false, sections: [], selSec: null, depth: 300, packs: new Set(['plans', 'sections', 'terrain', 'climate', 'model', 'cad'])
};
window.TK = S;  // handy for debugging / tests

/* ───────────── map ───────────── */
const M = createMap('map', {
  onClick(lon, lat) { if (S.step === 'site') pickSite(lon, lat, null); },
  onFrame(cfg, final) {
    S.center = [cfg.lon, cfg.lat]; S.bearing = cfg.bearing;
    if (cfg.custom) S.custom = { w: cfg.w, h: cfg.h };
    syncFrameUI(false);
    if (final) { markStale(); refreshAutoSections(); save(); }
  },
  onBearing(b) { $('#compassIcon').style.transform = `rotate(${-b}deg)`; },
  onSectionSelect(id) { selectSection(id); },
  onSectionChange(sec, final) { if (S.selSec !== sec.id) S.selSec = sec.id; scheduleProfile(); if (final) { renderSecList(); save(); } },
  onDrawCancel() { $('#btnAddSec').classList.remove('armed'); }
});
M.map.on('load', () => { restore(); });

/* ───────────── steps & navigation ───────────── */
function canGo(step) {
  const i = STEPS.indexOf(step);
  if (i >= 1 && !S.site) return false;
  if (i >= 3 && (!S.model || S.stale)) return false;
  return true;
}
function go(step) {
  if (!canGo(step)) {
    toast(!S.site ? 'Pick a site first.' : 'Load the site data first (step 3).', 'warn');
    return;
  }
  const from = STEPS.indexOf(S.step), to = STEPS.indexOf(step);
  S.step = step; $('#app').dataset.step = step;
  $$('.step').forEach(el => {
    const i = STEPS.indexOf(el.dataset.step);
    el.classList.toggle('on', i === to);
    el.classList.toggle('left', i < to);
  });
  $$('#stepper button').forEach((b, i) => { b.classList.toggle('cur', i === to); b.classList.toggle('done', i < to || (i === 2 && S.model && !S.stale)); b.disabled = !canGo(STEPS[i]); });
  $('#stepFill').style.width = `${to / 4 * 100}%`;
  $('#btnBack').style.visibility = to === 0 ? 'hidden' : 'visible';
  const next = $('#btnNext');
  next.style.display = to === 4 ? 'none' : '';
  next.textContent = to === 2 && (!S.model || S.stale) ? 'Load data' : 'Next';
  M.setFrameEditable(step === 'frame');
  M.showSections(step === 'sections');
  if (step === 'sections') { if (!S.selSec && S.sections.length) S.selSec = S.sections[0].id; renderSecList(); M.setSections(S.sections, S.selSec); scheduleProfile(); }
  else closeDrawer();
  if (step === 'frame' && S.site && from < to) M.fitFrame();
  if (step !== 'sections') M.cancelDraw();
  status('');
}
$$('#stepper button').forEach(b => b.onclick = () => go(b.dataset.go));
$('#btnBack').onclick = () => go(STEPS[Math.max(0, STEPS.indexOf(S.step) - 1)]);
$('#btnNext').onclick = () => {
  if (S.step === 'data' && (!S.model || S.stale)) return loadData();
  go(STEPS[Math.min(4, STEPS.indexOf(S.step) + 1)]);
};
function status(t) { $('#status').textContent = t; }

/* ───────────── 1. site ───────────── */
let qTimer, qAbort, sugg = [], suggIdx = -1;
$('#q').addEventListener('input', () => {
  clearTimeout(qTimer);
  const q = $('#q').value.trim();
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) { showSuggest([{ name: `Coordinates ${(+m[1]).toFixed(5)}, ${(+m[2]).toFixed(5)}`, sub: 'press Enter', lat: +m[1], lon: +m[2] }]); return; }
  if (q.length < 3) return showSuggest([]);
  qTimer = setTimeout(() => searchPlaces(q), 380);
});
$('#q').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); suggIdx = clamp(suggIdx + (e.key === 'ArrowDown' ? 1 : -1), 0, sugg.length - 1); $$('#suggest li').forEach((li, i) => li.classList.toggle('act', i === suggIdx)); }
  if (e.key === 'Enter' && sugg.length) choose(sugg[Math.max(0, suggIdx)]);
  if (e.key === 'Escape') showSuggest([]);
});
async function searchPlaces(q) {
  qAbort && qAbort.abort(); qAbort = new AbortController(); $('#qSpin').hidden = false;
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&addressdetails=0&q=${encodeURIComponent(q)}`, { signal: qAbort.signal, headers: { 'Accept-Language': 'en' } });
    const js = await r.json();
    showSuggest(js.map(p => ({ name: p.name || p.display_name.split(',')[0], sub: p.display_name, lat: +p.lat, lon: +p.lon })));
  } catch (e) { if (e.name !== 'AbortError') showSuggest([{ name: 'Search unavailable', sub: 'type coordinates instead, e.g. 25.2671, 55.2958', disabled: true }]); }
  finally { $('#qSpin').hidden = true; }
}
function showSuggest(list) {
  sugg = list.filter(s => !s.disabled); suggIdx = -1;
  const ul = $('#suggest'); ul.innerHTML = list.map((s, i) => `<li role="option" data-i="${i}"><span>${esc(s.name)}</span><small>${esc(s.sub || '')}</small></li>`).join('');
  ul.classList.toggle('on', list.length > 0);
  $$('#suggest li').forEach(li => li.onmousedown = e => { e.preventDefault(); const s = list[+li.dataset.i]; if (!s.disabled) choose(s); });
}
$('#q').addEventListener('blur', () => setTimeout(() => showSuggest([]), 150));
function choose(s) { showSuggest([]); $('#q').value = s.name; pickSite(s.lon, s.lat, s.name, true); }
$('#btnLocate').onclick = () => {
  if (!navigator.geolocation) return toast('Location is not available in this browser.', 'warn');
  status('Finding you…');
  navigator.geolocation.getCurrentPosition(p => pickSite(p.coords.longitude, p.coords.latitude, 'My location', true), () => { status(''); toast('Could not get your location.', 'warn'); }, { enableHighAccuracy: true, timeout: 10000 });
};
async function pickSite(lon, lat, name, fly) {
  S.site = { lon, lat, name: name || `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
  S.center = [lon, lat];
  M.setSite(lon, lat);
  if (fly !== false) M.flyTo(lon, lat, 16);
  $('#siteCard').hidden = false;
  $('#siteName').textContent = S.site.name;
  $('#siteCoords').textContent = `${Math.abs(lat).toFixed(6)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(6)}° ${lon >= 0 ? 'E' : 'W'}`;
  $('#siteTitle').hidden = false; $('#siteTitle').textContent = S.site.name;
  markStale(); syncFrameUI(true); refreshAutoSections(true);
  go(S.step);
  if (!name) reverseName(lon, lat);
  save(); remember();
}
async function reverseName(lon, lat) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&lat=${lat}&lon=${lon}`, { headers: { 'Accept-Language': 'en' } });
    const js = await r.json(); const a = js.address || {};
    const nm = [a.neighbourhood || a.suburb || a.quarter || a.road, a.city || a.town || a.village || a.county].filter(Boolean).join(', ');
    if (nm && S.site && S.site.lon === lon) { S.site.name = nm; $('#siteName').textContent = nm; $('#siteTitle').textContent = nm; save(); remember(); }
  } catch (e) { /* name is cosmetic */ }
}
function remember() {
  try {
    const list = JSON.parse(localStorage.getItem('tk-recent') || '[]').filter(r => Math.hypot(r.lon - S.site.lon, r.lat - S.site.lat) > 1e-4);
    list.unshift(S.site); localStorage.setItem('tk-recent', JSON.stringify(list.slice(0, 6)));
  } catch (e) { /* storage may be blocked */ }
  renderRecent();
}
function renderRecent() {
  let list = []; try { list = JSON.parse(localStorage.getItem('tk-recent') || '[]'); } catch (e) { /* ignore */ }
  $('#recentWrap').hidden = !list.length;
  $('#recent').innerHTML = list.map((r, i) => `<button data-i="${i}">${esc(r.name)}<br><small class="mono">${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}</small></button>`).join('');
  $$('#recent button').forEach(b => b.onclick = () => { const r = list[+b.dataset.i]; pickSite(r.lon, r.lat, r.name, true); });
}

/* ───────────── 2. frame ───────────── */
const scaleChips = $('#scaleChips');
scaleChips.innerHTML = SCALES.map(s => `<button data-v="${s}" class="${s === S.scale ? 'on' : ''}">1:${fmt(s)}</button>`).join('');
const seg = (sel, key, conv = v => v) => $$(sel + ' button').forEach(b => b.onclick = () => { S[key] = conv(b.dataset.v); S.custom = null; $$(sel + ' button').forEach(x => x.classList.toggle('on', x === b)); syncFrameUI(true); markStale(); refreshAutoSections(); save(); M.fitFrame(); });
seg('#paperSeg', 'paper'); seg('#orientSeg', 'orient'); seg('#scaleChips', 'scale', Number);

/** frame size: paper viewport × scale, or custom size */
export function frameSize() {
  const L = sheetLayout(S.paper, S.orient);
  if (S.custom) return { w: S.custom.w, h: S.custom.h };
  return { w: Math.round(L.vw * S.scale / 1000), h: Math.round(L.vh * S.scale / 1000) };
}
/** the exact scale the sheets will print at (custom frames are fitted to the nearest standard scale) */
export function printScale() {
  if (!S.custom) return S.scale;
  const L = sheetLayout(S.paper, S.orient), need = Math.max(S.custom.w / L.vw, S.custom.h / L.vh) * 1000;
  return [...SCALES, 20000, 25000, 50000].find(s => s >= need * 0.999) || Math.ceil(need);
}
function frameCfg() { if (!S.center) return null; const { w, h } = frameSize(); return { lon: S.center[0], lat: S.center[1], w, h, bearing: S.bearing, custom: !!S.custom }; }
function syncFrameUI(redraw) {
  const { w, h } = frameSize();
  $('#frameSize').textContent = `${fmt(w)} × ${fmt(h)} m`;
  $('#frameArea').textContent = w * h >= 1e6 ? `${fmt(w * h / 1e6, 2)} km²` : `${fmt(w * h / 1e4, 1)} ha`;
  $('#rot').value = S.bearing; $('#rotV').textContent = `${fmt(S.bearing, 1)}°`;
  $('#cw').value = w; $('#ch').value = h;
  const km2 = w * h / 1e6, warn = $('#frameWarn');
  warn.hidden = km2 < 6;
  if (km2 >= 6) warn.textContent = km2 > 25 ? `Large area (${fmt(km2, 1)} km²): buildings and streets may be slow or time out — consider a larger scale number only for context maps.` : `Area is ${fmt(km2, 1)} km² — loading may take a minute.`;
  if (S.custom) $$('#scaleChips button').forEach(b => b.classList.remove('on'));
  if (redraw && S.center) M.setFrame(frameCfg());
}
$('#rot').addEventListener('input', () => { S.bearing = +$('#rot').value; syncFrameUI(true); });
$('#rot').addEventListener('change', () => { markStale(); refreshAutoSections(); save(); });
$('#btnNorth').onclick = () => { S.bearing = 0; syncFrameUI(true); markStale(); refreshAutoSections(); save(); M.rotateTo(0); };
$('#btnViewFrame').onclick = () => M.rotateTo(S.bearing);
$('#btnAlign').onclick = () => {
  let b = M.streetBearing();
  if (b == null && S.model) b = bearingFromRoads();
  if (b == null) return toast('No streets found near the frame to align with — zoom in or switch to the Map base.', 'warn');
  S.bearing = Math.round(b * 2) / 2; syncFrameUI(true); markStale(); refreshAutoSections(); save(); M.rotateTo(S.bearing);
  toast(`Frame aligned to the street grid (${fmt(S.bearing, 1)}°).`, 'ok');
};
function bearingFromRoads() {
  const bins = new Float64Array(90), f = S.model.frame;
  for (const r of S.model.osm.roads) for (let i = 1; i < r.pts.length; i++) {
    const dE = (r.pts[i][0] - r.pts[i - 1][0]) * Math.cos(f.lat * Math.PI / 180), dN = r.pts[i][1] - r.pts[i - 1][1], len = Math.hypot(dE, dN);
    if (len) bins[Math.floor(((Math.atan2(dE, dN) * 180 / Math.PI) % 90 + 90) % 90)] += len;
  }
  let best = -1, bv = 0; bins.forEach((v, a) => { if (v > bv) { bv = v; best = a; } });
  return best < 0 ? null : (best > 45 ? best - 90 : best);
}
['#cw', '#ch'].forEach(id => $(id).addEventListener('change', () => {
  S.custom = { w: clamp(+$('#cw').value || 100, 20, 20000), h: clamp(+$('#ch').value || 100, 20, 20000) };
  syncFrameUI(true); markStale(); refreshAutoSections(); save(); M.fitFrame();
}));

/* ───────────── 3. data ───────────── */
const ICON = {
  terrain: '<svg viewBox="0 0 24 24"><path d="M3 19 9 9l4 6 3-4 5 8z"/></svg>',
  buildings: '<svg viewBox="0 0 24 24"><path d="M4 21V8l6-4v17M10 21V9l10 3v9M2 21h20M14 15h2M14 18h2"/></svg>',
  streets: '<svg viewBox="0 0 24 24"><path d="M5 21 9 3M19 21 15 3M12 6v2M12 11v2M12 16v2"/></svg>',
  water: '<svg viewBox="0 0 24 24"><path d="M3 14c2 0 2-1.5 4.5-1.5S10 14 12 14s2.5-1.5 4.5-1.5S19 14 21 14M3 19c2 0 2-1.5 4.5-1.5S10 19 12 19s2.5-1.5 4.5-1.5S19 19 21 19M12 3s-4 4.5-4 7a4 4 0 0 0 8 0c0-2.5-4-7-4-7z"/></svg>',
  trees: '<svg viewBox="0 0 24 24"><path d="M12 22v-6M7 16h10l-2.5-4H16l-4-7-4 7h1.5z"/></svg>',
  climate: '<svg viewBox="0 0 24 24"><circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M17 21H9a4 4 0 0 1 0-8 5 5 0 0 1 9.6 1.4A3.3 3.3 0 0 1 17 21z"/></svg>'
};
const LAYERS = [
  ['terrain', 'Terrain', 'Elevation model on a metric grid aligned to your frame'],
  ['buildings', 'Buildings', 'Footprints, heights and floors'],
  ['streets', 'Streets & paths', 'Road network with names and classes'],
  ['water', 'Water & land use', 'Rivers, lakes, sea, parks, land use'],
  ['trees', 'Mapped trees', 'Individual trees surveyed in OpenStreetMap'],
  ['climate', 'Climate & wind', 'Rainfall, temperature and hourly wind for last year']
];
function renderLayers() {
  $('#layers').innerHTML = LAYERS.map(([id, t, d], i) => `<div class="layer${S.layers[id] ? '' : ' off'}" id="ly-${id}" style="animation-delay:${i * 50}ms">
    <div class="ic">${ICON[id]}</div><div class="hd"><h4>${t}</h4><span class="st" style="display:none"></span></div>
    <label class="switch" title="Include ${t.toLowerCase()}"><input type="checkbox" data-l="${id}" ${S.layers[id] ? 'checked' : ''} ${id === 'terrain' ? 'disabled' : ''}><span></span></label>
    <div class="meta" data-meta>${d}</div><div class="src" data-src></div></div>`).join('');
  $$('#layers input[data-l]').forEach(i => i.onchange = () => { S.layers[i.dataset.l] = i.checked; $('#ly-' + i.dataset.l).classList.toggle('off', !i.checked); markStale(); });
}
function layerState(id, state, meta, src, q) {
  const el = $('#ly-' + id); if (!el) return;
  el.classList.remove('loading', 'ok', 'fail'); if (state) el.classList.add(state);
  const st = el.querySelector('.st');
  st.textContent = state === 'loading' ? 'Loading' : state === 'ok' ? 'Ready' : state === 'fail' ? 'Retry' : '';
  st.style.display = state ? '' : 'none';
  if (meta != null) el.querySelector('[data-meta]').innerHTML = meta;
  if (src != null) { el.querySelector('[data-src]').innerHTML = src + (q ? `<span class="q ${q}">${q.toUpperCase()}</span>` : ''); el.classList.add('has-src'); }
  if (state === 'fail') st.onclick = () => loadData();
}
const defH = () => +$('#defH').value;
$('#defH').oninput = () => { $('#defHV').textContent = `${defH()} m`; if (S.model) { applyDefaultHeight(); } };
$('#smooth').oninput = () => { $('#smoothV').textContent = `${(+$('#smooth').value).toFixed(1)} cells`; };
$('#smooth').onchange = () => { if (S.model) { rebuildSmooth(); scheduleProfile(); } };
$('#gridRes').onchange = () => markStale();

function markStale() {
  if (S.model && !S.stale) { S.stale = true; $('#dataHint').textContent = 'The frame or layers changed — load the data again to update.'; $('#btnLoad span').textContent = 'Reload site data'; }
  go(S.step === 'sections' || S.step === 'outputs' ? 'data' : S.step);
}

async function loadData() {
  if (S.loading) return;
  const cfg = frameCfg(); if (!cfg) return toast('Pick a site first.', 'warn');
  if (S.step !== 'data') go('data');
  S.loading = true; const btn = $('#btnLoad'); btn.classList.add('busy'); btn.disabled = true;
  const frame = makeFrame(cfg), bb = frame.bbox(80), log = m => status(m);
  const long = Math.max(cfg.w, cfg.h), gridSel = $('#gridRes').value;
  const N = gridSel === 'auto' ? clamp(Math.round(long / Math.max(1.5, long / 640)), 160, 768) : +gridSel;
  const res = { frame, osm: emptyOSM(), overture: null, osmBuildings: null, vt: null, climate: null, failed: [] };
  for (const [id] of LAYERS) if (S.layers[id]) layerState(id, 'loading', 'Fetching…'); else layerState(id, null);
  status('Loading site data…');

  const tTerrain = buildDEM(frame, N, p => layerState('terrain', 'loading', `Downloading terrain… ${Math.round(p * 100)}%`)).then(d => { res.dem = d; })
    .catch(e => { res.failed.push('terrain'); layerState('terrain', 'fail', `Failed: ${esc(e.message)}`); });
  const tClimate = S.layers.climate ? fetchClimate(frame).then(c => { res.climate = c; }).catch(e => { res.failed.push('climate'); layerState('climate', 'fail', `Failed: ${esc(e.message)}`); }) : null;
  const tOverture = S.layers.buildings ? loadOvertureBuildings(bb, { log: m => layerState('buildings', 'loading', esc(m)) }).then(r => { res.overture = r; }).catch(e => { res.overtureErr = e.message; }) : null;
  const tOsm = (S.layers.streets || S.layers.water || S.layers.trees) ? fetchOSM(bb, { streets: S.layers.streets, water: S.layers.water, green: S.layers.water, trees: S.layers.trees }, log)
    .then(r => { res.osm = r.data; res.osmFailed = r.failed; }) : null;
  await tOverture;
  if (S.layers.buildings && !(res.overture && res.overture.buildings.length)) {
    layerState('buildings', 'loading', 'Overture unavailable — trying OpenStreetMap…');
    try { const r = await fetchOSM(bb, { buildings: true }, log); res.osmBuildings = r.data.buildings; } catch (e) { /* fall through */ }
    if (!(res.osmBuildings && res.osmBuildings.length)) {
      layerState('buildings', 'loading', 'Trying OpenFreeMap tiles…');
      try { res.vt = await fetchVectorTiles(bb); } catch (e) { /* reported below */ }
    }
  }
  await Promise.all([tTerrain, tClimate, tOsm]);
  // the sea is not an OSM polygon — add OpenFreeMap ocean/sea polygons when water is wanted
  if (S.layers.water && frame.lat > -85) { try { if (!res.vt) res.vt = await fetchVectorTiles(bb); res.osm.water.push(...res.vt.water.filter(w => /ocean|sea/.test(w.tags.water))); } catch (e) { /* optional */ } }

  btn.classList.remove('busy'); btn.disabled = false; S.loading = false;
  if (!res.dem) { status('Terrain failed — check your connection and retry.'); toast('Terrain could not be loaded. Press Retry on the Terrain card.', 'err'); return; }
  buildModel(res);
  S.stale = false; $('#btnLoad span').textContent = 'Reload site data'; $('#dataHint').textContent = '';
  status(''); toast(`Site data ready — ${fmt(S.model.buildings.length)} buildings, ${fmt(S.model.osm.roads.length)} streets.`, 'ok');
  refreshAutoSections(); go('data');
}

function buildModel(res) {
  const { frame, dem } = res, sigma = +$('#smooth').value;
  const smooth = gaussian(dem.data, dem.W, dem.H, sigma), zAt = makeZAt(dem, frame, smooth);
  const osm = localiseOSM(frame, res.osm);
  const nb = normaliseBuildings(frame, { overture: res.overture && res.overture.buildings, osm: res.osmBuildings, vt: res.vt && res.vt.buildings }, defH());
  for (const b of nb.buildings) b.base = buildingBase(b, zAt);
  const der = derive(dem, frame, smooth);
  const model = { frame, dem, smooth, zAt, der, flow: null, buildings: nb.buildings, bsource: nb.source, release: res.overture && res.overture.release, osm, climate: res.climate, terrain: terrainSourceNote(frame.lon, frame.lat), site: S.site, paper: S.paper, orient: S.orient, scale: printScale(), loadedAt: new Date() };
  model.flowArr = () => (model.flow ||= flowAccumulation({ ...dem, data: smooth }));
  S.model = model;
  // layer cards
  const t = model.terrain, cell = Math.max(dem.dx, dem.dy), gres = dem.groundRes;
  layerState('terrain', 'ok', `Grid <b>${dem.W}×${dem.H}</b> · <b>${fmt(cell, 1)} m</b> cells · <b>${fmt(dem.min, 1)}–${fmt(dem.max, 1)} m</b>${dem.repaired ? ` · repaired ${fmt(dem.repaired)} bad cells` : ''}`,
    `${esc(t.name)} · resolution ${t.res} · accuracy ${t.acc} · AWS Terrain Tiles z${dem.zoom} (${fmt(gres, 1)} m pixels)`, /≈(2|3|8|10) m/.test(t.res) ? 'good' : /30|25|15/.test(t.res) ? 'fair' : 'limited');
  if (S.layers.buildings) {
    const hs = heightStats(model.buildings), srcs = {};
    for (const b of model.buildings) for (const s of String(b.src).split(', ')) srcs[s] = (srcs[s] || 0) + 1;
    const srcTxt = Object.entries(srcs).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k)} ${Math.round(v / Math.max(1, model.buildings.length) * 100)}%`).join(', ');
    if (!model.buildings.length) layerState('buildings', 'fail', 'No buildings found here (or all servers failed). Retry, or this area may simply have none mapped.');
    else {
      layerState('buildings', 'ok', `<b data-c="${hs.n}">0</b> buildings · <b>${fmt(hs.pct, 0)}%</b> with real heights (${fmt(hs.recorded)} recorded, ${fmt(hs.floors)} from floors) · others use ${defH()} m, marked “~”`,
        `${esc(model.bsource)}${model.release ? ' ' + esc(model.release) : ''}${srcTxt ? ' — ' + srcTxt : ''}`, hs.pct >= 60 ? 'good' : hs.pct >= 25 ? 'fair' : 'limited');
      const el = $('#ly-buildings [data-c]'); if (el) countUp(el, hs.n);
      const bar = document.createElement('div'); bar.className = 'bar'; bar.innerHTML = '<i></i>'; $('#ly-buildings').appendChild(bar); requestAnimationFrame(() => bar.firstChild.style.width = `${hs.pct}%`);
    }
  }
  const failed = g => (res.osmFailed || []).includes(g);
  if (S.layers.streets) {
    if (failed('streets')) layerState('streets', 'fail', 'OpenStreetMap servers busy — Retry.');
    else { const km = osm.roads.reduce((a, r) => a + r.loc.reduce((s, p, i) => i ? s + Math.hypot(p[0] - r.loc[i - 1][0], p[1] - r.loc[i - 1][1]) : 0, 0), 0) / 1000; layerState('streets', 'ok', `<b>${fmt(osm.roads.length)}</b> ways · <b>${fmt(km, 1)} km</b> · ${fmt(osm.roads.filter(r => r.name).length)} named · ${fmt(osm.rails.length)} rail`, 'OpenStreetMap (live)', 'good'); }
  }
  if (S.layers.water) {
    if (failed('land')) layerState('water', 'fail', 'OpenStreetMap servers busy — Retry.');
    else layerState('water', 'ok', `<b>${fmt(osm.water.length + osm.waterways.length)}</b> water · <b>${fmt(osm.green.length)}</b> green · <b>${fmt(osm.landuse.length)}</b> land-use areas`, 'OpenStreetMap (live) + OpenFreeMap sea polygons', 'good');
  }
  if (S.layers.trees && !failed('land')) layerState('trees', 'ok', `<b>${fmt(osm.trees.length)}</b> mapped trees · ${fmt(osm.trees.filter(t => t.h).length)} with recorded height`, 'OpenStreetMap — only trees someone has surveyed; many areas have few', osm.trees.length > 20 ? 'fair' : 'limited');
  if (S.layers.climate && res.climate) { const c = res.climate; layerState('climate', 'ok', `<b>${fmt(c.annual)} mm</b> rain/yr · <b>${fmt(c.temp, 1)} °C</b> mean · ${c.wind ? 'hourly wind ✓' : 'no wind data'} (${c.year})`, 'Open-Meteo ERA5 reanalysis — regional (≈10–25 km), not site-specific', 'fair'); }
  // map preview of the buildings actually used
  M.setBuildings({ type: 'FeatureCollection', features: model.buildings.map(b => ({ type: 'Feature', properties: { h: b.h, how: b.known ? b.how : 'unknown' }, geometry: { type: 'Polygon', coordinates: b.rings } })) });
  $('#tData').hidden = !model.buildings.length;
}
function applyDefaultHeight() {
  for (const b of S.model.buildings) if (!b.known) b.h = defH();
  scheduleProfile();
}
function rebuildSmooth() {
  const m = S.model; m.smooth = gaussian(m.dem.data, m.dem.W, m.dem.H, +$('#smooth').value); m.zAt = makeZAt(m.dem, m.frame, m.smooth);
  m.der = derive(m.dem, m.frame, m.smooth); m.flow = null;
  for (const b of m.buildings) b.base = buildingBase(b, m.zAt);
}
$('#btnLoad').onclick = loadData;
$('#tData').onclick = () => { const on = !$('#tData').classList.contains('on'); $('#tData').classList.toggle('on', on); M.showBuildings(on); $('#bLegend').hidden = !on; if (on && !M.map.getPitch()) { $('#t3d').click(); } };

/* ───────────── 4. sections ───────────── */
let secSeq = 0;
function autoSections(cfg) {
  const f = makeFrame(cfg);
  return [
    { id: 'A', n: 'A', auto: true, a: f.toLonLat(-cfg.w / 2, 0), b: f.toLonLat(cfg.w / 2, 0) },
    { id: 'B', n: 'B', auto: true, a: f.toLonLat(0, -cfg.h / 2), b: f.toLonLat(0, cfg.h / 2) }
  ];
}
function refreshAutoSections(reset) {
  const cfg = frameCfg(); if (!cfg) return;
  const auto = autoSections(cfg);
  if (reset || !S.sections.length) S.sections = auto;
  else S.sections = S.sections.map(s => s.auto ? (auto.find(a => a.id === s.id) || s) : s);
  M.setSections(S.sections, S.selSec);
}
const nextLetter = () => { const used = new Set(S.sections.map(s => s.n)); return 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('').find(c => !used.has(c)) || 'S' + (++secSeq); };
function renderSecList() {
  $('#secList').innerHTML = S.sections.map((s, i) => {
    let info = '';
    if (S.model) { const f = S.model.frame, A = f.toLocal(...s.a), B = f.toLocal(...s.b); info = `${fmt(Math.hypot(B[0] - A[0], B[1] - A[1]))} m`; }
    return `<div class="sec${s.id === S.selSec ? ' sel' : ''}" data-id="${s.id}" style="animation-delay:${i * 40}ms"><div class="tag">${s.n}</div><div class="info"><strong>Section ${s.n}–${s.n}′</strong><small>${info}${s.auto ? ' · automatic' : ' · custom'}</small></div>
      <button data-a="flip" title="Look the other way"><svg viewBox="0 0 24 24"><path d="M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3"/></svg></button>
      <button data-a="del" title="Delete"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></div>`;
  }).join('');
  $$('#secList .sec').forEach(el => {
    el.onclick = e => { const a = e.target.closest('button'); const s = S.sections.find(q => q.id === el.dataset.id);
      if (a && a.dataset.a === 'flip') { [s.a, s.b] = [s.b, s.a]; s.auto = false; }
      else if (a && a.dataset.a === 'del') { S.sections = S.sections.filter(q => q !== s); if (S.selSec === s.id) S.selSec = S.sections[0] && S.sections[0].id; }
      else S.selSec = s.id;
      renderSecList(); M.setSections(S.sections, S.selSec); scheduleProfile(); save(); };
  });
}
function selectSection(id) { S.selSec = id; renderSecList(); M.setSections(S.sections, S.selSec); scheduleProfile(); }
$('#btnAddSec').onclick = () => {
  const b = $('#btnAddSec');
  if (b.classList.contains('armed')) { M.cancelDraw(); return; }
  b.classList.add('armed'); toast('Click the start point, then the end point. Esc to cancel.');
  M.startDraw((a, bb) => {
    b.classList.remove('armed');
    const n = nextLetter(), s = { id: n + Date.now(), n, a, b: bb, auto: false };
    S.sections.push(s); S.selSec = s.id; renderSecList(); M.setSections(S.sections, S.selSec); scheduleProfile(); save();
  });
};
$('#secDepth').oninput = () => { S.depth = +$('#secDepth').value; $('#depthV').textContent = `${S.depth} m`; scheduleProfile(); };
let profRaf = 0;
function scheduleProfile() { if (profRaf) return; profRaf = requestAnimationFrame(() => { profRaf = 0; drawProfile(); }); }
function drawProfile() {
  if (S.step !== 'sections' || !S.model) return;
  const s = S.sections.find(q => q.id === S.selSec); if (!s) return closeDrawer();
  const sd = computeSection(S.model, s, S.depth), body = $('#profile'), W = body.clientWidth || 800, H = body.clientHeight || 190;
  const p = profileSVG(sd, W, H);
  body.innerHTML = p.svg;
  $('#drawerTitle').textContent = `Section ${s.n}–${s.n}′`;
  $('#drawerMeta').textContent = `${fmt(sd.L)} m · ${sd.dir} · looking ${sd.view} · ${sd.cuts.length} buildings cut · ${sd.beyond.length} beyond${p.exag > 1.05 ? ` · preview ×${fmt(p.exag, 1)} vertical` : ''}`;
  const d = $('#drawer'); if (!d.classList.contains('on')) { d.classList.add('on'); d.setAttribute('aria-hidden', 'false'); requestAnimationFrame(drawProfile); }
}
function closeDrawer() { $('#drawer').classList.remove('on'); $('#drawer').setAttribute('aria-hidden', 'true'); }
$('#drawerClose').onclick = closeDrawer;
addEventListener('resize', () => scheduleProfile());

/* ───────────── 5. outputs ───────────── */
const PACKS = [
  ['plans', 'Site plans', 'Contour site plan, figure-ground, building heights, streets, land use', '<svg viewBox="0 0 24 24"><path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z M9 3v15M15 6v15"/></svg>'],
  ['sections', 'Sections', 'Every section as a true-scale CAD drawing', '<svg viewBox="0 0 24 24"><path d="M2 18h20M4 18v-6h4v6M10 18V8h5v10M17 18v-4h3v4"/></svg>'],
  ['terrain', 'Terrain analysis', 'Elevation, slope, aspect, solar, runoff, wider area', '<svg viewBox="0 0 24 24"><path d="M3 19 9 9l4 6 3-4 5 8z"/></svg>'],
  ['climate', 'Sun & climate', 'Sun path, shadow study, wind rose, climate', '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/></svg>'],
  ['model', 'Physical model', 'Laser-cut contour layers + 3D-print STL', '<svg viewBox="0 0 24 24"><path d="M3 17l9 4 9-4M3 13l9 4 9-4M3 9l9 4 9-4-9-4z"/></svg>'],
  ['cad', 'CAD / GIS files', 'DXF, GeoTIFF, XYZ, OBJ/GLB, GeoJSON, KML', '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z M14 3v6h6M8 13h8M8 17h5"/></svg>']
];
function renderPacks() {
  $('#packs').innerHTML = PACKS.map(([id, t, d, ic], i) => `<button class="pack${S.packs.has(id) ? ' on' : ''}" data-p="${id}" style="animation-delay:${i * 45}ms">${ic}<strong>${t}</strong><small>${d}</small></button>`).join('');
  $$('#packs .pack').forEach(b => b.onclick = () => { S.packs.has(b.dataset.p) ? S.packs.delete(b.dataset.p) : S.packs.add(b.dataset.p); b.classList.toggle('on'); $('#laserOpts').open = S.packs.has('model'); laserHint(); });
}
function laserHint() {
  if (!S.model) return;
  const ms = +$('#modelScale').value, t = +$('#board').value, f = S.model.frame, iv = t * ms / 1000;
  const layers = Math.ceil((S.model.dem.max - S.model.dem.min) / iv) + 1;
  $('#laserHint').innerHTML = `Model ${fmt(f.w * 1000 / ms)} × ${fmt(f.h * 1000 / ms)} mm · contour step <b>${fmt(iv, 2)} m</b> (= board thickness at 1:${fmt(ms)}) · ≈${fmt(layers)} layers`;
}
['#modelScale', '#board'].forEach(id => $(id).addEventListener('input', laserHint));
$('#btnCreate').onclick = async () => {
  if (!S.packs.size) return toast('Choose at least one pack.', 'warn');
  const { openStudio } = await import('./studio.js');
  openStudio(S, { frameSize, printScale, title: () => ({ project: $('#tbProject').value || 'Site analysis', author: $('#tbAuthor').value || '', place: S.site.name }), laser: () => ({ scale: +$('#modelScale').value, board: +$('#board').value, sheetW: +$('#laserW').value, sheetH: +$('#laserH').value }), depth: () => S.depth, defH });
};

/* ───────────── map tools ───────────── */
$('#tCompass').onclick = () => M.map.easeTo({ bearing: 0, pitch: 0, duration: 800 });
$('#t3d').onclick = () => { const on = !$('#t3d').classList.contains('on'); $('#t3d').classList.toggle('on', on); M.set3D(on); };
$$('#tBase button').forEach(b => b.onclick = () => { $$('#tBase button').forEach(x => x.classList.toggle('on', x === b)); M.setBase(b.dataset.v); });
$('#btnHelp').onclick = () => { $('#help').classList.add('on'); $('#help').setAttribute('aria-hidden', 'false'); };
$('#helpClose').onclick = () => { $('#help').classList.remove('on'); $('#help').setAttribute('aria-hidden', 'true'); try { localStorage.setItem('tk-help', '1'); } catch (e) { /* ignore */ } };
$('#btnShare').onclick = async () => { save(); try { await navigator.clipboard.writeText(location.href); toast('Link copied — it reopens this site, frame and sections.', 'ok'); } catch (e) { toast('Copy this page address to share the project.', 'info'); } };

/* ───────────── persistence (link + local) ───────────── */
let saveT;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    if (!S.site) return;
    const st = { s: [+S.site.lon.toFixed(7), +S.site.lat.toFixed(7), S.site.name], c: S.center && S.center.map(v => +v.toFixed(7)), p: S.paper, o: S.orient[0], k: S.scale, b: S.bearing, cu: S.custom,
      x: S.sections.filter(q => !q.auto).map(q => [q.n, ...q.a.map(v => +v.toFixed(7)), ...q.b.map(v => +v.toFixed(7))]), xa: S.sections.filter(q => q.auto).map(q => q.id) };
    const h = '#p=' + encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(st)))));
    history.replaceState(null, '', h);
    try { localStorage.setItem('tk-last', h); } catch (e) { /* ignore */ }
  }, 300);
}
function restore() {
  renderLayers(); renderPacks(); renderRecent();
  let h = location.hash; if (!h.startsWith('#p=')) { try { h = localStorage.getItem('tk-last') || ''; } catch (e) { h = ''; } }
  go('site');
  try { if (!localStorage.getItem('tk-help')) setTimeout(() => $('#btnHelp').click(), 900); } catch (e) { /* ignore */ }
  if (!h.startsWith('#p=')) return;
  try {
    const st = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(h.slice(3))))));
    S.paper = st.p || 'A1'; S.orient = st.o === 'p' ? 'portrait' : 'landscape'; S.scale = st.k || 500; S.bearing = st.b || 0; S.custom = st.cu || null;
    $$('#paperSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === S.paper));
    $$('#orientSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === S.orient));
    $$('#scaleChips button').forEach(b => b.classList.toggle('on', +b.dataset.v === S.scale && !S.custom));
    pickSite(st.s[0], st.s[1], st.s[2], false);
    S.center = st.c || [st.s[0], st.s[1]];
    syncFrameUI(true); refreshAutoSections(true);
    S.sections = S.sections.filter(q => (st.xa || ['A', 'B']).includes(q.id));
    for (const [n, a0, a1, b0, b1] of st.x || []) S.sections.push({ id: n + Math.random().toString(36).slice(2, 6), n, a: [a0, a1], b: [b0, b1], auto: false });
    M.setSections(S.sections, S.selSec);
    M.map.jumpTo({ center: S.center, zoom: 15.5 }); setTimeout(() => M.fitFrame(), 300);
    go('frame');
  } catch (e) { console.warn('could not restore project', e); }
}
