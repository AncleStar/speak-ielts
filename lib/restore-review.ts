import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import { RECOVERY_STATE_KEY } from "@/lib/recovery-state";

const money = z.number().finite().nonnegative().max(1e9);
const monthSchema = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
const costSchema = z.object({ source: z.enum(["platform", "personal"]), userId: z.string().min(1).nullable(), month: monthSchema, totalYuan: money });
const ledgerSchema = z.object({ format: z.literal("speak-cost-ledger-v1"), exportedAt: z.string().datetime(), totals: z.array(costSchema).max(100000) });
const reviewSchema = z.object({ format: z.literal("speak-restore-review-v1"), recoveryId: z.string().uuid(), month: monthSchema,
  checks: z.object({ accountsAndPermissions: z.literal(true), costsIncludingPendingCalls: z.literal(true), deploymentAndSecrets: z.literal(true) }),
  evidence: z.string().trim().min(8).max(2000), openNewSessions: z.boolean(),
  accounts: z.array(z.object({ userId: z.string().min(1), access: z.enum(["disabled", "user", "admin"]) })).max(100000),
  costs: z.array(costSchema).max(100000) });
type Cost = z.infer<typeof costSchema>;
type State = { recoveryId: string; status: "pending" | "approved"; backupCreatedAt: string; reviewHash?: string; costFloorHash?: string };
export const recoveryMonth = (now = new Date()) => new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 7);
const costKey = (cost: Pick<Cost, "source" | "userId" | "month">) => JSON.stringify([cost.source, cost.userId, cost.month]);
const privateJson = (file: string, data: unknown) => fs.writeFile(file, JSON.stringify(data, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true });
async function readJson(file: string) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error("恢复检查文件必须是大小受限的普通文件");
  return JSON.parse(await fs.readFile(file, "utf8"));
}
async function clientFor(databaseUrl: string) {
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });
  await client.connect(); return client;
}
async function requireStopped(client: pg.Client) {
  const { rows } = await client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()");
  if (rows[0].n !== 0) throw new Error("请先停止该环境的网页、worker 和其他数据库连接，再执行恢复检查");
}
async function stateFor(client: pg.Client, directory: string) {
  // Two independently persisted identities prevent an accidentally selected business database from being edited.
  const complete = await readJson(path.join(directory, "restore-complete.json"));
  const row = (await client.query("SELECT value FROM app_setting WHERE key=$1", [RECOVERY_STATE_KEY])).rows[0];
  const state = row?.value as State | undefined;
  if (!state || state.recoveryId !== complete.recoveryId || !["pending", "approved"].includes(state.status)) throw new Error("目标数据库与恢复目录不匹配，未修改任何账号或账本");
  if (await fs.stat(path.join(directory, "restore-pending.json")).then(() => true, () => false)) throw new Error("数据恢复尚未完成，不能进行开放检查");
  return state;
}
async function totalsFor(client: pg.Client): Promise<Cost[]> {
  const rows = (await client.query(`SELECT billing_source AS source, CASE WHEN billing_source='personal' THEN user_id ELSE NULL END AS "userId",
    to_char(created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM') AS month, sum(cost_yuan)::float8 AS "totalYuan"
    FROM usage_event WHERE mock=false GROUP BY 1,2,3`)).rows;
  return rows.map(row => costSchema.parse(row));
}
function mapCosts(costs: Cost[]) {
  const map = new Map<string, Cost>();
  for (const cost of costs) {
    if (cost.source === "platform" && cost.userId !== null) throw new Error("站点费用须为整体合计，不能按个人重复记账");
    const key = costKey(cost); if (map.has(key)) throw new Error("费用核对包含重复项目"); map.set(key, cost);
  }
  return map;
}

/** Called only after archive restore and deletion replay; old passwords cannot be used even if a marker is lost. */
export async function initializeRestoreReview(databaseUrl: string, directory: string, backupCreatedAt: string) {
  const client = await clientFor(databaseUrl), recoveryId = randomUUID();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE account SET password=NULL, access_token=NULL, refresh_token=NULL, id_token=NULL");
    await client.query("DELETE FROM verification");
    await client.query('UPDATE "user" SET must_change_password=true');
    await client.query("INSERT INTO app_setting(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()", [RECOVERY_STATE_KEY, { recoveryId, status: "pending", backupCreatedAt }]);
    await client.query("INSERT INTO app_setting(key,value) VALUES('pauseNewSessions','true'::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=now()");
    await privateJson(path.join(directory, "restore-review-pending.json"), { recoveryId });
    await client.query("COMMIT"); return recoveryId;
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { await client.end(); }
}

/** Minimal read-only export, with no content, addresses, passwords or credentials. Stop source services first. */
export async function exportRecoveryLedger(databaseUrl: string, output: string) {
  const client = await clientFor(databaseUrl);
  try {
    await requireStopped(client); await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const totals = await totalsFor(client);
    await privateJson(output, { format: "speak-cost-ledger-v1", exportedAt: new Date().toISOString(), totals });
    await client.query("COMMIT"); return { entries: totals.length };
  } finally { await client.end(); }
}

/** All confirmations and reviewed totals start unresolved. The latest ledger supplies a lower bound, not an invoice. */
export async function prepareRestoreReview(databaseUrl: string, directory: string, ledgerFile?: string) {
  const client = await clientFor(databaseUrl);
  try {
    await requireStopped(client); const state = await stateFor(client, directory);
    if (state.status !== "pending") throw new Error("该恢复已经通过检查，无需重新准备");
    const accounts = (await client.query('SELECT id AS "userId",name,email,role AS "previousRole",banned FROM "user" WHERE deleted_at IS NULL ORDER BY id')).rows;
    const floors = mapCosts(await totalsFor(client));
    if (ledgerFile) {
      const ledger = ledgerSchema.parse(await readJson(ledgerFile));
      if (new Date(ledger.exportedAt).getTime() < new Date(state.backupCreatedAt).getTime()) throw new Error("用量导出早于备份，不能作为最新费用依据");
      for (const [key, cost] of mapCosts(ledger.totals)) {
        const existing = floors.get(key); if (!existing || cost.totalYuan > existing.totalYuan) floors.set(key, cost);
      }
    }
    for (const cost of [{ source: "platform" as const, userId: null, month: recoveryMonth(), totalYuan: 0 }, ...accounts.map(row => ({ source: "personal" as const, userId: row.userId as string, month: recoveryMonth(), totalYuan: 0 }))])
      if (!floors.has(costKey(cost))) floors.set(costKey(cost), cost);
    const template = { format: "speak-restore-review-v1", recoveryId: state.recoveryId, month: recoveryMonth(),
      checks: { accountsAndPermissions: false, costsIncludingPendingCalls: false, deploymentAndSecrets: false }, evidence: "", openNewSessions: false,
      accounts: accounts.map(row => ({ ...row, access: null })), costs: [...floors.values()].map(cost => ({ ...cost, minimumKnownYuan: cost.totalYuan, totalYuan: null })) };
    // Preserve the immutable floor separately: editing the worksheet must not lower a known cost.
    await privateJson(path.join(directory, "restore-cost-floor.json"), { recoveryId: state.recoveryId, totals: [...floors.values()] });
    await privateJson(path.join(directory, "restore-review.json"), template);
    const costFloorHash = createHash("sha256").update(JSON.stringify([...floors.values()])).digest("hex");
    await client.query("UPDATE app_setting SET value=$2,updated_at=now() WHERE key=$1", [RECOVERY_STATE_KEY, { ...state, costFloorHash }]);
    return { accounts: accounts.length, costEntries: floors.size, file: path.join(directory, "restore-review.json") };
  } finally { await client.end(); }
}

export async function approveRestoreReview(databaseUrl: string, directory: string, inputFile: string) {
  const client = await clientFor(databaseUrl);
  try {
    await requireStopped(client); const state = await stateFor(client, directory);
    const review = reviewSchema.parse(await readJson(inputFile)), reviewHash = createHash("sha256").update(JSON.stringify(review)).digest("hex");
    if (review.recoveryId !== state.recoveryId) throw new Error("检查表不属于该恢复");
    const credentialsFile = path.join(directory, "restore-credentials.json");
    if (state.status === "approved") {
      if (state.reviewHash !== reviewHash) throw new Error("该恢复已使用另一份检查表开放，禁止重复修改");
      await fs.rm(path.join(directory, "restore-review-pending.json"), { force: true });
      return { alreadyApproved: true, credentialsFile };
    }
    if (review.month !== recoveryMonth()) throw new Error("检查月份已经变化，请重新核对当前月份费用");
    const accounts = (await client.query('SELECT id,name,email FROM "user" WHERE deleted_at IS NULL ORDER BY id')).rows;
    const choices = new Map(review.accounts.map(row => [row.userId, row.access]));
    if (choices.size !== review.accounts.length || choices.size !== accounts.length || accounts.some(row => !choices.has(row.id))) throw new Error("必须逐一核对全部账号，不能遗漏、重复或加入陌生账号");
    if (![...choices.values()].includes("admin")) throw new Error("至少指定一个经过核对的管理员");
    const floor = await readJson(path.join(directory, "restore-cost-floor.json"));
    if (floor.recoveryId !== state.recoveryId) throw new Error("费用依据不属于该恢复");
    if (!state.costFloorHash || state.costFloorHash !== createHash("sha256").update(JSON.stringify(floor.totals)).digest("hex")) throw new Error("费用依据缺失或被修改，请保留文件并重新检查恢复准备流程");
    const costs = mapCosts(review.costs), known = mapCosts(z.array(costSchema).parse(floor.totals));
    for (const cost of await totalsFor(client)) { const old = known.get(costKey(cost)); if (!old || cost.totalYuan > old.totalYuan) known.set(costKey(cost), cost); }
    for (const [key, cost] of known) if (!costs.has(key) || costs.get(key)!.totalYuan < cost.totalYuan) throw new Error("核对费用不能遗漏或低于已知账本，未知计费须保留预估金额");
    for (const cost of costs.values()) if (cost.month > review.month) throw new Error("不能提前填入未来月份费用");
    let credentials: { recoveryId: string; reviewHash: string; accounts: { userId: string; email: string; name: string; temporaryPassword: string }[] };
    try { credentials = await readJson(credentialsFile); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      credentials = { recoveryId: state.recoveryId, reviewHash, accounts: accounts.filter(row => choices.get(row.id) !== "disabled").map(row => ({ userId: row.id, email: row.email, name: row.name, temporaryPassword: randomBytes(24).toString("base64url") })) };
      await privateJson(credentialsFile, credentials);
    }
    if (credentials.recoveryId !== state.recoveryId || credentials.reviewHash !== reviewHash) throw new Error("已有临时凭据对应另一份检查表，请保留文件并检查失败原因");
    const enabled = accounts.filter(row => choices.get(row.id) !== "disabled");
    if (!Array.isArray(credentials.accounts) || credentials.accounts.length !== enabled.length || new Set(credentials.accounts.map(row => row.userId)).size !== enabled.length ||
      enabled.some(row => !credentials.accounts.some(entry => entry.userId === row.id && typeof entry.temporaryPassword === "string" && /^[A-Za-z0-9_-]{32}$/.test(entry.temporaryPassword))))
      throw new Error("临时凭据损坏或缺失，保持恢复实例关闭");
    const passwordHashes = new Map<string, string>();
    for (const row of credentials.accounts) passwordHashes.set(row.userId, await hashPassword(row.temporaryPassword));
    await client.query("BEGIN");
    await client.query("SELECT value FROM app_setting WHERE key=$1 FOR UPDATE", [RECOVERY_STATE_KEY]);
    // Credentials/permissions and carry-forward expenses become visible in the same transaction.
    await client.query('DELETE FROM "session"'); await client.query("DELETE FROM verification");
    for (const row of accounts) {
      const access = choices.get(row.id)!;
      await client.query('UPDATE "user" SET role=$2,banned=$3,ban_reason=$4,ban_expires=NULL,must_change_password=true,updated_at=now() WHERE id=$1', [row.id, access === "admin" ? "admin" : "user", access === "disabled", access === "disabled" ? "recovery_access_disabled" : null]);
      await client.query("UPDATE account SET password=$2,access_token=NULL,refresh_token=NULL,id_token=NULL,updated_at=now() WHERE user_id=$1", [row.id, passwordHashes.get(row.id) ?? null]);
    }
    // A snapshot can contain a subsequently revoked personal key. Require deliberate re-entry after recovery.
    await client.query("UPDATE user_ai_config SET key_ciphertext=NULL,key_last4=NULL,consented_at=NULL,updated_at=now()");
    const restored = mapCosts(await totalsFor(client));
    for (const [key, cost] of costs) {
      const delta = cost.totalYuan - (restored.get(key)?.totalYuan ?? 0); if (delta <= 0) continue;
      await client.query("INSERT INTO usage_event(id,user_id,billing_source,service,model,job_ref,units,cost_yuan,mock,ok,created_at) VALUES($1,$2,$3,'recovery-adjustment','reviewed-cost-carry',$4,$5,$6,false,true,$7)",
        [randomUUID(), cost.userId, cost.source, state.recoveryId, { recoveryAdjustment: true, costEstimated: true, recoveryId: state.recoveryId, month: cost.month }, delta, new Date(`${cost.month}-01T00:00:00+08:00`)]);
    }
    await client.query("UPDATE app_setting SET value=$2,updated_at=now() WHERE key=$1", [RECOVERY_STATE_KEY, { ...state, status: "approved", reviewHash, approvedAt: new Date().toISOString(), personalKeysRequireReentry: true }]);
    await client.query("UPDATE app_setting SET value=$1::jsonb,updated_at=now() WHERE key='pauseNewSessions'", [JSON.stringify(!review.openNewSessions)]);
    await client.query("COMMIT");
    await fs.rm(path.join(directory, "restore-review-pending.json"));
    return { alreadyApproved: false, credentialsFile };
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { await client.end(); }
}
