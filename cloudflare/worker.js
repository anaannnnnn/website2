// TerraKit's fixed-origin data gateway. It is intentionally not a general proxy.
const APP_ORIGINS = new Set([
  'https://minhafathimapk.art',
  'https://www.minhafathimapk.art',
]);

const ROUTES = {
  '/pvgis': {
    base: 'https://re.jrc.ec.europa.eu/api/v5_3/PVcalc',
    params: ['lat', 'lon', 'peakpower', 'loss', 'optimalinclination', 'optimalangles', 'outputformat'],
    cacheTtl: 86400,
  },
  '/air-quality': {
    base: 'https://air-quality-api.open-meteo.com/v1/air-quality',
    params: ['latitude', 'longitude', 'hourly', 'timezone', 'forecast_days', 'domains'],
    cacheTtl: 1800,
  },
  '/climate': {
    base: 'https://archive-api.open-meteo.com/v1/archive',
    params: ['latitude', 'longitude', 'start_date', 'end_date', 'daily', 'hourly', 'wind_speed_unit', 'timezone'],
    cacheTtl: 86400,
  },
};

// Keep the same public Overpass mirrors TerraKit used before proxying. Fail over
// only when an instance reports a server-side outage; pass quota and policy
// responses through unchanged.
const OVERPASS_UPSTREAMS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

function corsHeaders(origin) {
  const h = new Headers({
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  });
  if (APP_ORIGINS.has(origin)) h.set('Access-Control-Allow-Origin', origin);
  return h;
}

function jsonError(message, status, headers) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: new Headers([...headers, ['Content-Type', 'application/json; charset=utf-8']]),
  });
}

function validCoordinates(params, keys) {
  for (const [key, min, max] of keys) {
    const value = Number(params.get(key));
    if (!params.has(key) || !Number.isFinite(value) || value < min || value > max) return false;
  }
  return true;
}

async function cacheKey(path, queryOrBody) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${path}\n${queryOrBody}`));
  const hash = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
  return new Request(`https://terrakit-cache.invalid/${path.slice(1)}/${hash}`);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (origin && !APP_ORIGINS.has(origin)) return jsonError('Origin not allowed', 403, cors);
    if (!origin) return jsonError('Browser Origin required', 403, cors);

    const route = ROUTES[url.pathname];
    const overpass = url.pathname === '/overpass';
    if (!route && !overpass) return jsonError('Not found', 404, cors);

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rate = await env.TERRAKIT_LIMITER.limit({ key: `${ip}:${url.pathname}` });
    if (!rate.success) return jsonError('Rate limit exceeded; retry shortly', 429, cors);

    try {
      if (route) {
        if (request.method !== 'GET') return jsonError('GET required', 405, cors);
        const upstream = new URL(route.base);
        for (const key of route.params) {
          for (const value of url.searchParams.getAll(key)) upstream.searchParams.append(key, value);
        }
        const coordinates = url.pathname === '/pvgis'
          ? [['lat', -90, 90], ['lon', -180, 180]]
          : [['latitude', -90, 90], ['longitude', -180, 180]];
        if (!validCoordinates(upstream.searchParams, coordinates)) return jsonError('Valid latitude and longitude are required', 400, cors);

        const key = await cacheKey(url.pathname, upstream.toString());
        const cached = await caches.default.match(key);
        if (cached) return new Response(cached.body, { status: cached.status, headers: new Headers([...cached.headers, ...cors]) });

        const upstreamResponse = await fetch(upstream, {
          headers: { Accept: 'application/json', 'User-Agent': 'TerraKit/1.0 (environmental site analysis)' },
        });
        const headers = new Headers({
          'Content-Type': upstreamResponse.headers.get('Content-Type') || 'application/json',
          'Cache-Control': `public, max-age=${route.cacheTtl}`,
        });
        const stored = new Response(upstreamResponse.body, { status: upstreamResponse.status, headers });
        if (upstreamResponse.ok) ctx.waitUntil(caches.default.put(key, stored.clone()));
        for (const [name, value] of cors) headers.set(name, value);
        return new Response(stored.body, { status: stored.status, headers });
      }

      if (request.method !== 'POST') return jsonError('POST required', 405, cors);
      const contentType = request.headers.get('Content-Type') || '';
      if (!contentType.toLowerCase().startsWith('application/x-www-form-urlencoded')) return jsonError('Form-encoded Overpass query required', 415, cors);
      const body = await request.text();
      if (body.length > 24000) return jsonError('Query too large', 413, cors);
      const query = new URLSearchParams(body).get('data') || '';
      if (!query.startsWith('[out:json][timeout:30];(') || !/(?:;)?\);out geom;$/.test(query)) return jsonError('Unsupported Overpass query', 400, cors);

      const key = await cacheKey('/overpass', query);
      const cached = await caches.default.match(key);
      if (cached) return new Response(cached.body, { status: cached.status, headers: new Headers([...cached.headers, ...cors]) });

      let upstreamResponse;
      for (const endpoint of OVERPASS_UPSTREAMS) {
        try {
          upstreamResponse = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'TerraKit/1.0 (https://minhafathimapk.art)' },
            body: `data=${encodeURIComponent(query)}`,
          });
          if (![502, 503, 504].includes(upstreamResponse.status)) break;
        } catch {
          upstreamResponse = null;
        }
      }
      if (!upstreamResponse) return jsonError('Overpass providers unavailable', 502, cors);
      const headers = new Headers({
        'Content-Type': upstreamResponse.headers.get('Content-Type') || 'application/json',
        'Cache-Control': 'public, max-age=300',
      });
      const stored = new Response(upstreamResponse.body, { status: upstreamResponse.status, headers });
      if (upstreamResponse.ok) ctx.waitUntil(caches.default.put(key, stored.clone()));
      for (const [name, value] of cors) headers.set(name, value);
      return new Response(stored.body, { status: stored.status, headers });
    } catch {
      return jsonError('Data provider unavailable', 502, cors);
    }
  },
};
