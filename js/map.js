// MapLibre map: base styles, 3D terrain, site pin, editable rotatable frame, section lines.
import { D2R, makeFrame } from './geo.js';

const STYLES = {
  map: 'https://tiles.openfreemap.org/styles/liberty',
  sat: {
    version: 8, glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: { esri: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' } },
    layers: [{ id: 'esri', type: 'raster', source: 'esri' }]
  },
  topo: {
    version: 8, glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: { topo: { type: 'raster', tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://b.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://c.tile.opentopomap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 17, attribution: '© OpenTopoMap (CC-BY-SA) · © OpenStreetMap contributors' } },
    layers: [{ id: 'topo', type: 'raster', source: 'topo' }]
  }
};
const DEM_SRC = { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], encoding: 'terrarium', tileSize: 256, maxzoom: 15, attribution: 'Terrain: AWS Terrain Tiles' };
const EMPTY = { type: 'FeatureCollection', features: [] };

function el(cls, html = '') { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; return d; }

export function createMap(container, cb) {
  const map = new maplibregl.Map({
    container, style: STYLES.map, center: [55.2958, 25.2671], zoom: 2.2, maxPitch: 75, attributionControl: { compact: true },
    canvasContextAttributes: { preserveDrawingBuffer: false }
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false, visualizePitch: true }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

  const st = { base: 'map', three: false, frame: null, frameEditable: false, handles: [], site: null, siteMarker: null, sections: [], selSec: null, secMarkers: [], buildings: EMPTY, showBuildings: false, draw: null };

  function overlays() {
    if (!map.getSource('tk-dem')) map.addSource('tk-dem', DEM_SRC);
    if (st.three) map.setTerrain({ source: 'tk-dem', exaggeration: 1 });
    const add = (id, src, layer, before) => { if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: src }); for (const l of [].concat(layer)) if (!map.getLayer(l.id)) map.addLayer({ ...l, source: id }, before); };
    add('tk-bld', st.buildings, [{ id: 'tk-bld', type: 'fill-extrusion', layout: { visibility: st.showBuildings ? 'visible' : 'none' }, paint: { 'fill-extrusion-color': ['match', ['get', 'how'], 'recorded height', '#1f6feb', 'floors × 3 m', '#7c9cc9', '#c9c4bb'], 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-opacity': 0.9 } }]);
    add('tk-frame', EMPTY, [
      { id: 'tk-frame-fill', type: 'fill', paint: { 'fill-color': '#ff4f1a', 'fill-opacity': 0.06 } },
      { id: 'tk-frame-line', type: 'line', paint: { 'line-color': '#16181d', 'line-width': 2.2, 'line-dasharray': [3, 1.5] } }
    ]);
    add('tk-sec', EMPTY, [
      { id: 'tk-sec-halo', type: 'line', paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.8 } },
      { id: 'tk-sec-line', type: 'line', paint: { 'line-color': ['case', ['get', 'sel'], '#ff4f1a', '#16181d'], 'line-width': 2.6, 'line-dasharray': [4, 2] } }
    ]);
    add('tk-draw', EMPTY, [{ id: 'tk-draw', type: 'line', paint: { 'line-color': '#ff4f1a', 'line-width': 2.5, 'line-dasharray': [1, 1] } }]);
    renderFrame(); renderSections();
    if (st.buildings) map.getSource('tk-bld').setData(st.buildings);
  }
  map.on('style.load', overlays);
  map.on('rotate', () => cb.onBearing && cb.onBearing(map.getBearing()));
  map.on('click', e => { if (st.draw) return drawClick(e); cb.onClick && cb.onClick(e.lngLat.lng, e.lngLat.lat, e); });
  map.on('mousemove', e => { if (st.draw && st.draw.a) drawMove(e); });

  /* ── base map / 3D ── */
  function setBase(kind) { if (kind === st.base) return; st.base = kind; map.setStyle(STYLES[kind], { diff: false }); }
  function set3D(on) {
    st.three = on;
    if (!map.getSource('tk-dem')) map.addSource('tk-dem', DEM_SRC);
    map.setTerrain(on ? { source: 'tk-dem', exaggeration: 1 } : null);
    map.easeTo({ pitch: on ? 58 : 0, duration: 1100 });
  }

  /* ── site pin ── */
  function setSite(lon, lat) {
    st.site = [lon, lat];
    if (!st.siteMarker) st.siteMarker = new maplibregl.Marker({ element: el('h-site'), anchor: 'center' }).setLngLat(st.site).addTo(map);
    else st.siteMarker.setLngLat(st.site);
  }

  /* ── frame ── */
  const ring = f => { const cs = f.corners(); return [...cs, cs[0]]; };
  function renderFrame() {
    const src = map.getSource('tk-frame'); if (!src) return;
    src.setData(st.frame ? { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring(st.frame)] } } : EMPTY);
    placeHandles();
  }
  function placeHandles() {
    const f = st.frame;
    if (!f || !st.frameEditable) { st.handles.forEach(m => m.remove()); st.handles = []; return; }
    if (!st.handles.length) makeHandles();
    const [mv, rot, ...corners] = st.handles;
    mv.setLngLat([f.lon, f.lat]);
    rot.setLngLat(f.toLonLat(0, f.h / 2 + Math.max(25, f.h * 0.1)));
    const cs = f.corners(); corners.forEach((m, i) => m.setLngLat(cs[i]));
  }
  function makeHandles() {
    const mk = (cls, title) => { const e = el(cls); e.title = title; return new maplibregl.Marker({ element: e, draggable: true, anchor: 'center' }); };
    const mv = mk('h-move', 'Drag to move the frame'), rot = mk('h-rot', 'Drag to rotate the frame'), corners = [0, 1, 2, 3].map(() => mk('h-corner', 'Drag to resize (custom size)'));
    const emit = final => cb.onFrame && cb.onFrame({ lon: st.frame.lon, lat: st.frame.lat, w: st.frame.w, h: st.frame.h, bearing: st.frame.bearing }, final);
    mv.on('drag', () => { const p = mv.getLngLat(); st.frame = makeFrame({ ...cfgOf(st.frame), lon: p.lng, lat: p.lat }); renderFrame(); emit(false); });
    rot.on('drag', () => {
      const p = rot.getLngLat(), dE = (p.lng - st.frame.lon) * Math.cos(st.frame.lat * D2R), dN = p.lat - st.frame.lat;
      let b = Math.atan2(dE, dN) / D2R; b = Math.round(b * 2) / 2; for (const s of [-180, -90, 0, 90, 180]) if (Math.abs(b - s) < 1.5) b = s;
      st.frame = makeFrame({ ...cfgOf(st.frame), bearing: b }); renderFrame(); emit(false);
    });
    corners.forEach(m => m.on('drag', () => {
      const p = m.getLngLat(), [x, y] = st.frame.toLocal(p.lng, p.lat);
      st.frame = makeFrame({ ...cfgOf(st.frame), w: Math.max(20, Math.round(Math.abs(x) * 2)), h: Math.max(20, Math.round(Math.abs(y) * 2)), custom: true });
      renderFrame(); emit(false);
    }));
    [mv, rot, ...corners].forEach(m => { m.on('dragend', () => emit(true)); m.setLngLat([st.frame.lon, st.frame.lat]).addTo(map); });
    st.handles = [mv, rot, ...corners];
  }
  const cfgOf = f => ({ lon: f.lon, lat: f.lat, w: f.w, h: f.h, bearing: f.bearing, custom: f.custom });
  function setFrame(cfg, editable = st.frameEditable) { st.frame = cfg ? makeFrame(cfg) : null; st.frameEditable = editable; renderFrame(); }
  function setFrameEditable(on) { st.frameEditable = on; placeHandles(); }
  function fitFrame(opts = {}) {
    if (!st.frame) return;
    const cs = st.frame.corners(), xs = cs.map(c => c[0]), ys = cs.map(c => c[1]);
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: window.innerWidth > 820 ? { top: 90, bottom: 60, left: 460, right: 80 } : { top: 70, bottom: Math.round(window.innerHeight * 0.56) + 20, left: 24, right: 64 }, duration: 1200, bearing: opts.bearing ?? map.getBearing(), pitch: map.getPitch(), maxZoom: 18 });
  }

  /* estimate dominant street direction around the frame from rendered road features */
  function streetBearing() {
    if (!st.frame) return null;
    const c = map.project([st.frame.lon, st.frame.lat]), r = 220;
    const feats = map.queryRenderedFeatures([[c.x - r, c.y - r], [c.x + r, c.y + r]]).filter(f => /road|transportation|street|highway/i.test(f.layer.id + ' ' + (f.sourceLayer || '')) && /Line/.test(f.geometry.type));
    const bins = new Float64Array(90);
    for (const f of feats) {
      const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const ln of lines) for (let i = 1; i < ln.length; i++) {
        const dE = (ln[i][0] - ln[i - 1][0]) * Math.cos(st.frame.lat * D2R), dN = ln[i][1] - ln[i - 1][1], len = Math.hypot(dE, dN);
        if (!len) continue;
        const a = ((Math.atan2(dE, dN) / D2R) % 90 + 90) % 90; bins[Math.floor(a)] += len;
      }
    }
    let best = -1, bv = 0;
    for (let a = 0; a < 90; a++) { let v = 0; for (let d = -3; d <= 3; d++) v += bins[(a + d + 90) % 90] * (1 - Math.abs(d) / 4); if (v > bv) { bv = v; best = a; } }
    if (best < 0) return null;
    let b = best; if (b > 45) b -= 90;   // keep the turn small
    return b;
  }

  /* ── buildings preview ── */
  function setBuildings(fc) { st.buildings = fc || EMPTY; const s = map.getSource('tk-bld'); if (s) s.setData(st.buildings); }
  function showBuildings(on) { st.showBuildings = on; if (map.getLayer('tk-bld')) map.setLayoutProperty('tk-bld', 'visibility', on ? 'visible' : 'none'); }

  /* ── sections ── */
  function setSections(list, sel) { st.sections = list; st.selSec = sel; renderSections(); }
  function renderSections() {
    const src = map.getSource('tk-sec'); if (!src) return;
    src.setData({ type: 'FeatureCollection', features: st.sections.map(s => ({ type: 'Feature', properties: { id: s.id, sel: s.id === st.selSec }, geometry: { type: 'LineString', coordinates: [s.a, s.b] } })) });
    st.secMarkers.forEach(m => m.remove()); st.secMarkers = [];
    if (!st.secVisible) return;
    for (const s of st.sections) for (const end of ['a', 'b']) {
      const e = el('h-sec' + (s.id === st.selSec ? ' sel' : ''), s.n + (end === 'b' ? '′' : ''));
      const m = new maplibregl.Marker({ element: e, draggable: true, anchor: 'center' }).setLngLat(s[end]).addTo(map);
      e.addEventListener('click', ev => { ev.stopPropagation(); cb.onSectionSelect && cb.onSectionSelect(s.id); });
      m.on('drag', () => { const p = m.getLngLat(); s[end] = [p.lng, p.lat]; s.auto = false; const src2 = map.getSource('tk-sec'); src2 && src2.setData({ type: 'FeatureCollection', features: st.sections.map(q => ({ type: 'Feature', properties: { id: q.id, sel: q.id === st.selSec }, geometry: { type: 'LineString', coordinates: [q.a, q.b] } })) }); cb.onSectionChange && cb.onSectionChange(s, false); });
      m.on('dragend', () => cb.onSectionChange && cb.onSectionChange(s, true));
      st.secMarkers.push(m);
    }
  }
  function showSections(on) { st.secVisible = on; renderSections(); }

  function startDraw(done) {
    st.draw = { a: null, done };
    map.getCanvas().style.cursor = 'crosshair';
    const key = e => { if (e.key === 'Escape') cancelDraw(); };
    st.draw.key = key; window.addEventListener('keydown', key);
  }
  function cancelDraw() {
    if (!st.draw) return;
    window.removeEventListener('keydown', st.draw.key);
    st.draw = null; map.getCanvas().style.cursor = '';
    const s = map.getSource('tk-draw'); s && s.setData(EMPTY);
    cb.onDrawCancel && cb.onDrawCancel();
  }
  function snapped(e) {
    const p = [e.lngLat.lng, e.lngLat.lat];
    if (!st.draw.a || !st.frame || (e.originalEvent && e.originalEvent.shiftKey)) return p;
    const A = st.frame.toLocal(...st.draw.a), B = st.frame.toLocal(...p), dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx) / D2R, snap = Math.round(ang / 90) * 90;
    if (Math.abs(ang - snap) > 12) return p;
    return st.frame.toLonLat(A[0] + L * Math.cos(snap * D2R), A[1] + L * Math.sin(snap * D2R));
  }
  function drawClick(e) {
    const p = snapped(e);
    if (!st.draw.a) { st.draw.a = p; return; }
    const a = st.draw.a, done = st.draw.done;
    window.removeEventListener('keydown', st.draw.key);
    st.draw = null; map.getCanvas().style.cursor = '';
    const s = map.getSource('tk-draw'); s && s.setData(EMPTY);
    done(a, p);
  }
  function drawMove(e) { const s = map.getSource('tk-draw'); s && s.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [st.draw.a, snapped(e)] } }); }

  return {
    map, setBase, set3D, setSite, setFrame, setFrameEditable, fitFrame, streetBearing, setBuildings, showBuildings,
    setSections, showSections, startDraw, cancelDraw,
    get frame() { return st.frame; },
    flyTo(lon, lat, zoom = 16) { map.flyTo({ center: [lon, lat], zoom, speed: 1.4, curve: 1.5, essential: true }); },
    rotateTo(b) { map.rotateTo(b, { duration: 900 }); }
  };
}
