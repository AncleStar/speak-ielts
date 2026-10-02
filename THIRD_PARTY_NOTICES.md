# 第三方内容与许可

项目自有源码按根目录 `LICENSE` 的 MIT 许可证分发。以下内容仍适用各自原始许可，根目录许可证不替代第三方声明。

- **RhineLabUI**：基于 [LBEILC/RhineLabUI](https://github.com/LBEILC/RhineLabUI)，参考提交 `ee5779741c6c0c916e416705fa634c7abf905c73`。适配代码位于 `components/disc/rhine/`，模型位于 `public/models/rhine/`。保留 `public/licenses/rhine-lab-ui.txt` 的版权与 MIT 全文。SPEAK 标签和业务交互是本项目适配，不代表上游作者参与或背书。
- **MiSans 字体**：遵循 `public/fonts/MiSans-license.pdf` 及 `public/fonts/misans-webfont-4.3.1/UPSTREAM-README.md`。字体不因本项目 MIT 许可而重新授权。
- **Kokoro 模型与音色**：运行 `npm run setup:voice` 后从 [模型仓库](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) 下载；权重缓存不随源码分发。使用及再分发权重时核对模型仓库对应版本的许可。
- **Emma 头像**：AI 生成的虚构成年人物，经处理用于虚拟考官窗口，不是用户照片或真人视频。素材说明见 `docs/design/rhine-disc-v1/avatar-prompt.md`。
- **npm 依赖**：由 `package-lock.json` 固定版本，保留各软件包附带的许可证；`node_modules/` 不随源码包分发。
- **雅思题库**：本项目原创 AI 草稿用于练习，非官方试题、非官方评分服务；来源与人工审核流程见 `docs/题库与资料来源.md`。
