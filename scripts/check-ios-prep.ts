import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sourceInventory, materialEvidence } from "./prepare-ios";
import { mobileOpenApi } from "./ios-contracts";
import { loadContent } from "../lib/content/load";
import { checkIntegrity } from "../lib/content/validate";

// Preparation consistency only. Never imports production auth, env, database or providers.
const root = process.cwd();
const directory = path.join(root, "docs/ios");
const failures: string[] = [];
let checks = 0;
const check = (ok: boolean, message: string) => { checks++; if (!ok) failures.push(message); };
const hash = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");
const read = async <T>(file: string) => JSON.parse(await fs.readFile(path.join(root, file), "utf8")) as T;
const exists = async (file: string) => fs.stat(file).then(s => s.isFile(), () => false);
type Document = Record<string, unknown>;
function references(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => key === "$ref" && typeof child === "string" ? [child] : references(child));
}

const actualInventory = await sourceInventory();
const savedInventory = await read<typeof actualInventory>("docs/ios/generated/source-inventory.json");
check(isDeepStrictEqual(savedInventory, actualInventory), "Source inventory is stale; run prepare:ios");
const actualMaterials = await materialEvidence();
check(isDeepStrictEqual(await read("docs/ios/generated/material-evidence.json"), actualMaterials), "Material evidence hashes are stale");

const bundle = loadContent();
check(checkIntegrity(bundle).ok, "Source content integrity failed");
const queue = await read<{ total: number; pilotMainQuestions: number; approvedSourceQuestions: number; humanTeachingApproval: boolean; questions: { id: string; pilot: boolean; sourceStatus: string; humanReview: string; fingerprint: string }[] }>("docs/ios/generated/content-review-queue.json");
const pilot = new Set([...bundle.levels.filter(level => level.chapter === 1).flatMap(level => level.questions), ...bundle.mocks[0].part1, bundle.mocks[0].part2, ...bundle.mocks[0].part3]);
check(queue.total === bundle.questions.length && queue.questions.length === queue.total, "Question queue count mismatch");
check(queue.pilotMainQuestions === pilot.size, "Pilot queue count mismatch");
check(queue.approvedSourceQuestions === bundle.questions.filter(q => q.reviewStatus === "approved").length, "Source approval count mismatch");
check(queue.humanTeachingApproval === false, "Generated queue must not claim human teaching approval");
check(new Set(queue.questions.map(q => q.id)).size === queue.total, "Duplicate queue IDs");
for (const question of bundle.questions) {
  const row = queue.questions.find(q => q.id === question.id);
  check(Boolean(row && row.fingerprint === hash(JSON.stringify(question)) && row.sourceStatus === question.reviewStatus && row.pilot === pilot.has(question.id) && row.humanReview === "pending"), `Stale or misrepresented question: ${question.id}`);
}
const csv = await fs.readFile(path.join(directory, "generated/content-review-queue.csv"), "utf8");
check(queue.questions.every(q => csv.includes(q.fingerprint)), "CSV queue missing source fingerprints");

const api = await read<Document>("docs/ios/openapi.proposed.json");
check(isDeepStrictEqual(api, mobileOpenApi), "OpenAPI file differs from contract source");
check(api.openapi === "3.1.0" && api["x-production-enabled"] === false, "Proposed API must not claim production implementation");
for (const reference of references(api)) {
  check(reference.startsWith("#/"), `Unexpected external schema reference: ${reference}`);
  const resolved = reference.slice(2).split("/").reduce<unknown>((value, key) => value && typeof value === "object" ? (value as Document)[key.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined, api);
  check(resolved !== undefined, `Broken schema reference: ${reference}`);
}
const operationIds = new Set<string>();
for (const [url, item] of Object.entries(api.paths as Record<string, Document>)) {
  for (const [method, value] of Object.entries(item)) {
    if (!/^(get|post|put|patch|delete|head|options)$/.test(method)) continue;
    const operation = value as Document;
    const operationId = operation.operationId as string;
    check(Boolean(operationId) && !operationIds.has(operationId), `Duplicate/missing operation ID: ${url}`);
    operationIds.add(operationId);
    check(operation["x-implementation-status"] === "proposal", `Operation falsely enabled: ${url}`);
    check(typeof operation["x-existing-source"] === "string" && await exists(path.join(root, String(operation["x-existing-source"]))), `Missing source mapping: ${url}`);
    const parameters = [...((item.parameters ?? []) as Document[]), ...((operation.parameters ?? []) as Document[])];
    for (const match of url.matchAll(/\{([^}]+)\}/g)) check(parameters.some(p => p.in === "path" && p.name === match[1] && p.required === true), `Missing required path parameter: ${url}`);
  }
}
check(mobileOpenApi.paths["/answers/{id}/audio"].put["x-max-upload-bytes"] === 25 * 1024 * 1024, "Upload boundary mismatch");

const required = ["README.md", "首版功能与任务表.md", "架构与迁移清单.md", "移动API契约.md", "客户端能力与录音规则.md", "隐私与素材审核.md", "Mac接入与真机验收.md", "准备验收报告.md", "人工审核记录.example.csv", "readiness.json"];
for (const file of required) check(await exists(path.join(directory, file)), `Missing preparation document: ${file}`);
for (const file of required.filter(file => file.endsWith(".md"))) {
  const text = await fs.readFile(path.join(directory, file), "utf8");
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, "");
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    const local = decodeURIComponent(target.split(/[?#]/)[0]);
    check(await exists(path.resolve(directory, local)), `Broken document link: ${file} -> ${local}`);
  }
}
const readiness = await read<{ devices: { mac: { available: boolean }; iphone: { inspected: boolean; nativeValidated: boolean } }; domain: { purchaseAllowedIfNeeded: boolean; registered: boolean; publicServiceOpened: boolean }; gates: Record<string, boolean>; evidenceLimits: Record<string, boolean> }>("docs/ios/readiness.json");
check(!readiness.devices.mac.available && !readiness.devices.iphone.inspected && !readiness.devices.iphone.nativeValidated, "Preparation must preserve current unverified device status");
check(readiness.domain.purchaseAllowedIfNeeded && !readiness.domain.registered && !readiness.domain.publicServiceOpened, "Domain decision must not imply purchase/public exposure");
check(Object.values(readiness.gates).every(value => value === false) && Object.values(readiness.evidenceLimits).every(value => value === false), "Preparation must not pass native/human/release gates");
check(await exists(path.join(root, "lib/ios/ports.ts")), "Missing candidate capability interfaces");
const macScript = await fs.readFile(path.join(root, "scripts/ios/mac-preflight.sh"), "utf8");
check(!macScript.includes("\r") && macScript.includes('"Darwin"'), "Mac script needs LF line endings and a platform guard");

const fixtureDirectory = path.join(root, "data/verification/ios-prep-fixtures");
const fixtureManifest = await read<{ realSpeech: boolean; qualityValidated: boolean; fixtures: { file: string; sha256: string; bytes: number }[] }>("data/verification/ios-prep-fixtures/manifest.json");
check(fixtureManifest.realSpeech === false && fixtureManifest.qualityValidated === false, "Synthetic fixtures must not claim human quality evidence");
for (const fixture of fixtureManifest.fixtures) {
  if (!/^(signal-6s|silence-5s)\.wav$/.test(fixture.file)) { check(false, "Unexpected fixture path"); continue; }
  const bytes = await fs.readFile(path.join(fixtureDirectory, fixture.file));
  check(hash(bytes) === fixture.sha256 && bytes.length === fixture.bytes && bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WAVE", `Fixture integrity failed: ${fixture.file}`);
}
const report = { format: "speak-ios-preparation-check-v1", checkedAt: new Date().toISOString(), node: process.version, checks, windowsPreparationConsistent: failures.length === 0, sourceCounts: actualInventory.counts, proposedOperations: operationIds.size, questions: queue.total, pilotQuestions: queue.pilotMainQuestions, nativeValidated: false, humanReviewed: false, allMaterialsApproved: false, databaseTouched: false, paidCalls: 0, failures };
await fs.mkdir(path.join(root, "data/verification"), { recursive: true });
await fs.writeFile(path.join(root, "data/verification/ios-prep-current.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
