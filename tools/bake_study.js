// Runs the 24-fire policy study on the synthetic community and saves it for docs/synthetic.html.
//   node tools/bake_study.js
const fs = require('fs'), path = require('path');
const Sim = require('../src/sim.js'), Study = require('../src/study.js');
(async () => {
  const world = Sim.buildWorld(), t = Date.now();
  const r = await Study.run(Sim, world, { K: 24, seed: 2026, progress: (i, n) => process.stdout.write(`\rscenario ${i}/${n}`) });
  for (const k in r.scen) for (const m in r.scen[k]) if (typeof r.scen[k][m] === 'number') r.scen[k][m] = Math.round(r.scen[k][m] * 10) / 10;
  for (const m in r.geo) r.geo[m] = Math.round(r.geo[m] * 1000) / 1000;
  fs.writeFileSync(path.join(__dirname, '../src/baked_study.json'), JSON.stringify(r));
  console.log(`\nSaved src/baked_study.json in ${Math.round((Date.now() - t) / 1000)} s`);
})();
