import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const runDir = path.resolve(`data/verification/personal-ai-${Date.now()}`);
Object.assign(process.env, { DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5549/personal_ai", BETTER_AUTH_SECRET: "personal-ai-test-only-secret-0000000000000", USER_API_KEY_SECRET: "", BETTER_AUTH_URL: "http://localhost:3100", AI_PROVIDER: "mock", TTS_PROVIDER: "mock", STORAGE_DRIVER: "local", DATA_DIR: runDir, LOCAL_STORAGE_DIR: path.join(runDir,"storage"), CONTENT_REQUIRE_REVIEW: "false", SEED_PUBLISH_DRAFTS: "true", ADMIN_EMAIL: "", ADMIN_INITIAL_PASSWORD: "", TIME_SCALE: "1" });
let pg: Awaited<ReturnType<typeof import("../../scripts/local-db").startLocalPostgres>>;
let db: typeof import("@/lib/db").db, s: typeof import("@/db/schema");
let credentials: typeof import("@/lib/ai/credentials"), account: typeof import("@/lib/ai/account");
let meter: typeof import("@/lib/providers/metered").metered;
const owners: string[] = [];
const keyA = "test_key_personal_owner_alpha", keyB = "test_key_personal_owner_bravo";
const config = {mode:"personal",asrModel:"qwen3-asr-flash-2026-02-10",llmModel:"qwen-plus",monthlyBudgetYuan:20,consent:true};
const request = {purpose:"check" as const,system:"Respond in JSON.",user:"Connection check",maxTokens:32};
beforeAll(async () => {
  pg = await (await import("../../scripts/local-db")).startLocalPostgres({dir:path.join(runDir,"pg"),port:5549,dbName:"personal_ai",quiet:true});
  await (await import("../../scripts/migrate")).runMigrations();
  await (await import("../../scripts/seed")).seed({tts:false,quiet:true});
  ({db}=await import("@/lib/db"));s=await import("@/db/schema");credentials=await import("@/lib/ai/credentials");account=await import("@/lib/ai/account");({metered:meter}=await import("@/lib/providers/metered"));
  for (const name of ["alpha","bravo","budget"]) {
    const u=await (await import("@/lib/auth")).createAccount({email:`ai-${name}@example.test`,password:"Test-only-12345!",name});owners.push(u.id);
    await db.update(s.user).set({mustChangePassword:false,consentAt:new Date(),onboardedAt:new Date()}).where(eq(s.user.id,u.id));
  }
},120000);
afterEach(()=>vi.unstubAllGlobals());
afterAll(async()=>{await (await import("@/lib/queue")).stopBoss();await (await import("@/lib/db")).closeDb();await pg?.stop();},30000);
function mockFetch() {
  const calls:{key:string;model:string;url:string}[]=[];
  vi.stubGlobal("fetch",vi.fn(async(url:string,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));calls.push({key:new Headers(init.headers).get("Authorization")!,model:body.model,url});
    return new Response(JSON.stringify({choices:[{message:{content:body.asr_options ? "I enjoy learning English because it helps me communicate with people." : '{"ok":true}'}}],usage:{prompt_tokens:1000,completion_tokens:100,seconds:7}}),{status:200});
  }));return calls;
}
it("encrypts per owner, rejects swapped ciphertext, never returns the key, and requires consent",async()=>{
  await expect(credentials.saveAiConfig(owners[0],{...config,apiKey:keyA,consent:false})).rejects.toMatchObject({status:400});
  const view=await credentials.saveAiConfig(owners[0],{...config,apiKey:keyA});
  const row=(await credentials.getAiConfig(owners[0]))!;
  expect(row.keyCiphertext).not.toContain(keyA);expect(row.consentedAt).toBeInstanceOf(Date);
  expect(credentials.decryptApiKey(owners[0],row.keyCiphertext!)).toBe(keyA);
  expect(()=>credentials.decryptApiKey(owners[1],row.keyCiphertext!)).toThrow("无法解密");
  expect(JSON.stringify(view)).not.toContain(keyA);expect(view.maskedKey).toBe("•••• lpha");
  expect(credentials.encryptApiKey(owners[0],keyA)).not.toBe(row.keyCiphertext);
  expect((await account.getAiAccount(owners[1])).config.hasKey).toBe(false);
  await expect(credentials.saveAiConfig(owners[0],{...config,baseUrl:"http://localhost:5433"})).rejects.toMatchObject({status:400});
  await expect(credentials.saveAiConfig(owners[0],{...config,llmModel:"unsupported-model"})).rejects.toMatchObject({status:400});
});
it("routes concurrent users to their own key/model, records usage and keeps platform costs separate",async()=>{
  await credentials.saveAiConfig(owners[1],{...config,apiKey:keyB,llmModel:"qwen-flash"});
  const calls=mockFetch();
  await Promise.all([meter("ai-alpha",owners[0]).llmJson(request),meter("ai-bravo",owners[1]).llmJson(request)]);
  await meter("ai-alpha-asr",owners[0]).asr({audio:Buffer.from("test audio"),mime:"audio/wav",durationSec:6});
  expect(calls).toEqual(expect.arrayContaining([{key:`Bearer ${keyA}`,model:"qwen-plus",url:"https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"},{key:`Bearer ${keyB}`,model:"qwen-flash",url:"https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"}]));
  const a=await account.getAiAccount(owners[0]),b=await account.getAiAccount(owners[1]);
  expect(a.rows).toHaveLength(2);expect(b.rows).toHaveLength(1);expect(a.rows.every(r=>r.source==="personal")).toBe(true);
  expect(a.rows.find(r=>r.service==="asr")?.units.seconds).toBe(7);
  expect(b.rows[0].cost).toBeCloseTo(0.0003,8);
  expect(a.rows.find(r=>r.service==="llm")?.cost).toBeCloseTo(0.001,8);
  expect(JSON.stringify(a)).not.toContain(keyA);expect(JSON.stringify(a)).not.toContain("keyCiphertext");
  expect(await (await import("@/lib/usage")).monthCostYuan()).toBe(0);
  expect((await (await import("@/lib/services/admin")).usageOverview()).byService).toHaveLength(0);
});
it("reserves personal budgets atomically and ignores exhausted platform budget for personal calls",async()=>{
  await credentials.saveAiConfig(owners[2],{...config,apiKey:"test_key_budget_only",monthlyBudgetYuan:0.001});
  await (await import("@/lib/settings")).setSetting("budget",{monthlyYuan:0});
  const {billableCall}=await import("@/lib/usage");let calls=0;
  const opts={service:"llm" as const,model:"qwen-plus",mock:false,userId:owners[2],billingSource:"personal" as const,monthlyBudgetYuan:0.001,jobRef:"atomic-personal",estimate:{inputTokens:1000,outputTokens:100},run:async()=>{calls++;await new Promise(r=>setTimeout(r,50));return {model:"qwen-plus",latencyMs:50};},units:()=>({inputTokens:1000,outputTokens:100})};
  const results=await Promise.allSettled([billableCall(opts),billableCall(opts)]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(calls).toBe(1);
  await expect((await import("@/lib/ai/runtime")).assertUserAiBudget(owners[2])).rejects.toMatchObject({code:"personal_budget_exceeded"});
  const network=mockFetch();await credentials.saveAiConfig(owners[2],{...config,monthlyBudgetYuan:0});
  await expect(meter("zero",owners[2]).llmJson(request)).rejects.toMatchObject({code:"personal_budget_exceeded"});expect(network).toHaveLength(0);
  await (await import("@/lib/settings")).setSetting("budget",{monthlyYuan:100});
});
it("retains uncertain cost after failure, sanitizes provider errors and throttles paid checks",async()=>{
  mockFetch();expect((await account.testPersonalConnection(owners[0])).ok).toBe(true);
  await expect(account.testPersonalConnection(owners[0])).rejects.toMatchObject({code:"check_rate_limit"});
  vi.stubGlobal("fetch",vi.fn(async()=>new Response(`secret echoed ${keyA}`,{status:401})));
  await expect(meter("failure",owners[0]).llmJson(request)).rejects.toThrow("百炼接口返回 401");
  const report=await account.getAiAccount(owners[0]);const last=report.rows[0];expect(last.ok).toBe(false);expect(last.units.estimated).toBe(true);expect(last.cost).toBeGreaterThan(0);expect(JSON.stringify(report)).not.toContain(keyA);
});
it("processes a recorded answer with the personal models while the site default remains mock",async()=>{
  const transcript="I live in a small apartment with my family. I really like it because it is close to my school and the neighbourhood is quiet.";
  const fake=await (await import("@/lib/providers/mock")).createMockProviders().llmJson({purpose:"feedback",system:"",user:"",mockHint:{transcript,reference:transcript,speechSec:6}});
  const keys:string[]=[];
  vi.stubGlobal("fetch",vi.fn(async(_url:string,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));keys.push(new Headers(init.headers).get("Authorization")!);
    return new Response(JSON.stringify({choices:[{message:{content:body.asr_options?transcript:fake.raw}}],usage:{prompt_tokens:1200,completion_tokens:500,seconds:6}}),{status:200});
  }));
  const sessions=await import("@/lib/services/sessions"),answers=await import("@/lib/services/answers");
  const session=await sessions.createSession({id:owners[0],consentAt:new Date()},{mode:"practice",questionId:"P1-HOME-1",fresh:true});
  const ticket=await answers.createUploadTicket(owners[0],{sessionId:session.id,planIndex:0,kind:"main",submissionId:crypto.randomUUID(),clientDurationMs:6000});
  await answers.receiveAudio(owners[0],ticket.answerId,ticket.ticket,(await import("../../scripts/make-fixtures")).pcmFixture(6));
  expect(await (await import("@/lib/jobs/process-answer")).processAnswer({answerId:ticket.answerId},{finalAttempt:true})).toEqual({status:"done"});
  const [row]=await db.select().from(s.answer).where(eq(s.answer.id,ticket.answerId));
  const [feedback]=await db.select().from(s.feedback).where(eq(s.feedback.answerId,ticket.answerId));
  expect(row.transcriptMock).toBe(false);expect(row.transcriptModel).toBe(config.asrModel);expect(feedback.model).toBe("qwen-plus");expect(feedback.mock).toBe(false);expect(keys.length).toBeGreaterThanOrEqual(2);expect(keys.every(k=>k===`Bearer ${keyA}`)).toBe(true);
});
it("deleting a key cannot fall back to the platform; account deletion removes credentials immediately",async()=>{
  const calls=mockFetch();await credentials.deleteApiKey(owners[0]);
  expect((await account.getAiAccount(owners[0])).config).toMatchObject({hasKey:false,mode:"personal"});
  await expect(meter("after-delete",owners[0]).llmJson(request)).rejects.toMatchObject({code:"key_required"});expect(calls).toHaveLength(0);
  expect((await account.getAiAccount(owners[0])).rows.length).toBeGreaterThan(0);
  await (await import("@/lib/services/deletion")).deleteUserAccount(owners[1],owners[1]);
  expect(await credentials.getAiConfig(owners[1])).toBeNull();
  await expect(meter("deleted-account",owners[1]).llmJson(request)).rejects.toMatchObject({code:"account_inactive"});expect(calls).toHaveLength(0);
});
it("uses Shanghai month boundaries including leap years",()=>{
  const range=account.usageMonthRange("2024-02");expect(range.from.toISOString()).toBe("2024-01-31T16:00:00.000Z");expect(range.to.toISOString()).toBe("2024-02-29T16:00:00.000Z");
  expect(()=>account.usageMonthRange("2024-13")).toThrow();
});
