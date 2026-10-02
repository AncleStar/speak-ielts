import {test,expect,type Page} from "@playwright/test";
test.use({extraHTTPHeaders:{"x-forwarded-for":"192.0.2.45"}});
async function login(page:Page,email="outsider@example.test"){
  await page.goto("/login");await page.getByLabel("邮箱",{exact:true}).fill(email);await page.getByLabel("密码",{exact:true}).fill("Browser-test-123!");await page.getByRole("button",{name:"登录",exact:true}).click();await expect(page).not.toHaveURL(/\/login$/);
}
test("personal API settings stay private, save models, delete without fallback, and fit mobile",async({page,browser})=>{
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await login(page);await page.goto("/settings");await page.getByRole("link",{name:/API Key、模型与用量/}).click();await expect(page.getByRole("heading",{name:"API 与用量",exact:true})).toBeVisible();
  expect((await page.request.put("/api/ai-settings",{headers:{Origin:"https://untrusted.example.test"},data:{}})).status()).toBe(403);
  expect((await page.request.post("/api/ai-settings/test",{headers:{Origin:"https://untrusted.example.test"}})).status()).toBe(403);
  await page.getByLabel("服务模式",{exact:true}).selectOption("personal");
  const key="test_key_browser_personal_only";
  await page.getByLabel("百炼 API Key",{exact:true}).fill(key);await page.getByLabel("反馈与追问模型",{exact:true}).selectOption("qwen-flash");await page.getByLabel("个人月度预算（元）",{exact:true}).fill("5");
  await page.getByRole("checkbox",{name:/我同意将录音与回答/}).check();await page.getByRole("button",{name:"保存设置",exact:true}).click();
  await expect(page.getByText("设置已保存，将用于后续模型调用。正在执行的请求仍使用原配置。")).toBeVisible();await expect(page.getByLabel("百炼 API Key",{exact:true})).toHaveValue("");
  const account=await(await page.request.get("/api/ai-settings")).json();expect(account.config).toMatchObject({hasKey:true,mode:"personal",llmModel:"qwen-flash",monthlyBudgetYuan:5});
  expect(JSON.stringify(account)).not.toContain(key);expect(JSON.stringify(account)).not.toContain("keyCiphertext");
  expect(await page.evaluate(()=>JSON.stringify(localStorage)+JSON.stringify(sessionStorage))).not.toContain(key);
  await page.reload();await expect(page.getByLabel("百炼 API Key",{exact:true})).toHaveValue("");
  await page.screenshot({path:"data/verification/personal-ai-desktop.png",fullPage:true});
  const guest=await browser.newContext();expect((await guest.request.get("http://127.0.0.1:3100/api/ai-settings")).status()).toBe(401);await guest.close();
  const other=await browser.newContext({extraHTTPHeaders:{"x-forwarded-for":"192.0.2.46"}});const otherPage=await other.newPage();await otherPage.goto("http://127.0.0.1:3100/login");
  await otherPage.getByLabel("邮箱",{exact:true}).fill("learner@example.test");await otherPage.getByLabel("密码",{exact:true}).fill("Browser-test-123!");await otherPage.getByRole("button",{name:"登录",exact:true}).click();await expect(otherPage).not.toHaveURL(/\/login$/);
  expect((await(await other.request.get("http://127.0.0.1:3100/api/ai-settings")).json()).config.hasKey).toBe(false);await other.close();
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:"data/verification/personal-ai-mobile.png",fullPage:true});
  await page.getByRole("button",{name:"删除密钥",exact:true}).click();await expect(page.getByText("个人服务等待密钥",{exact:true})).toBeVisible();
  const deleted=await(await page.request.get("/api/ai-settings")).json();expect(deleted.config).toMatchObject({mode:"personal",hasKey:false,maskedKey:null});
  await page.getByLabel("服务模式",{exact:true}).selectOption("platform");await page.getByRole("button",{name:"保存设置",exact:true}).click();await expect(page.getByText("设置已保存，将用于后续模型调用。正在执行的请求仍使用原配置。")).toBeVisible();
  expect(errors).toEqual([]);
});
