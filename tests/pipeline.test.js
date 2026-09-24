// node --test tests/
const test = require('node:test'), assert = require('node:assert');
const Sim = require('../src/sim.js'), RW = require('../src/realworld.js'), Study = require('../src/study.js');
const M = require('./fixtures/mockosm.js'), OV = require('./fixtures/mockov.js'), LAND = require('./fixtures/mockland.js');

test('synthetic community: longer alert lag means more households fail to get out', () => {
  const W = Sim.buildWorld();
  const fails = lag => { let f = 0; for (const ign of [{ x: 80, y: 28 }, { x: 40, y: 32 }]) f += Sim.runToEnd(Sim.newRun(W, { ign, seed: 1, lagMin: lag })).failed; return f; };
  assert.ok(W.homes.length > 1000);
  assert.ok(fails(30) > fails(0));
});

test('Overture pipeline: segments, buildings, land cover and land use build a runnable world', () => {
  const { segs, blds } = OV.make();
  assert.equal(RW.kindOf(segs.features), 'segments');
  assert.equal(RW.kindOf(blds), 'buildings');
  assert.equal(RW.kindOf(LAND.landcover.features), 'landcover');
  assert.equal(RW.kindOf(LAND.landuse.features), 'landuse');
  assert.equal(RW.finestLod(LAND.landcover.features).length, LAND.landcover.features.length / 2);
  const B = RW.buildingsFromOverture(blds);
  assert.ok(B.homes.length > 0 && B.homes.length < B.all.length, 'non-residential buildings are filtered out');
  const { bbox } = RW.studyBox(RW.extentOf(segs.features), null, 25), grid = RW.makeGrid(bbox);
  const world = RW.build(RW.fromOverture(segs.features), grid, M.elev,
    { Sim, buildings: B, maxAgents: 4000, landcover: LAND.landcover.features, landuse: LAND.landuse.features });
  assert.equal(world.homeSource, 'buildings');
  assert.ok(world.agentWeight > 1);
  assert.ok(world.stats.exits >= 2, 'highways leaving the area become exits');
  assert.ok(world.stats.landcoverShare > 0.5);
  Sim.setDims(world.W, world.H); Sim.setZones(world.zones);
  const s = Sim.runToEnd(Sim.newRun(world, { ign: Sim.randomIgnition(world, Sim.mulberry32(4)), seed: 1 }));
  assert.ok(s.safe > 0 && s.threatened > 0);
  assert.ok(s.bottlenecks.length > 0);
});

test('polygon holes are left unfilled', () => {
  const grid = RW.makeGrid({ w: 0, s: 0, e: 0.01, n: 0.01 }), t = new Uint8Array(grid.W * grid.H);
  const box = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
  RW.rasterize([{ properties: {}, geometry: { type: 'Polygon', coordinates: [box(0.001, 0.001, 0.009, 0.009), box(0.004, 0.004, 0.006, 0.006)] } }], grid, grid.W, grid.H, () => 1, t);
  const at = (lat, lon) => { const [x, y] = grid.toGrid(lat, lon); return t[Math.floor(y) * grid.W + Math.floor(x)]; };
  assert.equal(at(0.002, 0.002), 1); assert.equal(at(0.005, 0.005), 0);
});

test('policy study runs every scenario', async () => {
  const W = Sim.buildWorld();
  const r = await Study.run(Sim, W, { K: 1, seed: 3 });
  assert.equal(Object.keys(r.scen).length, Study.SCEN.length);
});
