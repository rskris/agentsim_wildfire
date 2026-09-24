const M=require('./mockosm.js');
function make(){
  const o=M.mock(); const nodes=new Map(o.elements.filter(e=>e.type==='node').map(n=>[n.id,n]));
  const segs=[], blds=[]; let k=0;
  for(const w of o.elements.filter(e=>e.type==='way')){
    const t=w.tags, hw=t.highway, link=hw.endsWith('_link'), cls=link?hw.replace('_link',''):hw;
    const props={id:'seg'+(k++),type:'segment',subtype:'road',class:cls,subclass:link?'link':null,
      names:t.name?{primary:t.name}:null, routes:t.ref?[{ref:t.ref,network:'US:US'}]:null,
      speed_limits:cls==='residential'?[{max_speed:{value:25,unit:'mph'}}]:null,
      access_restrictions:t.oneway==='yes'&&cls!=='motorway'?[{access_type:'denied',when:{heading:'backward'}}]:null,
      connectors:w.nodes.filter((_,i)=>i===0||i===w.nodes.length-1).map((id,i)=>({connector_id:'c'+id,at:i}))};
    segs.push({type:'Feature',properties:props,geometry:{type:'LineString',coordinates:w.nodes.map(id=>[nodes.get(id).lon,nodes.get(id).lat])}});
    // buildings along residential/tertiary streets
    if(cls==='residential'||cls==='tertiary'){
      for(let i=1;i<w.nodes.length;i++){ const a=nodes.get(w.nodes[i-1]), b=nodes.get(w.nodes[i]);
        const L=Math.hypot((b.lon-a.lon)*92000,(b.lat-a.lat)*110540), n=Math.floor(L/35);
        for(let j=0;j<n;j++){ const f=(j+.5)/n, lon=a.lon+(b.lon-a.lon)*f, lat=a.lat+(b.lat-a.lat)*f;
          for(const side of [-1,1]){ const dx=-(b.lat-a.lat), dy=(b.lon-a.lon), l=Math.hypot(dx,dy)||1, off=0.00025;
            const cx=lon+side*dx/l*off, cy=lat+side*dy/l*off, s=0.00008; const r=Math.random();
            const cls2=r<0.05?'garage':r<0.08?'commercial':r<0.11?'apartments':r<0.5?'house':null;
            const sub=cls2==='commercial'?'commercial':cls2&&cls2!=='garage'?'residential':null;
            blds.push({type:'Feature',properties:{id:'b'+blds.length,subtype:sub,class:cls2,num_floors:cls2==='apartments'?3:null},
              geometry:{type:'Polygon',coordinates:[[[cx-s,cy-s],[cx+s,cy-s],[cx+s,cy+s],[cx-s,cy+s],[cx-s,cy-s]]]}});
          } } } }
  }
  return {segs:{type:'FeatureCollection',features:segs}, blds};
}
module.exports={make};
