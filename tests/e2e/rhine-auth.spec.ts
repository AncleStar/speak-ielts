import {test,expect,type Page} from "@playwright/test";
async function capture(page:Page,name:string){
  const style=await page.addStyleTag({content:'[data-testid="mock-banner"],[data-testid="timescale-banner"]{display:none!important}'});
  await page.waitForTimeout(100);await page.screenshot({path:`data/verification/rhine-${name}.png`});
  await style.evaluate(el=>(el as HTMLElement).remove());
}
// Isolate this intentional failed-login sequence from other tests' login quota.
// Keep the application's production rate limit enabled.
test.use({viewport:{width:1600,height:900},video:{mode:"on",size:{width:1280,height:720}},extraHTTPHeaders:{"x-forwarded-for":"192.0.2.43"}});
test("terminal login only authorizes after real credentials and keeps narrow layouts usable",async({page})=>{
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto("/login");
  await page.waitForTimeout(700);
  await capture(page,"login");
  await page.getByLabel("邮箱",{exact:true}).fill("learner@example.test");
  await page.getByLabel("密码",{exact:true}).fill("wrong-password");
  await page.getByRole("button",{name:"登录",exact:true}).click();
  await expect(page.getByText("邮箱或密码不正确",{exact:true})).toBeVisible();
  await expect(page.locator('.terminal-scan')).toHaveAttribute("data-authorized","false");
  for(const width of [320,390,768]){await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await expect(page.getByRole("button",{name:"登录",exact:true})).toBeInViewport();}
  await page.setViewportSize({width:390,height:844});await capture(page,"login-mobile");
  await page.setViewportSize({width:1600,height:900});await page.getByLabel("密码",{exact:true}).fill("Browser-test-123!");
  await page.getByRole("button",{name:"登录",exact:true}).click();
  await expect(page.locator('.terminal-scan')).toHaveAttribute("data-authorized","true");
  await page.waitForTimeout(1500);await capture(page,"authorized");
  await page.getByRole("button",{name:"跳过动画，进入系统"}).click();
  await expect(page).toHaveURL(/\/practice(?:\?|$)/);
  await expect(page.getByTestId("disc-scene")).toHaveAttribute("data-renderer","ready",{timeout:30000});
  await page.getByRole("button",{name:"上一张磁盘",exact:true}).click();await expect(page.getByTestId("q-P1-HOME-5")).toBeVisible();
  await page.getByRole("button",{name:"下一张磁盘",exact:true}).click();await expect(page.getByTestId("q-P1-HOME-1")).toBeVisible();
  await page.route("**/api/sessions",route=>route.fulfill({status:403,contentType:"application/json",body:JSON.stringify({error:{code:"quota_exceeded",message:"今日练习额度已用完"}})}));
  await page.getByTestId("practice-P1-HOME-1").click();await expect(page.getByText("今日练习额度已用完",{exact:true})).toBeVisible();
  await expect(page).toHaveURL(/\/practice(?:\?|$)/);await expect(page.getByRole("button",{name:"下一张磁盘",exact:true})).toBeEnabled();
  expect(errors).toEqual([]);
});
