# agentsim_wildfire

An agent-based wildfire evacuation simulator that runs entirely in the browser. It couples a stochastic fire-spread model with household agents, a queue-based road network and swarm-style shared fields, then reports the metrics that matter for evacuation policy: who gets out, how long it takes, where the roads jam, and which parcels carry the most egress risk.

It runs on real roads, buildings, land cover and land use from [Overture Maps](https://overturemaps.org), with terrain elevation fetched from open Terrain Tiles. A synthetic demo community is included for presentations that need no data at all.

> Everything beyond the input data (fire behavior, alert reach, departure delays, road capacities, zones) is illustrative and uncalibrated. Read results as the shape of the tradeoffs, not as predictions for any real place or event.

## The two apps

| App | File | Needs |
|---|---|---|
| Real-map simulator | `docs/index.html` | Overture GeoJSON files you upload; internet for basemaps and elevation |
| Synthetic demo | `docs/synthetic.html` | Nothing; runs offline and ships with a precomputed 24-fire policy study |

Open either file in Chrome, Edge or Firefox, or publish the repo with GitHub Pages (Settings → Pages → Deploy from branch → `main`, folder `/docs`). The real-map app will then be at `https://<your-username>.github.io/agentsim_wildfire/`.

## Getting the data

Download Overture data for Santa Barbara County, split into six study areas sized for the simulator:

```bash
pip install overturemaps
python scripts/get_sb_overture.py south_coast   # one area
python scripts/get_sb_overture.py               # all six
python scripts/get_sb_overture.py --list        # show area boxes
```

Each area folder gets `segments.geojson`, `buildings.geojson`, `landcover.geojson` and `landuse.geojson`. Drop all four into the app. Only the road segments are required; the others improve households and fuels. For another region, edit the `AREAS` table in the script or run `overturemaps download --bbox=west,south,east,north -f geojson --type=<theme>` directly. Keep study areas under about 25 km across.

## How the model works

**Fire.** A cellular model on a 50 m grid. Each burning cell ignites neighbors with a probability driven by fuel, slope and wind, and throws embers downwind. Roads close while fire crosses them.

**Fuels.** From Overture land cover (shrub, forest, grass, crop, barren, urban), refined by land use (irrigated parks, golf courses and cemeteries act as firebreaks; orchards and vineyards are agricultural fuel) and by building density (town versus neighborhoods in vegetation). Without land cover, fuels are inferred from terrain and building density.

**Households.** Residential buildings become households; apartment buildings count as several. Large areas are sampled so each simulated household stands for a few homes, with road capacity scaled to match. Without buildings, households are placed along residential streets.

**Roads and traffic.** Overture segments become a routable network with real classes, names, one-way rules and speed limits. Traffic uses a MATSim-style spatial queue model with link storage, flow capacity and spillback. Exits are where highways and arterials leave the uploaded area.

**Alerts.** Zones on a 2 km grid are ordered out when fire comes within a trigger distance, after a detection delay and an issuing lag, or all at once. At night fewer households receive the alert.

**Behavior.** Two modes. *Wait for the order*: households leave on the official order or on seeing flames, and take the fastest open route. *Read the neighborhood*: households also respond to shared fields for smoke and word of mouth (neighbors leaving), and route around congestion and fire. This is the swarm layer, and it produces shadow evacuation.

**Metrics.** Households that didn't get out (fire reached home first, or caught on a burning road), ignition-to-first-order time, 95% clearance time, peak road load, shadow evacuation, zones ranked by risk, bottlenecks by road name, and parcel egress risk from an ensemble of fires. A policy study runs the same fires through 16 scenarios covering alert timing, trigger distance, mass orders, contraflow, night conditions and behavior.

## Repository layout

```
src/sim.js            simulation engine: fire, agents, queue network, fields, metrics
src/realworld.js      Overture/OSM parsing, network building, fuels, households, zones
src/study.js          16-scenario policy study
src/ui/               page templates and shared styles
src/baked_study.json  precomputed study for the synthetic demo
docs/                 built single-file apps (GitHub Pages serves this folder)
scripts/              Overture download script for Santa Barbara County
tools/                build and bake scripts
tests/                Node tests with mock Overture fixtures
```

## Development

Requires Node 18 or newer; there are no npm dependencies.

```bash
npm test          # engine and pipeline tests
npm run build     # rebuild docs/ from src/
npm run bake      # rerun the synthetic 24-fire study (about a minute)
npm run serve     # serve docs/ at http://localhost:8000
```

Edit files in `src/`, then run `npm run build`. The files in `docs/` are generated.

## Known limitations

- Fire spread is a cellular automaton, not a physics-based model such as ELMFIRE or FlamMap, and fuels are a coarse stand-in for LANDFIRE fuel models.
- Behavior and alert parameters are placeholders, not calibrated to evacuation surveys.
- Zones are a regular grid, not official evacuation zones.
- Exits are wherever major roads leave the data; real plans may route people to local refuges instead.
- Large areas are sampled, so counts are simulated households unless the page says otherwise.

## Data and attribution

Road segments, buildings, land cover and land use: © Overture Maps Foundation and contributors. Overture themes carry different licenses (ODbL, CDLA Permissive 2.0 and others); follow Overture's attribution requirements for each theme you use. Elevation: Terrain Tiles on AWS Open Data, derived from USGS 3DEP, SRTM and other sources. Basemaps: © OpenStreetMap contributors, © CARTO, © OpenTopoMap (CC-BY-SA), Esri.
