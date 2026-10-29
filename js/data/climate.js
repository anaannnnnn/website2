// Open-Meteo ERA5 reanalysis: last full year of daily climate on a 4×4 grid plus
// hourly wind, humidity, apparent temperature and shortwave radiation at the site.
export async function fetchClimate(frame) {
  const b = frame.bbox(), G = 4, lats = [], lons = [];
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) { lats.push((b.s + (b.n - b.s) * j / (G - 1)).toFixed(4)); lons.push((b.w + (b.e - b.w) * i / (G - 1)).toFixed(4)); }
  const year = new Date().getUTCFullYear() - 1, base = 'https://data.desiregroup.ae/climate';
  const dailyUrl = `${base}?latitude=${lats.join(',')}&longitude=${lons.join(',')}&start_date=${year}-01-01&end_date=${year}-12-31&daily=precipitation_sum,snowfall_sum,temperature_2m_mean,temperature_2m_max,temperature_2m_min,et0_fao_evapotranspiration&timezone=GMT`;
  const hourlyUrl = `${base}?latitude=${frame.lat.toFixed(4)}&longitude=${frame.lon.toFixed(4)}&start_date=${year}-01-01&end_date=${year}-12-31&hourly=temperature_2m,relative_humidity_2m,apparent_temperature,shortwave_radiation,wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timezone=GMT`;
  // These datasets are independent; downloading them together nearly halves the
  // climate wait on normal connections.
  const hourlyRequest = fetch(hourlyUrl).then(async w => w.ok ? w.json() : null).catch(() => null);
  const r = await fetch(dailyUrl);
  if (!r.ok) throw new Error('Open-Meteo HTTP ' + r.status);
  let js = await r.json(); if (!Array.isArray(js)) js = [js];
  const monthMean = (arr, time) => { const s = new Array(12).fill(0), n = new Array(12).fill(0); time.forEach((t, i) => { if (arr[i] != null) { s[+t.slice(5, 7) - 1] += arr[i]; n[+t.slice(5, 7) - 1]++; } }); return s.map((v, m) => v / (n[m] || 1)); };
  const points = js.map((o, k) => {
    const d = o.daily, pr = d.precipitation_sum.map(v => v || 0), monthly = new Array(12).fill(0);
    d.time.forEach((t, i) => monthly[+t.slice(5, 7) - 1] += pr[i]);
    const temps = d.temperature_2m_mean.filter(v => v != null);
    return {
      lat: +lats[k], lon: +lons[k], annual: pr.reduce((a, v) => a + v, 0), monthly, temp: temps.reduce((a, v) => a + v, 0) / (temps.length || 1),
      wetDays: pr.filter(v => v >= 1).length, maxDay: Math.max(...pr), snow: d.snowfall_sum.reduce((a, v) => a + (v || 0), 0), et0: d.et0_fao_evapotranspiration.reduce((a, v) => a + (v || 0), 0),
      mTemp: monthMean(d.temperature_2m_mean, d.time), mTmax: monthMean(d.temperature_2m_max, d.time), mTmin: monthMean(d.temperature_2m_min, d.time), daily: d
    };
  });
  const avg = f => points.reduce((a, p) => a + f(p), 0) / points.length, m12 = f => Array.from({ length: 12 }, (_, m) => avg(p => f(p)[m]));
  let wind = null, hourly = null;
  const wj = await hourlyRequest;
  if (wj?.hourly) {
    const h = wj.hourly;
    wind = { spd: h.wind_speed_10m, dir: h.wind_direction_10m };
    hourly = { time: h.time, temp: h.temperature_2m, rh: h.relative_humidity_2m, apparent: h.apparent_temperature, radiation: h.shortwave_radiation };
  }
  return {
    year, points, wind, hourly, annual: avg(p => p.annual), temp: avg(p => p.temp), wetDays: avg(p => p.wetDays), maxDay: avg(p => p.maxDay), snow: avg(p => p.snow), et0: avg(p => p.et0),
    monthly: m12(p => p.monthly), mTemp: m12(p => p.mTemp), mTmax: m12(p => p.mTmax), mTmin: m12(p => p.mTmin)
  };
}
