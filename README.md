# AgentSim Wildfire 🌲🔥🚗

An agent-based wildfire evacuation and emergency operations simulator that runs on both **real-world Overture Maps data** and synthetic communities. It couples a stochastic fire-spread physics model with household agents, a queue-based road network (MATSim-style), and a **Reinforcement Learning (RL) Incident Commander agent** to evaluate who gets out, how long it takes, where roads bottleneck, and which parcels carry the highest egress risk.

The platform includes:
1. **Interactive Client-Side Web Simulator**: Zero-install 60 FPS Canvas interface deployed on GitHub Pages with interactive timeline scrubbing, GIS exports, and live policy toggles.
2. **Python Reinforcement Learning Suite**: A high-speed Gymnasium environment training deep Actor-Critic neural networks using PPO to discover optimal evacuation timing and arterial lane reversals.
3. **Pre-Trained In-Browser AI Agent**: An exported neural network policy running directly in the browser via pure JavaScript and ONNX.

> **Disclaimer**: Everything beyond the input geospatial data (fire spread rates, alert compliance, departure delay curves, road capacities) is illustrative and uncalibrated. Read results as the quantitative shape of emergency management trade-offs, not as predictive event forecasts.

---

## 🚀 Live Interactive Applications

* **Primary Overture Real-Map Simulator**: [https://rskris.github.io/agentsim_wildfire/](https://rskris.github.io/agentsim_wildfire/)
* **Synthetic Foothill Micro-Town Demo**: [https://rskris.github.io/agentsim_wildfire/synthetic.html](https://rskris.github.io/agentsim_wildfire/synthetic.html)
* **Pre-Trained ONNX Model**: [https://rskris.github.io/agentsim_wildfire/model/policy.onnx](https://rskris.github.io/agentsim_wildfire/model/policy.onnx)

---

## 🌟 Key Features

### 1. Reinforcement Learning Incident Commander (PPO)
* **Gymnasium Environment (`agentsim.env.WildfireEvacEnv`)**: Formulates evacuation operations as a Partially Observable Markov Decision Process (POMDP).
* **Multi-Binary Action Space**: The RL agent dynamically orders individual evacuation zones and triggers arterial contraflow based on fire acceleration and bottleneck densities.
* **In-Browser Execution**: The trained PyTorch model is exported to compact ONNX (`docs/model/policy.onnx`, 61 KB) and inlined JavaScript weights (`src/rl_policy.js`), allowing users to toggle **`AI Agent (PPO)`** directly on the web map with zero server latency.

### 2. Interactive Timeline Playback Scrubber
* Minute-by-minute simulation recorder captures spatial snapshots of every active fire cell, closed road, vehicle queue, and household state.
* Users can pause, rewind, drag through time, and inspect road queues at any point in the evacuation timeline.

### 3. Custom Jurisdictional Evacuation Zones (`zones.geojson`)
* Ingests official county emergency evacuation zones (e.g. Santa Barbara County `SBC-101`, `SBC-102`) via GeoJSON polygons.
* Assigns household agents directly to official emergency zones for phased staging.

### 4. GIS & Policy Report Exports
* **Parcel Egress Risk GeoJSON** (`parcel_egress_risk.geojson`): Spatial point features for all households with attributes (`id`, `zone`, `road_name`, `status`, `egress_risk_pct`, `depart_min`, `safe_min`) for ArcGIS/QGIS.
* **Bottlenecks CSV** (`bottlenecks.csv`): Road segment queue statistics and vehicle delay minutes.
* **Scenario Study CSV** (`scenario_study_results.csv`): Evacuation completion curves across 16 standard policy regimes.

### 5. Multi-Threaded Web Workers
* Headless batch execution for 16-scenario studies and 20-fire parcel risk ensembles runs in background Web Workers, keeping the map and UI completely responsive.

---

## 📊 Benchmark: Trained RL Policy vs. Rule-Based Baseline

Evaluated across test fires on the real-world Santa Barbara South Coast network (19,450 intersections, 15,327 links, 39 zones, and 6,456 households):

| Metric | Rule-Based Heuristic (1.5 km Buffer) | Trained RL Agent (PPO) | Impact |
| :--- | :--- | :--- | :--- |
| **Mean Casualties (Trapped / Overrun)** | **391.0** | **370.8** | **-5.2% casualty reduction** |
| **Mean Safely Evacuated** | **361.8** | **643.8** | **+77.9% more evacuees safe** |
| **Clearance Time ($T_{95}$)** | $1\text{ hr } 42\text{ min}$ | $1\text{ hr } 14\text{ min}$ | **-28 min faster clearance** |
| **Mean Cumulative Return** | -192,078.9 | -179,592.2 | **+12,486.7 net reward gain** |

---

## 🛠️ How to Run

### Option A: Run the Web Simulator Locally
```bash
# 1. Start local web server
python3 -m http.server 8000 --directory docs

# 2. Open in your browser:
#    Overture Real Map: http://localhost:8000/
#    Synthetic Demo:   http://localhost:8000/synthetic.html
```

### Option B: Python RL Environment & Training
```bash
# 1. Switch to python_implementation branch
git checkout python_implementation

# 2. Activate virtual environment
source .venv/bin/activate

# 3. Run Python unit tests
python -m unittest tests/test_rl.py

# 4. Train the RL Agent (Synthetic Micro-Town)
python train_rl.py --episodes 15 --dataset synthetic

# 5. Train the RL Agent (Santa Barbara Overture Network)
python train_rl.py --episodes 15 --dataset overture
```

---

## 📥 Downloading Santa Barbara Data

Download Overture Maps data for Santa Barbara County using the bundled CLI script:

```bash
pip install overturemaps
python scripts/get_sb_overture.py south_coast   # Downloads South Coast (Santa Barbara/Goleta/Montecito)
python scripts/get_sb_overture.py --list        # Lists all 6 county regions
```

This populates `sb_overture/south_coast/` with:
* `segments.geojson` (18 MB, 15,910 road segments)
* `buildings.geojson` (33 MB, 42,534 building footprints)
* `landcover.geojson` (3.6 MB, vegetation fuel models)
* `landuse.geojson` (3.0 MB, parks, orchards, urban buffers)

Drop all 4 files directly into the web app upload card and click **"Build the model"**.

---

## 📁 Repository Layout

```text
agentsim_wildfire/
├── description.md           # In-depth technical specification and mathematical formulation
├── train_rl.py              # CLI for training, benchmarking, and exporting PPO policies
├── requirements.txt         # Pinned Python dependencies
│
├── agentsim/                # Python RL package
│   ├── engine/
│   │   ├── loader.py        # Overture GeoJSON reader and graph builder
│   │   └── fast_sim.py      # High-speed vectorized Rothermel fire & queue simulation
│   ├── env/
│   │   └── wildfire_env.py  # Gymnasium environment (WildfireEvacEnv)
│   └── models/
│       └── ppo_agent.py     # PyTorch Actor-Critic PPO implementation & ONNX exporter
│
├── src/                     # Core web engine & UI
│   ├── sim.js               # Wildfire cellular automata, agent FSM, & queue dynamics
│   ├── realworld.js         # Overture ingestion, terrain sampling, & zone rasterization
│   ├── study.js             # 16-scenario Monte Carlo policy matrix
│   ├── rl_policy.js         # Inlined pure JS forward pass of the trained RL policy
│   └── ui/
│       ├── overture.html    # Primary Overture web simulator template
│       ├── synthetic.html   # Synthetic micro-town template
│       └── shared.css       # Unified design system
│
├── docs/                    # Production deployment bundle (served by GitHub Pages)
│   ├── index.html           # Standalone bundle for real-world Overture simulator
│   ├── synthetic.html       # Standalone bundle for synthetic demo
│   └── model/
│       ├── policy.onnx      # 61 KB ONNX neural network policy
│       └── policy_weights.json
│
├── checkpoints/             # PyTorch model checkpoints (.pt)
├── scripts/                 # Data download scripts (get_sb_overture.py)
├── tests/                   # Python unittest and Node.js test suites
└── tools/                   # Bundler (build.js) and pre-compute scripts
```

---

## 📖 In-Depth Technical Documentation

For the complete mathematical formulations of Rothermel's surface fire equations, the 7-state agent behavioral FSM, spatial queue network dynamics, and the deep PPO POMDP derivation, see **[`description.md`](file:///Users/rskris/dev_projects/agentsim_wildfire/description.md)**.

---

## 📄 License & Attribution

* **Roads, Buildings, Land Cover, Land Use**: © [Overture Maps Foundation](https://overturemaps.org) and contributors (ODbL, CDLA Permissive 2.0).
* **Elevation**: Terrain Tiles on AWS Open Data, derived from USGS 3DEP and SRTM.
* **Basemaps**: © OpenStreetMap contributors, © CARTO, © OpenTopoMap (CC-BY-SA), Esri.
