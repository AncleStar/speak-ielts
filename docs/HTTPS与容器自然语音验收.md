# HTTPS 与容器自然语音验收

2026-10-13 使用当前版本的实际 Linux Docker 镜像、PostgreSQL、worker 与 Caddy 2.11.7，在隔离项目完成工程验证。全部账号和录音为测试资料，ASR/反馈为模拟服务；考官确实使用 Kokoro q8、Emma `bf_emma@0.95-v1`。没有使用原站点 API Key、提高预算或新增付费调用。

## 已复现并修复

| 问题 | 原始证据 | 修复后的实际结果 |
| --- | --- | --- |
| 部分业务写入遗漏来源校验 | HTTPS 下同主机另一端口的真实 Edge 页面，带登录 Cookie 发送简单 text/plain 请求，创建了额外练习 | 统一 API 包装校验 Origin/Referer；同一页面重试收到 403，练习数量不变；登录和合法操作保持可用 |
| 反代重复响应头 | 登录响应有两个 Permissions-Policy、两个 nosniff，合并值出现重复 | Caddy 延后写入四个安全/隐私头；登录、健康接口、未登录私有接口、静态资源各只有一份，麦克风/摄像头/定位设置与应用一致 |
| 上传限制单位不一致 | 反代 26 MB = 26,000,000 字节，比应用 25 MiB = 26,214,400 字节小；合法边界文件返回 413 | 反代改为 26 MiB；完全相同的 25 MiB 文件上传并由实际 Linux worker 处理，应用上限多一个字节仍返回 too_large |

上传边界使用带 JUNK 填充块的有效 RIFF/WAV：实际音频为 6 秒，完整文件为 25 MiB。测试字节限制与转码，不把填充数据当成长时间真人录音。首次反代端口占用、夹具向只读代码挂载写报告、SQL 列名、TLS socket 与请求头观测方式等初次失败记录也保留在私有日志；修正夹具后复验，没有修改业务数据来隐藏问题。

## 实际播放与录音流程

- HTTPS 登录成功，Cookie 为 Secure/HttpOnly，浏览器具有安全上下文和麦克风接口。
- 在桌面浏览器明确拒绝麦克风，出现恢复提示；允许后重新检测可用。
- 真正的 MediaRecorder 录制合成输入，5 秒设备试音约 4.92 秒并完整回放；没有把录音函数替换为假的成功结果。
- 从鉴权接口取得实际合成的 Emma MP3，浏览器完整播放约 7.77 秒；实际题目播报后原速录制、上传 WebM，由 Linux FFmpeg/worker 解析并生成模拟反馈。
- 私有回答完整回放通过，经 HTTPS 的 128 字节 Range 与原音频对应字节一致；未登录和另一账号不能获取自己的录音。
- 390px 的回答页面截图无横向溢出。浏览器页面没有未处理异常，模型与用量另从实际容器核对；外部 fetch 在网页/worker 中被隔离测试钩子禁止。

四个固定模型文件在复制前后核对哈希，原业务缓存仅被读取；模型副本写入测试卷。网页、worker 与生成结果的模型/声音一致，真实自然语音资产标记为非模拟，用量账本没有正金额事件。详细账号、Cookie、音频、模型路径与报告全部保存在被忽略的本机验证目录，不随源码发布。

## HTTPS 证据范围

测试入口只绑定电脑回环地址。Caddy 使用自身本地 CA，Node.js 请求通过该请求专用 CA 核对 TLS 证书与主机名，实际连接为 TLS 1.3；测试浏览器上下文允许该本地测试证书。没有改系统信任库，没有公开服务或申请公网证书。配置域名的 HTTP 跳转到 HTTPS 也已实际检查。

这证明当前反代、登录、自然合成、录音、上传和回放在工程测试环境可用，不能填写成公网可信证书或真实 Android/iPhone 通过。真机仍需手机可访问的可信 HTTPS 地址，并执行 [双端实测](Android与iPhone双端实测.md)。人类听感、20 次真人练习、30 条反馈审核、真实 OSS 和受邀试用仍待完成。

部署者配置时核对域名、公开端口、认证地址与统一运行配置，见 [部署说明](部署说明.md) 和 [Docker 更新及恢复](Docker部署与恢复.md)。本地 CA、信任、公开证书的区别见 [Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https#local-https)；响应头及大小配置见 [header](https://caddyserver.com/docs/caddyfile/directives/header)、[request_body](https://caddyserver.com/docs/caddyfile/directives/request_body)。
