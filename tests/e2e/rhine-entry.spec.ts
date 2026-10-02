import {test,expect,type Page} from "@playwright/test";

test.use({viewport:{width:1600,height:900},video:{mode:"on",size:{width:1280,height:720}},extraHTTPHeaders:{"x-forwarded-for":"192.0.2.46"}});
async function signIn(page:Page){
  await page.goto("/login");
  await page.getByLabel("邮箱",{exact:true}).fill("learner@example.test");
  await page.getByLabel("密码",{exact:true}).fill("Browser-test-123!");
  await page.getByRole("button",{name:"登录",exact:true}).click();
}
async function capture(page:Page,name:string){
  const style=await page.addStyleTag({content:'[data-testid="mock-banner"],[data-testid="timescale-banner"]{display:none!important}'});
  await page.screenshot({path:`data/verification/entry-${name}.png`});
  await style.evaluate(el=>(el as HTMLElement).remove());
}
test("welcome reveal survives navigation, then selects files on the same canvas",async({page})=>{
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  // Keep the completed welcome available for a stable visual comparison even
  // when screenshot/font preparation takes longer than the opening timeline.
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route("**/*.glb",async route=>{await gate;await route.continue();});
  await signIn(page);
  const entry=page.getByTestId("terminal-entry");
  await expect(entry).toHaveAttribute("data-phase","opening");
  await expect(page.locator(".terminal-entry-content")).toHaveAttribute("inert","");
  await expect(page.locator('.terminal-welcome[data-visible="true"]')).toBeVisible();
  try{
    await page.waitForTimeout(1100);await capture(page,"welcome-reveal");
    await expect(entry).toHaveAttribute("data-phase","waiting");
    await capture(page,"welcome");
  }finally{release();}
  await expect(entry).toHaveAttribute("data-phase","selecting");
  const canvas=await page.locator(".rhine-world-canvas canvas").elementHandle();
  await expect(page.locator(".rhine-world-canvas")).toHaveAttribute("data-intro","true");
  await page.waitForTimeout(850);await capture(page,"selecting");
  await expect(page.locator(".rhine-selecting-files")).toHaveText("SELECTING FILES…");
  await expect(entry).toHaveCount(0,{timeout:15000});
  expect(await canvas?.evaluate(el=>el===document.querySelector(".rhine-world-canvas canvas"))).toBe(true);
  await expect(page.locator(".terminal-entry-content")).not.toHaveAttribute("inert","");
  await expect(page.locator(".disc-library")).toBeFocused();
  await capture(page,"ready");
  await page.getByRole("button",{name:"下一张磁盘",exact:true}).click();
  await expect(page.getByTestId("q-P1-HOME-2")).toBeVisible();
  await page.getByRole("link",{name:"SPEAK 首页",exact:true}).click();
  await page.goto("/practice?disc=P1-HOME-2");
  await expect(page.getByTestId("q-P1-HOME-2")).toBeVisible();
  await expect(entry).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("slow scene holds the curtain; mobile skip restores usable controls",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route("**/*.glb",async route=>{await gate;await route.continue();});
  await signIn(page);
  const entry=page.getByTestId("terminal-entry");
  try{
    await expect(entry).toHaveAttribute("data-phase","waiting",{timeout:15000});
    await expect(page.locator(".terminal-entry-curtain")).toHaveCSS("opacity","1");
    await capture(page,"mobile-welcome");
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(page.getByRole("button",{name:"跳过动画，进入系统"})).toBeInViewport();
  }finally{release();}
  await expect(entry).toHaveAttribute("data-phase","selecting",{timeout:30000});
  await expect(page.locator(".terminal-entry-curtain")).toHaveCSS("opacity","0");
  await capture(page,"mobile-selecting");
  await page.keyboard.press("Escape");
  await expect(entry).toHaveCount(0);
  await expect(page.getByTestId("disc-scene")).toHaveAttribute("data-renderer","ready");
  await expect(page.getByRole("button",{name:"下一张磁盘",exact:true})).toBeEnabled();
  await page.getByRole("button",{name:"下一张磁盘",exact:true}).click();
  await expect(page.getByTestId("q-P1-HOME-2")).toBeVisible();
  await capture(page,"mobile-ready");
});

test("reduced motion goes directly to the real disc library",async({page})=>{
  await page.emulateMedia({reducedMotion:"reduce"});
  await signIn(page);
  await expect(page).toHaveURL(/\/practice(?:\?|$)/);
  await expect(page.getByTestId("terminal-entry")).toHaveCount(0);
  await expect(page.getByRole("button",{name:"下一张磁盘",exact:true})).toBeEnabled();
  await expect(page.locator(".terminal-entry-content")).not.toHaveAttribute("inert","");
});
