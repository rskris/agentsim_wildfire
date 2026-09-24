const Study = (function () {
  const SCEN = [
    ['base', 'Baseline: afternoon, zones within 1.5 km, 10 min to issue', {}],
    ['night', 'Night (2 a.m.)', { night: true }],
    ['nightFast', 'Night, 5 min to issue, 2.5 km trigger', { night: true, lagMin: 5, trigKm: 2.5 }],
    ['det2', 'Fire reported at 2 min instead of 8', { detectMin: 2 }],
    ['det20', 'Fire reported at 20 min', { detectMin: 20 }],
    ['lag0', 'Orders issued instantly', { lagMin: 0 }],
    ['lag5', '5 min to issue each order', { lagMin: 5 }],
    ['lag15', '15 min to issue each order', { lagMin: 15 }],
    ['lag20', '20 min to issue each order', { lagMin: 20 }],
    ['lag30', '30 min to issue each order', { lagMin: 30 }],
    ['trig075', 'Tighter trigger, 0.75 km', { trigKm: 0.75 }],
    ['trig25', 'Wider trigger, 2.5 km', { trigKm: 2.5 }],
    ['all', 'Everyone ordered at once', { alertAll: true }],
    ['allcf', 'Everyone at once plus contraflow', { alertAll: true, contraflow: true }],
    ['cf', 'Contraflow, zone orders', { contraflow: true }],
    ['adaptive', 'Households react to cues', { mode: 'adaptive' }],
  ];
  const TABLE_ROWS = ['base', 'night', 'nightFast', 'det2', 'det20', 'lag0', 'lag30', 'trig075', 'trig25', 'all', 'allcf', 'adaptive'];
  const BASE = { windFrom: 0, windKmh: 50, detectMin: 8, trigKm: 1.5, lagMin: 10, night: false, alertAll: false, mode: 'rules', contraflow: false };

  function fires(Sim, world, K, seed) {
    const rng = Sim.mulberry32(seed), out = [];
    for (let i = 0; i < K; i++) out.push({ ign: Sim.randomIgnition(world, rng), seed: (rng() * 1e6) | 0 });
    return out;
  }

  function runScenario(Sim, world, F, params) {
    const K = F.length, nh = world.homes.length, homeFail = new Float32Array(nh);
    const a = { failed: 0, atrisk: 0, trapped: 0, threatened: 0, t95: 0, peak: 0, shadow: 0, departed: 0, firstOrderMin: 0 };
    const nn = { t95: 0, firstOrderMin: 0 };
    for (const f of F) {
      const R = Sim.newRun(world, Object.assign({}, BASE, params, f));
      const s = Sim.runToEnd(R);
      for (const k in a) {
        if (k in nn) { if (s[k] != null) { a[k] += s[k]; nn[k]++; } }
        else a[k] += s[k] / K;
      }
      for (let h = 0; h < nh; h++) if (R.st[h] === Sim.ST.ATRISK || R.st[h] === Sim.ST.TRAPPED) homeFail[h] += 1 / K;
    }
    for (const k in nn) a[k] = nn[k] ? a[k] / nn[k] : null;
    return { m: a, homeFail };
  }

  function geo(Sim, world, homeFail) {
    let foot = 0, town = 0, spur = 0, total = 0, nf = 0, nt = 0, ns = 0, footSum = 0, ge10 = 0, any = 0;
    world.homes.forEach((h, i) => {
      const p = homeFail[i]; total += p;
      const Z = world.zones || Sim.ZONES;
      if (Z[h.zone].foot) { foot += p; nf++; } else { town += p; nt++; }
      if (h.spur) { spur += p; ns++; } else if (Z[h.zone].foot) { footSum += p; }
      if (p >= 0.1) ge10++; if (p > 0) any++;
    });
    return { footShare: total ? foot / total : 0, footHomeShare: nf / world.homes.length, footRatio: (foot / nf) / Math.max(1e-6, town / nt),
      spurRatio: (spur / Math.max(1, ns)) / Math.max(1e-6, footSum / Math.max(1, nf - ns)), ge10, any, homes: world.homes.length };
  }

  async function run(Sim, world, opts) {
    const K = opts.K || 24, F = fires(Sim, world, K, opts.seed || 2026), res = { K, seed: opts.seed || 2026, scen: {} };
    for (let i = 0; i < SCEN.length; i++) {
      const [key, label, p] = SCEN[i];
      const r = runScenario(Sim, world, F, p);
      res.scen[key] = Object.assign({ label }, r.m);
      if (key === 'base') res.geo = geo(Sim, world, r.homeFail);
      if (opts.progress) await opts.progress(i + 1, SCEN.length);
    }
    return res;
  }

  return { SCEN, TABLE_ROWS, run };
})();
if (typeof module !== 'undefined') module.exports = Study;
