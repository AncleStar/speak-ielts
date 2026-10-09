import { test, expect, type Page } from "@playwright/test";
test.use({ reducedMotion: "reduce", extraHTTPHeaders: { "x-forwarded-for": "192.0.2.90" } });
const origin = { Origin: "http://127.0.0.1:3100" };
let unfinished: { id: string; email: string }[] = [];
test.beforeEach(() => { unfinished = []; });
test.afterEach(async ({ playwright }) => {
  // Logged-out recording cases intentionally leave an active server session. Clean only these fixtures;
  // otherwise they consume the real site-wide capacity limit in subsequent tests.
  for (const item of unfinished) {
    const cleanup = await playwright.request.newContext({ baseURL: "http://127.0.0.1:3100", extraHTTPHeaders: { ...origin, "x-forwarded-for": "192.0.2.91" } });
    try {
      expect((await cleanup.post("/api/auth/sign-in/email", { data: { email: item.email, password: "Browser-test-123!" } })).ok()).toBe(true);
      expect((await cleanup.delete(`/api/sessions/${item.id}`)).ok()).toBe(true);
    } finally { await cleanup.dispose(); }
  }
});
async function login(page: Page, email = "privacy-idea@example.test") {
  await page.goto("/login"); await page.getByLabel("邮箱", { exact: true }).fill(email); await page.getByLabel("密码", { exact: true }).fill("Browser-test-123!");
  await page.getByRole("button", { name: "登录", exact: true }).click(); await expect(page).not.toHaveURL(/login(?:\?.*)?$/);
}
async function thought(page: Page) {
  const response = await page.request.post("/api/thoughts", { headers: origin, data: { sourceText: "Students should learn through practical experience.", requestId: crypto.randomUUID() } }); expect(response.ok()).toBe(true); return response.json();
}
const savedDraft = (page: Page) => page.getByText("草稿已在本机暂存 · 保留 24 小时", { exact: true });
async function privateCounts(page: Page) {
  return page.evaluate(async () => new Promise<number[]>((resolve, reject) => {
    const request = indexedDB.open("ielts-recordings", 2); request.onerror = () => reject(request.error);
    request.onsuccess = () => { const db = request.result, names = ["recordings", "chunks", "thoughtDrafts"], tx = db.transaction(names), result: number[] = [];
      names.forEach((name, index) => { const get = tx.objectStore(name).count(); get.onsuccess = () => { result[index] = get.result; }; });
      tx.oncomplete = () => { db.close(); resolve(result); }; tx.onerror = () => reject(tx.error);
    };
  }));
}

test("browser back, forward and refresh recover an original idea; successful generation removes its drafts", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await login(page); await page.goto("/vocabulary"); await page.getByRole("link", { name: "自由练习", exact: true }).click();
  const text = "I believe students should have more practical opportunities.";
  await page.getByLabel("原始观点（中文或英文）").fill(text); await expect(savedDraft(page)).toBeVisible();
  await page.screenshot({ path: "data/verification/round3-local-drafts-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 320, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "data/verification/round3-local-drafts-mobile.png", fullPage: true }); await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goBack(); await expect(page).toHaveURL(/vocabulary$/); await page.goForward();
  await expect(page.getByLabel("原始观点（中文或英文）")).toBeEmpty();
  await page.getByRole("button", { name: "恢复草稿", exact: true }).first().click(); await expect(page.getByLabel("原始观点（中文或英文）")).toHaveValue(text);
  await expect(savedDraft(page)).toBeVisible(); page.once("dialog", dialog => dialog.accept()); await page.reload();
  await page.getByRole("button", { name: "恢复草稿", exact: true }).first().click(); await expect(page.getByLabel("原始观点（中文或英文）")).toHaveValue(text);
  await page.getByRole("button", { name: "生成三种表达", exact: true }).click(); await expect(page.getByText("三种表达已生成，并自动保存到观点历史。")).toBeVisible();
  await expect(page.getByRole("button", { name: "恢复草稿", exact: true })).toHaveCount(0);
  expect((await (await page.request.get("/api/thoughts")).json()).items.some((item: { sourceText: string }) => item.sourceText === text)).toBe(true);
  expect(errors).toEqual([]);
});

test("restored edits cannot silently overwrite a newer saved version", async ({ page }) => {
  await login(page, "privacy-conflict@example.test"); const t = await thought(page); await page.goto(`/thoughts?thought=${t.id}`);
  const local = `${t.natural} This is my unsaved local detail.`, remote = `${t.natural} This was saved in another tab.`;
  await page.locator("#thought-natural").fill(local); await expect(savedDraft(page)).toBeVisible();
  expect((await page.request.put(`/api/thoughts/${t.id}`, { headers: origin, data: { revision: 0, sourceText: t.sourceText, title: t.title, simple: t.simple, natural: remote, nuanced: t.nuanced } })).ok()).toBe(true);
  page.once("dialog", dialog => dialog.accept()); await page.reload(); await expect(page.locator("#thought-natural")).toHaveValue(remote);
  await page.getByRole("button", { name: "恢复草稿", exact: true }).first().click(); await expect(page.locator("#thought-natural")).toHaveValue(local);
  await expect(page.getByRole("button", { name: "保存修改", exact: true })).toBeDisabled(); await expect(page.getByText(/已保存版本有更新/)).toBeVisible();
  expect((await (await page.request.get(`/api/thoughts/${t.id}`)).json()).natural).toBe(remote);
  page.once("dialog", dialog => dialog.accept()); await page.getByRole("button", { name: "我已核对，使用草稿继续编辑", exact: true }).click();
  await page.getByRole("button", { name: "保存修改", exact: true }).click(); await expect(page.getByText(/修改已保存/)).toBeVisible();
  expect((await (await page.request.get(`/api/thoughts/${t.id}`)).json()).natural).toBe(local);
});

test("recall draft restores text without an audio blob or invented recording duration", async ({ page }) => {
  await login(page, "privacy-recall@example.test"); const t = await thought(page); await page.goto(`/thoughts?thought=${t.id}`);
  await page.getByRole("button", { name: "隐藏 Natural，开始练习", exact: true }).click();
  const recalled = "Practical activities let students apply knowledge.";
  await page.getByLabel("我的尝试表达（可选，也可直接写下来练习）").fill(recalled); await expect(savedDraft(page)).toBeVisible();
  page.once("dialog", dialog => dialog.accept()); await page.reload(); await page.getByRole("button", { name: "恢复草稿", exact: true }).first().click();
  await expect(page.getByLabel("我的尝试表达（可选，也可直接写下来练习）")).toHaveValue(recalled); await expect(page.getByLabel("本次观点练习录音")).toHaveCount(0);
  await page.getByRole("button", { name: "保存本次练习", exact: true }).click(); await expect(page.getByText(/练习已保存/)).toBeVisible();
  const saved = await (await page.request.get(`/api/thoughts/${t.id}`)).json(); expect(saved.practices[0].durationSeconds).toBe(0); expect(saved.practices[0].recalledText).toBe(recalled);
  await expect(page.getByRole("button", { name: "恢复草稿", exact: true })).toHaveCount(0);
});

test("logout cancels an in-flight upload across tabs, clears private stores and cannot recreate them", async ({ page, context }) => {
  await login(page, "privacy-upload@example.test"); const ownerId = (await (await page.request.get("/api/me")).json()).user.id;
  await page.goto("/thoughts"); await page.getByLabel("原始观点（中文或英文）").fill("This private idea must disappear on logout."); await expect(savedDraft(page)).toBeVisible();
  const created = await page.request.post("/api/sessions", { data: { mode: "practice", questionId: "P1-HOME-1", fresh: true } }); expect(created.ok()).toBe(true); const practice = await created.json();
  unfinished.push({ id: practice.id, email: "privacy-upload@example.test" });
  await page.evaluate(async ({ userId, sessionId }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("ielts-recordings", 2); request.onerror = () => reject(request.error);
    request.onsuccess = () => { const db = request.result, tx = db.transaction(["recordings", "chunks", "privateSession"], "readwrite"), scope = tx.objectStore("privateSession").get("current");
      scope.onsuccess = () => { tx.objectStore("recordings").put({ id: "logout-flight-fixture", userId, localEpoch: scope.result.epoch, sessionId, promptText: "synthetic pending privacy check", status: "failed", createdAt: Date.now(), durationMs: 500, mimeType: "audio/wav", planIndex: 0, kind: "main", followUpId: null, interrupted: false }); tx.objectStore("chunks").put({ recId: "logout-flight-fixture", seq: 0, blob: new Blob(["synthetic-only"], { type: "audio/wav" }) }); };
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
    };
  }), { userId: ownerId, sessionId: practice.id });
  const second = await context.newPage(); let release!: () => void, started = false, submits = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await second.route("**/api/answers/*/audio?*", async route => { started = true; await gate; await route.fulfill({ status: 200, body: "{}" }).catch(() => {}); });
  second.on("request", request => { if (request.url().endsWith("/submit")) submits++; });
  await second.goto("/"); await second.getByRole("button", { name: "重试上传", exact: true }).click(); await expect.poll(() => started).toBe(true);
  page.once("dialog", dialog => dialog.accept()); await page.goto("/settings"); page.once("dialog", dialog => dialog.accept()); await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page).toHaveURL(/login(?:\?.*)?$/); await expect(second).toHaveURL(/login(?:\?.*)?$/); expect((await page.request.get("/api/me")).status()).toBe(401);
  release(); await expect.poll(() => privateCounts(page)).toEqual([0, 0, 0]); expect(submits).toBe(0);
  await login(page, "outsider@example.test"); await page.goto("/thoughts"); await expect(page.getByRole("button", { name: "恢复草稿", exact: true })).toHaveCount(0);
  expect((await (await page.request.get("/api/me")).json()).user.id).not.toBe(ownerId); expect(await privateCounts(page)).toEqual([0, 0, 0]);
});

test("storage denial permits practice with an honest memory-only draft warning", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "indexedDB", { configurable: true, value: { open() { throw new DOMException("test storage denial", "SecurityError"); } } }); });
  await login(page, "privacy-denial@example.test"); await page.goto("/thoughts"); await page.getByLabel("原始观点（中文或英文）").fill("An idea in a restricted browser.");
  await expect(page.getByText("本机存储受限，草稿仅在当前页面内存中，刷新或关闭可能丢失。", { exact: true })).toBeVisible();
  await expect(savedDraft(page)).toHaveCount(0);
  await page.getByRole("button", { name: "生成三种表达", exact: true }).click(); await expect(page.getByText("三种表达已生成，并自动保存到观点历史。")).toBeVisible();
});

test("logout in another tab stops a real microphone recording without resurrecting chunks", async ({ page, context }) => {
  let stoppedBeforeNavigation = false, watching = false, committed = false;
  page.on("framenavigated", frame => { if (watching && frame === page.mainFrame() && /\/login(?:\?|$)/.test(frame.url())) committed = true; });
  await page.exposeFunction("reportPrivacyStopped", () => { if (watching && !committed) stoppedBeforeNavigation = true; });
  await page.addInitScript(() => {
    const observed = window as typeof window & { privacyTracks: MediaStreamTrack[]; reportPrivacyStopped: () => Promise<void> }; observed.privacyTracks = [];
    const getMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => { const stream = await getMedia(constraints); observed.privacyTracks.push(...stream.getTracks()); return stream; };
    const originalStop = MediaStreamTrack.prototype.stop;
    MediaStreamTrack.prototype.stop = function() { originalStop.call(this); if (observed.privacyTracks.length && observed.privacyTracks.every(track => track.readyState === "ended")) void observed.reportPrivacyStopped().catch(() => {}); };
  });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message)); await login(page, "privacy-recorder@example.test");
  const created = await page.request.post("/api/sessions", { data: { mode: "practice", questionId: "P2-PERSON-1", fresh: true } }); expect(created.ok()).toBe(true);
  const { id } = await created.json(); unfinished.push({ id, email: "privacy-recorder@example.test" }); await page.goto(`/interview/${id}`); await page.getByRole("button", { name: "开始面试", exact: true }).click();
  await page.getByRole("button", { name: "开始回答", exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.recording), { timeout: 30000 }).toBe("true");
  watching = true; let release!: () => void, releaseCheck!: () => void, checkStarted = false;
  const gate = new Promise<void>(resolve => { release = resolve; }), checkGate = new Promise<void>(resolve => { releaseCheck = resolve; });
  // Hold the login document: verify tracks stop before navigating destroys the old document.
  await page.route("**/login*", async route => { await gate; await route.continue().catch(() => {}); });
  await page.route("**/api/me", async route => { checkStarted = true; await checkGate; await route.continue().catch(() => {}); });
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await expect.poll(() => checkStarted).toBe(true);
  const other = await context.newPage(); await other.goto("/settings"); other.once("dialog", dialog => dialog.accept());
  try {
    await other.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect.poll(() => stoppedBeforeNavigation, { timeout: 5000 }).toBe(true);
  } finally { release(); releaseCheck(); }
  await expect(other).toHaveURL(/login(?:\?.*)?$/); await expect(page).toHaveURL(/login(?:\?.*)?$/); expect((await other.request.get("/api/me")).status()).toBe(401);
  await expect.poll(() => privateCounts(other)).toEqual([0, 0, 0]); expect(await page.evaluate(() => document.documentElement.dataset.recording)).toBeUndefined();
  expect(errors).toEqual([]);
});

test("a draft write that hits browser quota never reports itself as durable", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => { const original = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function(value, key) { if (this.name === "thoughtDrafts") throw new DOMException("test quota", "QuotaExceededError"); return original.call(this, value, key); }; });
  await login(page, "privacy-quota@example.test"); await page.goto("/thoughts"); await page.getByLabel("原始观点（中文或英文）").fill("This text cannot fit into persistent storage.");
  await expect(page.getByText("本机存储受限，草稿仅在当前页面内存中，刷新或关闭可能丢失。", { exact: true })).toBeVisible();
  await expect(savedDraft(page)).toHaveCount(0); expect((await privateCounts(page))[2]).toBe(0); expect(errors).toEqual([]);
});

test("deleting a thought clears its local drafts and closes the stale editor in another tab", async ({ page, context }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await login(page, "privacy-delete@example.test"); const t = await thought(page); await page.goto(`/thoughts?thought=${t.id}`);
  await page.locator("#thought-natural").fill(`${t.natural} An unsaved private detail.`); await expect(savedDraft(page)).toBeVisible();
  const other = await context.newPage(); await other.goto(`/thoughts?thought=${t.id}`); other.once("dialog", dialog => dialog.accept());
  await other.getByRole("button", { name: "删除观点", exact: true }).click(); await expect(other.getByText("观点及其本机草稿已删除。", { exact: true })).toBeVisible();
  await expect(page.getByText("这份观点已在其他页面删除，相关本机草稿已清除。", { exact: true })).toBeVisible();
  await expect(page.locator("#thought-natural")).toHaveCount(0); await expect.poll(async () => (await privateCounts(page))[2]).toBe(0);
  expect((await page.request.get(`/api/thoughts/${t.id}`)).status()).toBe(404); expect(errors).toEqual([]);
});
