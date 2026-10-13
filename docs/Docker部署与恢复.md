# Docker 部署与隔离恢复

适用于 PostgreSQL 17、本地私有音频和 `speak-backup-v1` 目录备份。使用 Docker Engine/Desktop 与 Compose；在项目目录执行命令。公网 HTTPS、手机真机、OSS 对象恢复和自然语音人类听感需要分别验收。

## 首次部署

从 `.env.example` 创建私有 `.env`，设置独立随机认证、个人密钥加密、数据库和初始管理员密码。数据库密码使用随机十六进制可避免连接 URL 编码问题。新版本设置独立 `APP_IMAGE_TAG`，保留上一版本镜像和备份；首次试运行可以用 `AI_PROVIDER=mock`。

```sh
docker compose config --quiet
docker compose up -d --build --wait --wait-timeout 180 web worker backup
docker compose ps
docker compose logs --tail 80 backup-premigrate setup web worker backup
```

镜像使用官方 Node 22 和 PostgreSQL 17 基础镜像，包含对应版本的 `pg_dump` / `pg_restore`、FFmpeg 和 eSpeak。依赖下载使用有限重试、官方 Debian HTTPS 源和构建缓存。镜像不包含 `.env`、个人密钥、模型缓存、备份或用户录音。

Docker 构建单独设置 `SPEAK_STANDALONE=1`，生成由 `node server.js` 启动的网页，并复制静态文件和 public 资源。本机 Windows 构建沿用原来的 `next start`。构建阶段与运行阶段分开；运行依赖按同一锁文件重新执行 `npm ci --omit=dev`，保留 worker、迁移、自然语音准备、备份、恢复和自检所需源文件。下载缓存仅在 BuildKit 缓存挂载中复用，不写入最终镜像。测试目录、说明图、内置开发用 PostgreSQL 和 TypeScript 编译器不进入运行镜像；依赖声明的可选 peer 包仍可能被 npm 安装，不能把它描述为所有测试相关包都不存在。

首次需要自然语音时，运行 `docker compose run --rm --no-deps web npm run setup:voice`，完成模型下载后重启 web / worker。自然语音和真实 API 必须另外验证，模拟流程通过不能代替它们。

启动顺序：数据库健康 → 迁移前完整备份 → 迁移与种子 → web / worker / 定时备份。只有完全没有用户关系的初始空库允许显式空库备份；缺少业务表的非空库、恢复尚未核对的数据库仍被拒绝。网页和 worker 使用普通 `node` 用户。备份工具使用 root 以写入 Linux 主机的私有目录，只读挂载应用数据，不获取站点 API Key。

数据库不对主机发布端口，网页只绑定本机 `127.0.0.1:3000`。持久卷为 `postgres-data` 和 `app-data`；不要在业务环境执行 `docker compose down -v`。

## 已有业务环境更新

新镜像可以在旧服务运行时构建，因为各容器使用自己的只读镜像文件；数据库迁移和切换服务必须协调进行。本机 Windows 不能在正在运行的同一 `.next` 目录中这样构建。

1. 保存现用镜像标签和私有配置，设置新的 `APP_IMAGE_TAG`。保持认证密钥、个人密钥加密配置与预算；构建失败时继续使用旧服务，不清理旧镜像或卷。
2. 构建成功后，在旧网页「管理 → 系统设置」暂停新会话，等待正在录音的用户上传或退出，并核对在途处理。记下更新前的暂停状态。
3. 停止该项目全部网页、worker 与定时备份，保留数据库运行。完成完整备份后再迁移；失败时保留现场，不直接开放训练。

```sh
docker compose config --quiet
docker compose build web
# 此时完成第 2 步的暂停、上传和在途任务核对
docker compose stop web worker backup
docker compose run --rm --no-deps backup-premigrate node --import tsx scripts/backup.ts --maintenance
docker compose run --rm --no-deps setup
docker compose run --rm --no-deps worker npm run queue:runtime
```

最后一条只读显示登记是否匹配。同配置的更新保留等待任务；改变模型、语速、存储或其他执行配置时，按 [配置切换与旧队列](部署自检与故障自救.md#配置切换与旧队列) 核对，再明确执行：

```sh
# 仅在确实需要切换任务配置、已经暂停且全部旧消费者停止时执行
docker compose run --rm --no-deps worker npm run queue:runtime -- --activate --confirm-stopped
```

不会自动迁移其他配置队列或重放未知任务。完成核对后启动新镜像，自检和实际录音/回放通过，再在管理页恢复原暂停状态：

```sh
docker compose up -d --no-build --wait --wait-timeout 180 web worker backup
docker compose ps
docker compose run --rm --no-deps worker npm --silent run doctor -- --json
docker compose logs --tail 80 backup-premigrate setup web worker backup
```

启动依赖也会检查迁移前备份与初始化服务的成功状态。服务健康只表示当前配置和后台就绪，仍要实际试听、录音、回放。需要回滚时先按 [备份恢复与回滚](备份恢复与回滚.md) 核对数据库版本；把旧网页镜像指向已经迁移的数据库不构成完整回滚。

## 完整备份和删除日志

```sh
docker compose run --rm --no-deps backup-premigrate node --import tsx scripts/backup.ts --maintenance
```

`./backups/interview-时间-随机标识/` 包含数据库、私有音频、删除日志与逐文件 SHA-256。先在 `.partial` 完成复制与校验，再发布为完整目录；数据库引用的应保留音频缺失会失败。备份不是 `.dump` 和 tar 两个独立成功文件。旧版的 `.dump` / `.data.tar.gz` 请单独保存，不能作为新版恢复命令的输入。

定时服务启动时执行一次，成功后每 24 小时执行一次；其余时间每分钟合并源删除日志到主机 `deletion-log.latest.jsonl`。合并保留已有删除意图，源文件缺失或截断不会抹掉旧记录，冲突和坏日志会报错。最新文件最多可能落后一个检查间隔；事故恢复仍要核对源日志及独立记录，不能从旧快照推断后来删除。

`BACKUP_RETENTION_DAYS` 默认 7，允许 1–365。只有新备份成功后，才清理超过期限的已验证日期目录；始终保留最新一份有效备份。未知名称、未完成目录、损坏或夹杂额外文件的目录不自动删除。最新删除日志不随日期目录清理。仍须把完整备份和最新日志复制到独立介质；同盘备份不能防止磁盘损坏。

备份、日志合并与清理共用 `.maintenance.lock/owner.json`。发现锁时不会猜测进程已死或自动解锁。中断后先停止该项目备份服务、确认没有一次性备份容器或其他维护者，检查 owner 与 `.partial`，保留现场再人工处理。正常 SIGTERM 会等待当前操作收尾；Compose 最多等待两分钟，强制退出仍可能留下待核对的锁。

## 从备份恢复到新卷

以下使用独立 Compose 文件与项目，完全不挂载原数据库、原应用卷。`RECOVERY_PORT` 默认 3101，`RECOVERY_URL` 默认 `http://localhost:3101`；使用一致的实际地址配置登录，避开已占用端口。恢复文件和账号检查表保存在被 Git 忽略的 `data/recovery-review/`。

先停止源环境网页、worker 与定时备份，保留原数据库和卷。源库仍可读取时导出最新费用；不可读取时，依据独立用量记录和服务商账单人工核对，不能以旧快照合计代替后续费用。

```sh
docker compose stop web worker backup
docker compose run --rm --no-deps backup-premigrate node --import tsx scripts/restore-ledger.ts /backups/latest-costs.json
```

导出不会覆盖已有文件。对重复演练使用新的私有文件名。停止服务后还要核对并保存最终源删除日志到 `backups/deletion-log.latest.jsonl`；定时服务正常退出不代表最后一分钟内发生的删除已经复制。下面命令在只读应用数据挂载中合并，而不是用旧文件覆盖最新日志：

```sh
docker compose run --rm --no-deps backup-premigrate node --import tsx -e "import('./lib/backup-maintenance.ts').then(m=>m.checkpointDeletionLog('/backups','/app-data'))"
docker compose stop db
```

创建新的恢复项目。保持 `data/recovery-review/` 私有，并先确保它存在。以下项目名用于一次演练；再次恢复应使用新项目名和新卷，恢复工具会拒绝非空目标。

```sh
docker compose -p speak-recovery-01 -f docker-compose.recovery.yml config --quiet
docker compose -p speak-recovery-01 -f docker-compose.recovery.yml up -d --wait db
docker compose -p speak-recovery-01 -f docker-compose.recovery.yml --profile ops run --rm restore node --import tsx scripts/restore.ts /backups/interview-具体目录
```

数据库名为 `interview_recovered`；应用数据写入新 `recovered-data` 卷的 `/restore-data/recovered`。恢复工具验证清单、实际文件、数据库 archive 和最新删除日志，持久保留关闭保护，重放删除、撤销旧登录与旧密码、暂停新训练。失败保留新目标供排查，不影响原卷；不要手工删除关闭保护来开放失败实例。

恢复工具以 root 写入目标。成功后只调整这份新数据目录的属主，使网页用户可读取音频并写入新记录：

```sh
docker compose -p speak-recovery-01 -f docker-compose.recovery.yml --profile ops run --rm restore chown -R 1000:1000 /restore-data/recovered
docker compose -p speak-recovery-01 -f docker-compose.recovery.yml --profile ops run --rm restore node --import tsx scripts/restore-review.ts prepare /backups/latest-costs.json /control/worksheet.json
```

不要对原卷使用此命令。准备命令要求网页、worker 和其他数据库连接全部停止；输出文件必须尚不存在，检查表中的确认项、权限和金额默认未填写。源库不可读取时省略账本参数，直接在新数据目录准备检查表，再复制到私有 `/control` 供人工核对。

按 [备份恢复与回滚](备份恢复与回滚.md#开放前核对账号与费用) 逐一填写主机 `data/recovery-review/worksheet.json`：保留账号权限、包括待定调用的每月费用合计、部署与密钥配置、依据及是否开放新训练。最低已知费用不能下调；预算不会自动提高。脚本验证格式和已知下限，不能代替服务商账单核对。

```sh
docker compose -p speak-recovery-01 -f docker-compose.recovery.yml --profile ops run --rm restore node --import tsx scripts/restore-review.ts approve /control/worksheet.json
```

通过检查才解除数据库保护；重复提交相同检查表不会重复补记费用。临时凭据只写在新卷的 `/restore-data/recovered/restore-credentials.json`，不会打印密码。需要交付时可复制到私有控制目录，再通过可信渠道仅交给本人：

```sh
docker compose -p speak-recovery-01 -f docker-compose.recovery.yml --profile ops run --rm restore cp --no-clobber /restore-data/recovered/restore-credentials.json /control/restore-credentials.json
docker compose -p speak-recovery-01 -f docker-compose.recovery.yml --profile serve up -d --wait --wait-timeout 180 web worker
```

首次登录必须改密。恢复的个人 API Key 被清空，服务模式与月预算保留，需要本人重新填写或主动选择站点服务，不会静默改由站点付费。交付并改密后妥善处理私有临时凭据文件。

`ops` 和 `serve` 分别控制恢复工具与网页服务；默认 `up` 只启动数据库。显式提前启动网页仍会显示恢复检查提示，私有 API 和登录返回 503。文件标记丢失不能绕过数据库保护，未核对数据库也不能再次生成完整备份。

## 验收范围

2026-10-12 已在 Windows Docker Desktop 的 Linux 引擎完成实际构建、初始空库备份、迁移与网页/worker 启动；关闭测试源数据库后，使用新 PostgreSQL 实例与新数据卷完成冷恢复。保留的录音、报告、观点、词汇和复习可用，备份后删除的内容未复活，未核对实例保持关闭，费用补记和首次改密通过，恢复后新录音由实际 Linux worker 完成。还在新卷下载校验 Emma 模型并完成 Linux 合成，修复了语音准备试写镜像内配置的问题。全部使用合成账号、录音与模拟 AI，无新增付费调用；192 项单元及真实 PostgreSQL 集成检查通过。

每次实际演练记录镜像、源代码、数据库版本、项目/卷、恢复检查、费用与删除日志依据。完整产品还需容器考官音频完整流程与听感、公网 HTTPS、手机麦克风、真实付费服务及受邀用户验收。OSS 不能走本地完整备份流程，需独立对象备份与恢复演练。

2026-10-13 使用当前任务隔离版本再次在 Linux 引擎构建，并在源服务及源数据库停止后用独立 PostgreSQL 和独立应用卷恢复。未核对实例拒绝登录、私有 API、worker 和再次完整备份；移除测试文件标记仍不能绕过数据库保护。核对后旧凭据失效、首次改密、费用下限补记、个人预算保留、个人 Key 清空、删除重放、原录音 SHA-256 和分段回放、新观点及新上传的实际 FFmpeg/worker 流程通过。开放检查表为合成测试资料，不能代替真实事故中的人工费用核对。

最终分阶段镜像另通过上述开放流程、运行文件边界与只读自检。实际终止任务执行连接后后续写入被拒绝，释放连接后原查询也不能继续执行；七个配置专用队列存在，不同配置的 Linux worker 在领任务前退出。本轮 AI/TTS 都使用模拟服务，自检按预期提示两项模拟服务警告，其余 12 项通过；自然考官的既有独立 Linux 合成证据仍需与当前完整设备流程分开说明。手机步骤见 [Android 与 iPhone 双端实测](Android与iPhone双端实测.md)，目前均为待测。

配置依据：[Docker 构建缓存](https://docs.docker.com/build/cache/optimize/)、[Compose profiles](https://docs.docker.com/compose/how-tos/profiles/)、[Next.js standalone 输出及静态资源](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)。
