import { test, expect } from "@playwright/test";
const origin = "http://127.0.0.1:3100";
async function login(page: import("@playwright/test").Page) {
  await page.goto("/login"); await page.getByLabel("邮箱", { exact: true }).fill("learner@example.test");
  await page.getByLabel("密码", { exact: true }).fill("Browser-test-123!"); await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).not.toHaveURL(/\/login$/);
}
test("authenticated foreign and null sources cannot create sessions, change API settings or redeem rewards", async ({ page }) => {
  await login(page);
  const before = await (await page.request.get("/api/sessions")).json(), settings = await (await page.request.get("/api/ai-settings")).json();
  for (const Origin of ["https://untrusted.example.test", "null", origin + "/malformed", "http://127.0.0.1:3101"]) {
    const result = await page.request.post("/api/sessions", { headers: { Origin, Referer: origin + "/practice", "Content-Type": "text/plain" }, data: JSON.stringify({ mode: "practice", questionId: "P1-HOME-1", fresh: true }) });
    expect(result.status()).toBe(403); expect((await result.json()).error.code).toBe("untrusted_origin");
  }
  for (const [method, route, data] of [
    ["PUT", "/api/ai-settings", { mode: "personal", apiKey: "synthetic_rejected_origin_key", asrModel: "qwen3-asr-flash-2026-02-10", llmModel: "qwen-flash", monthlyBudgetYuan: 999, consent: true }],
    ["POST", "/api/rewards", { action: "redeem" }],
    ["DELETE", "/api/ai-settings", undefined],
  ] as const) {
    const result = await page.request.fetch(route, { method, headers: { Origin: "https://untrusted.example.test" }, data });
    expect(result.status()).toBe(403); expect((await result.json()).error.code).toBe("untrusted_origin");
  }
  expect(await (await page.request.get("/api/sessions")).json()).toEqual(before);
  expect(await (await page.request.get("/api/ai-settings")).json()).toEqual(settings);
});
test("missing source is blocked and a trusted referer admits a native client without disabling authentication", async ({ page, context, playwright }) => {
  await login(page);
  // Clear Playwright's configured default Origin so this actually tests missing headers.
  const native = await playwright.request.newContext({ baseURL: origin, extraHTTPHeaders: {}, storageState: await context.storageState() });
  try {
    expect((await native.get("/api/me")).status()).toBe(200);
    const missing = await native.post("/api/sessions", { data: { mode: "practice", questionId: "P1-HOME-1", fresh: true } });
    expect(missing.status()).toBe(403); expect((await missing.json()).error.code).toBe("untrusted_origin");
    const accepted = await native.post("/api/sessions", { headers: { Referer: origin + "/practice" }, data: { mode: "practice", questionId: "P1-HOME-1", fresh: true } });
    expect(accepted.status()).toBe(201); const { id } = await accepted.json();
    expect((await native.delete(`/api/sessions/${id}`, { headers: { Referer: origin + "/history" } })).status()).toBe(200);
  } finally { await native.dispose(); }
});
