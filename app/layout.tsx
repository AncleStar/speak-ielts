import type { Metadata, Viewport } from "next";
import { env } from "@/lib/env";
import "./globals.css";
import "./terminal.css";
import "./rhine-fonts.css";
import "./rhine.css";
import "./ai-account.css";
import { AppearanceInit } from "@/components/appearance";
import { RhineProvider } from "@/components/disc/rhine-provider";
import { TerminalEntryProvider } from "@/components/auth/terminal-entry";
import "./terminal-entry.css";

export const metadata: Metadata = {
  title: { default: "雅思口语模拟面试", template: "%s · 雅思口语模拟面试" },
  description: "虚拟考官语音提问、限时语音作答、录音回放与 AI 反馈的雅思口语练习。",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#eeebe5",
};

export const dynamic = "force-dynamic";

function StatusBanners() {
  let mock = true;
  let scale = 1;
  try {
    const e = env();
    mock = e.AI_PROVIDER === "mock";
    scale = e.TIME_SCALE;
  } catch {
    /* 构建阶段可能没有完整环境变量 */
  }
  return (
    <>
      {mock ? (
        <div data-testid="mock-banner" className="sticky top-0 z-50 bg-amber-100 px-4 py-1.5 text-center text-xs font-medium text-amber-900 ring-1 ring-amber-200">
          站点默认使用模拟服务，演示结果不代表真实能力；个人 API Key 模式以报告标识为准
        </div>
      ) : null}
      {scale !== 1 ? (
        <div data-testid="timescale-banner" className="bg-red-600 px-4 py-1.5 text-center text-xs font-semibold text-white">
          ⚠️ 测试时间倍率 TIME_SCALE={scale} 已启用，所有计时被缩短（仅用于自动化测试，生产必须为 1）
        </div>
      ) : null}
    </>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-dvh">
        <AppearanceInit />
        <StatusBanners />
        <TerminalEntryProvider><RhineProvider>{children}</RhineProvider></TerminalEntryProvider>
      </body>
    </html>
  );
}
