import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import ts from "typescript";
import { loadContent } from "../lib/content/load";
import { checkIntegrity } from "../lib/content/validate";
import { pcmFixture } from "./make-fixtures";
import { mobileOpenApi } from "./ios-contracts";

const root = process.cwd();
const output = path.join(root, "docs", "ios", "generated");
const hash = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");
const slash = (value: string) => value.split(path.sep).join("/");

async function filesIn(relative: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(folder: string) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (/\.tsx?$/.test(entry.name)) results.push(slash(path.relative(root, file)));
    }
  }
  await walk(path.join(root, relative));
  return results.sort();
}

export async function sourceInventory() {
  const files = (await Promise.all(["app", "lib", "components", "worker", "db"].map(filesIn))).flat().sort();
  const rows = [];
  for (const file of files) {
    const text = await fs.readFile(path.join(root, file), "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const imports = source.statements.filter(ts.isImportDeclaration).map(node => (node.moduleSpecifier as ts.StringLiteral).text);
    const methods = new Set<string>();
    const exportedFunctions: string[] = [];
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement) && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(declaration.name.text)) methods.add(declaration.name.text);
      }
      if (ts.isFunctionDeclaration(statement) && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) && statement.name) {
        exportedFunctions.push(statement.name.text);
        if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(statement.name.text)) methods.add(statement.name.text);
      }
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(element.name.text)) methods.add(element.name.text);
      }
    }
    const flags = {
      clientDirective: /^\s*["']use client["']/.test(text),
      serverAction: /^\s*["']use server["']/.test(text),
      nextFramework: imports.some(value => value.startsWith("next/") || value === "next"),
      serverImports: imports.filter(value => value.startsWith("node:") || ["pg", "pg-boss", "ali-oss", "next/headers", "next/server"].includes(value)),
      browserRecording: /\b(MediaRecorder|getUserMedia|AudioContext)\b/.test(text),
      browserStorage: /\b(indexedDB|localStorage|sessionStorage|BroadcastChannel)\b/.test(text),
      browserLifecycle: /\b(visibilitychange|pagehide|beforeunload|navigator\.locks|wakeLock)\b/.test(text),
    };
    rows.push({ file, sha256: hash(text), imports, exportedFunctions, apiMethods: [...methods].sort(), ...flags });
  }
  const routes = rows.filter(row => row.file.startsWith("app/api/") && row.file.endsWith("/route.ts")).map(row => ({
    source: row.file,
    path: "/" + row.file.replace(/^app\//, "").replace(/\/route\.ts$/, "").replace(/\[\.\.\.([^\]]+)\]/g, "{$1}").replace(/\[([^\]]+)\]/g, "{$1}"),
    methods: row.apiMethods,
  }));
  return { format: "speak-ios-source-inventory-v1", scanKind: "static source inventory, not a native build", contentFingerprint: hash(JSON.stringify(rows.map(row => [row.file, row.sha256]))), counts: { files: rows.length, routes: routes.length, operations: routes.reduce((n, row) => n + row.methods.length, 0), serverActionFiles: rows.filter(row => row.serverAction).length, browserRecordingFiles: rows.filter(row => row.browserRecording).length, browserStorageFiles: rows.filter(row => row.browserStorage).length }, routes, files: rows };
}

export async function materialEvidence() {
  const sources = [
    ["LICENSE", "own code", "retain license"],
    ["THIRD_PARTY_NOTICES.md", "third-party register", "final iOS packaging review pending"],
    ["public/licenses/rhine-lab-ui.txt", "RhineLabUI original portions", "third-party visual rights excluded; final use review pending"],
    ["public/models/rhine/archive-assembly.glb", "referenced assembly", "final visual rights review pending"],
    ["public/models/rhine/archive-cassette.glb", "referenced cassette", "final visual rights review pending"],
    ["public/models/speak-disc/v1/training-disc.glb", "SPEAK model", "provenance and final review pending"],
    ["public/models/speak-disc/v1/playback-deck.glb", "SPEAK playback model", "provenance and final review pending"],
    ["public/fonts/MiSans-license.pdf", "original font terms", "read; split-font adaptation compatibility pending; native prototype uses system font"],
    ["public/fonts/NOTICE.txt", "font notice", "retain if used"],
    ["public/fonts/misans-webfont-4.3.1/source.json", "split-font provenance", "final native use not approved"],
    ["docs/design/rhine-disc-v1/avatar-prompt.md", "fictional AI examiner provenance", "final image and representation review pending"],
  ] as const;
  return { format: "speak-ios-material-evidence-v1", allMaterialsApproved: false, note: "Evidence inventory, not a legal clearance. No licensed font or voice weights are copied to a native package.", files: await Promise.all(sources.map(async ([file, category, status]) => {
    const bytes = await fs.readFile(path.join(root, file));
    return { file, category, status, bytes: bytes.length, sha256: hash(bytes) };
  })) };
}

const csvCell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;

export async function prepareIos() {
  const bundle = loadContent();
  const integrity = checkIntegrity(bundle);
  if (!integrity.ok) throw new Error("Content integrity failed; do not generate a ready package");
  const pilotIds = new Set([...bundle.levels.filter(level => level.chapter === 1).flatMap(level => level.questions), ...bundle.mocks[0].part1, bundle.mocks[0].part2, ...bundle.mocks[0].part3]);
  const queue = bundle.questions.map(question => ({ id: question.id, part: question.part, pilot: pilotIds.has(question.id), fingerprint: hash(JSON.stringify(question)), sourceStatus: question.reviewStatus, humanReview: "pending", question: question.text, reference: question.referenceAnswer, goal: question.trainingGoal }));
  const inventory = await sourceInventory();
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(root, "docs", "ios", "openapi.proposed.json"), JSON.stringify(mobileOpenApi, null, 2) + "\n");
  await fs.writeFile(path.join(output, "source-inventory.json"), JSON.stringify(inventory, null, 2) + "\n");
  await fs.writeFile(path.join(output, "material-evidence.json"), JSON.stringify(await materialEvidence(), null, 2) + "\n");
  await fs.writeFile(path.join(output, "content-review-queue.json"), JSON.stringify({ format: "speak-ios-content-review-v1", total: queue.length, pilotMainQuestions: queue.filter(row => row.pilot).length, approvedSourceQuestions: queue.filter(row => row.sourceStatus === "approved").length, humanTeachingApproval: false, note: "Machine-generated work queue. No question approval or production database is changed.", questions: queue }, null, 2) + "\n");
  await fs.writeFile(path.join(output, "content-review-queue.csv"), "\uFEFF" + [
    ["id", "part", "pilot", "fingerprint", "sourceStatus", "humanReview", "question", "reference", "goal"].map(csvCell).join(","),
    ...queue.map(row => [row.id, row.part, row.pilot, row.fingerprint, row.sourceStatus, row.humanReview, row.question, row.reference, row.goal].map(csvCell).join(",")),
  ].join("\r\n") + "\r\n");
  const fixtureDirectory = path.join(root, "data", "verification", "ios-prep-fixtures");
  await fs.mkdir(fixtureDirectory, { recursive: true });
  const fixtureRows = [];
  for (const [name, seconds, silent] of [["signal-6s.wav", 6, false], ["silence-5s.wav", 5, true]] as const) {
    const bytes = pcmFixture(seconds, silent);
    await fs.writeFile(path.join(fixtureDirectory, name), bytes);
    fixtureRows.push({ file: name, seconds, bytes: bytes.length, sha256: hash(bytes), kind: silent ? "synthetic silence" : "synthetic transport signal, not human speech" });
  }
  await fs.writeFile(path.join(fixtureDirectory, "manifest.json"), JSON.stringify({ format: "speak-ios-fixtures-v1", realSpeech: false, qualityValidated: false, fixtures: fixtureRows }, null, 2) + "\n");
  console.log(JSON.stringify({ prepared: true, sourceInventory: inventory.counts, contentQuestions: queue.length, pilotQuestions: queue.filter(row => row.pilot).length, fixtureBytes: fixtureRows.reduce((n, row) => n + row.bytes, 0), nativeValidated: false, humanReviewed: false, databaseTouched: false, paidCalls: 0 }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(root, "scripts/prepare-ios.ts")) await prepareIos();
