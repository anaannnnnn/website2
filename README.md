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
   - **Buildings**: **Overture Maps** (OpenStreetMap + Microsoft + Google + Esri footprints, heights, floors)
     read directly from Overture's public GeoParquet files; fallback to OpenFreeMap tiles, then
     live OpenStreetMap.
   - **Streets, water, land use, places**: OpenStreetMap via OpenFreeMap vector tiles (CDN, weekly) — always
     works; live Overpass (mirrors raced, 12 s grace) is preferred when it answers. **Trees** need live Overpass.
   - **Climate & wind**: Open-Meteo ERA5 (last full year).
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
   - **Sections**: each section on its own as a drawing-only PNG (up to 16,000 px, DPI embedded), SVG,
     PDF and **DXF** (1 unit = 1 m, X = distance along the cut, Y = real elevation; true hidden-line,
     cut buildings as solid fills, ground hatch, separate layers), plus a presentation sheet.
   - **CAD / GIS**: 2D site-plan DXF (footprints with heights, labelled contours, streets, water, green,
     land use, trees, section lines, north arrow), 3D DXF site model (site-aligned *and* real UTM), contour DXF/GeoJSON/KML,
     GeoTIFF (EPSG UTM with rotation), ASCII grid, XYZ points, 16-bit heightmap, OBJ, GLB, GeoJSON.

Every sheet is authored in millimetres and exports as **vector PDF**, SVG or PNG, with a title block
(project, author, coordinates, UTM zone, scale bar, rotated north arrow, data sources and reliability).
**DWG:** no free tool can write DWG reliably in a browser (the format is closed; LibreDWG's writer is
experimental). The DXF files are R12, which AutoCAD, BricsCAD, Rhino, ArchiCAD, Revit and SketchUp open
directly — in AutoCAD use *Save As → DWG*, or batch-convert a folder with the free ODA File Converter.

Projects are saved in the page link — share it to reopen the same site, frame and sections.

## Honest data

Nothing is invented. Buildings without a recorded height use a default height that you set, and are
hatched / dashed / on separate CAD layers. Missing layers are reported, not filled. Where national
open data is better than these global sources (lidar, LoD2 city models), it is worth using it alongside.

## Repository

- `index.html`, `css/`, `js/` — the app (plain ES modules, no build step).
- `data/overture-index.json` — bounding box of each Overture building file; refreshed weekly by
  `.github/workflows/overture-index.yml` running `tools/build-overture-index.mjs`.
- `legacy/` — the previous single-file version.

Data © OpenStreetMap contributors (ODbL), Overture Maps Foundation (CDLA-Permissive / ODbL),
AWS Terrain Tiles / Mapzen, Open-Meteo (CC-BY 4.0), OpenFreeMap, Esri (imagery, view only).
