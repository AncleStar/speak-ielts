import sharp from 'sharp';
const pairs=[
 {name:'type-and-action',source:'docs/design/rhine-disc-v1/01-训练磁盘库.png',actual:'data/verification/disc-library.png',a:{left:1110,top:270,width:520,height:540},b:{left:1030,top:260,width:600,height:570}},
 {name:'replay-controls',source:'docs/design/rhine-disc-v1/03-记录回放.png',actual:'data/verification/disc-archive.png',a:{left:640,top:400,width:990,height:170},b:{left:610,top:438,width:1010,height:170}}
];
for(const p of pairs){const [a,b]=await Promise.all([sharp(p.source).extract(p.a).resize(620,550,{fit:'contain',background:'#eeebe5'}).toBuffer(),sharp(p.actual).extract(p.b).resize(620,550,{fit:'contain',background:'#eeebe5'}).toBuffer()]);await sharp({create:{width:1240,height:550,channels:3,background:'#eeebe5'}}).composite([{input:a,left:0,top:0},{input:b,left:620,top:0}]).png().toFile('data/verification/disc-qa/focused-'+p.name+'.png');}
