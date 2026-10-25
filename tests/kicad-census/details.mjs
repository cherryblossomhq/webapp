// The numbers behind sections 5 to 8 of `docs/kicad-import.md` that `headline.mjs` does not give:
// pad-level totals, zone shapes, outline tolerances, the pad-frame evidence, duplicate references,
// net classes, and a rough estimate of how big each board's project file would be.
//
//   node tests/kicad-census/details.mjs <out-dir>
//
// The size estimate is crude on purpose (a fixed byte count per object, nothing joined); it is
// there to say which boards are anywhere near the account cap, and Phase 1 replaces it with a
// measurement against `serializeProject`.

import {readFileSync} from 'node:fs'
import { estimateBytes } from './size.mjs'
const b=JSON.parse(readFileSync(process.argv[2]+'/boards.json'))
const real=b.filter(x=>['pcbench','github','kicad-demos'].includes(x.group))
const sum=(f,s=real)=>s.reduce((a,x)=>a+f(x),0)
const N=real.length
console.log('REAL boards',N)
console.log('total pads',sum(x=>x.pads.total),'footprints',sum(x=>x.fps.total),'segments',sum(x=>x.tracks.segments),'arcs',sum(x=>x.tracks.arcs),'vias',sum(x=>x.tracks.vias),'zones',sum(x=>x.zones.total))
const sh={};for(const x of real)for(const [k,v] of Object.entries(x.pads.byShape))sh[k]=(sh[k]||0)+v
console.log('pad shapes (count)',JSON.stringify(sh))
const fl={},flb={};for(const x of real)for(const [k,v] of Object.entries(x.pads.flags)){fl[k]=(fl[k]||0)+v;flb[k]=(flb[k]||0)+1}
for(const k of Object.keys(fl).sort())console.log('  pad flag',k,fl[k],'pads in',flb[k],'boards ('+(100*flb[k]/N).toFixed(1)+'%)')
const dr={};for(const x of real)for(const [k,v] of Object.entries(x.pads.drill))dr[k]=(dr[k]||0)+v
console.log('drills',JSON.stringify(dr))
console.log('footprints at non-quarter angle',sum(x=>x.fps.angle.other),'of',sum(x=>x.fps.total),'; bottom',sum(x=>x.fps.bottom))
// zones
console.log('copper zones whole-board-like',sum(x=>x.zones.wholeBoardLike),'partial',sum(x=>x.zones.partial),'keepouts',sum(x=>x.zones.keepoutsPartial))
const onlyWhole=real.filter(x=>x.zones.wholeBoardLike+x.zones.partial>0&&x.zones.partial==0).length
const anyPartial=real.filter(x=>x.zones.partial>0).length
const anyCopperZone=real.filter(x=>x.zones.wholeBoardLike+x.zones.partial>0).length
console.log('boards with copper zones',anyCopperZone,'; all of them whole-board-like',onlyWhole,'; some partial',anyPartial)
const kz={};for(const x of real)for(const [k,v] of Object.entries(x.zones.kinds))kz[k]=(kz[k]||0)+1
console.log('zone kind boards',JSON.stringify(Object.fromEntries(Object.entries(kz).sort())))
// outline tolerance
for(const t of ['0.01','0.1','1']) console.log('open chains at',t,'mm:',real.filter(x=>x.outline.openChainsAt[t]>0).length)
console.log('outline w/ zero loops but pieces>0',real.filter(x=>x.outline.pieces>0&&x.outline.loops==0).length)
const dims=real.filter(x=>x.outline.width).map(x=>x.outline.width*x.outline.height).sort((a,c)=>a-c);console.log('board area mm2 median',dims[dims.length>>1],'p90',dims[Math.floor(dims.length*.9)],'max',dims[dims.length-1])
const gfx={};for(const x of real)for(const k of Object.keys(x.gfx)){if(k.startsWith('board:dimension')||k.startsWith('fp_text')||k.startsWith('fp_property'))gfx[k]=(gfx[k]||0)+1}
console.log('dimension/text boards',JSON.stringify(gfx))
const ev={};for(const x of real)for(const [k,v] of Object.entries(x.evidence)){ev[k]=ev[k]||{};for(const [n,c] of Object.entries(v))ev[k][n]=(ev[k][n]||0)+c}
console.log('evidence',JSON.stringify(ev))
const lay={};for(const x of real)lay[x.copperLayersDeclared]=(lay[x.copperLayersDeclared]||0)+1;console.log('layers declared',JSON.stringify(lay))
console.log('real boards with 2000+ pads:',real.filter(x=>x.pads.total>=2000).map(x=>x.file+' '+x.pads.total).join('; '))
console.log('fps with models',sum(x=>x.fps.withModels>0?1:0))
console.log('--- refs and classes')
console.log('boards with duplicate refs',real.filter(x=>x.fps.duplicateRefs>0).length,'; total dup',sum(x=>x.fps.duplicateRefs))
console.log('boards with empty ref',real.filter(x=>x.fps.emptyRef>0).length,'; footprints',sum(x=>x.fps.emptyRef||0))
console.log('boards with * ref (logos, REF**)',real.filter(x=>x.fps.starRef>0).length,'; footprints',sum(x=>x.fps.starRef||0))
console.log('padless footprints',sum(x=>x.fps.padless),'in boards',real.filter(x=>x.fps.padless>0).length)
const nc={};for(const x of real){const k=Math.min(x.nets.classes,6);nc[k]=(nc[k]||0)+1};console.log('net_class nodes per board (v5 era)',JSON.stringify(nc))
console.log('boards with >1 net_class',real.filter(x=>x.nets.classes>1).length)
console.log('boards with unnamed nets',real.filter(x=>x.nets.unnamed>0).length,'nets declared',sum(x=>x.nets.declared))

console.log("--- estimated project file size (size.mjs)")
const cap = 900 * 1024
const sizes = real.map((x) => ({ f: x.file, e: estimateBytes(x) })).sort((a, c) => a.e - c.e)
const at = (p) => sizes[Math.floor(p * sizes.length)].e
console.log("median KB", (at(0.5) / 1024).toFixed(0), "p90", (at(0.9) / 1024).toFixed(0), "p99", (at(0.99) / 1024).toFixed(0), "max", (sizes[sizes.length - 1].e / 1024).toFixed(0))
console.log("over 900KB:", sizes.filter((v) => v.e > cap).length, "of", sizes.length, "; over 500KB:", sizes.filter((v) => v.e > 500 * 1024).length)
console.log(sizes.slice(-6).map((v) => `${v.f.slice(-50)} ${(v.e / 1024).toFixed(0)}`).join(String.fromCharCode(10)))
