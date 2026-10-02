import {test,expect,type Page} from "@playwright/test";
test.use({viewport:{width:1600,height:900},extraHTTPHeaders:{"x-forwarded-for":"192.0.2.44"}});
async function login(page:Page){
  await page.addInitScript(()=>{
    const observed=window as typeof window&{observedTracks:MediaStreamTrack[];observedAudio:HTMLMediaElement[];permissionDelay?:number};
    observed.observedTracks=[];observed.observedAudio=[];
    const getMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await getMedia(constraints);observed.observedTracks.push(...stream.getTracks());if(observed.permissionDelay)await new Promise(resolve=>setTimeout(resolve,observed.permissionDelay));return stream;};
    const play=HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play=function(){observed.observedAudio.push(this);return play.call(this);};
  });
  await page.goto("/login");await page.getByLabel("邮箱",{exact:true}).fill("outsider@example.test");await page.getByLabel("密码",{exact:true}).fill("Browser-test-123!");await page.getByRole("button",{name:"登录",exact:true}).click();await expect(page).not.toHaveURL(/\/login$/);
}
async function stopped(page:Page){
  await expect.poll(()=>page.evaluate(()=>{const w=window as typeof window&{observedTracks:MediaStreamTrack[];observedAudio:HTMLMediaElement[]};return w.observedTracks.every(t=>t.readyState==="ended")&&w.observedAudio.every(a=>a.paused);})).toBe(true);
}
test("exit cancels pending microphone startup, saves partial training and resumes the same question",async({page})=>{
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  const decks:string[]=[];page.on("request",r=>{if(r.url().includes("playback-deck.glb"))decks.push(r.url());});
  await login(page);await page.goto("/practice?part=1&disc=P1-HOBBY-5");
  await page.getByTestId("practice-P1-HOBBY-5").click();await expect(page).toHaveURL(/\/interview\//);const id=page.url().split("/").at(-1)!;
  await page.evaluate(()=>{(window as typeof window&{permissionDelay:number}).permissionDelay=700;});
  await page.getByTestId("start-interview").click();await expect(page.getByTestId("interview-room")).toHaveAttribute("data-phase","starting");
  await page.getByTestId("exit-interview").click();await expect(page.getByTestId("q-P1-HOBBY-5")).toBeVisible();await stopped(page);
  expect((await(await page.request.get(`/api/sessions/${id}`)).json()).session.startedAt).toBeNull();
  await page.evaluate(()=>{(window as typeof window&{permissionDelay:number}).permissionDelay=0;});
  await page.getByRole("navigation",{name:"学习服务"}).getByRole("link",{name:"学习记录",exact:false}).click();
  await page.getByTestId(`history-${id}`).locator("a").first().click();await expect(page).toHaveURL(new RegExp(`/interview/${id}$`));
  await page.getByTestId("start-interview").click();await expect(page.getByTestId("recording-indicator")).toBeVisible();
  await page.waitForTimeout(240);await expect(page.getByTestId("disc-drive-loading")).toHaveCount(0);
  await page.screenshot({path:"data/verification/rhine-v4-recording.png"});
  await page.getByTestId("exit-interview").click();await expect(page.getByTestId("q-P1-HOBBY-5")).toBeVisible();await stopped(page);
  await expect.poll(async()=>{const data=await(await page.request.get(`/api/sessions/${id}`)).json();return data.answers.some((a:{interrupted:boolean;status:string})=>a.interrupted&&a.status!=="created");}).toBe(true);
  await page.emulateMedia({reducedMotion:"reduce"});await page.setViewportSize({width:390,height:844});
  await page.getByRole("navigation",{name:"学习服务"}).getByRole("link",{name:"学习记录",exact:false}).click();
  await page.getByTestId(`history-${id}`).locator("a").first().click();await expect(page).toHaveURL(new RegExp(`/interview/${id}$`));
  await page.getByTestId("start-interview").click();await expect(page.getByTestId("recording-indicator")).toBeVisible();
  await expect(page.getByTestId("disc-drive-loading")).toHaveCount(0);
  await expect(page.getByTestId("exit-interview")).toBeInViewport();await page.screenshot({path:"data/verification/rhine-v4-mobile-recording.png"});await page.getByTestId("exit-interview").click();await expect(page.getByTestId("q-P1-HOBBY-5")).toBeVisible();await stopped(page);
  expect(decks).toEqual([]);expect(errors).toEqual([]);
});
test("exiting a mock freezes the scene during saving and marks it interrupted",async({page})=>{
  await login(page);
  const response=await page.request.post("/api/sessions",{data:{mode:"mock",mockSetId:"mock-1",fresh:true}});expect(response.ok()).toBe(true);const {id}=await response.json();
  await page.goto(`/interview/${id}`);await expect(page.getByTestId("disc-scene")).toHaveAttribute("data-renderer","ready");await page.getByTestId("start-interview").click();await expect(page.getByTestId("recording-indicator")).toBeVisible();await page.waitForTimeout(250);
  await page.route(`**/api/sessions/${id}/events`,async route=>{if(route.request().postDataJSON()?.type==="interrupt")await new Promise(resolve=>setTimeout(resolve,1000));await route.continue();});
  await page.getByTestId("exit-interview").click();await expect(page.getByTestId("interview-room")).toHaveAttribute("data-phase","exiting");await stopped(page);
  await expect(page.locator(".rhine-world-canvas")).toHaveAttribute("data-paused","true");
  const time=await page.locator(".rhine-world-canvas").getAttribute("data-scene-time");expect(time).not.toBeNull();await page.waitForTimeout(200);expect(await page.locator(".rhine-world-canvas").getAttribute("data-scene-time")).toBe(time);
  await expect(page.getByTestId("countdown")).toHaveCount(0);await page.screenshot({path:"data/verification/rhine-v4-exiting.png"});
  await expect(page).toHaveURL(/\/practice(?:\?|$)/);await stopped(page);
  const data=await(await page.request.get(`/api/sessions/${id}`)).json();expect(data.session.status).toBe("interrupted");expect(data.session.interruptReason).toBe("user_exit");expect(data.answers.some((a:{interrupted:boolean})=>a.interrupted)).toBe(true);
});
