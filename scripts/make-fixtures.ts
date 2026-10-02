import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Deterministic PCM fixture for recorder transport tests; never presented as human speech. */
export function pcmFixture(seconds: number, silent = false): Buffer {
  const rate = 16000;
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(44 + n * 2);
  data.write("RIFF", 0); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const envelope = t % 4 > 3.5 ? 0 : 0.55 + 0.2 * Math.sin(t * 5);
    const value = silent ? 0 : Math.round(7500 * envelope * (Math.sin(2 * Math.PI * 220 * t) + 0.3 * Math.sin(2 * Math.PI * 580 * t)));
    data.writeInt16LE(value, 44 + i * 2);
  }
  return data;
}
export async function makeFixtures() {
  const dir = path.resolve("tests/fixtures");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "microphone.wav"), pcmFixture(12));
  await fs.writeFile(path.join(dir, "silence.wav"), pcmFixture(5, true));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await makeFixtures(); console.log("已生成录音传输测试音频（合成信号，非人声评测样本）。");
}
