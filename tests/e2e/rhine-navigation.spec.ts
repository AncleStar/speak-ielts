import {test,expect} from "@playwright/test";

test("cold entry has no old poster and returning restores the selected disc and filters",async({page})=>{
  test.setTimeout(120000);
  await page.setViewportSize({width:1600,height:900});
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto("/login");await page.getByLabel("邮箱",{exact:true}).fill("learner@example.test");await page.getByLabel("密码",{exact:true}).fill("Browser-test-123!");await page.getByRole("button",{name:"登录",exact:true}).click();await expect(page).not.toHaveURL(/\/login$/);
  const markup=await (await page.request.get("/practice?disc=P1-HOME-3")).text();
  expect(markup).toContain('class="rhine-root" data-rhine="library"');expect(markup).not.toContain('src="/models/speak-disc/v1/poster.webp"');
  await page.route("**/archive-cassette.glb",async route=>{await new Promise(resolve=>setTimeout(resolve,1600));await route.continue();});
  await page.goto("/practice?disc=P1-HOME-3&topic=HOME&q=HOME");
  await expect(page.locator(".rhine-root")).toHaveAttribute("data-rhine","library");
  await expect(page.locator(".rhine-world-loading")).toBeVisible();
  await expect(page.locator(".rhine-world-fallback img")).toHaveCount(0);
  expect(await page.locator(".terminal-header").evaluate(el=>getComputedStyle(el).position)).toBe("absolute");
  await page.screenshot({path:"data/verification/rhine-cold-entry.png"});
  await expect(page.getByTestId("disc-scene")).toHaveAttribute("data-renderer","ready",{timeout:30000});await page.unroute("**/archive-cassette.glb");
  await expect(page.getByTestId("q-P1-HOME-3")).toBeVisible();
  for(const label of ["积分兑换","学习记录","成长日历"])await expect(page.getByRole("navigation",{name:"学习服务"}).getByRole("link",{name:label,exact:false})).toBeVisible();
  await page.getByTestId("practice-P1-HOME-3").click();await expect(page).toHaveURL(/\/interview\//);
  await page.getByRole("button",{name:"退出面试",exact:true}).click();
  await expect(page.getByTestId("q-P1-HOME-3")).toBeVisible();expect(new URL(page.url()).searchParams.get("q")).toBe("HOME");
  await page.getByTestId("practice-P1-HOME-3").click();await expect(page).toHaveURL(/\/interview\//);await page.goBack();await expect(page.getByTestId("q-P1-HOME-3")).toBeVisible();
  await page.reload();await expect(page.getByTestId("q-P1-HOME-3")).toBeVisible();
  await page.goto("/history");await page.addStyleTag({content:'[data-testid="mock-banner"],[data-testid="timescale-banner"]{display:none!important}'});await page.screenshot({path:"data/verification/rhine-history.png"});
  await expect(page.locator('.record-disc-artwork img').first()).toHaveAttribute("src","/models/rhine/record-disc.webp");
  for(const width of [320,390,768,1024]){await page.setViewportSize({width,height:844});for(const route of ["/history","/practice?disc=P1-HOME-3"]){await page.goto(route);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}}
  await page.setViewportSize({width:390,height:844});await page.goto("/history");await page.addStyleTag({content:'[data-testid="mock-banner"],[data-testid="timescale-banner"]{display:none!important}'});await page.screenshot({path:"data/verification/rhine-history-mobile.png"});
  const image=await page.locator('.record-disc-artwork img').first().boundingBox(),copy=await page.locator('.record-disc-artwork + a').first().boundingBox();expect(image!.x+image!.width).toBeLessThanOrEqual(copy!.x);
  for(const width of [1600,390,320]){
    await page.setViewportSize({width,height:width===1600?900:844});await page.goto("/");
    await expect(page.locator('.home-disc-artwork img')).toHaveAttribute("src","/models/rhine/record-disc.webp");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(width!==320){await page.addStyleTag({content:'[data-testid="mock-banner"],[data-testid="timescale-banner"]{display:none!important}'});await page.screenshot({path:`data/verification/rhine-home-${width}.png`,fullPage:true});}
  }
  expect(errors).toEqual([]);
});
