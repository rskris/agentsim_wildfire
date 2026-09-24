const Sim = (function () {
  let W = 160, H = 100; const CELL = 50, DT = 10, BS = 4; let BW = W / BS, BH = H / BS;
  function setDims(w, h) { W = w; H = h; BW = w / BS; BH = h / BS; }
  const LU = { OCEAN: 0, BEACH: 1, URBAN: 2, WUI: 3, CHAP: 4 };
  const ST = { UNAWARE: 0, PREPARING: 1, WAITING: 2, ONROAD: 3, SAFE: 4, ATRISK: 5, TRAPPED: 6 };
  const DIRS = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function coastY(x) { return 90 + 3 * Math.sin(x / 17) + 1.5 * Math.sin(x / 7 + 1); }
  function wuiTop(x) { return 44 + 4 * Math.sin(x / 9) + 2 * Math.sin(x / 4.3); }
  function urbanTop(x) { return 68 + 2 * Math.sin(x / 13); }

  const ART = [22, 52, 86, 116, 146];
  const CON = [8, 37, 68, 101, 131, 156];
  const SPUR = [35, 70, 100, 132];

  const LINES = {
    hwy: { f: x => coastY(x) - 5, segs: [[0, 159]], spec: { lanes: 2, speed: 27, type: 'hwy', name: 'Coast Highway' } },
    u1: { f: x => 78 + Math.sin(x / 10), segs: [[3, 157]], spec: { lanes: 1, speed: 13, type: 'urban', name: 'Harbor Avenue' } },
    u2: { f: x => 71.5 + Math.sin(x / 12), segs: [[3, 157]], spec: { lanes: 1, speed: 13, type: 'urban', name: 'Grove Street' } },
    f1: { f: x => 63 + 2 * Math.sin(x / 11), segs: [[10, 152]], spec: { lanes: 1, speed: 11, type: 'local', name: 'Foothill Road' } },
    f2: { f: x => 55 + 2 * Math.sin(x / 9), segs: [[12, 44], [48, 104], [110, 152]], spec: { lanes: 1, speed: 11, type: 'local', name: 'Upper Ridge Road' } },
  };
  const VERT = [
    ...ART.map((x, i) => ({ x, top: 46, lines: ['f2', 'f1', 'u2', 'u1', 'hwy'], spec: { lanes: 1, speed: 15, type: 'art', name: ['Toyon', 'Manzanita', 'Ceanothus', 'Sage', 'Buckwheat'][i] + ' Canyon Road' } })),
    ...CON.map((x, i) => ({ x, top: null, lines: ['u2', 'u1', 'hwy'], spec: { lanes: 1, speed: 13, type: 'urban', name: ['Anchor', 'Kelp', 'Pier', 'Dune', 'Tide', 'Surf'][i] + ' Street' } })),
    ...SPUR.map((x, i) => ({ x, top: 42, lines: ['f2'], spec: { lanes: 1, speed: 9, type: 'local', name: ['Hollyleaf', 'Coffeeberry', 'Scrub Oak', 'Chamise'][i] + ' Lane (dead end)' } })),
  ];
  const SYNTH_ZONES = [
    { id: 'F1', x0: 0, x1: 37, foot: true }, { id: 'F2', x0: 37, x1: 70, foot: true }, { id: 'F3', x0: 70, x1: 101, foot: true },
    { id: 'F4', x0: 101, x1: 131, foot: true }, { id: 'F5', x0: 131, x1: 160, foot: true },
    { id: 'U1', x0: 0, x1: 53, foot: false }, { id: 'U2', x0: 53, x1: 106, foot: false }, { id: 'U3', x0: 106, x1: 160, foot: false },
  ];
  const FIRE = { pBase: 0.012, spot: 0.0003, spotDist: 0.5, wexp: 1.6, urban: 0.12 };
  let ZONES = SYNTH_ZONES;
  function setZones(z) { ZONES = z; }
  const CAP = { hwy: 3, art: 1.9, urban: 2.0, local: 1.5 }; // household-vehicle units per lane per tick (~1.7 veh/household, smoke-degraded flow)

  function inSeg(line, x) { return LINES[line].segs.some(s => x >= s[0] && x <= s[1]); }

  function buildWorld() {
    setDims(160, 100); ZONES = SYNTH_ZONES;
    const N = W * H;
    const elev = new Float32Array(N), lu = new Uint8Array(N), fuel = new Float32Array(N), road = new Uint8Array(N);
    const rng = mulberry32(7);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = y * W + x, cy = coastY(x), d = cy - y;
      let e = d > 0 ? d * 5 + Math.max(0, 50 - y) * 14 : 0;
      e += (Math.sin(x / 6.5) * 0.5 + Math.sin(x / 3.1 + y / 5) * 0.3) * Math.max(0, 70 - y) * 1.2;
      let canyon = 0;
      for (const ax of ART.concat(SPUR)) canyon = Math.max(canyon, Math.exp(-(((x - ax) / 2.5) ** 2)));
      e -= canyon * Math.max(0, 62 - y) * 1.5;
      elev[c] = Math.max(0, e);
      if (y > cy) { lu[c] = LU.OCEAN; fuel[c] = 0; }
      else if (y > cy - 1.5) { lu[c] = LU.BEACH; fuel[c] = 0.03; }
      else if (y >= urbanTop(x)) { lu[c] = LU.URBAN; fuel[c] = FIRE.urban + 0.06 * rng(); }
      else if (y >= wuiTop(x)) { lu[c] = LU.WUI; fuel[c] = 0.55 + 0.4 * canyon + 0.1 * rng(); }
      else { lu[c] = LU.CHAP; fuel[c] = 0.85 + 0.15 * rng(); }
    }

    const nodes = [], edges = [];
    function node(x, y) {
      for (let i = 0; i < nodes.length; i++) { const n = nodes[i]; if (Math.abs(n.x - x) < 0.6 && Math.abs(n.y - y) < 0.6) return i; }
      nodes.push({ id: nodes.length, x, y, out: [], inn: [], exit: false, local: false });
      return nodes.length - 1;
    }
    function addEdge(a, b, spec) {
      const A = nodes[a], B = nodes[b], dx = B.x - A.x, dy = B.y - A.y, dist = Math.hypot(dx, dy);
      const cells = [], n = Math.max(1, Math.ceil(dist * 2));
      for (let i = 0; i <= n; i++) {
        const cx = Math.round(A.x + dx * i / n), cy = Math.round(A.y + dy * i / n);
        if (cx >= 0 && cx < W && cy >= 0 && cy < H) { const c = cy * W + cx; if (!cells.includes(c)) cells.push(c); }
      }
      const e = { id: edges.length, from: a, to: b, len: dist * CELL, lanes: spec.lanes, speed: spec.speed, type: spec.type, name: spec.name, cells,
        mx: (A.x + B.x) / 2, my: (A.y + B.y) / 2 };
      edges.push(e); A.out.push(e.id); B.inn.push(e.id);
      if (spec.type !== 'hwy') { A.local = true; B.local = true; }
    }
    function link(a, b, spec, pathFn) {
      const A = nodes[a], B = nodes[b];
      const n = Math.max(1, Math.round(Math.hypot(B.x - A.x, B.y - A.y) / 5));
      let prev = a;
      for (let i = 1; i <= n; i++) {
        const id = i === n ? b : node(...pathFn(i / n));
        addEdge(prev, id, spec); addEdge(id, prev, spec); prev = id;
      }
    }
    for (const [name, L] of Object.entries(LINES)) {
      for (const [s0, s1] of L.segs) {
        const xs = [s0, s1];
        for (const v of VERT) if (v.lines.includes(name) && v.x > s0 && v.x < s1) xs.push(v.x);
        xs.sort((a, b) => a - b);
        for (let i = 0; i < xs.length - 1; i++) {
          const xa = xs[i], xb = xs[i + 1];
          link(node(xa, L.f(xa)), node(xb, L.f(xb)), L.spec, t => { const x = xa + (xb - xa) * t; return [x, L.f(x)]; });
        }
      }
    }
    for (const v of VERT) {
      const pts = [];
      if (v.top !== null) pts.push(v.top);
      for (const ln of v.lines) if (inSeg(ln, v.x)) pts.push(LINES[ln].f(v.x));
      pts.sort((a, b) => a - b);
      for (let i = 0; i < pts.length - 1; i++) {
        const ya = pts[i], yb = pts[i + 1];
        link(node(v.x, ya), node(v.x, yb), v.spec, t => [v.x, ya + (yb - ya) * t]);
      }
    }
    nodes[node(0, LINES.hwy.f(0))].exit = true;
    nodes[node(159, LINES.hwy.f(159))].exit = true;

    const cellEdges = {};
    for (const e of edges) {
      e.tt = Math.max(1, Math.round(e.len / e.speed / DT));
      for (const c of e.cells) { road[c] = 1; (cellEdges[c] = cellEdges[c] || []).push(e.id); }
    }
    for (let c = 0; c < N; c++) if (road[c]) fuel[c] *= 0.35;

    // distance to road (grid BFS)
    const rd = new Int16Array(N).fill(999), q = [];
    for (let c = 0; c < N; c++) if (road[c]) { rd[c] = 0; q.push(c); }
    for (let h = 0; h < q.length; h++) {
      const c = q[h], x = c % W, y = (c / W) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + DIRS[k][0], ny = y + DIRS[k][1];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx; if (rd[n] > rd[c] + 1) { rd[n] = rd[c] + 1; q.push(n); }
      }
    }

    const localNodes = nodes.filter(n => n.local && !n.exit);
    const homes = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = y * W + x;
      if (road[c] || rd[c] > 3) continue;
      const dens = lu[c] === LU.URBAN ? 0.30 : lu[c] === LU.WUI ? 0.36 : 0;
      if (rng() >= dens) continue;
      let best = -1, bd = 1e9;
      for (const n of localNodes) { const d = (n.x - x) ** 2 + (n.y - y) ** 2; if (d < bd) { bd = d; best = n.id; } }
      const foot = lu[c] === LU.WUI;
      const zone = ZONES.findIndex(z => z.foot === foot && x >= z.x0 && x < z.x1);
      const spur = nodes[best].inn.some(eid => /dead end/.test(edges[eid].name));
      homes.push({ id: homes.length, x, y, c, node: best, zone, spur, b: (y >> 2) * BW + (x >> 2) });
    }
    const cellHomes = {};
    for (const h of homes) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = h.x + dx, y = h.y + dy; if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const c = y * W + x; (cellHomes[c] = cellHomes[c] || []).push(h.id);
    }
    const zoneBlocks = ZONES.map(() => new Set());
    for (const h of homes) zoneBlocks[h.zone].add(h.b);

    // slope factor per cell per direction
    const sf = new Float32Array(N * 8);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = y * W + x;
      for (let k = 0; k < 8; k++) {
        const nx = x + DIRS[k][0], ny = y + DIRS[k][1];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const dist = k < 4 ? CELL : CELL * Math.SQRT2;
        const s = (elev[ny * W + nx] - elev[c]) / dist;
        sf[c * 8 + k] = Math.exp(Math.max(-1.5, Math.min(1.5, 3 * s)));
      }
    }
    return { FIRE, W, H, CELL, BS, BW, BH, elev, lu, fuel, road, nodes, edges, homes, cellHomes, cellEdges, zoneBlocks, sf };
  }

  const DEFAULTS = { ign: { x: 80, y: 28 }, windFrom: 0, windKmh: 50, night: false, detectMin: 8, trigKm: 1.5, lagMin: 10,
    alertAll: false, mode: 'rules', contraflow: false, seed: 1, maxMin: 240 };

  function newRun(world, params) {
    const p = Object.assign({}, DEFAULTS, params);
    const Wd = world, N = W * H, rng = mulberry32(p.seed * 9973 + 13);
    const ws = p.windKmh / 3.6, th = p.windFrom * Math.PI / 180;
    const wx = -Math.sin(th), wy = Math.cos(th);
    const wf = new Float32Array(8);
    for (let k = 0; k < 8; k++) {
      const dx = DIRS[k][0], dy = DIRS[k][1], l = Math.hypot(dx, dy);
      wf[k] = Math.exp(FIRE.wexp * (ws / 10) * (dx * wx + dy * wy) / l) * (k < 4 ? 1 : 0.72);
    }
    const nh = Wd.homes.length;
    const R = {
      p, t: 0, done: false, world: Wd, wx, wy, ws, wf, rng,
      fire: new Uint8Array(N), burnLeft: new Uint16Array(N), arrival: new Int32Array(N).fill(-1), burning: [],
      eq: Wd.edges.map(() => []), active: new Set(), eburn: new Uint16Array(Wd.edges.length), ebud: new Float32Array(Wd.edges.length),
      ecap: new Float32Array(Wd.edges.length), estore: new Float32Array(Wd.edges.length),
      st: new Uint8Array(nh), departAt: new Int32Array(nh).fill(-1), departT: new Int32Array(nh).fill(-1),
      safeT: new Int32Array(nh).fill(-1), fireNear: new Int32Array(nh).fill(-1), exitT: new Int32Array(nh),
      getsAlert: new Uint8Array(nh), awareBy: new Uint8Array(nh),
      nodeWait: Wd.nodes.map(() => []), waitNodes: new Set(),
      blockFire: new Uint8Array(BW * BH), fireDist: new Int16Array(BW * BH).fill(999), blockDirty: true,
      smoke: new Float32Array(BW * BH), info: new Float32Array(BW * BH), burnCount: new Float32Array(BW * BH),
      zoneTrig: new Int32Array(ZONES.length).fill(-1), zoneAlert: new Int32Array(ZONES.length).fill(-1),
      nextRules: new Int32Array(Wd.nodes.length).fill(-1), nextAdapt: new Int32Array(Wd.nodes.length).fill(-1),
      closedDirty: true, series: [], alertLog: [], edelay: new Float32Array(Wd.edges.length), peak: 0,
    };
    for (const e of Wd.edges) {
      let lanes = e.lanes;
      if (p.contraflow) {
        if (Wd.distExit) { if ((e.type === 'art' || e.type === 'hwy') && Wd.distExit[e.to] < Wd.distExit[e.from]) lanes = Math.min(4, e.lanes * 2); }
        else if (e.type === 'art' && Wd.nodes[e.to].y > Wd.nodes[e.from].y) lanes = 2;
      }
      const wgt = Wd.agentWeight || 1;
      R.ecap[e.id] = CAP[e.type] * lanes / wgt;
      R.estore[e.id] = Math.max(wgt > 1 ? 1.5 : 2, lanes * e.len / 12.75 / wgt);
    }
    const reach = p.night ? 0.65 : 0.88;
    for (let h = 0; h < nh; h++) R.getsAlert[h] = rng() < reach ? 1 : 0;
    ignite(R, p.ign.y * W + p.ign.x);
    for (const [dx, dy] of DIRS.slice(0, 4)) {
      const x = p.ign.x + dx, y = p.ign.y + dy;
      if (x >= 0 && y >= 0 && x < W && y < H) ignite(R, y * W + x);
    }
    recomputeTrees(R, true);
    return R;
  }

  function burnDur(lu) { return lu === LU.CHAP ? 24 : lu === LU.WUI ? 40 : lu === LU.URBAN ? 90 : 6; }

  function ignite(R, c) {
    const Wd = R.world;
    if (R.fire[c] !== 0 || Wd.fuel[c] <= 0) return;
    R.fire[c] = 1; R.burnLeft[c] = burnDur(Wd.lu[c]); R.arrival[c] = R.t; R.burning.push(c);
    const x = c % W, y = (c / W) | 0, b = (y >> 2) * BW + (x >> 2);
    if (!R.blockFire[b]) { R.blockFire[b] = 1; R.blockDirty = true; }
    const es = Wd.cellEdges[c];
    if (es) for (const eid of es) {
      if (R.eburn[eid]++ === 0) {
        R.closedDirty = true;
        for (const a of R.eq[eid]) R.st[a] = ST.TRAPPED;
        R.eq[eid] = [];
      }
    }
    const hs = Wd.cellHomes[c];
    if (hs) for (const h of hs) {
      if (R.fireNear[h] < 0) R.fireNear[h] = R.t;
      const s = R.st[h];
      if (s === ST.UNAWARE || s === ST.PREPARING || s === ST.WAITING) R.st[h] = ST.ATRISK;
    }
  }

  function stepFire(R) {
    const Wd = R.world, rng = R.rng, fuel = Wd.fuel, sf = Wd.sf, wf = R.wf, fire = R.fire;
    const pBase = FIRE.pBase, spotBase = FIRE.spot * (R.ws / 10) ** 2;
    const newIgn = [], still = [];
    R.burnCount.fill(0);
    for (const c of R.burning) {
      const x = c % W, y = (c / W) | 0;
      R.burnCount[(y >> 2) * BW + (x >> 2)] += 1;
      for (let k = 0; k < 8; k++) {
        const nx = x + DIRS[k][0], ny = y + DIRS[k][1];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (fire[n] !== 0 || fuel[n] <= 0) continue;
        if (rng() < pBase * fuel[n] * sf[c * 8 + k] * wf[k]) newIgn.push(n);
      }
      if (rng() < spotBase * fuel[c]) {
        const ang = Math.atan2(R.wy, R.wx) + (rng() - 0.5) * 0.6, d = 3 + rng() * R.ws * FIRE.spotDist;
        const sx = Math.round(x + Math.cos(ang) * d), sy = Math.round(y + Math.sin(ang) * d);
        if (sx >= 0 && sy >= 0 && sx < W && sy < H) { const s = sy * W + sx; if (rng() < fuel[s] * 0.6) newIgn.push(s); }
      }
      if (--R.burnLeft[c] === 0) {
        fire[c] = 2;
        const es = Wd.cellEdges[c];
        if (es) for (const eid of es) if (--R.eburn[eid] === 0) R.closedDirty = true;
      } else still.push(c);
    }
    R.burning = still;
    for (const n of newIgn) ignite(R, n);
  }

  function updateFireDist(R) {
    const fd = R.fireDist; fd.fill(999); const q = [];
    for (let b = 0; b < BW * BH; b++) if (R.blockFire[b]) { fd[b] = 0; q.push(b); }
    for (let h = 0; h < q.length; h++) {
      const b = q[h], x = b % BW, y = (b / BW) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + DIRS[k][0], ny = y + DIRS[k][1];
        if (nx < 0 || ny < 0 || nx >= BW || ny >= BH) continue;
        const n = ny * BW + nx; if (fd[n] > fd[b] + 1) { fd[n] = fd[b] + 1; q.push(n); }
      }
    }
    R.blockDirty = false;
  }

  function dijkstra(R, costFn, next) {
    const Wd = R.world, nn = Wd.nodes.length, dist = new Float64Array(nn).fill(Infinity);
    next.fill(-1);
    const heap = [];
    const push = (d, n) => { heap.push([d, n]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    for (const n of Wd.nodes) if (n.exit) { dist[n.id] = 0; push(0, n.id); }
    while (heap.length) {
      const [d, v] = pop(); if (d > dist[v]) continue;
      for (const eid of Wd.nodes[v].inn) {
        if (R.eburn[eid] > 0) continue;
        const u = Wd.edges[eid].from, nd = d + costFn(eid);
        if (nd < dist[u]) { dist[u] = nd; next[u] = eid; push(nd, u); }
      }
    }
  }

  function recomputeTrees(R, force) {
    const Wd = R.world;
    if (R.p.mode !== 'adaptive') { if (R.closedDirty || force) dijkstra(R, eid => Wd.edges[eid].tt * DT, R.nextRules); }
    else dijkstra(R, eid => {
      const e = Wd.edges[eid];
      const bx = Math.floor(e.mx) >> 2, by = Math.floor(e.my) >> 2;
      const fd = (bx >= 0 && by >= 0 && bx < BW && by < BH) ? R.fireDist[by * BW + bx] : 999;
      return e.tt * DT + (R.eq[eid].length / R.ecap[eid]) * DT + (fd <= 1 ? 900 : fd === 2 ? 300 : 0);
    }, R.nextAdapt);
    R.closedDirty = false;
  }

  function sampleDelay(R, night) {
    const med = night ? 20 : 14;
    const z = Math.sqrt(-2 * Math.log(R.rng() + 1e-9)) * Math.cos(2 * Math.PI * R.rng());
    return Math.round(Math.max(2, med * Math.exp(0.5 * z)) * 60 / DT);
  }

  function makeAware(R, h, fast, by) {
    if (R.st[h] !== ST.UNAWARE) return;
    R.st[h] = ST.PREPARING; R.awareBy[h] = by;
    let d = sampleDelay(R, R.p.night);
    if (fast) d = Math.min(d, Math.round((2 + R.rng() * 3) * 60 / DT));
    R.departAt[h] = R.t + d;
  }

  function step(R) {
    if (R.done) return;
    const Wd = R.world, p = R.p, t = ++R.t;
    stepFire(R);
    if (t % 6 === 0 || R.blockDirty) { if (R.blockDirty) updateFireDist(R); }

    // alerts
    const detT = Math.round(p.detectMin * 60 / DT);
    if (t >= detT && t % 3 === 0) {
      for (let z = 0; z < ZONES.length; z++) {
        if (R.zoneTrig[z] < 0) {
          let trig = p.alertAll;
          if (!trig) {
            let md = 999; for (const b of Wd.zoneBlocks[z]) md = Math.min(md, R.fireDist[b]);
            trig = md * BS * CELL <= p.trigKm * 1000;
          }
          if (trig) { R.zoneTrig[z] = t; R.zoneAlert[z] = t + Math.round(p.lagMin * 60 / DT); }
        }
        if (R.zoneAlert[z] >= 0 && t === R.zoneAlert[z]) {
          R.alertLog.push({ zone: ZONES[z].id, t });
          for (const h of Wd.homes) if (h.zone === z && R.getsAlert[h.id]) makeAware(R, h.id, false, 1);
        }
      }
    }

    // cue-based awareness
    const adaptive = p.mode === 'adaptive', nightF = p.night ? 0.5 : 1;
    for (const h of Wd.homes) {
      if (R.st[h.id] !== ST.UNAWARE) continue;
      const fd = R.fireDist[h.b];
      if (fd <= 1 && R.rng() < 0.2 * nightF) { makeAware(R, h.id, true, 2); continue; }
      if (adaptive) {
        const rate = 0.35 * R.info[h.b] + 0.04 * Math.min(R.smoke[h.b], 20) + (fd <= 3 ? 0.15 : 0);
        if (rate > 0 && R.rng() < (1 - Math.exp(-rate * DT / 60)) * nightF) makeAware(R, h.id, fd <= 3, 3);
      }
    }

    // departures
    for (const h of Wd.homes) {
      if (R.st[h.id] === ST.PREPARING && t >= R.departAt[h.id]) {
        R.st[h.id] = ST.WAITING; R.departT[h.id] = t;
        R.nodeWait[h.node].push(h.id); R.waitNodes.add(h.node);
        R.info[h.b] += 1;
      }
    }

    if ((adaptive && t % 6 === 0) || R.closedDirty) recomputeTrees(R);
    const next = adaptive ? R.nextAdapt : R.nextRules;

    // node entries
    for (const n of Array.from(R.waitNodes)) {
      const wq = R.nodeWait[n];
      let entries = 0;
      while (wq.length && entries < 2) {
        const a = wq[0];
        if (R.st[a] !== ST.WAITING) { wq.shift(); continue; }
        const ne = next[n]; if (ne < 0) break;
        if (R.eburn[ne] > 0 || R.eq[ne].length >= R.estore[ne]) break;
        wq.shift(); R.eq[ne].push(a); R.active.add(ne); R.exitT[a] = t + Wd.edges[ne].tt; R.st[a] = ST.ONROAD; entries++;
      }
      if (!wq.length) R.waitNodes.delete(n);
    }

    // link queues
    for (const eid of Array.from(R.active)) {
      const e = Wd.edges[eid], q = R.eq[e.id];
      if (!q.length) { R.ebud[e.id] = 0; R.active.delete(eid); continue; }
      R.ebud[e.id] = Math.min(R.ebud[e.id] + R.ecap[e.id], Math.max(1, R.ecap[e.id]));
      const toNode = Wd.nodes[e.to];
      while (q.length && R.exitT[q[0]] <= t && R.ebud[e.id] >= 1) {
        const a = q[0];
        if (toNode.exit) { q.shift(); R.st[a] = ST.SAFE; R.safeT[a] = t; R.ebud[e.id] -= 1; continue; }
        const ne = next[e.to]; if (ne < 0) break;
        if (R.eburn[ne] > 0 || R.eq[ne].length >= R.estore[ne]) break;
        q.shift(); R.eq[ne].push(a); R.active.add(ne); R.exitT[a] = t + Wd.edges[ne].tt; R.ebud[e.id] -= 1;
      }
      let dl = 0; for (const a of q) if (R.exitT[a] < t) dl++;
      R.edelay[e.id] += dl;
    }

    // fields
    const f = Math.min(1, R.ws * DT / (BS * CELL));
    const ns = new Float32Array(BW * BH);
    for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) {
      const sx = x - R.wx * f, sy = y - R.wy * f;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      const g = (xx, yy) => (xx < 0 || yy < 0 || xx >= BW || yy >= BH) ? 0 : R.smoke[yy * BW + xx];
      const v = g(x0, y0) * (1 - fx) * (1 - fy) + g(x0 + 1, y0) * fx * (1 - fy) + g(x0, y0 + 1) * (1 - fx) * fy + g(x0 + 1, y0 + 1) * fx * fy;
      ns[y * BW + x] = v * 0.985 + R.burnCount[y * BW + x] * 0.08;
    }
    R.smoke = ns;
    for (let b = 0; b < BW * BH; b++) R.info[b] *= 0.9885;
    if (t % 6 === 0) {
      const ni = new Float32Array(BW * BH);
      for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) {
        const b = y * BW + x; let s = R.info[b] * 0.6;
        for (let k = 0; k < 4; k++) { const nx = x + DIRS[k][0], ny = y + DIRS[k][1]; if (nx >= 0 && ny >= 0 && nx < BW && ny < BH) s += R.info[ny * BW + nx] * 0.1; }
        ni[b] = s;
      }
      R.info = ni;
    }

    if (t % 6 === 0) { const c = counts(R); R.series.push(c); if (c.onroad > R.peak) R.peak = c.onroad; }
    const active = R.burning.length > 0;
    let moving = false;
    for (let h = 0; h < R.st.length; h++) { const s = R.st[h]; if (s === ST.PREPARING || s === ST.WAITING || s === ST.ONROAD) { moving = true; break; } }
    if (t >= p.maxMin * 60 / DT || (!active && !moving)) R.done = true;
  }

  function counts(R) {
    const c = [0, 0, 0, 0, 0, 0, 0];
    for (let h = 0; h < R.st.length; h++) c[R.st[h]]++;
    return { t: R.t, unaware: c[0], preparing: c[1], onroad: c[2] + c[3], safe: c[4], atrisk: c[5], trapped: c[6] };
  }

  function summary(R) {
    const Wd = R.world, c = counts(R), safeTimes = [];
    let threatened = 0, shadow = 0, departed = 0;
    const zones = ZONES.map((z, i) => ({ id: z.id, foot: z.foot, homes: 0, threatened: 0, failed: 0,
      orderMin: R.zoneAlert[i] >= 0 && R.zoneAlert[i] <= R.t ? R.zoneAlert[i] * DT / 60 : null }));
    for (let h = 0; h < R.st.length; h++) {
      const z = zones[Wd.homes[h].zone]; z.homes++;
      if (R.safeT[h] >= 0) safeTimes.push(R.safeT[h]);
      if (R.fireNear[h] >= 0) { threatened++; z.threatened++; }
      if (R.st[h] === ST.ATRISK || R.st[h] === ST.TRAPPED) z.failed++;
      if (R.departT[h] >= 0) {
        departed++;
        const za = R.zoneAlert[Wd.homes[h].zone];
        if (za < 0 || R.departT[h] < za) shadow++;
      }
    }
    safeTimes.sort((a, b) => a - b);
    const t95 = safeTimes.length ? safeTimes[Math.floor(0.95 * (safeTimes.length - 1))] * DT / 60 : null;
    let burned = 0; for (let i = 0; i < R.fire.length; i++) if (R.fire[i]) burned++;
    const byRoad = {};
    for (const e of Wd.edges) if (R.edelay[e.id] > 0) byRoad[e.name] = (byRoad[e.name] || 0) + R.edelay[e.id] * DT / 60;
    const bottlenecks = Object.entries(byRoad).map(([name, vehMin]) => ({ name, vehMin })).sort((a, b) => b.vehMin - a.vehMin).slice(0, 4);
    const orders = R.alertLog.map(a => a.t * DT / 60);
    const failed = c.atrisk + c.trapped;
    return Object.assign(c, { threatened, failed, pctThreatened: threatened ? failed / threatened : 0, t95,
      burnedHa: burned * CELL * CELL / 10000, homes: R.st.length, shadow, departed, peak: R.peak,
      firstOrderMin: orders.length ? Math.min(...orders) : null, bottlenecks,
      zones: zones.sort((a, b) => (b.failed / b.homes) - (a.failed / a.homes) || b.threatened - a.threatened) });
  }

  function runToEnd(R) { while (!R.done) step(R); return summary(R); }

  function randomIgnition(world, rng) {
    if (world.ignCandidates) { const c = world.ignCandidates[Math.floor(rng() * world.ignCandidates.length)]; return { x: c % W, y: (c / W) | 0 }; }
    for (;;) {
      const x = 8 + Math.floor(rng() * 144), y = 14 + Math.floor(rng() * 26), c = y * W + x;
      if (world.lu[c] === LU.CHAP) return { x, y };
    }
  }

  return { setDims, setZones, zones: () => ZONES, FIRE, W, H, CELL, DT, BS, BW, BH, LU, ST, ZONES, LINES, buildWorld, newRun, step, runToEnd, summary, counts, randomIgnition, mulberry32, DEFAULTS };
})();
if (typeof module !== 'undefined') module.exports = Sim;
