# Emma 虚拟考官头像

- 成品：`public/images/examiner-emma.webp`，512 × 512，WebP。
- 来源：此前内置 `image_gen` 已完成的独立头像；本轮复用，不重复生成。
- 原始生成文件不随源码分发；本仓库仅包含已处理的 WebP 素材。
- 参考：`02-播放录制台.png` 右上角虚拟考官窗口。
- 优化：Sharp 等比例缩至 512 × 512，WebP quality 86；未更改画面内容。
- 人物为生成的虚构成年女性，页面应标注“虚拟考官”。静态头像不表示实时视频通话。

## 可复现提示词

下列是依据已接受的参考图整理的复现提示词，非原调用逐字日志：

```text
Use case: photorealistic-natural
Asset type: square virtual examiner portrait for an IELTS speaking app.
Reference image: 02-播放录制台.png, specifically the small examiner portrait at the upper right; use it as visual guidance, not as a whole-page output.
Primary request: one fictional adult female virtual examiner, short brown hair, black over-ear headset with a small microphone, black blouse, looking directly toward the learner with a calm and naturally attentive expression.
Scene/backdrop: softly blurred warm gray office, neutral and understated.
Composition/framing: square head-and-shoulders portrait, full head and headset visible, centered face with comfortable padding.
Lighting/mood: soft natural window light, realistic skin texture, friendly and professional.
Constraints: portrait only; no UI, no lettering, no logo, no watermark, no border; do not depict a known real person.
```

## 检查

已逐图查看原始头像及项目 WebP：成年人物、耳麦、衣着和背景与参考一致，无文字或 UI 残留，512 px 输出清晰。
