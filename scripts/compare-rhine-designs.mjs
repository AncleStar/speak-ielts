import sharp from "sharp";
import fs from "node:fs/promises";

const output = "data/verification/rhine-qa";
await fs.mkdir(output, { recursive: true });
for (const [reference, actual, name, width, height] of [
  ["array", "library", "array", 1600, 900],
  ["detail", "loaded", "detail", 1600, 900],
  ["boot-14", "authorized", "authorization", 1600, 900],
  ["mobile-array", "mobile", "mobile", 390, 844],
]) {
  const source = await sharp(`data/reference/rhine-capture/${reference}.png`).resize(width, height, { fit: "contain" }).toBuffer();
  const rendered = await sharp(`data/verification/rhine-${actual}.png`).resize(width, height, { fit: "contain" }).toBuffer();
  await sharp({ create: { width, height: height * 2, channels: 3, background: "#e8e5e1" } })
    .composite([{ input: source, top: 0, left: 0 }, { input: rendered, top: height, left: 0 }])
    .png().toFile(`${output}/${name}-comparison.png`);
}
for (const [name, region] of [
  ["library", { left: 790, top: 375, width: 770, height: 370 }],
  ["recording", { left: 900, top: 320, width: 670, height: 580 }],
  ["archive", { left: 900, top: 360, width: 670, height: 540 }],
  ["login", { left: 540, top: 220, width: 520, height: 600 }],
]) {
  await sharp(`data/verification/rhine-${name}.png`).extract(region).png().toFile(`${output}/focused-${name}.png`);
}
const samples = JSON.parse(await fs.readFile("data/verification/disc-frame-intervals.json", "utf8")).samplesMs.slice(1).sort((a, b) => a - b);
const timing = { samples: samples.length, medianMs: samples[Math.floor(samples.length * .5)], p95Ms: samples[Math.floor(samples.length * .95)], over33Ms: samples.filter(n => n > 33.4).length, scope: "This machine's browser requestAnimationFrame sample during disk selection, not GPU FPS or a mobile performance guarantee." };
await fs.writeFile(`${output}/timing-summary.json`, JSON.stringify(timing, null, 2));
console.log(JSON.stringify(timing));
