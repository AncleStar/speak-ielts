import sharp from 'sharp';
import fs from 'node:fs/promises';
await fs.mkdir('data/verification/disc-qa',{recursive:true});
for(const [source,name] of [['01-训练磁盘库.png','library'],['02-播放录制台.png','recording'],['03-记录回放.png','archive']]){
 const top=await sharp('docs/design/rhine-disc-v1/'+source).resize(1672,940).toBuffer();
 const bottom=await sharp('data/verification/disc-'+name+'.png').resize(1672,940).toBuffer();
 await sharp({create:{width:1672,height:1880,channels:3,background:'#eeebe5'}}).composite([{input:top,top:0,left:0},{input:bottom,top:940,left:0}]).png().toFile('data/verification/disc-qa/'+name+'-comparison.png');
}
const d=JSON.parse(await fs.readFile('data/verification/disc-frame-intervals.json','utf8')).samplesMs.slice(1).sort((a,b)=>a-b);console.log({medianMs:d[Math.floor(d.length*.5)],p95Ms:d[Math.floor(d.length*.95)],over33Ms:d.filter(x=>x>33.4).length,samples:d.length});
