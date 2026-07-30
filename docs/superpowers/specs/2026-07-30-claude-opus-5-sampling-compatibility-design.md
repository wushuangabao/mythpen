# Claude Opus 5 采样参数兼容性设计

## 背景

Mythpen 的 OpenAI-compatible 与 Anthropic 适配器会无条件发送 `temperature`。当前配置使用的 `claude-opus-5` 会拒绝非默认采样参数，代理返回 HTTP 400：`temperature is deprecated for this model`。

## 目标

- 对 `claude-opus-5`（包括带供应商前缀的模型名）省略 `temperature`。
- 同时覆盖 OpenAI-compatible 与 Anthropic 两条适配路径。
- 保持其他模型当前的温度行为不变。

## 非目标

- 不修改 API Key、接口地址、模型选择或数据库设置。
- 不以 `top_p`、`top_k` 替换 `temperature`。
- 按用户要求，不新增回归测试基础设施或测试文件。

## 设计

在 `server/ai-adapter.js` 集中定义一个纯模型能力判断函数。它规范化模型名，并识别末段为 `claude-opus-5` 的模型标识；匹配时返回“省略采样参数”。

OpenAI-compatible `complete`、OpenAI-compatible `stream`、Claude `complete` 与 Claude `stream` 在构造请求体时都使用此判断：

- 命中 Opus 5：请求体不含 `temperature`。
- 其他模型：保持现有默认值和调用方传入值。

这样不会向 Opus 5 发送任何替代采样参数，也不会改变 DeepSeek、OpenAI 或旧版 Claude 的创作随机性。

## 验证

- 运行静态检查与现有构建检查。
- 对配置的 OpenAI-compatible Claude Opus 5 代理进行一次最小请求，确认不再返回 `temperature` 相关的 HTTP 400。
- 不执行会写入小说项目内容的续写探测。
