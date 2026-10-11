import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chromium, type Browser } from "@playwright/test";

// Isolated framework fixture: no application database, credentials, audio or paid providers.
const project = process.cwd(), port = 3102, baseline = process.argv.includes("--baseline");
const root = path.resolve(`data/verification/render-cancellation-${Date.now()}-${randomUUID().slice(0, 8)}`);
const next = JSON.parse(await fs.readFile("node_modules/next/package.json", "utf8")).version;
let server: ChildProcess | undefined, browser: Browser | undefined;
let output = "";
async function write(relative: string, content: string) {
  const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content);
}
async function run(args: string[], file: string) {
  const log = await fs.open(path.join(root, file), "w", 0o600);
  const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let writes = Promise.resolve(); for (const stream of [child.stdout, child.stderr]) stream?.on("data", bytes => { writes = writes.then(async () => { await log.write(bytes); }); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }); await writes; await log.close();
  if (code !== 0) throw new Error(`Fixture build failed; inspect private ${file}`);
}
async function until(check: () => boolean | Promise<boolean>, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error("Fixture condition timed out");
}
try {
  await new Promise<void>((resolve, reject) => { const probe = net.createServer(); probe.once("error", () => reject(new Error("Test port is occupied; no existing process was stopped"))); probe.listen(port, "127.0.0.1", () => probe.close(() => resolve())); });
  await write("package.json", JSON.stringify({ private: true, name: "speak-render-cancellation-fixture", dependencies: { next, react: "19.2.8", "react-dom": "19.2.8" } }));
  await write("next.config.mjs", `export default {turbopack:{root:${JSON.stringify(project)}},outputFileTracingRoot:${JSON.stringify(project)},experimental:{turbopackFileSystemCacheForBuild:false}};`);
  await write("app/layout.jsx", 'export default function Layout({children}){return <html><body>{children}</body></html>}');
  await write("app/page.jsx", `import Link from 'next/link';export const dynamic='force-dynamic';export default async function Page({searchParams}){const {run='positive'}=await searchParams;return <Link prefetch={false} href={'/slow?run='+run}>Start slow render</Link>}`);
  await write("app/slow/page.jsx", `import {Suspense} from 'react';export const dynamic='force-dynamic';function Marker({run}){console.log('RENDER-COMPLETED '+run);return <p>DONE {run}</p>}async function Slow({run}){await new Promise(r=>setTimeout(r,2500));return <Marker run={run}/>}export default async function Page({searchParams}){const {run}=await searchParams;console.log('RENDER-STARTED '+run);return <main><Suspense fallback={<p>Rendering slow response</p>}><Slow run={run}/></Suspense></main>}`);
  await write("app/failure/page.jsx", `export const dynamic='force-dynamic';export default async function Page(){await new Promise(r=>setTimeout(r,100));throw new Error('Synthetic genuine render failure control')}`);
  await write("instrumentation.js", `export function onRequestError(error){console.log('RENDER-ERROR '+JSON.stringify({name:error.name,message:error.message}))}`);
  const cli = path.join(project, "node_modules/next/dist/bin/next");
  await run([cli, "build"], "build.log");
  server = spawn(process.execPath, [cli, "start", "-H", "127.0.0.1", "-p", String(port)], { cwd: root, windowsHide: true, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [server.stdout, server.stderr]) stream?.on("data", bytes => { output += bytes.toString(); });
  const url = `http://127.0.0.1:${port}`;
  await until(async () => fetch(url).then(r => r.ok, () => false));
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium" });
  const positive = await browser.newContext(), positivePage = await positive.newPage();
  await positivePage.goto(`${url}/?run=positive`); await positivePage.getByRole("link", { name: "Start slow render" }).click();
  await positivePage.getByText("DONE positive", { exact: true }).waitFor();
  const concurrent = await browser.newContext(), peer = await concurrent.newPage();
  await peer.goto(`${url}/?run=concurrent`); await peer.getByRole("link", { name: "Start slow render" }).click();
  const abort = await browser.newContext(), abortedPage = await abort.newPage();
  await abortedPage.goto(`${url}/?run=aborted`);
  const cdp = await abort.newCDPSession(abortedPage); await cdp.send("Network.enable");
  let rscRequest = "", firstChunk = false;
  cdp.on("Network.responseReceived", e => { if (e.response.url.includes("/slow?run=aborted") && e.response.status === 200 && String(e.response.headers["Content-Type"] ?? e.response.headers["content-type"]).includes("text/x-component")) rscRequest = e.requestId; });
  cdp.on("Network.dataReceived", e => { if (rscRequest && e.requestId === rscRequest && e.dataLength > 0) firstChunk = true; });
  await abortedPage.getByRole("link", { name: "Start slow render" }).click(); await until(() => firstChunk && output.includes("RENDER-STARTED aborted"), 2000);
  await abort.close(); await peer.getByText("DONE concurrent", { exact: true }).waitFor(); await new Promise(resolve => setTimeout(resolve, 2800));
  const expectedAbortErrors = output.split("\n").filter(line => line.startsWith("RENDER-ERROR ") && line.includes("The destination stream closed early.")).length;
  const noCancelledCompletion = !output.includes("RENDER-COMPLETED aborted"), positiveCompleted = output.includes("RENDER-COMPLETED positive"), concurrentCompleted = output.includes("RENDER-COMPLETED concurrent");
  const failure = await browser.newContext(), failurePage = await failure.newPage(); await failurePage.goto(`${url}/failure`);
  await until(() => output.includes('RENDER-ERROR {"name":"Error","message":"Synthetic genuine render failure control"}'));
  const checks = { firstRscChunkReceived: firstChunk, positiveCompleted, cancelledRenderStopped: noCancelledCompletion, concurrentCompleted, genuineFailureReported: true, abortClassification: baseline ? expectedAbortErrors > 0 : expectedAbortErrors === 0 };
  const report = { passed: Object.values(checks).every(Boolean), checkedAt: new Date().toISOString(), nextVersion: next, baseline, checks, expectedAbortErrors, fixtureOnly: true, actualEdge: process.platform === "win32", paidApiCalls: 0 };
  await write("acceptance.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, report: path.relative(project, path.join(root, "acceptance.json")) }));
  if (!report.passed) process.exitCode = 1;
} catch (error) { console.error("Render cancellation check failed:", (error as Error).message); process.exitCode = 1; }
finally {
  await browser?.close();
  if (server?.pid && server.exitCode === null) {
    if (process.platform === "win32") await new Promise<void>(resolve => { const kill = spawn("taskkill", ["/PID", String(server!.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); kill.once("exit", () => resolve()); kill.once("error", () => resolve()); }); else server.kill("SIGTERM");
  }
  if (output) await write("server.log", output);
}
