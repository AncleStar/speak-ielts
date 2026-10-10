import fs from "node:fs";
const pause = new Int32Array(new SharedArrayBuffer(4));
/** Windows readers can briefly hold the destination open. Keep the last complete state until rename succeeds. */
export function writeRuntimeState(file: string, value: unknown) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value));
    for (let attempt = 0; ; attempt++) {
      try { fs.renameSync(temp, file); return; }
      catch (error) {
        if (!["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "") || attempt >= 5) throw error;
        Atomics.wait(pause, 0, 0, 10 * 2 ** attempt);
      }
    }
  } finally { fs.rmSync(temp, { force: true }); }
}
