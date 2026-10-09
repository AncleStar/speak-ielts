import { test, expect, type Page } from "@playwright/test";
test.use({ extraHTTPHeaders: { "x-forwarded-for": "192.0.2.80" }, reducedMotion: "reduce" });
const origin = { Origin: "http://127.0.0.1:3100" };
async function login(page: Page, email = "learner@example.test") {
  await page.goto("/login"); await page.getByLabel("邮箱", { exact: true }).fill(email); await page.getByLabel("密码", { exact: true }).fill("Browser-test-123!");
  await page.getByRole("button", { name: "登录", exact: true }).click(); await expect(page).not.toHaveURL(/\/login$/);
}

test("opinion generation, editing, hidden speaking practice, vocabulary and spaced review form a complete loop", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await login(page); await page.getByRole("link", { name: "自由练习", exact: true }).click();
  await expect(page.getByRole("heading", { name: /个人观点实验室/ })).toBeVisible();
  await page.getByLabel("原始观点（中文或英文）").fill("我认为大学生应该多参加社会实践，因为这能帮助他们把课堂知识用到真实生活中。");
  await page.getByRole("button", { name: "生成三种表达", exact: true }).click();
  await expect(page.getByText("三种表达已生成，并自动保存到观点历史。")).toBeVisible();
  await expect(page.getByLabel("Simple", { exact: false })).not.toBeEmpty();
  const banner = await page.addStyleTag({ content: '[data-testid="timescale-banner"]{display:none!important}' });
  await page.screenshot({ path: "data/verification/thought-lab-desktop.png", fullPage: true }); await banner.evaluate(el => el.parentNode?.removeChild(el));
  const natural = page.locator("#thought-natural"), original = await natural.inputValue();
  await natural.fill(original + " This could also help students make more informed choices.");
  await expect(page.getByRole("button", { name: "隐藏 Natural，开始练习", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "保存修改", exact: true }).click(); await expect(page.getByText(/修改已保存。Natural/)).toBeVisible();
  const thoughtId = new URL(page.url()).searchParams.get("thought")!;
  await page.reload(); await expect(natural).toHaveValue(original + " This could also help students make more informed choices.");
  await page.locator(".thought-vocabulary input[type=checkbox]").first().check(); await page.getByRole("button", { name: "收藏选中的 1 个词语", exact: true }).click(); await expect(page.getByText("已收藏 1 个词语。")).toBeVisible();
  await page.getByRole("button", { name: "将 Natural 加入复习", exact: true }).click(); await expect(page.getByText(/Natural 已加入今日复习/)).toBeVisible();
  await page.getByRole("button", { name: "隐藏 Natural，开始练习", exact: true }).click();
  await expect(page.getByText("Natural 已隐藏", { exact: true })).toBeVisible(); expect(await page.locator(".thought-natural-answer").count()).toBe(0);
  await page.getByRole("button", { name: "开始录音", exact: true }).click(); await expect(page.getByRole("button", { name: "结束录音", exact: true })).toBeVisible();
  await expect.poll(async () => await page.getByRole("timer").textContent()).not.toContain("00:00");
  await page.getByRole("button", { name: "结束录音", exact: true }).click(); await expect(page.getByLabel("本次观点练习录音")).toHaveAttribute("src", /^blob:/);
  expect(await page.evaluate(() => document.documentElement.dataset.recording)).toBeUndefined();
  await page.getByLabel("我的尝试表达（可选，也可直接写下来练习）").fill("I think students should volunteer because they can gain practical experience.");
  await page.getByRole("button", { name: "显示 Natural，进行对照", exact: true }).click(); await expect(page.locator(".thought-natural-answer")).toContainText("more informed choices");
  await page.getByRole("button", { name: "已想起来 · 安排下次复习", exact: true }).click(); await expect(page.getByText(/练习已保存，可在本页/)).toBeVisible();
  const result = await (await page.request.get(`/api/thoughts/${thoughtId}`)).json(); expect(result.review.completedCount).toBe(1); expect(result.practices[0].durationSeconds).toBeGreaterThanOrEqual(1);
  await page.goto("/review"); await page.getByText(/接下来的个人表达/).click(); await expect(page.getByRole("link", { name: /大学生与社会实践/ })).toBeVisible();
  await page.goto("/vocabulary"); await expect(page.getByText("practical experience", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("API requires login and same origin; another account cannot open or alter personal material", async ({ page, browser }) => {
  await login(page); const created = await page.request.post("/api/thoughts", { headers: origin, data: { sourceText: "I think learning new skills is helpful.", requestId: crypto.randomUUID() } });
  expect(created.status()).toBe(200); const t = await created.json();
  expect((await page.request.post("/api/thoughts", { headers: { Origin: "https://untrusted.example.test" }, data: { sourceText: "Opinion", requestId: crypto.randomUUID() } })).status()).toBe(403);
  expect((await page.request.post(`/api/thoughts/${t.id}/review`, { headers: { Origin: "https://untrusted.example.test" }, data: { action: "enroll", revision: 0 } })).status()).toBe(403);
  const guest = await browser.newContext(); expect((await guest.request.get("http://127.0.0.1:3100/api/thoughts")).status()).toBe(401); expect((await guest.request.get("http://127.0.0.1:3100/api/vocabulary")).status()).toBe(401); await guest.close();
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:3100", reducedMotion: "reduce", extraHTTPHeaders: { "x-forwarded-for": "192.0.2.81" } });
  const other = await context.newPage(); await login(other, "outsider@example.test");
  expect((await context.request.get(`http://127.0.0.1:3100/api/thoughts/${t.id}`)).status()).toBe(404);
  expect((await context.request.delete(`http://127.0.0.1:3100/api/thoughts/${t.id}`, { headers: origin })).status()).toBe(404);
  expect((await context.request.post("http://127.0.0.1:3100/api/vocabulary", { headers: origin, data: { thoughtId: t.id, revision: 0, indices: [0] } })).status()).toBe(404);
  await context.close(); expect((await page.request.get(`/api/thoughts/${t.id}`)).status()).toBe(200);
});

test("mobile history, vocabulary editing and deletion fit the terminal and preserve collected words", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page);
  const created = await page.request.post("/api/thoughts", { headers: origin, data: { sourceText: "我认为大学生应该多参加社会实践", requestId: crypto.randomUUID() } }); const t = await created.json();
  await page.goto(`/thoughts?thought=${t.id}`); await expect(page.locator("#thought-natural")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const navPositions = await page.getByRole("navigation", { name: "底部导航", exact: true }).locator("li").evaluateAll(items => items.map(item => item.getBoundingClientRect().top));
  expect(new Set(navPositions).size).toBe(1);
  const banner = await page.addStyleTag({ content: '[data-testid="timescale-banner"]{display:none!important}' });
  await page.screenshot({ path: "data/verification/thought-lab-mobile.png", fullPage: true }); await banner.evaluate(el => el.parentNode?.removeChild(el));
  await page.locator(".thought-vocabulary input[type=checkbox]").first().check(); await page.getByRole("button", { name: "收藏选中的 1 个词语", exact: true }).click();
  await page.goto("/vocabulary"); await page.getByRole("button", { name: "编辑 practical experience", exact: true }).click();
  await page.getByLabel("中文释义", { exact: true }).fill("我想积累的实践经验"); await page.getByRole("button", { name: "保存词语修改", exact: true }).click(); await expect(page.getByText("词语修改已保存。")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto(`/thoughts?thought=${t.id}`); page.once("dialog", dialog => dialog.accept()); await page.getByRole("button", { name: "删除观点", exact: true }).click(); await expect(page.getByText("观点及其本机草稿已删除。")).toBeVisible();
  expect((await page.request.get(`/api/thoughts/${t.id}`)).status()).toBe(404);
  await page.goto("/vocabulary"); await expect(page.getByText("我想积累的实践经验", { exact: true })).toBeVisible();
});

test("unsaved edits and recall attempts warn before navigation, and saved practice reaches the growth calendar", async ({ page }) => {
  await login(page);
  const created = await page.request.post("/api/thoughts", { headers: origin, data: { sourceText: "I believe students should gain experience.", requestId: crypto.randomUUID() } });
  expect(created.status()).toBe(200); const t = await created.json();
  t.title = "导航保护与成长记录回归";
  expect((await page.request.put(`/api/thoughts/${t.id}`, { headers: origin, data: { revision: t.revision, title: t.title, sourceText: t.sourceText, simple: t.simple, natural: t.natural, nuanced: t.nuanced } })).status()).toBe(200);
  await page.goto(`/thoughts?thought=${t.id}`);
  const natural = page.locator("#thought-natural"), edited = t.natural + " This is my own addition.";
  await natural.fill(edited);
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("link", { name: /02 \/ 个人词汇库/ }).click();
  await expect(natural).toHaveValue(edited); await expect(page).toHaveURL(/\/thoughts\?/);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("link", { name: /02 \/ 个人词汇库/ }).click(); await expect(page).toHaveURL(/\/vocabulary$/);
  await page.goto(`/thoughts?thought=${t.id}`); await expect(natural).toHaveValue(t.natural);
  await page.getByRole("button", { name: "隐藏 Natural，开始练习", exact: true }).click();
  await page.getByLabel("我的尝试表达（可选，也可直接写下来练习）").fill("Students should put their knowledge into practice.");
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "返回编辑", exact: true }).click(); await expect(page.getByText("Natural 已隐藏", { exact: true })).toBeVisible();
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("link", { name: /03 \/ 今日复习/ }).click(); await expect(page).toHaveURL(/\/thoughts\?/);
  await page.getByRole("button", { name: "保存本次练习", exact: true }).click(); await expect(page.getByText(/练习已保存，可在本页/)).toBeVisible();
  await page.goto("/growth");
  await expect(page.getByRole("link", { name: t.title, exact: true })).toBeVisible();
  await expect(page.getByText(/观点练习 · 文本练习/)).toBeVisible();
  await page.getByRole("link", { name: t.title, exact: true }).click(); await expect(natural).toHaveValue(t.natural);
});
