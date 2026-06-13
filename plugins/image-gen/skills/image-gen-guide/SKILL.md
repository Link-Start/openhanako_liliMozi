---
name: image-gen-guide
description: 使用图片/视频生成工具时必读。包含工具参数、非阻塞工作流、任务路由。
---

# 媒体生成工具指南

## 非阻塞工作流

生成是异步的。提交后工具立即返回媒体生成占位块，你**不需要等待结果**，也**不需要调用 stage_files**。图片/视频文件由 Hana 原生 Media Manager 在后台完成时登记为 SessionFile；占位块完成后会被真实 SessionFile 媒体块原地替换，文件生命周期仍归 SessionFile 管。

1. 调用工具，传入 prompt 和参数
2. **告诉用户正在生成，完成后会自动显示**
3. **继续对话**，不要等待
4. 生成完成由 UI 原地替换占位，Bridge 会按当前会话体验自动发送媒体；不要等待后台完成，也不要因为完成结果打断接下来的回复

## 工具参数

### image-gen_generate-image

- `prompt`（必填）：图片描述，中英文均可
- `count`：并发生成张数（1-9），用户说"多来几张"/"再抽几张"时用
- `image`：参考图路径（图生图、图片编辑、风格迁移时传入）
- `referenceImages`：多张参考图路径数组。用户明确给了多张参考图时使用它；只有一张参考图时继续用 `image` 也可以。最终可用张数由所选模型 mode 的 `inputLimits.referenceImages` 声明把关
- `ratio`：长宽比（1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 21:9）
- `resolution`：统一分辨率档位（1k, 2k, 4k），adapter 会映射为供应商最接近的尺寸
- `quality`：画质（low, medium, high, auto）
- `provider`：指定生图 provider（可选，默认自动选择）。可用 provider 来自 Hana Provider Registry 的 `media.imageGeneration` capability，不从聊天模型列表推断
- `model`：指定生图模型（可选）
- `mode`：指定供应商模式（可选，如 text2image / image2image）
- `options`：供应商专属可选参数。普通生成不要主动填；用户明确要求高级参数，或默认值不满足请求时，先调用 `image-gen_describe-media-options`

### image-gen_generate-video

- `prompt`（必填）：视频描述，中英文均可
- `image`：参考图路径（图生视频）
- `duration`：时长（秒）
- `ratio`：长宽比
- `provider`：指定 provider（可选）
- `model`：指定视频模型（可选）
- `mode`：指定供应商模式（可选，如 text2video / image2video）
- `resolution`：统一分辨率或供应商分辨率档位（可选）
- `options`：供应商专属可选参数。普通生成不要主动填；用户要求 1080p、特定格式、特殊模式等高级参数时，先调用 `image-gen_describe-media-options`

### image-gen_describe-media-options

无副作用参数查询工具。用于查看当前已安装 provider、模型、模式、参考图限制和供应商专属参数 schema。

- `kind`（必填）：`image` 或 `video`
- `provider`：provider id（可选）
- `model`：模型 id（可选）
- `mode`：模式 id（可选）

默认策略：用户只说“生成图片/视频”时，直接调用生成工具，只传 prompt 和必要图片；用户提出明确高级约束，或你不知道某 provider/model/mode 支持哪些参数、是否支持参考图时，先查询 options，再把确认过的字段放进生成工具的 `options`。

## 任务路由

| 用户意图 | 示例 | 工具 | 备注 |
|---------|------|------|------|
| 凭空生成图片 | "画一只猫" | generate-image | prompt 描述画面 |
| 编辑/修改图片 | "把帽子去掉" | generate-image + image 参数 | prompt 写编辑指令 |
| 参考图生新图 | "参考这个风格画一套icon" | generate-image + image 参数 | prompt 说明参考什么 + 要生成什么 |
| 多参考图融合 | "参考这三张做一个统一风格封面" | generate-image + referenceImages 参数 | prompt 说明每张参考图承担的角色 |
| 生成视频 | "做一个猫的短视频" | generate-video | prompt 描述画面和运动 |
| 图片变视频 | "让这张图动起来" | generate-video + image 参数 | prompt 描述运动和变化 |
| 高级参数视频 | "用即梦生成 1080p 竖屏 8 秒视频" | describe-media-options → generate-video | 先查模型/模式支持，再填 `options` |
| 不是生成请求 | "这张图画的是什么" | 不调用 | 只是看图/聊天 |

## 注意

- 生成消耗 provider 额度，大批量前建议提醒用户
- 不同 provider、同一 provider 的不同模型、同一模型的不同 mode 都可能支持不同参数。不要把参数当 provider 级能力；先看 `describe-media-options` 返回的 model/mode schema
- Provider 可能来自内置 provider、插件贡献，或 CLI wrapper。不要假设它一定是聊天 provider
- 视频生成通常比图片慢（几十秒到几分钟），但同样不阻塞
- 图中需要出现文字时，把文字内容放在**双引号**里
