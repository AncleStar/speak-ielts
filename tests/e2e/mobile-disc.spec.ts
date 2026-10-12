import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";

for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test.describe(`disc page ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });
    test("keeps loading visible, separates page scrolling from selection, and returns to the current disc", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto("/login");
      await page.getByLabel("邮箱", { exact: true }).fill("learner@example.test");
      await page.getByLabel("密码", { exact: true }).fill("Browser-test-123!");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await expect(page).not.toHaveURL(/\/login$/);
      await page.getByRole("button", { name: "跳过动画，进入系统" }).click();
      // The timer and mock-provider banners are fixtures, not the ordinary page layout.
      await page.addStyleTag({ content: '[data-testid="mock-banner"],[data-testid="timescale-banner"]{display:none!important}' });
      await expect(page.locator(".rhine-world")).toHaveAttribute("data-renderer", "ready", { timeout: 30000 });
      // IntersectionObserver rounds fractional CSS pixels (0.03px on a 44px button).
      await expect(page.getByTestId("practice-P1-HOME-1")).toBeInViewport({ ratio: .999 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const canvas = await page.locator(".rhine-world-canvas canvas").elementHandle();
      const geometry = await page.locator(".disc-scene-library").boundingBox();
      const title = await page.locator(".rhine-callout").boundingBox();
      expect(geometry).not.toBeNull(); expect(title).not.toBeNull();
      if (viewport.width < 768) expect(geometry!.y + geometry!.height).toBeLessThanOrEqual(title!.y);
      await fs.mkdir("data/verification/round15-mobile-after", { recursive: true });
      await page.waitForTimeout(1800);
      await page.screenshot({ path: `data/verification/round15-mobile-after/${viewport.width}-selection.png`, fullPage: true });

      const current = page.url();
      await page.mouse.move(10, Math.min(viewport.height - 20, title!.y));
      const scrollEnded = page.evaluate(() => new Promise<void>(resolve => document.addEventListener("scrollend", () => resolve(), { once: true })));
      await page.mouse.wheel(0, 400);
      await scrollEnded;
      await expect.poll(() => page.evaluate(() => Math.abs(scrollY - (document.documentElement.scrollHeight - innerHeight)))).toBeLessThan(1);
      const outsideScrollY = await page.evaluate(() => scrollY);
      expect(outsideScrollY).toBeGreaterThan(0);
      expect(page.url()).toBe(current);
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      // The artwork itself retains wheel selection; its caption button remains clickable.
      const visibleArtwork = await page.locator(".disc-scene-library").boundingBox();
      expect(visibleArtwork).not.toBeNull();
      const wheelPoint = { x: visibleArtwork!.x + visibleArtwork!.width / 2, y: visibleArtwork!.y + visibleArtwork!.height / 2 };
      const hit = await page.evaluate(point => ({ scrollY, target: document.elementFromPoint(point.x, point.y)?.outerHTML.slice(0, 300), inArtwork: Boolean(document.elementFromPoint(point.x, point.y)?.closest(".disc-scene-library")) }), wheelPoint);
      await fs.writeFile(`data/verification/round15-mobile-after/${viewport.width}-wheel-target.json`, JSON.stringify({ original: geometry, visibleArtwork, wheelPoint, hit }, null, 2));
      expect(hit.inArtwork).toBe(true);
      await page.mouse.move(wheelPoint.x, wheelPoint.y);
      await page.mouse.wheel(0, 100);
      await expect(page.getByTestId("q-P1-HOME-2")).toBeVisible();
      await page.getByRole("button", { name: "简洁显示", exact: true }).click();
      await expect(page.getByTestId("disc-scene")).toHaveAttribute("data-renderer", "simple");
      await page.getByRole("button", { name: "启用 3D", exact: true }).click();
      await expect(page.getByTestId("disc-scene")).toHaveAttribute("data-renderer", "ready", { timeout: 30000 });
      const loadingCanvas = await page.locator(".rhine-world-canvas canvas").elementHandle();
      expect(await canvas!.evaluate(element => element.isConnected)).toBe(false);
      await page.getByTestId("practice-P1-HOME-2").click();
      await expect(page).toHaveURL(/\/interview\//);
      await expect(page.locator(".rhine-world-canvas")).toHaveAttribute("data-reveal", "clear", { timeout: 15000 });
      expect(await loadingCanvas!.evaluate(element => element.isConnected)).toBe(true);
      const brand = await page.locator(".terminal-header .speak-brand").boundingBox();
      const toolbar = await page.locator(".interview-toolbar").boundingBox();
      expect(brand).not.toBeNull(); expect(toolbar).not.toBeNull();
      expect(toolbar!.y).toBeGreaterThanOrEqual(brand!.y + brand!.height + 8);
      await page.waitForTimeout(600);
      await page.screenshot({ path: `data/verification/round15-mobile-after/${viewport.width}-loaded.png`, fullPage: true });
      await page.getByRole("button", { name: "退出面试", exact: true }).click();
      await expect(page.getByTestId("q-P1-HOME-2")).toBeVisible();
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(page.getByTestId("practice-P1-HOME-2")).toBeInViewport({ ratio: .999 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.getByRole("button", { name: "下一张磁盘", exact: true }).scrollIntoViewIfNeeded();
      const nextButton = await page.getByRole("button", { name: "下一张磁盘", exact: true }).boundingBox();
      expect(nextButton).not.toBeNull();
      await page.touchscreen.tap(nextButton!.x + nextButton!.width / 2, nextButton!.y + nextButton!.height / 2);
      await expect(page.getByTestId("q-P1-HOME-3")).toBeVisible();
      expect(await page.locator(".disc-detail").evaluate(element => getComputedStyle(element).animationName)).toBe("none");
      expect(errors).toEqual([]);
      await fs.writeFile(`data/verification/round15-mobile-after/${viewport.width}-acceptance.json`, JSON.stringify({
        checkedAt: new Date().toISOString(), viewport, realPhone: false, syntheticAccounts: true,
        hiddenTestOnlyBanners: true, selectionSlot: geometry, titleBounds: title, outsideScrollY,
        loadViewportThreshold: .999,
        loadFullyVisible: true, outsideScrollPreservedSelection: true, artworkWheelSelectedNext: true,
        simpleModeAndRestored3d: true, sharedCanvasOnLoad: true, exitReturnedCurrent: true,
        headerClearance: toolbar!.y - brand!.y - brand!.height,
        reducedMotionTouchButton: true, pageErrors: errors,
      }, null, 2));
    });
  });
}
