import { test, expect, type Page } from "@playwright/test";
test.use({ reducedMotion: "reduce", extraHTTPHeaders: { "x-forwarded-for": "192.0.2.92" } });
const origin = { Origin: "http://127.0.0.1:3100" };
async function signIn(page: Page, email: string) {
  expect((await page.request.post("/api/auth/sign-in/email", { data: { email, password: "Browser-test-123!" }, headers: origin })).ok()).toBe(true);
}
async function localState(page: Page) {
  return page.evaluate(() => new Promise<{ userId: string; epoch: string; drafts: { userId: string; fields: { sourceText: string } }[] }>((resolve, reject) => {
    const request = indexedDB.open("ielts-recordings", 2); request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction(["privateSession", "thoughtDrafts"]);
      const scope = tx.objectStore("privateSession").get("current"), drafts = tx.objectStore("thoughtDrafts").getAll();
      tx.oncomplete = () => { db.close(); resolve({ userId: scope.result.userId, epoch: scope.result.epoch, drafts: drafts.result }); };
      tx.onerror = () => reject(tx.error);
    };
  }));
}
for (const silent of [false, true]) {
  test(`a stale initial identity response preserves the new account's draft${silent ? " without local notifications" : " with local notifications"}`, async ({ page, context }) => {
    const prefix = silent ? "identity-silent" : "identity";
    await signIn(page, `${prefix}-alice@example.test`); await page.goto("/thoughts");
    await expect(page.getByLabel("原始观点（中文或英文）")).toBeVisible();
    const alice = (await (await page.request.get("/api/me")).json()).user.id;
    const old = await context.newPage(); const errors: string[] = []; old.on("pageerror", e => errors.push(e.message));
    let privateRendered = false;
    await old.exposeFunction("reportOldPrivateRendered", () => { privateRendered = true; });
    await old.addInitScript(() => {
      const observed = window as typeof window & { reportOldPrivateRendered: () => Promise<void> };
      new MutationObserver(() => { if (document.querySelector("#thought-source")) void observed.reportOldPrivateRendered().catch(() => {}); }).observe(document, { subtree: true, childList: true });
    });
    if (silent) await old.addInitScript(() => {
      Object.defineProperty(window, "BroadcastChannel", { configurable: true, value: class { constructor() { throw new Error("Synthetic unavailable notifications"); } } });
      // Keep IndexedDB working; suppress only notification/focus fallbacks in this old document.
      const addWindow = window.addEventListener.bind(window), addDocument = document.addEventListener.bind(document);
      window.addEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => { if (!["storage", "focus"].includes(type)) addWindow(type, listener, options); };
      document.addEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => { if (type !== "visibilitychange") addDocument(type, listener, options); };
    });
    let captured: string | null = null, count = 0, loginRequested = false;
    let releaseFirst!: () => void, releaseOthers!: () => void, releaseLogin!: () => void;
    const first = new Promise<void>(r => { releaseFirst = r; }), others = new Promise<void>(r => { releaseOthers = r; }), login = new Promise<void>(r => { releaseLogin = r; });
    await old.route("**/api/me", async route => {
      const index = count++, response = await route.fetch(); if (!index) captured = (await response.json()).user.id;
      await (index === 0 ? first : others); await route.fulfill({ response }).catch(() => {});
    });
    // Observe the old document before its replacement, so navigation destruction cannot hide a stale activation.
    await old.route("**/login*", async route => { loginRequested = true; await login; await route.continue().catch(() => {}); });
    try {
      await old.goto("/thoughts"); await expect.poll(() => captured).toBe(alice);
      expect((await page.request.post("/api/auth/sign-out", { data: {}, headers: origin })).ok()).toBe(true);
      await signIn(page, `${prefix}-bob@example.test`); await page.goto("/thoughts");
      await expect(page.getByLabel("原始观点（中文或英文）")).toBeVisible();
      const bob = (await (await page.request.get("/api/me")).json()).user.id; expect(bob).not.toBe(alice);
      const text = "This new account's private draft must survive the delayed response.";
      await page.getByLabel("原始观点（中文或英文）").fill(text);
      await expect(page.getByText("草稿已在本机暂存 · 保留 24 小时", { exact: true })).toBeVisible();
      const before = await localState(page); expect(before.userId).toBe(bob); expect(before.drafts).toHaveLength(1);
      if (silent) expect(loginRequested).toBe(false);
      else await expect.poll(() => loginRequested, { timeout: 5000 }).toBe(true);
      releaseFirst(); await expect.poll(() => loginRequested, { timeout: 5000 }).toBe(true);
      expect(await localState(page)).toEqual(before);
      expect(before.drafts[0]).toMatchObject({ userId: bob, fields: { sourceText: text } });
      // Observe from Node; browser operations wait for the deliberately held navigation.
      expect(privateRendered).toBe(false);
      expect((await (await page.request.get("/api/me")).json()).user.id).toBe(bob);
      expect(errors).toEqual([]);
    } finally { releaseFirst(); releaseOthers(); releaseLogin(); await old.close(); }
  });
}

test("two first-use tabs for the same account initialize without replacing each other's local scope", async ({ page, context }) => {
  await signIn(page, "identity-parallel@example.test");
  const second = await context.newPage(); let captured = 0, release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  for (const tab of [page, second]) {
    let first = true;
    await tab.route("**/api/me", async route => {
      const response = await route.fetch(); if (first) { first = false; captured++; await gate; }
      await route.fulfill({ response }).catch(() => {});
    });
  }
  try {
    await Promise.all([page.goto("/thoughts"), second.goto("/thoughts")]); await expect.poll(() => captured).toBe(2);
    release();
    for (const tab of [page, second]) await expect(tab.getByLabel("原始观点（中文或英文）")).toBeVisible();
    const first = await localState(page); expect(await localState(second)).toEqual(first);
    await page.getByLabel("原始观点（中文或英文）").fill("One durable draft shared by this account's tabs.");
    await expect(page.getByText("草稿已在本机暂存 · 保留 24 小时", { exact: true })).toBeVisible();
    await expect.poll(async () => (await localState(second)).drafts.length).toBe(1);
    await expect(second.getByLabel("原始观点（中文或英文）")).toBeVisible();
  } finally { release(); await second.close(); }
});
