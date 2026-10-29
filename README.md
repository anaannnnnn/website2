# TerraKit — Site Studio

Free, accurate site drawings for architecture students, anywhere in the world. Pick a site, frame it on a
rotatable 3D map at the sheet size and scale you'll print, and get true-scale plans, sections, terrain
analysis, climate boards, CAD/GIS files, a 3D model and laser-cut contour layers.

Everything runs in the browser — no account, no paid server. Host it free on GitHub Pages
(Settings → Pages → deploy from branch, root folder).

## How it works

1. **Site** — search (OpenStreetMap Nominatim), paste coordinates, use your location or click the map.
2. **Frame** — choose the sheet (A4–A0, landscape/portrait) and scale (1:200 – 1:10 000); the frame becomes
   exactly the area that fits. Drag to move, rotate with the handle, or *Align to street* to snap to the
   street grid. The map itself rotates and tilts (MapLibre GL, 3D terrain).
3. **Data** — fetched live, each layer with its source and a reliability badge:
   - **Terrain**: AWS Terrain Tiles (SRTM, USGS 3DEP, UK EA LIDAR, EU-DEM, LINZ … depending on region),
     resampled onto a frame-aligned UTM grid, dropouts repaired.
   - **Buildings**: **Overture Maps** footprints, heights, floors, materials and roof fields, including
     Overture's separate OSM-derived `building_part` features for detailed 3D massing; live OpenStreetMap
     and OpenFreeMap footprints are merged in to fill gaps rather than discarded when Overture has data.
   - **Streets, water, land use, trees, places**: live OpenStreetMap (Overpass, 4 mirrors) + sea polygons.
   - **Climate & wind**: Open-Meteo ERA5 (last full year).
   - **Solar resource**: European Commission JRC PVGIS typical-year yield and plane-of-array irradiation (1 kWp reference system, 14% assumed losses).
   - **Air quality**: CAMS forecast via Open-Meteo (PM₂.₅, PM₁₀, NO₂, ozone and European AQI at the nearest model grid cell).
4. **Sections** — A–A′ and B–B′ are added along the frame axes; draw more on the map (snapping to the
   frame axes), drag the ends and watch the live profile.
5. **Drawings** — choose packs:
   - **Site plans**: contour site plan with index labels and spot heights, figure-ground, building
     heights, street hierarchy, land use.
   - **Sections**: true-scale CAD sections — solid poché cut, hidden-line elevation behind, terrain
     silhouettes, hatched ground.
   - **Terrain analysis**: elevation, slope, aspect, solar exposure, runoff paths, clay axonometric model.
   - **Sun & climate**: sun path, shadow study (solstices/equinox × 9/12/15 h), wind rose, climate summary.
   - **Physical model**: laser-cut contour layers (contour step = board thickness at model scale,
     next layer + building footprints engraved, packed on your board size) as SVG/DXF, and a 3D-print STL.
   - **CAD / GIS**: DXF site model (site-aligned *and* real UTM coordinates), contour DXF/GeoJSON/KML,
     GeoTIFF (EPSG UTM with rotation), ASCII grid, XYZ points, 16-bit heightmap, OBJ, GLB, GeoJSON.

6. **Advanced analysis** — the Studio’s Analyze tab adds an evidence-led comparison workspace:
   - clipped building coverage, estimated FAR and mapped building-use/year/material completeness;
   - mapped parcel availability, green/water ratios and amenity proximity;
   - terrain-and-building sky-view factor and direct-sun access at the site centre;
   - terrain viewshed, apparent-temperature comfort hours, radiation totals and a transparent road-exposure index;
   - reusable visual palettes, an eight-card custom diagram board, JSON/CSV evidence export and a printable report;
   - an accuracy ledger beside the results: mapped, derived, modelled and indicative values are never presented as equivalent.

The 3D viewer also has an **Explode layers** control for separating terrain, buildings and vegetation into an
axonometric layer study. Advanced results are saved into every ZIP as an evidence report with calculation
methods, input sources and explicit unavailable-data disclosures.

Where sources provide building parts, roof shape, roof height, colors or materials, the 3D model uses those
attributes. For known low-rise heights without a mapped roof shape, TerraKit infers a simple gabled or hipped
roof from the footprint; this is a visual estimate, not surveyed roof geometry. Unknown building heights still
use the configured default and are marked as approximate.

Every sheet is authored in millimetres and exports as **vector PDF**, SVG or PNG, with a title block
(project, author, coordinates, UTM zone, scale bar, rotated north arrow, data sources and reliability).
Projects are saved in the page link — share it to reopen the same site, frame and sections.

## Honest data

Building heights are sourced or explicitly marked as defaults. The 3D viewer infers simple roofs only
when a low-rise has a known height but no roof-shape tag; that visual estimate is identified in the data
card. Buildings without a recorded height use a default height that you set, and are hatched / dashed /
on separate CAD layers. Missing layers are reported, not filled. Where national
open data is better than these global sources (lidar, LoD2 city models), it is worth using it alongside.
Accordingly, TerraKit does not label a road-class proxy as measured traffic noise, regional wind as CFD,
community-mapped boundaries as an authoritative cadastre, or building counts as population. Native SKP,
RVT and 3DM authoring also requires the corresponding proprietary SDK or conversion service. Those results
remain unavailable unless the required observed, statutory or licensed system exists.
PVGIS yield is a long-term model result for a reference PV system, not a roof-specific shading or
engineering estimate. CAMS air-quality values are regional grid-cell forecasts, not local monitor readings.

## Repository

- `index.html`, `css/`, `js/` — the app (plain ES modules, no build step).
- `data/overture-index.json` — bounding boxes for Overture building and building-part files; refreshed weekly by
  `.github/workflows/overture-index.yml` running `tools/build-overture-index.mjs`.
- `legacy/` — the previous single-file version.

Data © OpenStreetMap contributors (ODbL), Overture Maps Foundation (CDLA-Permissive / ODbL),
AWS Terrain Tiles / Mapzen, Open-Meteo (CC-BY 4.0), CAMS ENSEMBLE, JRC PVGIS, OpenFreeMap,
Esri (imagery, view only).
