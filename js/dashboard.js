import { analyseSite } from './advanced.js';
import { $, $$, download, esc, fmt, toast } from './util.js';

const pct = v => v == null ? 'Unavailable' : `${fmt(v, 1)}%`;
const metres = v => v == null ? 'Unavailable' : v >= 1000 ? `${fmt(v / 1000, 2)} km` : `${fmt(v, 0)} m`;
const metric = (id, label, value, note, quality = 'modelled') => ({ id, label, value, note, quality });

function flatten(A) {
  const u = A.urban, e = A.environment, c = e.comfort, s = e.solar, nearest = e.access.groups.filter(x => x.nearest != null).sort((a, b) => a.nearest - b.nearest)[0];
  return [
    metric('coverage', 'Site coverage', pct(u.coveragePct), `${fmt(u.footprintM2, 0)} m² mapped building footprint`, 'mapped'),
    metric('far', 'Estimated FAR', u.far == null ? 'Unavailable' : fmt(u.far, 2), `${u.floorAreaCoveragePct.toFixed(0)}% of footprint has enough height/floor data`, 'derived'),
    metric('green', 'Mapped green', pct(u.greenPct), 'Mapped green polygons clipped to the frame', 'mapped'),
    metric('water', 'Mapped water', pct(u.waterPct), 'Mapped water polygons clipped to the frame', 'mapped'),
    metric('sky', 'Sky view factor', pct(e.skyViewPct), 'Site-centre 2.5D horizon, terrain + buildings', 'modelled'),
    metric('sun', 'Direct-sun access', pct(s.annualAccess), `${fmt(s.annualMeanHours, 1)} h/day mean on monthly reference days`, 'modelled'),
    metric('views', 'Terrain visibility', pct(e.terrainVisiblePct), 'Terrain line-of-sight from 1.6 m eye height', 'modelled'),
    metric('walk', 'Amenity access index', e.access.score == null ? 'Unavailable' : `${fmt(e.access.score, 0)} / 100`, nearest ? `Nearest mapped category: ${nearest.name}, ${metres(nearest.nearest)}` : 'No mapped amenities', 'indicative'),
    metric('roads', 'Road exposure index', fmt(e.roadExposureIndex, 1), `${fmt(u.roadKm, 2)} km mapped road in frame; relative, not dB`, 'indicative'),
    metric('comfort', 'Comfortable hours', c ? pct(c.comfortablePct) : 'Unavailable', c ? `Open-Meteo apparent temperature, 18–26 °C · P05 ${fmt(c.p05, 1)}° / P95 ${fmt(c.p95, 1)}°` : 'Hourly climate unavailable', 'modelled'),
    metric('heat', 'Heat-stress hours', c ? pct(c.heatStressPct) : 'Unavailable', 'Apparent temperature ≥32 °C', 'modelled'),
    metric('solar_energy', 'Annual shortwave', c ? `${fmt(c.solarKWhM2, 0)} kWh/m²` : 'Unavailable', 'Horizontal reanalysis radiation at the site coordinate', 'modelled'),
    metric('parcels', 'Mapped parcels', String(u.parcels.count), u.parcels.count ? `${pct(u.parcels.coveragePct)} frame coverage` : 'No explicit OSM parcel boundaries here', 'mapped'),
    metric('year', 'Building year coverage', pct(u.yearKnownPct), u.yearMedian ? `Median mapped year ${u.yearMedian}` : 'No construction-year records', 'mapped')
  ];
}

const paletteKey = 'tk-analysis-palette';
const customPaletteKey = 'tk-analysis-custom-palette';
const pinsKey = 'tk-analysis-pins';
const uploadsKey = 'tk-analysis-uploads';
const PALETTES = {
  ember: ['#ff4f1a', '#1d2026', '#f5f4f0'],
  cobalt: ['#2867e8', '#172033', '#f3f7ff'],
  forest: ['#17715a', '#17352e', '#f1f7f3'],
  plum: ['#8b4dcc', '#2c2135', '#faf5ff'],
  mono: ['#111111', '#333333', '#f3f3f1']
};
let current = null, metrics = [];

function getPins() { try { return JSON.parse(localStorage.getItem(pinsKey) || '[]'); } catch { return []; } }
function setPins(v) { localStorage.setItem(pinsKey, JSON.stringify(v.slice(0, 8))); }
function getUploads() { try { return JSON.parse(localStorage.getItem(uploadsKey) || '[]'); } catch { return []; } }
function setUploads(v) {
  try { localStorage.setItem(uploadsKey, JSON.stringify(v)); }
  catch { toast('Those images exceed browser storage. Use smaller files.', 'warn'); }
}
function quality(q) { return `<span class="evidence ${q}">${q}</span>`; }

function renderCards(host) {
  const pins = getPins();
  host.querySelector('[data-metrics]').innerHTML = metrics.map(m => `<article class="analysis-card${pins.includes(m.id) ? ' pinned' : ''}" data-id="${m.id}">
    <button class="pin" title="${pins.includes(m.id) ? 'Remove from diagram board' : 'Pin to diagram board'}" aria-pressed="${pins.includes(m.id)}">${pins.includes(m.id) ? '●' : '○'}</button>
    <small>${esc(m.label)}</small><strong>${esc(m.value)}</strong><p>${esc(m.note)}</p>${quality(m.quality)}</article>`).join('');
  host.querySelectorAll('.analysis-card .pin').forEach(b => b.onclick = () => {
    const id = b.closest('[data-id]').dataset.id, next = getPins();
    if (next.includes(id)) next.splice(next.indexOf(id), 1);
    else if (next.length + getUploads().length < 8) next.push(id);
    else return toast('The diagram board holds up to eight cards.', 'warn');
    setPins(next); renderCards(host); renderBoard(host);
  });
}

function renderBoard(host) {
  const chosen = getPins().map(id => metrics.find(m => m.id === id)).filter(Boolean), uploads = getUploads();
  const board = host.querySelector('[data-board]');
  board.innerHTML = chosen.length || uploads.length ? chosen.map((m, i) => `<div class="diagram-tile" style="--i:${i}"><span>${esc(m.label)}</span><b>${esc(m.value)}</b><small>${esc(m.note)}</small></div>`).join('') + uploads.map((u, i) => `<figure class="diagram-upload" style="--i:${chosen.length + i}"><img src="${u.data}" alt=""><figcaption>${esc(u.name)}</figcaption><button data-remove-upload="${i}" title="Remove upload">×</button></figure>`).join('') : '<p class="analysis-empty">Pin metrics or upload images to build a presentation-ready diagram board.</p>';
  board.querySelectorAll('[data-remove-upload]').forEach(b => b.onclick = () => { const a = getUploads(); a.splice(+b.dataset.removeUpload, 1); setUploads(a); renderBoard(host); });
}

function reportHtml(A) {
  const rows = metrics.map(m => `<tr><th>${esc(m.label)}</th><td>${esc(m.value)}</td><td>${esc(m.note)}</td><td>${esc(m.quality)}</td></tr>`).join('');
  const methods = Object.entries(A.evidence.methods).map(([k, v]) => `<li><b>${esc(k)}</b> — ${esc(v)}</li>`).join('');
  const gaps = A.unavailable.map(x => `<li>${esc(x)}</li>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>TerraKit evidence report</title><style>body{font:14px Inter,Arial,sans-serif;color:#17191f;margin:40px;max-width:1100px}h1{font-size:30px}h2{margin-top:32px}table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #ddd;padding:10px}th{width:18%}small{color:#666}@media print{body{margin:12mm}}</style><h1>TerraKit site evidence report</h1><p>${A.site.latitude.toFixed(5)}, ${A.site.longitude.toFixed(5)} · ${fmt(A.site.areaM2 / 10000, 2)} ha · generated ${new Date(A.generatedAt).toLocaleString()}</p><h2>Results</h2><table><tr><th>Measure</th><th>Result</th><th>Meaning</th><th>Evidence class</th></tr>${rows}</table><h2>Methods</h2><ul>${methods}</ul><h2>Unavailable or limited</h2><ul>${gaps}</ul><p><small>Mapped values are only as complete as their cited source. Modelled and indicative results are not surveys or statutory determinations.</small></p><script>onload=()=>print()<\/script>`;
}

export function renderAnalysis(M, prepared = null) {
  const host = $('#analysisWorkspace');
  try { current = prepared || analyseSite(M); metrics = flatten(current); }
  catch (e) { host.innerHTML = `<div class="analysis-error">Analysis failed: ${esc(e.message)}</div>`; return; }
  host.innerHTML = `<header class="analysis-head"><div><span>Evidence workspace</span><h2>Advanced site intelligence</h2><p>Mapped, modelled and indicative results remain visibly distinct. Nothing unavailable is synthesized.</p></div><div class="analysis-actions"><button class="btn ghost" data-export="json">JSON</button><button class="btn ghost" data-export="csv">CSV</button><button class="btn dark" data-report>Print report</button></div></header>
    <section class="palette-row"><b>Diagram style</b>${Object.entries(PALETTES).map(([k, v]) => `<button data-palette="${k}" title="${k}" style="--p1:${v[0]};--p2:${v[1]};--p3:${v[2]}"><i></i><i></i><i></i></button>`).join('')}<label class="custom-colors" title="Custom accent"><input type="color" value="#ff4f1a" data-color="0"></label><label class="custom-colors" title="Custom ink"><input type="color" value="#1d2026" data-color="1"></label><label class="custom-colors" title="Custom paper"><input type="color" value="#f5f4f0" data-color="2"></label><button class="style-action" data-copy-style title="Copy style JSON">Share style</button><button class="style-action" data-import-style title="Import style JSON">Import</button></section>
    <section class="analysis-metrics" data-metrics></section>
    <section class="analysis-section"><div class="analysis-title"><div><span>Custom diagrams</span><h3>Diagram board</h3></div><div class="board-actions"><button class="btn ghost btn-sm" data-board-mode>Stack</button><label class="btn ghost btn-sm">Upload<input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" multiple data-upload hidden></label></div></div><div class="diagram-board" data-board></div></section>
    <section class="analysis-columns"><div><div class="analysis-title"><div><span>Building intelligence</span><h3>Mapped use</h3></div></div><div class="bar-list">${current.urban.uses.slice(0, 8).map(x => `<div><span>${esc(x.name)}</span><i><b style="width:${Math.max(1, x.pct)}%"></b></i><em>${fmt(x.pct, 1)}%</em></div>`).join('') || '<p>No mapped use data.</p>'}</div></div>
    <div><div class="analysis-title"><div><span>Proximity</span><h3>Amenities</h3></div></div><div class="proximity-list">${current.environment.access.groups.map(x => `<div><span>${esc(x.name)}</span><b>${x.nearest == null ? 'No mapped result' : metres(x.nearest)}</b><small>${x.count} mapped</small></div>`).join('')}</div></div></section>
    <section class="analysis-section"><div class="analysis-title"><div><span>Accuracy ledger</span><h3>Methods and limitations</h3></div></div><details open><summary>Calculation methods</summary><ul>${Object.entries(current.evidence.methods).map(([k, v]) => `<li><b>${esc(k)}</b> — ${esc(v)}</li>`).join('')}</ul></details><details><summary>Unavailable or limited results (${current.unavailable.length})</summary><ul>${current.unavailable.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details></section>`;
  const custom = (() => { try { return JSON.parse(localStorage.getItem(customPaletteKey) || 'null'); } catch { return null; } })();
  if (custom) PALETTES.custom = custom;
  const palette = localStorage.getItem(paletteKey) || 'ember'; applyPalette(host, palette);
  const activeColors = PALETTES[palette] || PALETTES.ember; host.querySelectorAll('[data-color]').forEach((x, i) => { x.value = activeColors[i]; x.oninput = () => { const colors = [...host.querySelectorAll('[data-color]')].map(y => y.value); PALETTES.custom = colors; localStorage.setItem(customPaletteKey, JSON.stringify(colors)); localStorage.setItem(paletteKey, 'custom'); applyPalette(host, 'custom'); }; });
  host.querySelectorAll('[data-palette]').forEach(b => b.onclick = () => { localStorage.setItem(paletteKey, b.dataset.palette); applyPalette(host, b.dataset.palette); });
  host.querySelector('[data-copy-style]').onclick = async () => { const key = localStorage.getItem(paletteKey) || 'ember', payload = JSON.stringify({ terrakitStyle: 1, name: key, colors: PALETTES[key] || PALETTES.ember }); try { await navigator.clipboard.writeText(payload); toast('Style copied. Share the JSON with another TerraKit user.', 'ok'); } catch { download(payload, 'terrakit-style.json', 'application/json'); } };
  host.querySelector('[data-import-style]').onclick = () => { const raw = prompt('Paste a TerraKit style JSON'); if (!raw) return; try { const s = JSON.parse(raw); if (s.terrakitStyle !== 1 || !Array.isArray(s.colors) || s.colors.length !== 3 || s.colors.some(x => !/^#[0-9a-f]{6}$/i.test(x))) throw new Error('invalid style'); PALETTES.custom = s.colors; localStorage.setItem(customPaletteKey, JSON.stringify(s.colors)); localStorage.setItem(paletteKey, 'custom'); applyPalette(host, 'custom'); host.querySelectorAll('[data-color]').forEach((x, i) => x.value = s.colors[i]); toast('Shared style applied.', 'ok'); } catch { toast('That is not a valid TerraKit style.', 'warn'); } };
  host.querySelector('[data-board-mode]').onclick = e => { const board = host.querySelector('[data-board]'), on = board.classList.toggle('stack'); e.currentTarget.textContent = on ? 'Grid' : 'Stack'; };
  host.querySelector('[data-upload]').onchange = async e => {
    const existing = getUploads(), room = Math.max(0, 8 - getPins().length - existing.length), files = [...e.target.files].slice(0, room);
    if (!room) return toast('Remove a pinned item before uploading.', 'warn');
    for (const file of files) {
      if (file.size > 1_500_000) { toast(`${file.name} is over 1.5 MB and was skipped.`, 'warn'); continue; }
      const data = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
      existing.push({ name: file.name, data });
    }
    setUploads(existing); e.target.value = ''; renderBoard(host);
  };
  host.querySelector('[data-report]').onclick = () => { const w = open('', '_blank'); if (!w) return toast('Allow pop-ups to print the report.', 'warn'); w.document.write(reportHtml(current)); w.document.close(); };
  host.querySelector('[data-export="json"]').onclick = () => download(JSON.stringify(current, null, 2), 'terrakit_analysis.json', 'application/json');
  host.querySelector('[data-export="csv"]').onclick = () => download('metric,value,evidence,note\n' + metrics.map(m => [m.label, m.value, m.quality, m.note].map(x => `"${String(x).replaceAll('"', '""')}"`).join(',')).join('\n'), 'terrakit_analysis.csv', 'text/csv');
  renderCards(host); renderBoard(host);
}

function applyPalette(host, key) {
  const p = PALETTES[key] || PALETTES.ember;
  host.style.setProperty('--analysis-accent', p[0]); host.style.setProperty('--analysis-ink', p[1]); host.style.setProperty('--analysis-paper', p[2]);
  host.querySelectorAll('[data-palette]').forEach(b => b.classList.toggle('on', b.dataset.palette === key));
}

