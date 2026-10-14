# 自有 Mac 接入、开发地址与真机工作包

更新：2026-10-14。设备登记：Mac mini M4、16GB 内存、256GB 存储、macOS 27.0.1；iPhone 14 Pro、iOS 26.6.2。均为用户报告，尚未读取设备核验，可用磁盘空间未知。用户选择在 Mac 安装 Codex、打开同一 GitHub 项目继续；Windows 仍为主力电脑。本次 Windows 会话未连接 Mac，当前没有已安装的 iOS 构建或原生验收结果。

## 1. 首次安装顺序

1. 在 Mac 的 App Store 或 Apple Developer 下载页面安装稳定版 Xcode。按本次核对的 [苹果兼容表](https://developer.apple.com/xcode/system-requirements)，Xcode 27 支持 macOS 26.6 及以后版本，适用于用户报告的 macOS 27.0.1；首次准备不选择 RC 或 beta。先打开 Xcode，按界面完成协议及必要组件安装，首轮仅准备一个 iOS 模拟器。
2. 在 Xcode → Settings → Locations → Command Line Tools 选择完整 Xcode。完整 Xcode 已包含命令行工具，无需另装独立 Command Line Tools 包。[苹果命令行工具说明](https://developer.apple.com/documentation/xcode/installing-the-command-line-tools/)
3. 在 [Node.js 官方下载页](https://nodejs.org/en/download) 选择 Node 24 LTS、macOS、ARM64，使用官方安装包。现有工程要求 Node ≥22.12，首轮沿用 Node 24 主版本，不执行 `npm update`。
4. 按 [OpenAI 官方桌面应用说明](https://learn.chatgpt.com/docs/app) 下载 Apple Silicon 版本，登录同一 ChatGPT 账号并进入 Codex，稍后打开克隆的项目文件夹。官方入口当前提供带 Codex 的桌面客户端。

针对 256GB 存储，先把数据库、Docker、完整录音历史和语音模型权重留在 Windows。只在 Mac 安装当前小样需要的工具及一个模拟器；实际剩余空间以本机检查为准。接入本机备份，项目可重装的依赖和构建缓存无需当作唯一源码副本。

## 2. 拉取源码并运行准备检查

打开 Mac 的「终端」，逐行执行以下命令；某一步报错时先处理该步，不继续后续命令。此步骤仅用于新建克隆；已经存在项目时先检查工作区再同步，避免覆盖未提交代码。

```bash
mkdir -p ~/Developer
cd ~/Developer
git clone https://github.com/AncleStar/speak-ielts.git
cd speak-ielts
node --version
npm --version
xcode-select --print-path
bash scripts/ios/mac-preflight.sh
npm ci
npm run prepare:ios
npm run check:ios-prep
npm run test:ios-prep
```

`xcode-select --print-path` 通常应指向 `/Applications/Xcode.app/Contents/Developer`。若指向独立 Command Line Tools，回到 Xcode 的 Locations 选择完整 Xcode。若提示协议、组件或 iOS 平台尚未准备，先在 Xcode 完成首次设置。`mac-preflight.sh` 只读检查，不安装工具或自动接受协议。

验收这一阶段：实际执行上述命令，Mac 脚本返回 0、准备检查无失败、12 项隔离认证及来源测试通过，并记录实际 macOS、Xcode、Node 和 Git 版本。检查通过代表源码准备包和环境发现，不代表原生 App 已构建。此处不需要业务 `.env`、API Key、PostgreSQL 或域名，也不应执行生产数据库初始化命令。

`prepare:ios` 在新克隆生成被 Git 忽略的合成音频及本机文件指纹；不同平台的文本换行可能产生清单差异，提交前审阅生成文件。`.env`、业务数据、Key、私人录音、证书和个人钥匙串不通过 Git 同步。

## 3. 在 Mac 的 Codex 接续开发

在 Mac 的 Codex 打开 `~/Developer/speak-ielts` 文件夹。在该项目的聊天中发送以下提示词；聊天历史即使可见，也需要重新打开 Mac 上的实际项目目录。

```text
继续 SPEAK 雅思口语 App 的 iOS 开发。先读取 docs/ios/README.md、
docs/ios/Mac接入与真机验收.md、docs/ios/架构与迁移清单.md，
以及 docs/iOS正式开发前准备计划_v1.0.md，再查看实际 Git 状态。
设备为自有 Mac mini M4 / 16GB / 256GB / macOS 27.0.1（用户报告），
测试手机 iPhone 14 Pro / iOS 26.6.2（用户报告）。Windows 仍是主力电脑；
不用云端 Mac 或 Xcode Cloud。本机环境尚未验收，请先实际检查并记录版本。
在独立分支推进 P3：选定并锁定当前兼容的 Capacitor 和插件版本，
创建能本地编译、资源随包的独立 iOS 小样，先用虚构账号和模拟数据验证
登录、选盘、播报、限时录音、中断和回放，再按移动接口契约接入受控开发后端。
当前没有已实现的移动客户端或 /api/mobile/v1 服务，不能把候选契约当成现成接口。
保持现有网页来源保护、磁盘风格、原登录节奏、静态圆环、当前盘返回和月预算；
沿用既有服务端语音方案，真人效果在后端联调时验证。
每次记录实际编译、签名、真机操作及失败结果；未验项保持待验。
```

首个开发交付是能在模拟器及自有 iPhone 安装的小样，不直接把 Next.js 服务端打包进 iPhone。候选路线为独立 React 客户端配合 Capacitor，本地随包资源；原生会话、存储、录音、播放与生命周期按 Port 实现。版本需要结合实际 Xcode 和 iPhone 验证。[Capacitor 环境说明](https://capacitorjs.com/docs/getting-started/environment-setup)

Windows 和 Mac 各自保留独立克隆，通过 Git 同步源码；Mac 原生工作使用独立分支，切换电脑前提交并推送，另一台先查看工作区再拉取。签名凭据留在 Mac 的钥匙串。

## 4. 连接 iPhone 与首次开发签名

1. 使用支持数据传输的线连接 iPhone 与 Mac，在手机上解锁并确认信任，按 Xcode 的设备管理提示完成配对。
2. 手机「设置 → 隐私与安全性 → 开发者模式」打开后按提示重启并确认；若看不到选项，先完成与 Xcode 的配对。[苹果 Developer Mode 说明](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device?language=objc)
3. 在 Xcode 的账号设置登录自己的 Apple 账号，为小样选择 Personal Team 和独立 Bundle ID，使用自动签名后运行到自己的 iPhone。设备口令、账号和证书只在本机输入。
4. 首轮可以使用免费 Personal Team 验证自有设备；免费开发签名有效期为 7 天，届时需重新构建安装。TestFlight 和 App Store 分发再办理付费 Apple Developer Program。[苹果账号与会员说明](https://developer.apple.com/help/account/basics/about-your-developer-account)

当天优先完成环境检查、模拟器首次启动和小样真机安装；G1 还要求后面的真实训练流程、中断、恢复及性能验证，安装成功本身不通过 G1。

## 地址与域名的用途

| 环境 | 需要的资源 | 本阶段状态 |
| --- | --- | --- |
| Windows 文档、内存认证实验、合成数据检查 | 当前电脑，不需域名 | 已具备 |
| iPhone Safari 开发基线 | 手机可访问的可信 HTTPS；隔离测试数据 | 方案待执行，不能使用手机自己的 localhost 指代 Windows |
| iOS 原生小样 | 自有 Mac、iPhone；本地模拟可先独立运行，真实联调再接受控开发后端 | 硬件已报告到位；环境、实际请求方式和 HTTPS 配置待验 |
| 受邀 TestFlight | 可持续访问的 HTTPS 隔离后端、开发者会员、测试账号与说明 | 未准备完成 |
| App Store 正式运行 | 稳定后端、域名/证书、私有存储、备份与支持页面 | 用户允许按需购买域名；名称、预算、发布主体及服务器仍待确定 |

域名采购在用途、后端和发布地区明确后进行，记录首年与续费价格、注册主体和 DNS 管理方式。域名放在用户自己的注册账号下；不把现有私人应用或数据库直接映射到公网。购买、解析、部署和公开访问分别验收。

初期可先采用隔离临时可信 HTTPS 测试；短期地址不作为长期运行承诺。若要求后端也全部在自有设备运行，需另核对公网连通、持续供电、证书、备份和适用的地区要求。

## 真机验收记录

| 编号 | 步骤 | 通过条件 | 当前 |
| --- | --- | --- | --- |
| I01 | 新装、登录、首次改密、退出 | 不必打开 Safari 才能使用；旧会话失效 | 待验 |
| I02 | 同意/拒绝权限与 5 秒试音 | 状态说明准确，真实声音可回放，拒绝后文字功能可用 | 待验 |
| I03 | 选盘 → 播报 → 限时录音 → 反馈 → 回放 | 当前盘返回正确，录音时长与前台停止误差 ≤1 秒 | 待验 |
| I04 | 来电、锁屏、切后台和耳机切换 | 正确停止/中断，无隐式后台录音；可用片段保留 | 待验 |
| I05 | 断网、重复点击、超时和重启 | 原标识查询恢复，无重复处理或扣额；到期说明准确 | 待验 |
| I06 | 换账号、撤回授权、删除记录/账号 | 旧资料不可访问，录音/播放/上传停止，旧凭据失效 | 待验 |
| I07 | 原速完整模考 | 原截止时间不重置，三部分与记录一致 | 待验 |
| I08 | 连续切盘、回放和输入 | 测帧率、内存、发热、安全区、键盘及场景释放 | 待验 |
| I09 | VoiceOver、动态字体与减少动态效果 | 主要操作可访问，阅读顺序和退出入口清楚 | 待验 |

每项记录代码/构建版本、设备系统、网络、模型、耗时、结果和缺陷编号；真人录音和设备标识保存在私人目录。只把有证据的项改为通过。
