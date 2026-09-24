// Mock Overpass response + elevation shaped like a coastal foothill town (for testing only)
const BB={s:34.405,w:-119.76,n:34.495,e:-119.585};
function coastLat(lon){ return 34.418+0.006*Math.sin((lon+119.7)*40); }
function elev(lat,lon){ const d=lat-coastLat(lon); if(d<0) return -20; return Math.max(0.6, d*3500 + Math.max(0,lat-34.445)*18000 + 60*Math.sin(lon*300)*Math.max(0,lat-34.44)*40); }
function mock(){
  let id=1; const els=[]; const node=(lat,lon)=>{ const n={type:'node',id:id++,lat,lon}; els.push(n); return n.id; };
  const way=(nodes,tags)=>els.push({type:'way',id:id++,nodes,tags});
  const lons=[]; for(let lon=BB.w+0.004; lon<BB.e-0.002; lon+=0.0032) lons.push(lon);
  const rows=[]; for(let k=0;k<11;k++) rows.push(k);
  const lat=(k,lon)=>coastLat(lon)+0.006+k*0.0024;
  const L=lons.map((lon,j)=>rows.map(k=>node(lat(k,lon),lon)));
  rows.forEach(k=>way(lons.map((_,j)=>L[j][k]),{highway:k%4===0?'secondary':'residential',name:k%4===0?`Mock Boulevard ${k}`:`Row Street ${k}`}));
  lons.forEach((lon,j)=>{
    const col=rows.map(k=>L[j][k]);
    if(j%6===2){ // canyon road into foothills
      const ext=[]; for(let t=1;t<=12;t++) ext.push(node(lat(10,lon)+t*0.0022, lon+0.002*Math.sin(t)));
      way(col.concat(ext),{highway:'tertiary',name:`Canyon Road ${j}`});
      for(let s=3;s<=11;s+=4){ const sp=[ext[s]]; for(let u=1;u<=4;u++) sp.push(node(lat(10,lon)+(s+1)*0.0022+u*0.0006, lon+u*0.0016)); way(sp,{highway:'residential',name:`Ridge Lane ${j}-${s}`}); }
    } else way(col,{highway:j%5===0?'tertiary':'residential',name:`Col Avenue ${j}`});
  });
  // freeway both directions, extending beyond bbox
  const fw=[]; const fwl=[]; for(let lon=BB.w-0.01; lon<=BB.e+0.01; lon+=0.004){ fw.push(node(coastLat(lon)+0.003,lon)); }
  way(fw,{highway:'motorway',ref:'US 101',name:'Mock Freeway',oneway:'yes'}); way(fw.slice().reverse(),{highway:'motorway',ref:'US 101',name:'Mock Freeway',oneway:'yes'});
  // ramps: connect every 5th lattice col bottom to nearest freeway node
  lons.forEach((lon,j)=>{ if(j%5!==1) return; let bi=0,bd=1e9; fw.forEach((n,i)=>{ const e=els.find(x=>x.id===n); const d=Math.abs(e.lon-lon); if(d<bd){bd=d;bi=i;} }); way([L[j][0],fw[bi]],{highway:'motorway_link'}); way([fw[bi],L[j][0]],{highway:'motorway_link'}); });
  // trunk to north-west
  const tr=[L[3][10]]; for(let t=1;t<=20;t++) tr.push(node(lat(10,lons[3])+t*0.0035, lons[3]-t*0.0012)); way(tr,{highway:'trunk',ref:'SR 154',name:'Mock Pass Road'});
  return {elements:els};
}
module.exports={BB,elev,mock};
