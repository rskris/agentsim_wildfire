const RealWorld = (function () {
  const CELL = 50, BS = 4, DT = 10;
  const DIRS = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  const LU = { OCEAN: 0, BEACH: 1, URBAN: 2, WUI: 3, CHAP: 4, GRASS: 5, AG: 6, BARE: 7 };
  const CLS = { motorway: 'hwy', motorway_link: 'hwy', trunk: 'hwy', trunk_link: 'hwy', primary: 'art', primary_link: 'art',
    secondary: 'art', secondary_link: 'art', tertiary: 'urban', tertiary_link: 'urban', unclassified: 'local', residential: 'local', living_street: 'local' };
  const MPH = { motorway: 65, motorway_link: 35, trunk: 55, trunk_link: 35, primary: 40, primary_link: 30, secondary: 35, secondary_link: 30,
    tertiary: 30, tertiary_link: 25, unclassified: 25, residential: 25, living_street: 15 };
  const RANK = { hwy: 3, art: 2, urban: 1, local: 0 };
  const PRETTY = { motorway: 'Freeway', trunk: 'Highway', primary: 'Primary road', secondary: 'Secondary road', tertiary: 'Collector road',
    unclassified: 'Local road', residential: 'Residential street', living_street: 'Residential lane' };

  function makeGrid(bbox) {
    const lat0 = (bbox.s + bbox.n) / 2;
    const dLon = CELL / (111320 * Math.cos(lat0 * Math.PI / 180)), dLat = CELL / 110540;
    const W = Math.ceil((bbox.e - bbox.w) / dLon / BS) * BS, H = Math.ceil((bbox.n - bbox.s) / dLat / BS) * BS;
    return { bbox, dLon, dLat, W, H,
      toGrid: (lat, lon) => [(lon - bbox.w) / dLon, (bbox.n - lat) / dLat],
      toLatLng: (gx, gy) => [bbox.n - gy * dLat, bbox.w + gx * dLon] };
  }

  function overpassQuery(b) {
    return `[out:json][timeout:120];way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street)$"](${b.s},${b.w},${b.n},${b.e});(._;>;);out body;`;
  }

  // Terrarium elevation tiles
  const lon2tile = (lon, z) => (lon + 180) / 360 * 2 ** z;
  const lat2tile = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z; };
  function terrariumTiles(b, z) {
    const x0 = Math.floor(lon2tile(b.w, z)), x1 = Math.floor(lon2tile(b.e, z));
    const y0 = Math.floor(lat2tile(b.n, z)), y1 = Math.floor(lat2tile(b.s, z));
    const out = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ z, x, y });
    return out;
  }
  // tiles: [{z,x,y,data:Uint8ClampedArray(256*256*4)}]
  function makeElevSampler(tiles) {
    const map = new Map(tiles.map(t => [t.x + ',' + t.y, t]));
    const z = tiles[0].z;
    return (lat, lon) => {
      const fx = lon2tile(lon, z), fy = lat2tile(lat, z), tx = Math.floor(fx), ty = Math.floor(fy);
      const t = map.get(tx + ',' + ty); if (!t) return 0;
      const px = Math.min(255, Math.floor((fx - tx) * 256)), py = Math.min(255, Math.floor((fy - ty) * 256)), i = (py * 256 + px) * 4;
      return (t.data[i] * 256 + t.data[i + 1] + t.data[i + 2] / 256) - 32768;
    };
  }

  function parseMaxspeed(v) {
    if (!v) return null; const m = /([\d.]+)\s*(mph)?/.exec(v); if (!m) return null;
    const n = parseFloat(m[1]); return m[2] ? n * 0.44704 : n / 3.6;
  }

  function build(osm, grid, elevFn, opts) {
    opts = opts || {};
    const spacing = opts.homeSpacing || 60, Sim = opts.Sim, rng = Sim.mulberry32(opts.seed || 11);
    const W = grid.W, H = grid.H, N = W * H, BW = W / BS, BH = H / BS;
    const inside = (gx, gy) => gx >= 0 && gy >= 0 && gx < W && gy < H;
    const MG = opts.netMargin == null ? 40 : opts.netMargin;   // network extends ~2 km beyond the study box
    const inNet = (gx, gy) => gx >= -MG && gy >= -MG && gx < W + MG && gy < H + MG;

    // elevation
    const elev = new Float32Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [lat, lon] = grid.toLatLng(x + 0.5, y + 0.5); elev[y * W + x] = elevFn(lat, lon); }

    // parse OSM
    const nll = new Map(); const ways = [];
    for (const el of osm.elements) {
      if (el.type === 'node') nll.set(el.id, [el.lat, el.lon]);
      else if (el.type === 'way' && el.tags && CLS[el.tags.highway]) ways.push(el);
    }
    const use = new Map();
    for (const w of ways) w.nodes.forEach((id, i) => use.set(id, (use.get(id) || 0) + ((i === 0 || i === w.nodes.length - 1) ? 2 : 1)));

    const nodes = [], edges = [], gidx = new Map();
    function gnode(id, gx, gy) {
      let g = gidx.get(id);
      if (g === undefined) { g = nodes.length; gidx.set(id, g); nodes.push({ id: g, x: gx, y: gy, out: [], inn: [], exit: false, local: false, boundary: 0, nb: new Set() }); }
      return g;
    }
    function addEdge(a, b, pts, spec) {
      let len = 0; const cum = [0];
      for (let i = 1; i < pts.length; i++) { len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) * CELL; cum.push(len); }
      if (len < 1) return null;
      const e = { id: edges.length, from: a, to: b, len, lanes: spec.lanes, speed: spec.speed, type: spec.type, name: spec.name, cls: spec.cls, pts, cum,
        cells: [], mx: pts[pts.length >> 1][0], my: pts[pts.length >> 1][1] };
      edges.push(e); nodes[a].out.push(e.id); nodes[b].inn.push(e.id); nodes[a].nb.add(b); nodes[b].nb.add(a);
      return e;
    }
    for (const w of ways) {
      const t = w.tags, hw = t.highway, type = CLS[hw];
      const ow = t.oneway === 'yes' || t.oneway === '1' || t.oneway === 'true' || hw === 'motorway' || hw === 'motorway_link' || t.junction === 'roundabout';
      const rev = t.oneway === '-1';
      let lanes = parseInt(t.lanes, 10);
      if (!(lanes > 0)) lanes = (hw === 'motorway' || hw === 'trunk') ? (ow ? 2 : 4) : (ow ? 1 : 2);
      const perDir = ow || rev ? lanes : Math.max(1, Math.round(lanes / 2));
      const speed = parseMaxspeed(t.maxspeed) || MPH[hw] * 0.44704;
      const spec = { lanes: Math.max(1, Math.min(4, perDir)), speed, type, cls: hw, name: t.name || t.ref || PRETTY[hw.replace('_link', '')] || 'Road' };
      if (t.ref && t.name && (type === 'hwy')) spec.name = `${t.name} (${t.ref})`;
      let seg = [], prevIn = null;
      const emit = () => {
        if (seg.length < 2) return;
        const a = gnode(seg[0].id, seg[0].gx, seg[0].gy), b = gnode(seg[seg.length - 1].id, seg[seg.length - 1].gx, seg[seg.length - 1].gy);
        if (a === b) return;
        const pts = seg.map(p => [p.gx, p.gy]);
        if (!rev) addEdge(a, b, pts, spec);
        if (!ow || rev) addEdge(b, a, pts.slice().reverse(), spec);
      };
      for (let i = 0; i < w.nodes.length; i++) {
        const id = w.nodes[i], ll = nll.get(id); if (!ll) continue;
        const [gx, gy] = grid.toGrid(ll[0], ll[1]), inn = inNet(gx, gy);
        if (!inn) {
          if (prevIn && seg.length) { const last = seg[seg.length - 1]; const g = gnode(last.id, last.gx, last.gy); nodes[g].boundary = Math.max(nodes[g].boundary, RANK[type] + 1); }
          emit(); seg = []; prevIn = false; continue;
        }
        seg.push({ id, gx, gy });
        if (prevIn === false && seg.length === 1) { const g = gnode(id, gx, gy); nodes[g].boundary = Math.max(nodes[g].boundary, RANK[type] + 1); }
        prevIn = true;
        if (seg.length > 1 && use.get(id) > 1) { emit(); seg = [seg[seg.length - 1]]; }
      }
      emit();
    }

    // exits: boundary nodes on highways/arterials, else any boundary
    const major = n => n.out.concat(n.inn).some(id => RANK[edges[id].type] >= RANK.art);
    const nearEdge = n => n.x < 6 || n.y < 6 || n.x >= W - 6 || n.y >= H - 6;
    let ex = nodes.filter(n => n.boundary >= RANK.art + 1 || (n.nb.size === 1 && major(n) && nearEdge(n)));
    if (!ex.length) ex = nodes.filter(n => n.boundary > 0 || (n.nb.size === 1 && nearEdge(n)));
    for (const n of ex) n.exit = true;

    // distance to exit (free flow, reverse Dijkstra)
    const distExit = new Float64Array(nodes.length).fill(Infinity);
    { const heap = []; const push = (d, n) => { heap.push([d, n]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
      const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
      for (const n of nodes) if (n.exit) { distExit[n.id] = 0; push(0, n.id); }
      while (heap.length) { const [d, v] = pop(); if (d > distExit[v]) continue; for (const eid of nodes[v].inn) { const e = edges[eid], nd = d + e.len / e.speed; if (nd < distExit[e.from]) { distExit[e.from] = nd; push(nd, e.from); } } } }

    // rasterize edges
    const road = new Uint8Array(N), resRoad = new Uint8Array(N), cellEdges = {};
    for (const e of edges) {
      const set = new Set();
      for (let i = 1; i < e.pts.length; i++) {
        const [x0, y0] = e.pts[i - 1], [x1, y1] = e.pts[i], n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
        for (let k = 0; k <= n; k++) { const cx = Math.floor(x0 + (x1 - x0) * k / n), cy = Math.floor(y0 + (y1 - y0) * k / n); if (inside(cx, cy)) set.add(cy * W + cx); }
      }
      e.cells = Array.from(set);
      for (const c of e.cells) { road[c] = 1; if (e.type !== 'hwy') resRoad[c] = 1; (cellEdges[c] = cellEdges[c] || []).push(e.id); }
      e.tt = Math.max(1, Math.round(e.len / e.speed / DT));
    }

    // land cover from terrain + street density
    const R = 4, integ = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) integ[(y + 1) * (W + 1) + x + 1] = resRoad[y * W + x] + integ[y * (W + 1) + x + 1] + integ[(y + 1) * (W + 1) + x] - integ[y * (W + 1) + x];
    const dens = (x, y) => { const x0 = Math.max(0, x - R), x1 = Math.min(W, x + R + 1), y0 = Math.max(0, y - R), y1 = Math.min(H, y + R + 1);
      return (integ[y1 * (W + 1) + x1] - integ[y0 * (W + 1) + x1] - integ[y1 * (W + 1) + x0] + integ[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0)); };
    const bl = opts.buildings, useB = bl && bl.all && bl.all.length > 50;
    let bdens = null;
    if (useB) {
      const bc = new Float64Array((W + 1) * (H + 1)), cnt = new Float32Array(N);
      for (const b of bl.all) { const [gx, gy] = grid.toGrid(b.lat, b.lon), x = Math.floor(gx), y = Math.floor(gy); if (inside(x, y)) cnt[y * W + x]++; }
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) bc[(y + 1) * (W + 1) + x + 1] = cnt[y * W + x] + bc[y * (W + 1) + x + 1] + bc[(y + 1) * (W + 1) + x] - bc[y * (W + 1) + x];
      bdens = (x, y) => { const x0 = Math.max(0, x - R), x1 = Math.min(W, x + R + 1), y0 = Math.max(0, y - R), y1 = Math.min(H, y + R + 1);
        return (bc[y1 * (W + 1) + x1] - bc[y0 * (W + 1) + x1] - bc[y1 * (W + 1) + x0] + bc[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0) * 0.25); };
    }
    const lu = new Uint8Array(N), fuel = new Float32Array(N);
    const lcR = new Uint8Array(N), luR = new Uint8Array(N);
    let lcCells = 0, luCells = 0;
    if (opts.landcover && opts.landcover.length) lcCells = rasterize(finestLod(opts.landcover), grid, W, H, p => LC_CODE[p.subtype] || 0, lcR);
    if (opts.landuse && opts.landuse.length) luCells = rasterize(opts.landuse, grid, W, H, luCode, luR);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = y * W + x, e = elev[c], d = dens(x, y), lcv = lcR[c], veg = LC_FUEL[lcv];
      if (e < 0.5) { lu[c] = LU.OCEAN; fuel[c] = 0; continue; }
      const urban = (useB ? bdens(x, y) >= 4 || d > 0.13 : d > 0.13) && e < 150;
      const wui = useB ? bdens(x, y) >= 0.6 : d > 0.035;
      if (urban) { lu[c] = LU.URBAN; fuel[c] = Sim.FIRE.urban + 0.06 * rng(); }
      else if (wui) { lu[c] = LU.WUI; fuel[c] = veg != null ? 0.35 + 0.45 * veg + 0.06 * rng() : 0.6 + 0.12 * rng(); }
      else if (lcv) {
        if (lcv === 1 || lcv === 2) { lu[c] = LU.CHAP; fuel[c] = veg * (0.88 + 0.12 * rng()); }
        else if (lcv === 3 || lcv === 7) { lu[c] = LU.GRASS; fuel[c] = veg * (0.9 + 0.1 * rng()); }
        else if (lcv === 4) { lu[c] = LU.AG; fuel[c] = veg; }
        else if (lcv === 5) { lu[c] = LU.BARE; fuel[c] = veg; }
        else { lu[c] = LU.URBAN; fuel[c] = veg; }
      }
      else if (e > 60) { lu[c] = LU.CHAP; fuel[c] = 0.85 + 0.15 * rng(); }
      else { lu[c] = LU.CHAP; fuel[c] = 0.45 + 0.1 * rng(); }
      const luv = luR[c];
      if (luv === 1 && lu[c] !== LU.URBAN) { lu[c] = LU.GRASS; fuel[c] = 0.12; }
      else if (luv === 2 && lu[c] !== LU.URBAN && lu[c] !== LU.WUI) { lu[c] = LU.AG; fuel[c] = 0.3; }
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = y * W + x; if (lu[c] === LU.OCEAN || elev[c] > 4) continue;
      let nearSea = false; for (let dy = -2; dy <= 2 && !nearSea; dy++) for (let dx = -2; dx <= 2; dx++) { const xx = x + dx, yy = y + dy; if (inside(xx, yy) && lu[yy * W + xx] === LU.OCEAN) { nearSea = true; break; } }
      if (nearSea && !road[c]) { lu[c] = LU.BEACH; fuel[c] = 0.03; }
    }
    for (let c = 0; c < N; c++) if (road[c]) fuel[c] *= 0.35;

    const homes = [];
    let agentWeight = 1, homeSource = 'streets', totalHH = 0;
    if (bl && bl.homes && bl.homes.length) {
      homeSource = 'buildings';
      const maxAgents = opts.maxAgents || 12000;
      const inBox = bl.homes.filter(b => { const [gx, gy] = grid.toGrid(b.lat, b.lon); return inside(Math.floor(gx), Math.floor(gy)); });
      totalHH = inBox.reduce((a, b) => a + b.hh, 0);
      agentWeight = Math.max(1, totalHH / maxAgents);
      const bucket = new Map();
      for (const n of nodes) { if (n.exit || !inside(n.x, n.y) || !isFinite(distExit[n.id]) || !(n.out.some(id => edges[id].type !== 'hwy'))) continue; const k = ((n.y >> 2) * BW + (n.x >> 2)); (bucket.get(k) || bucket.set(k, []).get(k)).push(n.id); }
      const nearest = (gx, gy) => {
        const bx = Math.floor(gx) >> 2, by = Math.floor(gy) >> 2; let best = -1, bd = Infinity;
        for (let r = 0; r <= 10; r++) {
          for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = bx + dx, y = by + dy; if (x < 0 || y < 0 || x >= BW || y >= BH) continue;
            const ls = bucket.get(y * BW + x); if (!ls) continue;
            for (const id of ls) { const d = (nodes[id].x - gx) ** 2 + (nodes[id].y - gy) ** 2; if (d < bd) { bd = d; best = id; } }
          }
          if (best >= 0 && r >= 1) break;
        }
        return best;
      };
      for (const b of inBox) {
        const [gx, gy] = grid.toGrid(b.lat, b.lon), hx = Math.floor(gx), hy = Math.floor(gy);
        if (lu[hy * W + hx] === LU.OCEAN) continue;
        const ex = b.hh / agentWeight; let n = Math.floor(ex); if (rng() < ex - n) n++;
        if (!n) continue;
        const node = nearest(gx, gy); if (node < 0) continue;
        const e0 = nodes[node].out.map(id => edges[id]).find(e => e.type !== 'hwy');
        for (let k = 0; k < n; k++) {
          const fx = gx + (k ? (rng() - 0.5) * 0.3 : 0), fy = gy + (k ? (rng() - 0.5) * 0.3 : 0);
          homes.push({ id: homes.length, x: hx, y: hy, fx, fy, c: hy * W + hx, node, zone: -1, spur: false, b: (hy >> 2) * BW + (hx >> 2), road: e0 ? e0.name : 'local street' });
        }
      }
    }
    // otherwise, homes along residential and collector streets
    if (homeSource === 'streets') for (const e of edges) {
      if (e.type !== 'local' && e.type !== 'urban') continue;
      const twin = nodes[e.to].out.find(id => edges[id].to === e.from && edges[id].name === e.name);
      if (twin !== undefined && twin < e.id) continue;
      const nh = Math.floor(e.len / spacing);
      for (let k = 0; k < nh; k++) {
        const s = (k + 0.5 + (rng() - 0.5) * 0.6) * e.len / Math.max(1, nh);
        let i = 1; while (i < e.cum.length - 1 && e.cum[i] < s) i++;
        const [x0, y0] = e.pts[i - 1], [x1, y1] = e.pts[i], seg = e.cum[i] - e.cum[i - 1] || 1, f = (s - e.cum[i - 1]) / seg;
        const px = x0 + (x1 - x0) * f, py = y0 + (y1 - y0) * f, l = Math.hypot(x1 - x0, y1 - y0) || 1, side = k % 2 ? 1 : -1;
        const fx = px + side * (-(y1 - y0) / l) * 0.45, fy = py + side * ((x1 - x0) / l) * 0.45;
        const hx = Math.floor(fx), hy = Math.floor(fy);
        if (!inside(hx, hy) || lu[hy * W + hx] === LU.OCEAN) continue;
        let node = s < e.len / 2 ? e.from : e.to;
        if (!isFinite(distExit[node])) node = node === e.from ? e.to : e.from;
        if (!isFinite(distExit[node]) || nodes[node].exit || !inside(nodes[node].x, nodes[node].y)) continue;
        homes.push({ id: homes.length, x: hx, y: hy, fx, fy, c: hy * W + hx, node, zone: -1, spur: false, b: (hy >> 2) * BW + (hx >> 2), road: e.name });
      }
    }
    for (const n of nodes) { n.local = n.out.some(id => edges[id].type !== 'hwy') || n.inn.some(id => edges[id].type !== 'hwy'); }
    for (const h of homes) h.spur = nodes[h.node].nb.size === 1;

    // zones: custom polygons if provided, otherwise 2 km grid
    const zones = [];
    if (opts.zones && opts.zones.length) {
      const zR = new Int16Array(N).fill(0);
      const zfeats = opts.zones;
      for (let i = 0; i < zfeats.length; i++) {
        const p = zfeats[i].properties || {};
        const zid = p.id || p.zone_id || p.zone || p.name || p.zone_name || p.ZONE || ('Zone ' + (i + 1));
        zones.push({ id: String(zid), n: 0, wui: 0, sx: 0, sy: 0, r: 0, q: i });
      }
      rasterize(zfeats, grid, W, H, (p, fi) => (fi + 1), zR);
      let outsideZone = -1;
      for (const h of homes) {
        let z = zR[h.c] - 1;
        if (z < 0 || z >= zones.length) {
          if (outsideZone < 0) {
            outsideZone = zones.length;
            zones.push({ id: 'Other', n: 0, wui: 0, sx: 0, sy: 0, r: 0, q: outsideZone });
          }
          z = outsideZone;
        }
        h.zone = z;
        const Z = zones[z];
        Z.n++; Z.sx += h.fx; Z.sy += h.fy;
        if (lu[h.c] === LU.WUI || lu[h.c] === LU.CHAP) Z.wui++;
      }
      for (const z of zones) {
        z.foot = z.n > 0 ? (z.wui / z.n > 0.5) : false;
        z.cx = z.n > 0 ? (z.sx / z.n) : (W / 2);
        z.cy = z.n > 0 ? (z.sy / z.n) : (H / 2);
      }
    } else {
      const ZS = 40, zmap = new Map();
      for (const h of homes) {
        const r = Math.floor(h.y / ZS), q = Math.floor(h.x / ZS), key = r + ',' + q;
        if (!zmap.has(key)) { zmap.set(key, zones.length); zones.push({ id: String.fromCharCode(65 + r) + (q + 1), r, q, n: 0, wui: 0, sx: 0, sy: 0 }); }
        const z = zmap.get(key); h.zone = z; const Z = zones[z]; Z.n++; Z.sx += h.fx; Z.sy += h.fy; if (lu[h.c] === LU.WUI || lu[h.c] === LU.CHAP) Z.wui++;
      }
      for (const z of zones) { z.foot = z.wui / z.n > 0.5; z.cx = z.sx / z.n; z.cy = z.sy / z.n; }
    }

    // derived indexes
    const cellHomes = {};
    for (const h of homes) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = h.x + dx, y = h.y + dy; if (!inside(x, y)) continue; const c = y * W + x; (cellHomes[c] = cellHomes[c] || []).push(h.id);
    }
    const zoneBlocks = zones.map(() => new Set()); for (const h of homes) zoneBlocks[h.zone].add(h.b);
    const sf = new Float32Array(N * 8);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = y * W + x;
      for (let k = 0; k < 8; k++) {
        const nx = x + DIRS[k][0], ny = y + DIRS[k][1]; if (!inside(nx, ny)) continue;
        const s = (elev[ny * W + nx] - elev[c]) / (k < 4 ? CELL : CELL * Math.SQRT2);
        sf[c * 8 + k] = Math.exp(Math.max(-1.5, Math.min(1.5, 3 * s)));
      }
    }
    // ignition candidates: wildland cells within ~3 km of homes
    const hb = new Int16Array(BW * BH).fill(999), q = [];
    for (const h of homes) if (hb[h.b] !== 0) { hb[h.b] = 0; q.push(h.b); }
    for (let i = 0; i < q.length; i++) { const b = q[i], x = b % BW, y = (b / BW) | 0; for (let k = 0; k < 8; k++) { const nx = x + DIRS[k][0], ny = y + DIRS[k][1]; if (nx < 0 || ny < 0 || nx >= BW || ny >= BH) continue; const n = ny * BW + nx; if (hb[n] > hb[b] + 1) { hb[n] = hb[b] + 1; q.push(n); } } }
    const ignCandidates = [];
    for (let c = 0; c < N; c++) { if (lu[c] !== LU.CHAP || fuel[c] < 0.8) continue; const x = c % W, y = (c / W) | 0, d = hb[(y >> 2) * BW + (x >> 2)]; if (d >= 2 && d <= 15) ignCandidates.push(c); }
    if (!ignCandidates.length) for (let c = 0; c < N; c++) { const x = c % W, y = (c / W) | 0, d = hb[(y >> 2) * BW + (x >> 2)]; if (fuel[c] >= 0.45 && lu[c] !== LU.URBAN && d >= 1 && d <= 15) ignCandidates.push(c); }

    return { W, H, CELL, BS, BW, BH, elev, lu, fuel, road, nodes, edges, homes, cellHomes, cellEdges, zoneBlocks, sf, zones, distExit, ignCandidates, grid, agentWeight, homeSource,
      stats: { ways: ways.length, nodes: nodes.length, edges: edges.length, homes: homes.length, zones: zones.length, exits: nodes.filter(n => n.exit).length, households: totalHH || homes.length, landcoverShare: lcR.reduce((a, v) => a + (v ? 1 : 0), 0) / N, landuseCells: luR.reduce((a, v) => a + (v ? 1 : 0), 0) } };
  }

  // Parse an OSM export: Overpass JSON, OSM XML, or GeoJSON (e.g. from overpass-turbo)
  function parseOsm(text) {
    const t = text.trim();
    if (t[0] === '<') return fromXml(t);
    const j = JSON.parse(t);
    if (Array.isArray(j.elements)) return j;
    if (j.type === 'FeatureCollection') return fromGeoJson(j);
    throw new Error('the file is not Overpass JSON, OSM XML or GeoJSON');
  }
  function fromXml(t) {
    const doc = new DOMParser().parseFromString(t, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('the XML file could not be read');
    const els = [];
    for (const n of doc.getElementsByTagName('node')) els.push({ type: 'node', id: +n.getAttribute('id'), lat: +n.getAttribute('lat'), lon: +n.getAttribute('lon') });
    for (const w of doc.getElementsByTagName('way')) {
      const nodes = Array.from(w.getElementsByTagName('nd')).map(nd => +nd.getAttribute('ref')), tags = {};
      for (const tg of w.getElementsByTagName('tag')) tags[tg.getAttribute('k')] = tg.getAttribute('v');
      els.push({ type: 'way', id: +w.getAttribute('id'), nodes, tags });
    }
    return { elements: els };
  }
  function fromGeoJson(g) {
    const ids = new Map(), els = []; let next = 1;
    const nid = (lon, lat) => { const k = lon.toFixed(7) + ',' + lat.toFixed(7); let id = ids.get(k); if (!id) { id = next++; ids.set(k, id); els.push({ type: 'node', id, lat, lon }); } return id; };
    for (const f of g.features || []) {
      const p = f.properties || {}, tags = p.tags || p; if (!f.geometry || !tags.highway) continue;
      const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];
      for (const line of lines) els.push({ type: 'way', id: next++, nodes: line.map(([lon, lat]) => nid(lon, lat)), tags });
    }
    return { elements: els };
  }

  // ---------- Overture Maps ----------
  const jp = v => { if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return v; } } return v; };
  function parseFeatures(text) {
    const t = text.trim();
    if (t[0] === '<') return { osm: fromXml(t) };
    if (t[0] === '{' || t[0] === '[') {
      try {
        const j = JSON.parse(t);
        if (Array.isArray(j.elements)) return { osm: j };
        if (j.type === 'FeatureCollection') return { features: j.features || [] };
        if (j.type === 'Feature') return { features: [j] };
        if (Array.isArray(j)) return { features: j.filter(f => f && f.type === 'Feature') };
      } catch (e) { /* may be GeoJSONSeq */ }
    }
    const feats = [];
    for (const line of t.split(/\r?\n/)) {
      const l = line.replace(/^\x1e/, '').trim(); if (!l) continue;
      const f = JSON.parse(l); if (f.type === 'Feature') feats.push(f); else if (f.type === 'FeatureCollection') feats.push(...f.features);
    }
    if (!feats.length) throw new Error('no GeoJSON features found');
    return { features: feats };
  }
  const LC_SUB = new Set(['forest', 'shrub', 'grass', 'crop', 'barren', 'urban', 'wetland', 'mangrove', 'moss', 'snow']);
  const BLD_HINT = ['height', 'num_floors', 'has_parts', 'roof_shape', 'facade_color', 'is_underground', 'min_height', 'level'];
  function roughArea(g) {
    const ring = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : null; if (!ring) return 0;
    let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity; for (const [x, y] of ring) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
    return (e - w) * 92000 * (n - s) * 110540;
  }
  function kindOf(features) {
    let seg = 0, poly = 0, pt = 0, lc = 0, luT = 0, bT = 0, bHint = 0, zT = 0; const areas = [];
    for (const f of features.slice(0, 800)) {
      const g = f.geometry && f.geometry.type, p = f.properties || {};
      if ((g === 'LineString' || g === 'MultiLineString') && (p.subtype === 'road' || p.class || p.highway)) seg++;
      else if (g === 'Polygon' || g === 'MultiPolygon') {
        poly++; areas.push(roughArea(f.geometry));
        if (p.type === 'land_cover' || (LC_SUB.has(p.subtype) && !p.class)) lc++;
        if (p.type === 'land_use') luT++;
        if (p.type === 'building') bT++;
        if (BLD_HINT.some(k => p[k] != null)) bHint++;
        if (p.evac_zone || p.zone_id || p.zone_name || p.ZONE || p.Zone || (p.zone && !p.class && !p.subtype)) zT++;
      } else if (g === 'Point') pt++;
    }
    if (seg && seg >= poly && seg >= pt) return 'segments';
    if (poly && poly >= pt) {
      if (zT > poly * 0.4) return 'zones';
      if (lc > poly * 0.6) return 'landcover';
      if (luT > poly * 0.6) return 'landuse';
      if (bT > poly * 0.6 || bHint > poly * 0.2) return 'buildings';
      areas.sort((a, b) => a - b);
      return areas[areas.length >> 1] > 5000 ? 'landuse' : 'buildings';
    }
    return pt ? 'points' : 'unknown';
  }
  // Keep only the finest level of detail when Overture ships several (cartography.max_zoom / min_zoom)
  function finestLod(features) {
    const zoomOf = f => { const c = jp((f.properties || {}).cartography); return c && typeof c === 'object' ? (c.max_zoom != null ? c.max_zoom : c.min_zoom) : null; };
    let best = null; for (const f of features) { const z = zoomOf(f); if (z != null && (best == null || z > best)) best = z; }
    return best == null ? features : features.filter(f => { const z = zoomOf(f); return z == null || z === best; });
  }
  // Scanline fill of polygon features onto the grid; valueFn(props, index) returns a code > 0 or 0 to skip
  function rasterize(features, grid, W, H, valueFn, target) {
    let n = 0;
    for (let fi = 0; fi < features.length; fi++) {
      const f = features[fi];
      const g = f.geometry; if (!g) continue;
      const v = valueFn(f.properties || {}, fi); if (!v) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const poly of polys) {
        const rings = poly.map(r => r.map(([lon, lat]) => grid.toGrid(lat, lon)));
        let y0 = Infinity, y1 = -Infinity;
        for (const r of rings) for (const p of r) { if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
        const ya = Math.max(0, Math.ceil(y0 - 0.5)), yb = Math.min(H - 1, Math.floor(y1 - 0.5));
        for (let y = ya; y <= yb; y++) {
          const cy = y + 0.5, xs = [];
          for (const r of rings) for (let i = 0; i < r.length - 1; i++) {
            const a = r[i], b = r[i + 1];
            if ((a[1] <= cy) !== (b[1] <= cy)) xs.push(a[0] + (cy - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
          }
          xs.sort((a, b) => a - b);
          for (let k = 0; k + 1 < xs.length; k += 2) {
            const xa = Math.max(0, Math.ceil(xs[k] - 0.5)), xb = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
            for (let x = xa; x <= xb; x++) { target[y * W + x] = v; n++; }
          }
        }
      }
    }
    return n;
  }
  const LC_CODE = { forest: 1, shrub: 2, grass: 3, crop: 4, barren: 5, moss: 5, snow: 5, urban: 6, wetland: 7, mangrove: 7 };
  const LC_FUEL = [null, 0.9, 1.0, 0.6, 0.3, 0.05, 0.15, 0.2];
  const LU_IRR = new Set(['park', 'golf_course', 'golf', 'cemetery', 'pitch', 'playground', 'recreation_ground', 'garden', 'village_green', 'stadium', 'sports_centre', 'dog_park', 'grass']);
  const LU_AG = new Set(['agriculture', 'horticulture', 'farmland', 'orchard', 'vineyard', 'plant_nursery', 'greenhouse_horticulture', 'allotments', 'farmyard']);
  const luCode = p => (LU_IRR.has(p.class) || (LU_IRR.has(p.subtype) && !LU_AG.has(p.class))) ? 1 : (LU_AG.has(p.class) || LU_AG.has(p.subtype)) ? 2 : 0;

  const OV_CLASS = { motorway: 1, trunk: 1, primary: 1, secondary: 1, tertiary: 1, residential: 1, living_street: 1, unclassified: 1 };
  function fromOverture(features) {
    const ids = new Map(), els = []; let next = 1;
    const nid = (lon, lat) => { const k = lon.toFixed(7) + ',' + lat.toFixed(7); let id = ids.get(k); if (!id) { id = next++; ids.set(k, id); els.push({ type: 'node', id, lat, lon }); } return id; };
    for (const f of features) {
      const p = f.properties || {}, g = f.geometry; if (!g) continue;
      let tags;
      if (p.highway) tags = p;                       // OSM-style GeoJSON
      else {
        if (p.subtype && p.subtype !== 'road') continue;
        if (!OV_CLASS[p.class]) continue;
        const hw = p.subclass === 'link' && ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'].includes(p.class) ? p.class + '_link' : p.class;
        tags = { highway: hw };
        const names = jp(p.names);
        const nm = names && (names.primary || (names.common && (names.common.en || Object.values(names.common)[0])));
        if (nm) tags.name = nm;
        const routes = jp(p.routes); if (Array.isArray(routes) && routes.length && (routes[0].ref || routes[0].name)) tags.ref = routes[0].ref || routes[0].name;
        const sl = jp(p.speed_limits);
        if (Array.isArray(sl)) for (const s of sl) { const m = s && (s.max_speed || s.maxSpeed); if (m && m.value) { tags.maxspeed = m.value + (m.unit === 'mph' ? ' mph' : ''); break; } }
        const ar = jp(p.access_restrictions);
        if (Array.isArray(ar)) for (const a of ar) {
          if (a && a.access_type === 'denied' && a.when && a.when.heading && Object.keys(a.when).length === 1) tags.oneway = a.when.heading === 'backward' ? 'yes' : '-1';
        }
      }
      const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      for (const line of lines) if (line.length > 1) els.push({ type: 'way', id: next++, nodes: line.map(([lon, lat]) => nid(lon, lat)), tags });
    }
    return { elements: els };
  }
  const RES_CLS = new Set(['house', 'detached', 'apartments', 'residential', 'semidetached_house', 'terrace', 'bungalow', 'dormitory', 'cabin', 'static_caravan', 'farm', 'hut', 'trullo', 'stilt_house', 'houseboat']);
  const NON_CLS = new Set(['garage', 'garages', 'shed', 'carport', 'roof', 'greenhouse', 'barn', 'storage_tank', 'parking', 'hangar', 'industrial', 'commercial', 'retail', 'warehouse', 'office', 'school', 'church', 'hospital', 'kindergarten', 'university', 'hotel', 'civic', 'public', 'service', 'transportation', 'toilets', 'boathouse', 'silo']);
  function buildingsFromOverture(features) {
    const homes = [], all = [];
    for (const f of features) {
      const g = f.geometry; if (!g) continue;
      const ring = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates[0][0] : null;
      if (!ring || ring.length < 4) continue;
      let sx = 0, sy = 0; const n = ring.length - 1;
      for (let i = 0; i < n; i++) { sx += ring[i][0]; sy += ring[i][1]; }
      const lon = sx / n, lat = sy / n, kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
      let a = 0; for (let i = 0; i < n; i++) { const [x0, y0] = ring[i], [x1, y1] = ring[i + 1]; a += (x0 - lon) * kx * (y1 - lat) * ky - (x1 - lon) * kx * (y0 - lat) * ky; }
      const area = Math.abs(a) / 2, p = f.properties || {}, sub = p.subtype || null, cls = p.class || p.building || null;
      all.push({ lat, lon });
      let res = sub === 'residential' || RES_CLS.has(cls);
      if (!sub && (!cls || cls === 'yes')) res = area >= 50 && area <= 1500;
      if (NON_CLS.has(cls)) res = false;
      if (sub && sub !== 'residential' && !RES_CLS.has(cls)) res = false;
      if (!res) continue;
      const floors = +p.num_floors || +p.levels || 0;
      const hh = (cls === 'apartments' || cls === 'dormitory' || (area > 600 && floors >= 2)) ? Math.min(60, Math.max(2, Math.round(area * (floors || 2) / 110))) : 1;
      homes.push({ lat, lon, area, hh });
    }
    return { homes, all };
  }
  function extentOf(features) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    const visit = c => { if (typeof c[0] === 'number') { if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0]; if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1]; } else for (const x of c) visit(x); };
    for (const f of features) if (f.geometry && f.geometry.coordinates) visit(f.geometry.coordinates);
    return { w, s, e, n };
  }
  // Study-area box: data extent pulled in up to 1 km, capped at maxKm around a center
  function studyBox(ext, center, maxKm) {
    const lat0 = (ext.s + ext.n) / 2, kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540, pad = Math.min(1000, 0.1 * Math.min((ext.e - ext.w) * kx, (ext.n - ext.s) * ky));
    let b = { w: ext.w + pad / kx, e: ext.e - pad / kx, s: ext.s + pad / ky, n: ext.n - pad / ky }, trimmed = false;
    const halfX = maxKm * 500 / kx, halfY = maxKm * 500 / ky, c = center || { lat: lat0, lon: (ext.w + ext.e) / 2 };
    if (b.e - b.w > 2 * halfX) { b.w = Math.max(b.w, c.lon - halfX); b.e = Math.min(b.e, b.w + 2 * halfX); trimmed = true; }
    if (b.n - b.s > 2 * halfY) { b.s = Math.max(b.s, c.lat - halfY); b.n = Math.min(b.n, b.s + 2 * halfY); trimmed = true; }
    return { bbox: b, trimmed };
  }

  return { finestLod, rasterize, parseFeatures, kindOf, fromOverture, buildingsFromOverture, extentOf, studyBox, parseOsm, makeGrid, overpassQuery, terrariumTiles, makeElevSampler, build, LU };
})();
if (typeof module !== 'undefined') module.exports = RealWorld;
