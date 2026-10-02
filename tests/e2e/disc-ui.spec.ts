import {test,expect,type Page} from "@playwright/test";
import fs from "node:fs/promises";

test.use({viewport:{width:1600,height:900},video:{mode:"on",size:{width:1280,height:720}}});
async function login(page:Page){await page.goto("/login");await page.getByLabel("邮箱",{exact:true}).fill("learner@example.test");await page.getByLabel("密码",{exact:true}).fill("Browser-test-123!");await page.getByRole("button",{name:"登录",exact:true}).click();await expect(page).not.toHaveURL(/\/login$/);}
async function capture(page:Page,name:string){
  await page.evaluate(()=>window.scrollTo(0,0));
  const style=await page.addStyleTag({content:'[data-testid="mock-banner"],[data-testid="timescale-banner"]{display:none!important}'});
  await page.waitForTimeout(150);
  if(name==="recording")await expect(page.getByRole("button",{name:"我答完了",exact:true})).toBeInViewport({ratio:1});
  if(name==="archive")await expect(page.getByRole("button",{name:"再次录制",exact:true})).toBeInViewport({ratio:1});
  await page.screenshot({path:`data/verification/rhine-${name}.png`});
  await style.evaluate(el=>(el as HTMLElement).remove());
}

test("disk selection, real recording state, replay controls and responsive fallbacks",async({page})=>{
  test.setTimeout(180000);
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  await login(page);await page.goto("/practice");
  await expect(page.getByTestId("disc-scene")).toHaveAttribute("data-renderer","ready",{timeout:30000});
  await expect(page.getByTestId("q-P1-HOME-1")).toBeVisible();
  const originalCanvas=await page.locator(".rhine-world-canvas canvas").elementHandle();
  await page.getByRole("button",{name:"下一张磁盘",exact:true}).click();
  await expect(page.getByTestId("q-P1-HOME-2")).toBeVisible();
  expect(await originalCanvas!.evaluate(el=>el.isConnected)).toBe(true);
  const timings=await page.evaluate(()=>new Promise<number[]>(resolve=>{const samples:number[]=[];let prev=performance.now();function frame(now:number){samples.push(now-prev);prev=now;if(samples.length<90)requestAnimationFrame(frame);else resolve(samples);}requestAnimationFrame(frame);}));
  await fs.writeFile("data/verification/disc-frame-intervals.json",JSON.stringify({note:"Browser requestAnimationFrame intervals during selection; not a phone or all-scenes performance guarantee",samplesMs:timings},null,2));
  await page.getByRole("button",{name:"上一张磁盘",exact:true}).click();
  await page.waitForTimeout(1800);await capture(page,"library");
  await page.getByRole("button",{name:"题库索引"}).click();
  await page.getByLabel("检索题目",{exact:true}).fill("no-such-training-disc");await expect(page.getByRole("dialog").getByText("没有找到匹配的训练盘")).toBeVisible();
  await page.getByRole("dialog").getByRole("button",{name:"清除筛选",exact:true}).click();
  await page.getByLabel("检索题目",{exact:true}).fill("P1-HOME-1");await expect(page.getByTestId("q-P1-HOME-1")).toBeVisible();
  await page.getByRole("button",{name:"关闭题库索引"}).click();
  await page.getByRole("button",{name:"简洁显示",exact:true}).click();await expect(page.getByTestId("disc-scene")).toHaveAttribute("data-renderer","simple");
  await page.getByRole("button",{name:"启用 3D",exact:true}).click();await expect(page.getByTestId("disc-scene")).toHaveAttribute("data-renderer","ready",{timeout:30000});
  const enteringCanvas=await page.locator(".rhine-world-canvas canvas").elementHandle();
  await page.getByTestId("practice-P1-HOME-1").click();await expect(page.locator(".rhine-library")).toHaveAttribute("data-loading","true");await page.waitForTimeout(600);await capture(page,"extract");await expect(page).toHaveURL(/\/interview\//);
  expect(await enteringCanvas!.evaluate(el=>el.isConnected)).toBe(true);
  await expect(page.locator(".rhine-world-canvas")).toHaveAttribute("data-reveal","clear",{timeout:15000});
  await page.waitForTimeout(750);await capture(page,"loaded");
  const sessionId=page.url().split("/").at(-1)!;
  await expect(page.getByTestId("disc-scene")).toHaveAttribute("data-renderer","ready",{timeout:30000});
  await page.getByRole("button",{name:"开始面试",exact:true}).click({timeout:60000});
  await expect(page.getByTestId("disc-drive-loading")).toHaveCount(0);
  await expect(page.getByTestId("disc-scene")).toHaveAttribute("data-state","recording",{timeout:30000});
  await capture(page,"recording");
  await page.getByRole("button",{name:"我答完了",exact:true}).click();
  await expect(page.getByTestId("disc-scene")).not.toHaveAttribute("data-state","recording");
  await page.getByRole("button",{name:"完成本关",exact:true}).click();await expect(page.getByText("本次练习完成！",{exact:true})).toBeVisible();
  await expect.poll(async()=>{const d=await(await page.request.get(`/api/sessions/${sessionId}`)).json();return d.answers[0]?.status;},{timeout:60000}).toBe("done");
  const data=await(await page.request.get(`/api/sessions/${sessionId}`)).json();const answerId=data.answers[0].id;
  await page.goto(`/answers/${answerId}`);await expect(page.getByTestId("disc-scene")).toHaveAttribute("data-renderer","ready",{timeout:30000});
  await expect(page.locator(".rhine-world-canvas")).toHaveAttribute("data-reveal","clear",{timeout:15000});await page.waitForTimeout(750);await capture(page,"archive");
  await page.getByRole("button",{name:"播放录音",exact:true}).click();await expect(page.getByTestId("disc-scene")).toHaveAttribute("data-state","playing");
  await expect(page.getByTestId("disc-drive-loading")).toHaveCount(0);
  await page.getByRole("button",{name:"暂停录音回放",exact:true}).click();await expect(page.getByTestId("disc-scene")).toHaveAttribute("data-state","idle");
  await page.getByLabel("回放速度",{exact:true}).selectOption("1.5");expect(await page.getByTestId("answer-audio").evaluate((el:HTMLAudioElement)=>el.playbackRate)).toBe(1.5);
  await page.getByLabel("回放音量",{exact:true}).fill("0.5");expect(await page.getByTestId("answer-audio").evaluate((el:HTMLAudioElement)=>el.volume)).toBe(.5);
  await page.getByRole("tab",{name:"反馈报告",exact:true}).click();await expect(page.getByRole("button",{name:"朗读参考回答"})).toBeVisible();
  await page.getByRole("tab",{name:"同题对比",exact:true}).click();await expect(page.getByRole("tabpanel")).toBeVisible();
  for(const width of [390,320,768]){await page.setViewportSize({width,height:844});for(const route of ["/practice",`/answers/${answerId}`,"/history"]){await page.goto(route);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${route} at ${width}px`).toBe(true);} }
  await page.setViewportSize({width:390,height:844});await page.goto("/practice?topic=HOME");await expect(page.getByTestId("disc-scene")).toHaveAttribute("data-renderer","ready",{timeout:30000});await page.waitForTimeout(1800);await capture(page,"mobile");
  await page.getByLabel("页面导航",{exact:true}).click();await expect(page.getByRole("navigation",{name:"快捷导航"}).getByRole("link",{name:"成长日历"})).toBeVisible();await page.keyboard.press("Escape");await expect(page.locator(".terminal-mobile-menu")).not.toHaveAttribute("open","");
  await page.emulateMedia({reducedMotion:"reduce"});await page.getByRole("button",{name:"下一张磁盘",exact:true}).click();await expect(page.getByTestId("q-P1-HOME-2")).toBeVisible();
  expect(await page.locator(".disc-detail").evaluate(el=>getComputedStyle(el).animationName)).toBe("none");
  await page.route("**/archive-cassette.glb",route=>route.abort());await page.reload();await expect(page.getByTestId("disc-scene")).toHaveAttribute("data-renderer","fallback",{timeout:30000});
  await expect(page.getByRole("button",{name:"载入训练盘",exact:false})).toBeVisible();
  expect(errors).toEqual([]);
});
