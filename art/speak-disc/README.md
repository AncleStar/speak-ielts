# SPEAK 训练磁盘与播放底座

v1 盘体和底座由本机 Blender 脚本生成，形状参考已生成的 SPEAK 页面稿。v1 没有导入上游 GLB、角色、标志或音乐。当前 v2 网页盘体及下述高清缩略图使用经 MIT 许可的 RhineLabUI 模型，来源与 v1 分开记录。

## 当前记录与主页缩略图（2026-10-01）

`render_record.py` 导入 `public/models/rhine/archive-cassette.glb`，删除原品牌印刷与压字、替换为 SPEAK / AUDIO 标签，以 Cycles / OPTIX 渲染透明底 1200×1200 PNG。保留双光学环、透明外壳、金属边缘、螺钉和光学走线；网页采用 900×900 WebP（38,960 字节），用于管理员和普通用户共用的个人主页、学习记录及 3D 不可用时的回退。

- 源工程：`record-disc-v2.blend`（本地生成，不随源码分发）。
- 可重现脚本：`render_record.py`；使用 `--background --factory-startup --python-exit-code 1 --python` 执行。
- 输出：`../../public/models/rhine/record-disc.png`、`record-disc.webp`。WebP 用 Sharp 调整为 900×900，quality 94、alphaQuality 100。
- 上游：<https://github.com/LBEILC/RhineLabUI>，提交 `ee5779741c6c0c916e416705fa634c7abf905c73`，版权及 MIT 许可见 `../../public/licenses/rhine-lab-ui.txt`。
- v3 曾复用 v1 的 `playback-deck.glb` 底座。按用户后续要求，v4 已移除插盘、底座及新增的双环旋转，面试与回放保留原盘体展示；v1 底座仅作为源资产存档。网页渲染性能与静态 Cycles 图不同。

## v1 源资产存档

文件：

- `speak-disc-v1.blend`：脚本生成的带材质、灯光和相机的工程，不随源码分发。
- `disc-and-deck-preview.png`：Blender Cycles 渲染，和 Image Gen 页面稿区分。
- `build_disc.py`：可重复执行的建模、导出和预览脚本。
- `asset-report.json`：文件大小、三角面数量、运行时节点清单。
- `check_assets.py` / `verification.json`：GLB 结构、独立导入与交互节点检查；不代表浏览器帧率或手机通过。
- `../../public/models/speak-disc/v1/training-disc.glb`：可复用训练盘/个人记录盘。
- `../../public/models/speak-disc/v1/playback-deck.glb`：播放录制底座。

本轮验证：Blender 5.2.2 LTS，Cycles/OPTIX 已渲染并检查模型完整入镜。训练盘 841,904 字节、18,100 个三角面、15 个网格；底座 185,256 字节、3,812 个三角面、6 个网格。两个 GLB 均通过独立 Blender 重新导入、关键节点和外部依赖检查；合计约 1.03 MB（十进制）。浏览器交互和手机性能尚未验证。

## 重新生成

将 Blender 加入 PATH 后，在项目根目录执行。脚本使用新的后台场景，不打开或修改正在编辑的工程。

```powershell
blender --background --factory-startup --python-exit-code 1 --python art/speak-disc/build_disc.py
blender --background --factory-startup --python-exit-code 1 --python art/speak-disc/check_assets.py
```

Blender 源坐标以 Z 向上，正面朝 -Y；GLB 已转换为网页常用的 Y 向上，正面朝 +Z。盘底处于原点，底座的 `Deck_InsertAnchor` 给出盘底插入位置。源文件中盘已摆放到底座上，单独导出的训练盘仍保持底部原点。

## 前端接入约定

| 节点 | 用途 |
| --- | --- |
| `TrainingDisc` | 整盘插入、抽出、选中动画 |
| `Disc_ReelLarge` / `Disc_ReelSmall` | 独立双环旋转；glTF 中绕本地 Z 轴 |
| `Disc_FrontCover` | 透明前盖，必要时简化材质 |
| `Disc_LabelSurface` / `Disc_LabelAnchor` | 运行时显示题目或记录编号；公共 GLB 不写入私人信息 |
| `Disc_CategoryAccent` | 题型或个人记录分类色；修改时克隆共享材质以免影响其他零件 |
| `PlaybackDeck` | 底座整体 |
| `Deck_InsertAnchor` | 插盘对齐位置 |
| `Deck_RecordLED` | 仅在真实麦克风正在录制时点亮，停止/上传时熄灭 |

材质使用 glTF 可导出的 Principled BSDF。透明件包含 `KHR_materials_transmission`；面向低性能设备时应提供关闭透射的替代材质。没有外部纹理或字体加载依赖；模型中的英文标记已经转换为网格。

当前是静态模型和可控制节点，不包含已接好的动画、麦克风监听或考试逻辑。后续需要在 Three.js 中读取节点，按现有业务状态更新；时间限制继续由会话逻辑决定。阵列应复用材质和几何、只渲染可见的磁盘，避免为全部题目持续创建独立渲染资源。

生成器可使用 OPTIX 进行预览；这不代表浏览器或手机上具有同等画质与性能。参考导出接口：[Blender 官方 glTF API](https://docs.blender.org/api/main/bpy.ops.export_scene.html)。
