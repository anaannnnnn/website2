# TerraKit — free terrain & 3D site studio

A single-page web app (`index.html`, no build step) that generates and downloads, for free, from open data:

- **Terrain / DEM**: GeoTIFF, ESRI ASCII grid, XYZ point cloud, 16-bit PNG and R16 heightmaps (Unreal/Unity), 8-bit PNG
- **Contours**: DXF, GeoJSON, KML, SVG (auto or custom interval, major/minor)
- **3D models**: STL (watertight, 3D-print scaling), OBJ, textured GLB, DXF site model (terrain mesh, contours, 3D buildings, roads, water, green, trees)
- **3D styles**: smooth landscape, 3D terrain blocks, terraced contour model, 3D heatmap bars, wireframe
- **Heatmaps**: elevation, hillshade, slope, aspect, solar exposure, runoff paths (D8 flow accumulation), annual rainfall, rainfall runoff volume, temperature, flood depth, satellite
- **Rainfall & climate**: last full year of daily rainfall, snow, temperature and evapotranspiration (CSV)
- **Tools**: flood / water-level simulation, sun position & shadows by date and time, 2D heatmap overlay on the map
- **Presentation sheets** (vector SVG + PNG): building heights, figure-ground, street hierarchy, land use / green & blue, slope analysis, contour heat map (site and wider area), layered interpretation, 3D topography & contour model, sun path diagram, wind rose, climate summary
- **Rendered 3D section views**: section perspective and sectional aerial view per section — the real area cut open along the line, OSM building footprints with windowed facades and roofs, trees, satellite or map-style ground, sun shadows, poché cut faces, level markers and key plan
- **Site sections**: A–A′ (west–east) and B–B′ (south–north) through the site plus any line you draw — ground poché, buildings cut and in elevation, trees, water, street names, level datums, key plan; also DXF and CSV profile
- Automatic repair of terrain-tile dropouts, adjustable smoothing, crisp classed colour bands
- **Download everything** as one ZIP

Data: AWS Terrain Tiles (SRTM, 3DEP, EU-DEM…), © OpenStreetMap contributors (ODbL), Open-Meteo ERA5 (CC-BY 4.0), Esri World Imagery.

Run locally: open `index.html` in a browser, or serve the folder (`python3 -m http.server`). Host free on GitHub Pages (Settings → Pages → deploy from branch).
