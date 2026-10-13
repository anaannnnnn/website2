// Studio: builds the chosen packs into true-scale sheets + files, shows them in a gallery, handles downloads.
import { $, $$, download, esc, fmt, sleep, toast } from './util.js';
import * as SH from './sheets.js';
import * as EX from './export.js';
import { laserModel } from './laser.js';

let ST = null;   // current studio run
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export async function openStudio(S, H) {
  const M = S.model; M.defaultH = H.defH(); M.site = S.site;
  const studio = $('#studio'); studio.classList.add('on'); studio.setAttribute('aria-hidden', 'false');
  tab('sheets');
  const t = H.title(), scale = H.printScale();
  const c = SH.sheetCtx(M, { paper: S.paper, orient: S.orient, scale, project: t.project, author: t.author });
  const view3d = await import('./view3d.js');
  EX.useTriangulator(view3d.triangulate);
  const iv = SH.contourIntervalFor(c), laser = H.laser();
  const jobs = [];
  const add = (pack, title, fn, kind = 'sheet') => jobs.push({ pack, title, fn, kind });
  if (S.packs.has('plans')) {
    add('plans', 'Site plan', () => SH.sitePlan(c, S.sections));
    add('plans', 'Figure-ground', () => SH.figureGround(c));
    add('plans', 'Building heights', () => SH.buildingHeights(c));
    add('plans', 'Street hierarchy', () => SH.streets(c));
    add('plans', 'Land use, green & blue', () => SH.landUse(c));
  }
  if (S.packs.has('sections') && S.sections.length) add('sections', 'Sections', () => SH.sectionSheets(c, S.sections, H.depth()), 'multi');
  if (S.packs.has('terrain')) {
    add('terrain', 'Elevation', () => SH.elevationMap(c));
    add('terrain', 'Slope analysis', () => SH.slopeMap(c));
    add('terrain', 'Aspect', () => SH.aspectMap(c));
    add('terrain', 'Solar exposure', () => SH.solarMap(c));
    add('terrain', 'Surface runoff paths', () => SH.runoffMap(c));
    add('terrain', 'Site model (axonometric)', async () => { const r = await view3d.axonometricPNG(M, { style: 'terraced', iv: Math.max(iv, (M.dem.max - M.dem.min) / 25), exag: 1 }); return SH.imageSheet(c, { title: 'Site model — axonometric', subtitle: `Contour-layer model (${fmt(Math.max(iv, (M.dem.max - M.dem.min) / 25), 2)} m steps) with buildings at their recorded or default heights; white = recorded height, grey = height not recorded.`, url: r.url, iw: r.w, ih: r.h, legend: [{ fill: '#ffffff', label: 'Building (recorded height / floors)' }, { fill: '#e4e0d8', label: 'Building, height not recorded' }] }); });
  }
  if (S.packs.has('climate')) {
    add('climate', 'Sun path diagram', () => SH.sunPathSheet(c));
    if (M.buildings.length) add('climate', 'Shadow study', () => SH.shadowStudy(c));
    if (M.climate && M.climate.wind) add('climate', 'Wind rose', () => SH.windRoseSheet(c));
    if (M.climate) add('climate', 'Climate summary', () => SH.climateSheet(c));
  }
  if (S.packs.has('model')) add('model', 'Laser-cut boards', () => laserModel(M, laser), 'laser');

  const files = [];
  const file = (pack, name, desc, make, type = 'application/octet-stream') => files.push({ pack, name, desc, make, type });
  const base = slug((S.site && S.site.name) || 'site');
  if (S.packs.has('cad')) {
    file('cad', `${base}_site.dxf`, 'CAD site model — site-aligned metres (terrain mesh, contours, 3D buildings, roads, water, trees)', () => EX.siteDXF(M, iv, 'site'), 'application/dxf');
    file('cad', `${base}_site_utm.dxf`, `CAD site model — real UTM ${M.frame.zone}${M.frame.south ? 'S' : 'N'} coordinates`, () => EX.siteDXF(M, iv, 'utm'), 'application/dxf');
    file('cad', `${base}_contours_${iv}m.dxf`, `Contours every ${iv} m (major every ${iv * 5} m) — site-aligned`, () => EX.contoursDXF(M, iv, 'site'), 'application/dxf');
    file('cad', `${base}_contours.geojson`, 'Contours as GeoJSON (WGS84)', () => EX.contoursGeoJSON(M, iv), 'application/geo+json');
    file('cad', `${base}_contours.kml`, 'Contours for Google Earth', () => EX.contoursKML(M, iv), 'application/vnd.google-earth.kml+xml');
    file('cad', `${base}_dem_utm.tif`, `Terrain GeoTIFF, EPSG:${M.frame.epsg} (rotated frame)`, () => EX.geoTiff(M));
    file('cad', `${base}_dem_site.asc`, 'Terrain ASCII grid (site-aligned metres)', () => EX.ascGrid(M), 'text/plain');
    file('cad', `${base}_points.csv`, 'Terrain points: site x/y, UTM E/N, lon/lat, elevation', () => EX.xyzCSV(M), 'text/csv');
    file('cad', `${base}_heightmap16.png`, '16-bit heightmap (min→0, max→65535) for Unreal/Unity/Blender', () => EX.png16(M), 'image/png');
    file('cad', `${base}_features.geojson`, 'Buildings (with height source), streets, water, green, land use, trees', () => EX.featuresGeoJSON(M), 'application/geo+json');
    file('cad', `${base}_model.obj`, '3D model (OBJ, metres) — terrain + buildings + mapped trees', async () => EX_OBJ(view3d, M), 'text/plain');
    file('cad', `${base}_model.glb`, '3D model (glTF binary, metres)', async () => EX_GLB(view3d, M));
  }
  if (S.packs.has('model')) file('model', `${base}_print_1to${laser.scale}.stl`, `3D-print model at 1:${fmt(laser.scale)} in millimetres (${fmt(M.frame.w * 1000 / laser.scale)} × ${fmt(M.frame.h * 1000 / laser.scale)} mm)`, async () => EX_STL(view3d, M, laser.scale), 'model/stl');
  file('info', 'README.txt', 'Coordinate systems, sources and reliability of every file', () => EX.readme(M), 'text/plain');

  ST = { S, H, M, c, sheets: [], files, base, view3d, iv };
  renderFiles(files);
  // gallery with skeletons
  const g = $('#gallery'); g.innerHTML = jobs.map((j, i) => `<div class="card skeleton" data-j="${i}" style="animation-delay:${i * 40}ms"><div class="thumb"></div><div class="cap"><div><strong>${esc(j.title)}</strong><small>Drawing…</small></div></div></div>`).join('');
  const bar = $('#studioProgress div'); bar.style.width = '0';
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i], card = g.querySelector(`[data-j="${i}"]`);
    await sleep(20);
    try {
      const r = await j.fn();
      if (j.kind === 'laser') {
        const out = r.boards.map((b, k) => ({ id: `laser_board_${k + 1}`, title: `Laser board ${k + 1} / ${r.boards.length}`, sub: `${fmt(b.w)} × ${fmt(b.h)} mm · ${b.n} pieces${b.oversize ? ' · piece larger than your board' : ''}`, svg: b.svg, dxf: b.dxf, pack: 'model' }));
        out[0] && (out[0].note = `Contour step ${fmt(r.interval, 2)} m · ${r.layers} layers · ${r.pieces} pieces · model ${fmt(r.size[0])} × ${fmt(r.size[1])} mm`);
        fillCards(card, out);
        if (r.oversize) toast(`${r.oversize} laser piece(s) are bigger than your board — choose a smaller model scale (e.g. 1:${fmt(laser.scale * 2)}).`, 'warn', 7000);
      } else if (j.kind === 'multi') {
        fillCards(card, r.map((svg, k) => ({ id: `sections_${k + 1}`, title: r.length > 1 ? `Sections · sheet ${k + 1}` : 'Sections', sub: `1:${fmt(scale)} @ ${S.paper}`, svg, pack: j.pack })));
      } else fillCards(card, [{ id: slug(j.title), title: j.title, sub: `${S.paper} ${S.orient} · ${/axonometric|Sun path|Wind|Climate/.test(j.title) ? 'diagram' : '1:' + fmt(scale)}`, svg: r, pack: j.pack }]);
    } catch (e) {
      console.error(j.title, e);
      card.classList.remove('skeleton'); card.querySelector('small').textContent = 'Could not draw: ' + e.message;
    }
    bar.style.width = `${(i + 1) / jobs.length * 100}%`;
  }
  numberSheets();
  setTimeout(() => { bar.style.width = '0'; }, 900);
  toast(`${ST.sheets.length} sheets and ${files.length} files ready.`, 'ok');
}

function fillCards(card, list) {
  const frag = document.createDocumentFragment();
  for (const sh of list) {
    ST.sheets.push(sh);
    const el = document.createElement('div'); el.className = 'card';
    const url = URL.createObjectURL(new Blob([sh.svg], { type: 'image/svg+xml' }));
    el.innerHTML = `<div class="thumb"><img alt="${esc(sh.title)}" src="${url}"></div><div class="cap"><div><strong>${esc(sh.title)}</strong><small>${esc(sh.note || sh.sub)}</small></div></div>
      <div class="acts"><button class="btn ghost" data-a="pdf">PDF</button><button class="btn ghost" data-a="svg">SVG</button><button class="btn ghost" data-a="png">PNG</button>${sh.dxf ? '<button class="btn ghost" data-a="dxf">DXF</button>' : ''}</div>`;
    el.querySelector('.thumb').onclick = () => openModal(sh, url);
    el.querySelectorAll('[data-a]').forEach(b => b.onclick = () => sheetDownload(sh, b.dataset.a, b));
    frag.appendChild(el);
  }
  card.replaceWith(frag);
}
function numberSheets() { const n = ST.sheets.filter(s => !s.dxf).length; let i = 0; for (const s of ST.sheets) if (!s.dxf) { i++; s.svg = s.svg.replace(/(\d{4}-\d{2}-\d{2})(<\/text>)/, `$1  ·  SHEET ${String(i).padStart(2, '0')}/${String(n).padStart(2, '0')}$2`); } }
async function sheetDownload(sh, kind, btn) {
  const name = `${ST.base}_${sh.id}`;
  try {
    btn && (btn.disabled = true);
    if (kind === 'svg') download(sh.svg, name + '.svg', 'image/svg+xml');
    if (kind === 'dxf') download(sh.dxf, name + '.dxf', 'application/dxf');
    if (kind === 'png') download(await EX.svgToPNG(sh.svg, 150), name + '.png');
    if (kind === 'pdf') { toast('Building vector PDF…'); download(await EX.sheetsToPDF([sh.svg]), name + '.pdf', 'application/pdf'); }
  } catch (e) { console.error(e); toast('Export failed: ' + e.message, 'err'); }
  finally { btn && (btn.disabled = false); }
}

/* zoomable preview */
function openModal(sh, url) {
  const m = $('#viewerModal'), cv = $('#modalCanvas');
  $('#modalTitle').textContent = sh.title;
  cv.innerHTML = `<img src="${url}" alt="">`;
  const img = cv.firstChild; let z = 1;
  img.onload = () => { const fit = Math.min((cv.clientWidth - 40) / img.naturalWidth, (cv.clientHeight - 30) / img.naturalHeight); img.style.width = img.naturalWidth * fit + 'px'; };
  cv.onwheel = e => { e.preventDefault(); z = Math.min(8, Math.max(1, z * (e.deltaY < 0 ? 1.15 : 0.87))); img.style.transform = `scale(${z})`; };
  $('#modalActions').innerHTML = ['pdf', 'svg', 'png'].concat(sh.dxf ? ['dxf'] : []).map(k => `<button class="btn ghost" data-a="${k}">${k.toUpperCase()}</button>`).join('');
  $$('#modalActions [data-a]').forEach(b => b.onclick = () => sheetDownload(sh, b.dataset.a, b));
  m.classList.add('on'); m.setAttribute('aria-hidden', 'false');
}
$('#modalClose').onclick = () => { $('#viewerModal').classList.remove('on'); $('#viewerModal').setAttribute('aria-hidden', 'true'); };

/* files */
function renderFiles(files) {
  $('#files').innerHTML = files.map((f, i) => `<div class="file" style="animation-delay:${i * 30}ms"><div class="ext">${esc(f.name.split('.').pop().toUpperCase())}</div><div><strong>${esc(f.name)}</strong><small>${esc(f.desc)}</small></div><button class="btn ghost" data-i="${i}">Download</button></div>`).join('');
  $$('#files [data-i]').forEach(b => b.onclick = async () => { const f = files[+b.dataset.i]; b.disabled = true; b.textContent = '…'; try { download(await f.make(), f.name, f.type); } catch (e) { console.error(e); toast('Failed: ' + e.message, 'err'); } b.disabled = false; b.textContent = 'Download'; });
}
async function modelRoot(view3d, M) { const { root } = view3d.buildScene(M, { style: 'smooth', buildings: true, base: true, exag: 1 }, await view3d.surfaceTexture(M, 'clay')); return root; }
async function EX_OBJ(view3d, M) { return view3d.toOBJ(await modelRoot(view3d, M)); }
async function EX_GLB(view3d, M) { return view3d.toGLB(await modelRoot(view3d, M)); }
async function EX_STL(view3d, M, scale) { return view3d.toSTL(await modelRoot(view3d, M), 1000 / scale); }

/* download all */
$('#btnZip').onclick = async () => {
  if (!ST) return;
  const b = $('#btnZip'); b.disabled = true; const bar = $('#studioProgress div');
  try {
    const z = new JSZip(), total = ST.sheets.length + ST.files.length + 1; let n = 0;
    const tick = msg => { bar.style.width = `${++n / total * 100}%`; b.textContent = msg; };
    for (const s of ST.sheets) { z.file(`${s.pack}/${ST.base}_${s.id}.svg`, s.svg); if (s.dxf) z.file(`${s.pack}/${ST.base}_${s.id}.dxf`, s.dxf); tick('Sheets…'); await sleep(0); }
    for (const f of ST.files) { try { z.file(`${f.pack}/${f.name}`, await f.make()); } catch (e) { console.error(f.name, e); } tick('Files…'); await sleep(0); }
    try { const set = ST.sheets.filter(s => !s.dxf).map(s => s.svg); if (set.length) z.file(`${ST.base}_drawings.pdf`, await EX.sheetsToPDF(set)); } catch (e) { console.error('pdf', e); }
    tick('Compressing…');
    download(await z.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 4 } }), `${ST.base}_terrakit.zip`);
    toast('ZIP ready.', 'ok');
  } catch (e) { console.error(e); toast('ZIP failed: ' + e.message, 'err'); }
  finally { b.disabled = false; b.textContent = 'Download all'; setTimeout(() => bar.style.width = '0', 800); }
};
$('#btnPdfAll').onclick = async () => {
  if (!ST) return;
  const b = $('#btnPdfAll'); b.disabled = true; b.textContent = 'Building PDF…';
  try { download(await EX.sheetsToPDF(ST.sheets.filter(s => !s.dxf).map(s => s.svg)), `${ST.base}_drawings.pdf`, 'application/pdf'); toast('PDF set ready.', 'ok'); }
  catch (e) { console.error(e); toast('PDF failed: ' + e.message, 'err'); }
  finally { b.disabled = false; b.textContent = 'PDF set'; }
};

/* tabs & 3D */
function tab(t) { $$('#studioTabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t)); $$('.tabpane').forEach(p => p.classList.toggle('on', p.dataset.t === t)); if (t === 'model') show3D(); }
$$('#studioTabs button').forEach(b => b.onclick = () => tab(b.dataset.t));
$('#studioBack').onclick = () => { $('#studio').classList.remove('on'); $('#studio').setAttribute('aria-hidden', 'true'); };
let viewer = null;
async function show3D() {
  if (!ST) return;
  if (!viewer) { viewer = ST.view3d.createViewer($('#viewer')); if (!$('#mDate').value) $('#mDate').valueAsDate = new Date(); }
  const o = { style: $('#mStyle').value, surface: $('#mHeat').value, exag: +$('#mExag').value, buildings: $('#mBuild').checked, base: $('#mBase').checked, iv: Math.max(ST.iv, (ST.M.dem.max - ST.M.dem.min) / 30), date: $('#mDate').valueAsDate || new Date(), hour: +$('#mTime').value, context: Object.fromEntries($$('[data-ctx]').map(c => [c.dataset.ctx, c.checked])) };
  try {
    const lg = await viewer.show(ST.M, o);
    $('#mLegend').innerHTML = lg ? `<div class="hint">${esc(lg.label)}</div><div class="grad" style="background:linear-gradient(90deg,${lg.colors.join(',')})"></div><div class="ends"><span>${fmt(lg.lo, 1)}</span><span>${fmt(lg.hi, 1)}</span></div>` : '';
  } catch (e) { console.error(e); toast('3D failed: ' + e.message, 'err'); }
}
['#mStyle', '#mHeat', '#mExag', '#mBuild', '#mBase', '#mDate', '#mTime'].forEach(id => $(id).addEventListener('change', show3D));
$$('[data-ctx]').forEach(c => c.addEventListener('change', show3D));
$('#mExag').addEventListener('input', () => { $('#mExagV').textContent = (+$('#mExag').value).toFixed(1) + '×'; });
$('#mTime').addEventListener('input', () => { const h = +$('#mTime').value; $('#mTimeV').textContent = `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round(h % 1 * 60)).padStart(2, '0')}`; });
$$('.model-panel [data-m]').forEach(b => b.onclick = async () => {
  if (!viewer || !viewer.root) return;
  const k = b.dataset.m, name = `${ST.base}_model_view`;
  if (k === 'png') return download(await viewer.png(), name + '.png');
  if (k === 'stl') return download(ST.view3d.toSTL(viewer.root), name + '.stl');
  if (k === 'obj') return download(ST.view3d.toOBJ(viewer.root), name + '.obj', 'text/plain');
  if (k === 'glb') return download(await ST.view3d.toGLB(viewer.root), name + '.glb');
});
