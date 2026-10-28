// Supplemental environmental data from public services.
// These are regional/grid-cell products, not measurements at the project boundary.

const json = async (url, label) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`${label} HTTP ${r.status}`);
    const data = await r.json();
    if (data.error) throw new Error(data.reason || `${label} returned an error`);
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`${label} timed out`);
    throw e;
  } finally { clearTimeout(timer); }
};

/** Long-term, modelled solar resource and fixed-panel yield from JRC PVGIS. */
export async function fetchSolarResource(lat, lon) {
  const q = new URLSearchParams({ lat: String(lat), lon: String(lon), peakpower: '1', loss: '14', optimalangles: '1', outputformat: 'json' });
  const data = await json(`https://re.jrc.ec.europa.eu/api/v5_3/PVcalc?${q}`, 'PVGIS');
  const monthly = data.outputs?.monthly?.fixed;
  const annual = data.outputs?.totals?.fixed;
  if (!Array.isArray(monthly) || !annual) throw new Error('PVGIS did not return solar resource values');
  return {
    source: 'European Commission Joint Research Centre PVGIS 5.3',
    latitude: data.inputs?.location?.latitude ?? lat,
    longitude: data.inputs?.location?.longitude ?? lon,
    elevationM: data.inputs?.location?.elevation ?? null,
    years: [data.inputs?.meteo_data?.year_min, data.inputs?.meteo_data?.year_max],
    annualPVYieldKWhPerKwp: annual.E_y ?? null,
    annualPlaneIrradianceKWhM2: annual['H(i)_y'] ?? null,
    monthly: monthly.map(m => ({ month: m.month, pvYieldKWhPerKwp: m.E_m ?? null, planeIrradianceKWhM2: m['H(i)_m'] ?? null }))
  };
}

/** CAMS air-quality grid-cell forecast from Open-Meteo; retain timestamp and units. */
export async function fetchAirQuality(lat, lon) {
  const q = new URLSearchParams({
    latitude: String(lat), longitude: String(lon), domains: 'auto', forecast_days: '5',
    hourly: 'pm2_5,pm10,nitrogen_dioxide,ozone,european_aqi'
  });
  const data = await json(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}`, 'Air quality');
  const h = data.hourly;
  if (!Array.isArray(h?.time) || !h.time.length) throw new Error('Air-quality forecast returned no hourly values');
  const latest = {};
  for (const k of ['pm2_5', 'pm10', 'nitrogen_dioxide', 'ozone', 'european_aqi']) {
    const values = h[k] || [];
    const i = values.findIndex(v => v != null && Number.isFinite(+v));
    latest[k] = i < 0 ? null : +values[i];
  }
  return {
    source: 'CAMS air-quality forecast via Open-Meteo',
    model: data.model || null,
    latitude: data.latitude ?? lat,
    longitude: data.longitude ?? lon,
    time: h.time.find((_, i) => ['pm2_5', 'pm10', 'nitrogen_dioxide', 'ozone', 'european_aqi'].some(k => h[k]?.[i] != null)) || null,
    values: latest,
    units: data.hourly_units || {},
    resolutionNote: 'Grid-cell forecast (about 11 km in Europe and about 45 km globally); not a local sensor reading.'
  };
}
