---
name: image-gen-guide
description: 使用图片/视频生成工具时必读。包含工具参数、非阻塞工作流、任务路由。
---

# 媒体生成工具指南

## 非阻塞工作流

生成是异步的。提交后工具立即返回媒体生成占位块，你**不需要等待结果**，也**不需要调用 stage_files**。图片/视频文件由 image-gen 插件在后台完成时登记为 SessionFile；占位块完成后会被真实 SessionFile 媒体块原地替换，文件生命周期仍归 SessionFile 管。

1. 调用工具，传入 prompt 和参数
2. **告诉用户正在生成，完成后会自动显示**
3. **继续对话**，不要等待
4. 生成完成由 UI 原地替换占位，Bridge 会按当前会话体验自动发送媒体；不要等待后台完成，也不要因为完成结果打断接下来的回复

## 工具参数

### image-gen_generate-image

- `prompt`（必填）：图片描述，中英文均可
- `count`：并发生成张数（1-9），用户说"多来几张"/"再抽几张"时用
- `image`：参考图路径（图生图、图片编辑、风格迁移时传入）
- `ratio`：长宽比（1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 21:9）
- `resolution`：统一分辨率档位（1k, 2k, 4k），adapter 会映射为供应商最接近的尺寸
- `quality`：画质（low, medium, high, auto）
- `provider`：指定生图 provider（可选，默认自动选择）。可用 provider 来自 Hana Provider Registry 的 `media.imageGeneration` capability，不从聊天模型列表推断

### image-gen_generate-video

- `prompt`（必填）：视频描述，中英文均可
- `image`：参考图路径（图生视频）
- `duration`：时长（秒）
- `ratio`：长宽比
- `provider`：指定 provider（可选）

## 任务路由

| 用户意图 | 示例 | 工具 | 备注 |
|---------|------|------|------|
| 凭空生成图片 | "画一只猫" | generate-image | prompt 描述画面 |
| 编辑/修改图片 | "把帽子去掉" | generate-image + image 参数 | prompt 写编辑指令 |
| 参考图生新图 | "参考这个风格画一套icon" | generate-image + image 参数 | prompt 说明参考什么 + 要生成什么 |
| 生成视频 | "做一个猫的短视频" | generate-video | prompt 描述画面和运动 |
| 图片变视频 | "让这张图动起来" | generate-video + image 参数 | prompt 描述运动和变化 |
| 不是生成请求 | "这张图画的是什么" | 不调用 | 只是看图/聊天 |

## 注意

- 生成消耗 provider 额度，大批量前建议提醒用户
- 不同 provider 支持的参数不同，工具会按 provider 的媒体能力和 adapter 处理
- Provider 可能来自内置 provider、插件贡献，或 CLI wrapper。不要假设它一定是聊天 provider
- 视频生成通常比图片慢（几十秒到几分钟），但同样不阻塞
- 图中需要出现文字时，把文字内容放在**双引号**里
