// Assembles the single-file apps in docs/ from src/.
//   node tools/build.js
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), rd = f => fs.readFileSync(path.join(root, f), 'utf8');
const sim = rd('src/sim.js'), rw = rd('src/realworld.js'), study = rd('src/study.js'), css = rd('src/ui/shared.css');
const rl = fs.existsSync(path.join(root, 'src/rl_policy.js')) ? rd('src/rl_policy.js') : '';
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });

const overture = rd('src/ui/overture.html')
  .replace('/*CSS*/', () => css).replace('/*SIM*/', () => sim).replace('/*RW*/', () => rw).replace('/*STUDY*/', () => study).replace('/*RL*/', () => rl);
fs.writeFileSync(path.join(root, 'docs/index.html'), overture);

const bakedPath = path.join(root, 'src/baked_study.json');
if (!fs.existsSync(bakedPath)) { console.error('Missing src/baked_study.json. Run: npm run bake'); process.exit(1); }
const synthetic = rd('src/ui/synthetic.html')
  .replace('/*SIM*/', () => sim).replace('/*STUDY*/', () => study).replace('/*BAKED*/', () => fs.readFileSync(bakedPath, 'utf8')).replace('/*RL*/', () => rl);
fs.writeFileSync(path.join(root, 'docs/synthetic.html'), synthetic);
console.log('Built docs/index.html and docs/synthetic.html with RL policy integration');
