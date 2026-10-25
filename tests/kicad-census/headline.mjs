// The headline table: one column per part of the corpus, one row per question the gap list asks.
//
//   node tests/kicad-census/headline.mjs <out-dir>
//
// `real` is every board that was not picked for a feature (PCBench, the GitHub projects found by
// chance, KiCad's demos); `targeted` are GitHub projects found by searching for blind vias, arcs,
// keepouts or curves, and `qa` are KiCad's own regression boards. Only `real` gives unbiased rates.

import {readFileSync} from 'node:fs'
const b=JSON.parse(readFileSync(process.argv[2]+'/boards.json'))
const sets={pcbench:b.filter(x=>x.group=='pcbench'),github:b.filter(x=>x.group=='github'),demos:b.filter(x=>x.group=='kicad-demos'),targeted:b.filter(x=>x.group=='github-targeted'),qa:b.filter(x=>x.group=='kicad-qa'),real:b.filter(x=>['pcbench','github','kicad-demos'].includes(x.group)),all:b}
const rows={
 'boards':x=>true,
 'module era (stamp<=20171130 / v3-v5)':x=>x.version<=20171130,
 'KiCad 3/4 stamp (3 or 4)':x=>x.version<=4,
 'KiCad 5 stamp':x=>x.version>4&&x.version<=20171130,
 'KiCad 6+ ( >=20211014 )':x=>x.version>=20211014,
 'pre6 nightly':x=>x.version>20171130&&x.version<20211014,
 '2 copper layers declared':x=>x.copperLayersDeclared==2,
 '>2 copper layers declared':x=>x.copperLayersDeclared>2,
 '1 layer used':x=>x.copperLayersUsed==1,
 'outline rect':x=>x.outline.shape=='rect',
 'outline roundrect':x=>x.outline.shape=='roundrect',
 'outline polygon (lines)':x=>x.outline.shape=='polygon',
 'outline arcs':x=>x.outline.shape=='arcs',
 'outline circle':x=>x.outline.shape=='circle',
 'outline curve':x=>x.outline.shape=='curve',
 'outline open/unclosed':x=>x.outline.shape=='open',
 'outline none':x=>x.outline.shape=='none',
 'NON-rectangular outline (anything but rect/none)':x=>!['rect','none'].includes(x.outline.shape),
 'outline representable today (rectangle, or four equal corner radii, nothing cut out)':x=>x.outline.representable,
 'outline NOT representable today (incl. none, open, cutouts, unequal radii)':x=>!x.outline.representable,
 'outline roundrect with unequal corner radii':x=>x.outline.shape=='roundrect-unequal',
 'outline has cutout loops':x=>x.outline.cutouts>0,
 'outline with arcs/circles (any)':x=>x.outline.kinds.some(k=>k=='arc'||k=='circle'||k=='curve'),
 'any zone':x=>x.zones.total>0,
 'filled copper zone':x=>x.zones.filled>0,
 'unfilled copper zone':x=>x.zones.unfilled>0,
 'keepout zone':x=>(x.zones.kinds.keepout||0)>0,
 'rule area (all allowed)':x=>(x.zones.kinds['rule-area']||0)>0,
 'zone priority>0':x=>x.zones.priorities>0,
 'multi-layer zone':x=>x.zones.multiLayer>0,
 'copper zone not polygon-of-whole-board (any zone)':x=>x.zones.total>0,
 'arc tracks':x=>x.tracks.arcs>0,
 'blind via':x=>(x.tracks.viaKinds.blind||0)>0,
 'micro via':x=>(x.tracks.viaKinds.micro||0)>0,
 'buried/blind/micro/partial-span via':x=>Object.keys(x.tracks.viaKinds).some(k=>['blind','micro','buried','through-but-partial-span'].includes(k)),
 'footprint at non-quarter angle':x=>x.fps.angle.other>0,
 'pad with non-quarter angle':x=>(x.pads.flags['non-quarter-angle']||0)>0,
 'custom-shape pad':x=>Object.keys(x.pads.byShape).some(k=>k.endsWith(':custom')),
 'trapezoid pad':x=>Object.keys(x.pads.byShape).some(k=>k.endsWith(':trapezoid')),
 'roundrect pad':x=>Object.keys(x.pads.byShape).some(k=>k.endsWith(':roundrect')),
 'drill offset':x=>(x.pads.drill['round+offset']||0)+(x.pads.drill['oval+offset']||0)>0,
 'oval drill (slot)':x=>(x.pads.drill['oval']||0)+(x.pads.drill['oval+offset']||0)>0,
 'bottom-side footprints':x=>x.fps.bottom>0,
 'SMD pad on the other side of its footprint':x=>(x.pads.flags['smd-on-the-other-side-of-its-footprint']||0)>0,
 'copper zone with no net':x=>x.zones.noNet>0,
 'graphics on copper layer':x=>Object.keys(x.gfx).some(k=>k.endsWith('@copper')),
 'user-renamed copper layers':x=>x.customCopperNames,
 'copper on undeclared layer':x=>x.undeclaredCopperLayers.length>0,
 'has .kicad_pro':x=>x.companions.includes('.kicad_pro'),
 'has .kicad_sch':x=>x.companions.some(c=>c.endsWith('.kicad_sch')),
 'has legacy .sch':x=>x.companions.some(c=>c.endsWith('.sch')&&!c.endsWith('.kicad_sch')),
 'has .kicad_dru':x=>x.companions.some(c=>c.endsWith('.kicad_dru')),
 'has stackup block':x=>x.stackup,
 'dimension nodes':x=>(x.nodes['dimension']||0)>0,
 'group nodes':x=>(x.nodes['group']||0)>0,
 'image nodes':x=>(x.nodes['image']||0)>0,
 'embedded_files':x=>Object.keys(x.nodes).some(k=>/(^|>)embedded_files$/.test(k)),
 'generated (generators)':x=>(x.nodes['generated']||0)>0,
 'teardrop (zone or teardrops node)':x=>x.zones.teardrop>0||Object.keys(x.nodes).some(k=>k.endsWith('>teardrops')),
 'net_class in board':x=>x.nets.classes>0,
 'pads>=2000':x=>x.pads.total>=2000,
}
const names=Object.keys(sets)
console.log('| metric | '+names.map(n=>`${n} (${sets[n].length})`).join(' | ')+' |')
console.log('|---|'+names.map(()=>'---|').join(''))
for(const [k,f] of Object.entries(rows)){
 console.log(`| ${k} | `+names.map(n=>{const s=sets[n];const c=s.filter(f).length;return `${c} (${(100*c/s.length).toFixed(1)}%)`}).join(' | ')+' |')
}
