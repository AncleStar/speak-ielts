// Audited source snapshot; run only against the local reference checkout.
import fs from 'node:fs/promises';
import path from 'node:path';
const source = 'data/reference/RhineLabUI';
const destination = 'components/disc/rhine';
if (await fs.stat(`${destination}/scene.ts`).catch(()=>null)) throw new Error('The adapted renderer already exists. Review upstream changes manually; this bootstrap will not overwrite it.');
const entries = ['scene','archive-visibility','instance-updates','render-state','shared-depth','three-resources','theme-motion','theme-material','archive-play-motion','archive-lighting','render-quality','quality-renderer','appearance','internal-optics','decryption','archive-drag','motion-preferences','motion','viewport-layout','glass-reveal','boot-motion','boot-tracks','boot-orbit-tracks','boot-logo-tracks'];
await fs.mkdir(destination,{recursive:true});
for(const entry of entries){
  let code=(await fs.readFile(`${source}/src/${entry}.ts`,'utf8')).replaceAll('\r\n','\n');
  code=code.replaceAll('.ts"','"');
  if(entry==='scene'){
    code=code.replace('import { fileAtSlot, fileLocation } from "./data";', 'import type { ArchiveCatalog } from "./catalog";');
    code=code.replace('  selectionCell,\n','').replace('  fileAtCell,\n','');
    code=code.replace('import { labelMarkSvg } from "./brand";\n','');
    code=code.replace('    private container: HTMLElement,','    private container: HTMLElement,\n    public catalog: ArchiveCatalog,');
    for(const name of ['fileAtSlot','fileLocation','fileAtCell','selectionCell'])code=code.replaceAll(`${name}(`,`this.catalog.${name}(`);
    code=code.replace('  private labelMark = new Image();\n','');
    code=code.replace(/    this\.labelMark\.src =[^\n]+\n    await this\.labelMark\.decode\(\);\n/,'');
    code=code.replace('if (name === "Carbon_Ink") continue;', 'if (name === "Carbon_Ink" || name === "Moulded_Lettering") continue;');
    code=code.replace('"RHINE LAB, LLC."','"SPEAK / IELTS"').replace('"INTERNAL DATABASE"','"PERSONAL TRAINING DISC"').replace('"R L / I S"','"S P / OS"');
    code=code.replace('c.fillText("NO." + String(index + 1).padStart(3, "0"), 22, 360);','c.font = "bold 84px MiSans";\n    c.fillText(this.catalog.records[index]?.id ?? "DISC", 22, 350, 730);');
    code=code.replace('    c.drawImage(this.labelMark, 790, 242, 210, 98);','    c.font = "bold 36px MiSans";\n    c.fillText("SPEAK", 808, 330);');
  }
  await fs.writeFile(`${destination}/${entry}.ts`,`// Adapted from RhineLabUI, Copyright (c) 2026 LBEILC, MIT. See public/licenses/rhine-lab-ui.txt.\n${code}`);
}
await fs.mkdir('public/models/rhine',{recursive:true});
for(const name of ['archive-cassette.glb','archive-assembly.glb']) await fs.copyFile(`${source}/public/assets/${name}`,`public/models/rhine/${name}`);
await fs.mkdir('public/licenses',{recursive:true});
await fs.copyFile(`${source}/LICENSE`,'public/licenses/rhine-lab-ui.txt');
await fs.cp(`${source}/public/fonts`,'public/fonts',{recursive:true});
await fs.copyFile(`${source}/src/fonts.css`,'app/rhine-fonts.css');
console.log(`Copied ${entries.length} motion/render modules, models, MiSans shards and licenses.`);
