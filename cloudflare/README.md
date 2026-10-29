# TerraKit data Worker

`worker.js` is the fixed-origin gateway used by the browser app at
`https://minhafathimapk.art`. It exposes only `/pvgis`, `/air-quality`,
`/climate`, and `/overpass`; it does not accept arbitrary upstream URLs.

The Worker caches successful environmental GET requests for 30 minutes to one
day and Overpass responses for five minutes. A Cloudflare rate-limit binding
limits each client IP and path to 120 requests per minute. Public data providers
can still rate-limit or reject Cloudflare egress; the proxy does not bypass
their terms or quotas.

The Worker is named `terrakit` and uses the custom domain
`data.desiregroup.ae`. `wrangler.jsonc` records its runtime and route settings.
