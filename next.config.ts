import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Each checkout uses its own dependencies, including nested clean-install verification copies.
  turbopack: { root: process.cwd() },
  outputFileTracingRoot: process.cwd(),
  // Runtime backups, credentials and data are mounted/configured separately, never shipped in traces.
  outputFileTracingExcludes: { "/*": ["./data/**/*", "./backups/**/*", "./.env", "./.env.*", "./.git/**/*", "./release/**/*"] },
  // A stale broad filesystem trace made cache shutdown retain ~14 GB on Windows. Build without that cache.
  experimental: { turbopackFileSystemCacheForBuild: false },
  // pg / pg-boss / ali-oss 为 Node 专用依赖，不参与打包
  serverExternalPackages: ["pg", "pg-boss", "ali-oss", "kokoro-js", "@huggingface/transformers", "onnxruntime-node"],
  poweredByHeader: false,
  typescript: {
    // 类型检查单独运行 `npm run typecheck`，避免构建阶段重复执行
    ignoreBuildErrors: false,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          // 麦克风只允许本站使用；摄像头与定位首版不使用
          { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
