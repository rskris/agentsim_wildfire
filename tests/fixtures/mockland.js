const box=(w,s,e,n)=>[[w,s],[e,s],[e,n],[w,n],[w,s]];
const lc=[]; const F=(sub,coords,z,type='Polygon')=>({type:'Feature',properties:{id:'lc'+lc.length,subtype:sub,cartography:{min_zoom:z[0],max_zoom:z[1]}},geometry:{type,coordinates:coords}});
for (const z of [[0,7],[8,15]]){
  const j=z[0]?0:0.004; // coarse LOD slightly offset to prove it's dropped
  lc.push(F('shrub',[box(-119.80,34.455+j,-119.55,34.52)],z));
  lc.push(F('forest',[box(-119.70,34.47,-119.66,34.50)],z));
  lc.push(F('grass',[box(-119.80,34.43,-119.70,34.455+j)],z));
  lc.push(F('crop',[box(-119.62,34.42,-119.55,34.455)],z));
  lc.push(F('urban',[box(-119.70,34.41,-119.62,34.45)],z));
  lc.push(F('barren',[box(-119.66,34.505,-119.64,34.515)],z));
}
const lu=[
 {type:'Feature',properties:{subtype:'park',class:'park',names:{primary:'Mock Park'}},geometry:{type:'Polygon',coordinates:[box(-119.69,34.44,-119.68,34.447),box(-119.687,34.442,-119.683,34.445)]}},
 {type:'Feature',properties:{subtype:'golf',class:'golf_course'},geometry:{type:'MultiPolygon',coordinates:[[box(-119.75,34.435,-119.73,34.445)],[box(-119.60,34.43,-119.59,34.44)]]}},
 {type:'Feature',properties:{subtype:'agriculture',class:'vineyard'},geometry:{type:'Polygon',coordinates:[box(-119.78,34.46,-119.76,34.47)]}},
 {type:'Feature',properties:{subtype:'residential',class:'residential'},geometry:{type:'Polygon',coordinates:[box(-119.70,34.43,-119.66,34.45)]}},
];
module.exports={landcover:{type:'FeatureCollection',features:lc},landuse:{type:'FeatureCollection',features:lu}};
