# 移动 API 候选契约

本文件和 [OpenAPI](openapi.proposed.json) 描述待实现的 `/api/mobile/v1`，**当前服务器未提供这些路径**。现有接口来源由 [静态清单](generated/source-inventory.json) 核对；原生认证和响应 DTO 在 Mac 小样阶段接入。

## 核心操作

| 候选操作 | 请求要点 | 现有服务/入口 | 关键规则 |
| --- | --- | --- | --- |
| 邮箱登录、退出、当前用户 | 邮箱/密码；当前会话 | Better Auth、`/api/me` | 受控凭据、限速、封禁/删除检查、改密和入门下一步 |
| 修改密码 | currentPassword/newPassword/confirmPassword | `changePasswordAction` | 复用 8–128 位且字母+数字规则，撤销旧会话；不返回网页重定向 |
| 入门与录音授权 | 目标、自评、明确同意 | `grantRecordingConsent` | 系统麦克风权限不等于云端数据同意，返回授权版本 |
| 撤回录音授权 | 无客户端指定 userId | `withdrawRecordingConsent` | 更新版本，停止新上传和处理；已发出的云调用不能收回 |
| 删除账号 | 当前密码、确认文字 | `deleteUserAccount` | 立即封禁并撤销会话，后台清理；备份恢复重放删除日志 |
| 创建/读取/结束会话 | mode、题目/关卡、已有会话标识 | 会话服务、`/api/sessions` | 服务端选题和锁定版本，确认接管和冲突，不重置原模考期限 |
| 领取上传凭证 | submissionId、时长、会话、授权版本 | `createUploadTicket` | 同一 submissionId 复用；凭证和对象限定，不返回第三方 Key |
| 上传与提交 | 文件、上传凭证、answerId | 回答音频与提交服务 | 文件内容检测、25 MiB 限制、服务端时长核对及重复提交幂等 |
| 私有回放与报告 | answerId/sessionId | 回答音频、报告、参考朗读 | 每次鉴权和权属判断；Range；删除后拒绝访问 |

## 学习、记录和费用操作

候选 OpenAPI 已列出下列操作及现有来源，完整成功 DTO 与原生适配仍待实现；`Object` 明确表示尚未冻结的响应，不能视为已完成接口集成。

| 操作 | 请求与返回规则 | 现有来源 |
| --- | --- | --- |
| 题库与磁盘 | 只返回服务端允许使用的关卡和题目；发布时启用人审门槛 | `/api/levels`、`getLevelMap` |
| 学习记录 | mode 与 offset；现有每页 30 条，原生候选补 pageSize/hasMore，排序稳定；删除后不返回该记录 | `/api/sessions`、`listSessions` |
| 观点生成 | sourceText 3–2000 字、requestId UUID；超时复用标识，返回 Simple/Natural/Nuanced、词汇和模拟标记 | `/api/thoughts`、`generateThought` |
| 观点编辑/删除 | 当前 revision；英文表达长度沿用 schema，版本冲突保留本机编辑 | `/api/thoughts/{id}`、`editThought` |
| 隐藏表达与复习 | 隐藏仅是界面状态；enroll/remove 或 practice；练习带 revision、requestId、outcome 与可选回忆文本、0–300 秒自报时长 | `/api/thoughts/{id}/review` |
| 词汇保存/编辑/删除 | thoughtId、revision、indices 0–7；q 最长 100 字、offset 0–100000；服务端归属和词条去重 | `/api/vocabulary` 及其资源接口 |
| 复习队列 | due/upcoming/thoughts；到期以服务端时间为准，客户端不自行修改排程 | `getReviewQueue`，现有服务端函数，原生需接口化 |
| 成长日历 | month 为 YYYY-MM；当前以 UTC+08:00 划分业务日，返回 today、events、week、monthStats 与 dailySeconds | `getGrowth`，现有服务端函数，原生需接口化 |
| 签到与兑换 | checkin 按账号/业务日去重；redeem 带稳定 requestId 和用户确认的 offer，规则更新要求重新确认；review 带 answerId | `/api/rewards`、奖励服务 |
| 用量和费用 | month、offset；返回模型、mock/真实状态、额度、平台/个人来源、估算费用与调用明细；当前明细每页 30 条、hasMore | `getAiAccount`，候选 `/usage` 只读 |

费用按服务器配置单价估算，与云厂商账单区分；未知调用结果继续显示状态，不能凭客户端断网退款。积分换分钟不绕过服务器月预算。个人 Key 编辑与模型选择仍保留在现有 Web 高级设置；iOS 是否纳入及审核体验在首版定位定案后另开契约。

## 虚构请求与响应示例

以下是候选设计示例，不是实际服务器抓包。登录成功由原生适配器接收 `set-auth-token` 响应头并存入安全存储；示例不包含该值。

```json
{"user":{"id":"sample-user","email":"tester@example.test","mustChangePassword":false,"onboarded":true,"consentAllowed":true,"consentVersion":2}}
```

为某一题创建训练（创建成功拟保留 201、复用保留 200）：

```json
{"mode":"practice","questionId":"P1-HOBBY-5","fresh":false}
```

普通训练上传凭证请求；真实 id 由客户端此前收到的服务端结果填写，submissionId 在重试期间保持不变：

```json
{"sessionId":"sample-session","planIndex":0,"kind":"main","submissionId":"sample-submission-01","clientDurationMs":42000,"consentVersion":2,"interrupted":false}
```

授权过期示例；此码是候选说明，实施时核对既有服务返回并固定映射：

```json
{"error":{"code":"consent_changed","message":"录音授权状态已更新，请确认后继续。"}}
```

费用列表候选分页结构使用 `{month,offset,pageSize,hasMore,rows,quota,platform,totals}`；具体字段按 `AiAccountView` 接入并审查脱敏。API 版本保留兼容字段，不能让旧客户端因新增可选字段失效。

## 通用约定

- 只使用配置中明确允许的 HTTPS 后端；登录和 Token 附加不允许跳转到任意 URL。开发例外必须是单独开发配置。
- 原生会话凭据由原生安全存储保存和原生网络附加；正文、URL、日志、分析事件和 JSON 示例不含凭据。
- 常规 JSON 成功响应包含所需最小 DTO，服务端时间由 `X-Server-Time` 给出；原始认证库响应需在适配层规范化。
- 错误为 `{ error: { code, message, ...safeDetails } }`；保留未知错误码，显示可操作说明，不暴露异常堆栈和内部路径。
- 401：本机登录失效并停止受保护操作；403：授权/改密/预算等具体原因分别处理；404：不暴露其他账号资源是否存在；409：保留草稿并确认冲突；413：保留文件并提示大小；429：遵守重试时机。
- 网络超时不能直接视为“未计费”或“服务器未收到”。使用稳定 submissionId/answerId 查询和恢复，不重复创建收费任务。
- 页面重开、重试和恢复继续使用原提交标识；用户主动重新作答才创建新标识。后端预算及账本规则保持不变。
- 字段如分页、重试时间、文件期限及状态版本通过响应明确返回；客户端不猜剩余额度或自动延期。

| 状态/错误 | 来源或约定 | 原生客户端应答 |
| --- | --- | --- |
| 400 `bad_json` / `bad_request` | 当前共享处理层 | 提示输入问题，保留文件和编辑内容 |
| 401 `unauthorized` | 当前 `apiUser` | 本机失效，停止上传与播放并回登录 |
| 403 `must_change_password` / `consent_required` | 当前账号与回答服务 | 跳到改密或授权说明；不自动再次同意 |
| 403 `untrusted_origin` | 当前网页来源保护 | 不修改 Origin 伪装请求；原生候选入口另行接入 |
| 404 `not_found` | 当前权属与不存在统一处理 | 不显示其他账号记录；清理对应失效缓存 |
| 409 版本/接管冲突 | 服务按场景返回具体码 | 重新读取服务器状态，用户确认后继续 |
| 429 `budget_exceeded`、限速 | 当前预算/限速服务 | 保留进度；响应若有重试时机则遵守，没有则不编造倒计时 |
| 400 `offer_changed` / `insufficient_points` | 当前兑换服务 | 刷新规则或说明积分不足，不重复扣积分 |
| 413 / 416 | 上传边界 / Range 回放 | 保留录音并提示大小；回放重新查询可用范围 |
| 500 `internal`、502、503 | 内部异常、供应商或恢复中的服务 | 显示可重试说明，通过原标识查询结果 |

上传票据当前常规有效期为 15 分钟；保留片段的票据还受原始待上传期限限制，不能把本机录音的 24 小时保存期限当成票据有效期。失效后由同一账号、授权版本与原提交标识重新申请；候选响应需显式增加 expiresAt 并经过集成验证。

## 必须覆盖的负面场景

1. 无凭据、未签名/篡改/过期凭据、被撤销会话及改密后的旧会话。
2. 双账号访问回答、回放、观点和上传对象；请求体夹带他人 userId 不得改变身份。
3. Cookie 与 Bearer 混用，伪造 Origin/Host，以及网页跨来源写入。
4. 旧授权版本、撤回后仍到达的上传和处理请求。
5. 重复领取上传票据、重复上传/提交、超时后查询重试以及预算不足。
6. 25 MiB 边界、非法文件头、客户端虚假时长、Range 和删除后的访问。
7. 第一次必须改密、入门未完成、账号删除与本机取消清理失败。

认证库实验只覆盖上述一部分。资源隔离、上传、账本和删除需在真实移动入口接入后复用并补充集成测试；未实施的接口在 OpenAPI 中明确标为 proposal。
