# AI 请求参数配置

Mythpen 通过数据目录中的 `ai-request-parameters.json` 控制发送给模型的普通顶层 API 参数。本文件是该配置格式与运行行为的权威说明。

## 配置文件位置

配置文件位于：

```text
<当前 Mythpen 数据目录>/ai-request-parameters.json
```

数据目录由 `MYTHPEN_DATA_DIR`、Mythpen 数据目录设置或默认的 `<用户目录>/.mythpen` 决定。配置文件会随整个数据目录迁移，并且不会在应用升级时覆盖已有内容。

文件不存在时，下一次创建 AI 请求会生成默认配置。用户删除文件后，下一次请求会重新生成默认配置。

## 热加载

Mythpen 不使用文件监听器。每次创建新的 AI Adapter 时检查文件的修改时间与大小；文件变化后重新读取、解析和校验。

- 有效修改：从下一次新请求开始生效。
- 无效修改：继续使用最后一次有效配置。
- 冷启动时配置无效：使用程序内置默认配置。
- 同一次工具调用循环固定使用创建 Adapter 时的配置快照。

配置路径必须是普通文件，文件大小最多为 1 MiB（1,048,576 bytes）。目录、管道、设备等非普通条目（包括指向这类条目的链接）不会被读取；超限文件、打开或有界读取失败，以及读取期间发生变化的文件也不会被接受。这些情况均继续使用最后一次有效配置；冷启动时没有有效配置可用，则回退到程序内置默认配置。

配置错误会写入服务端日志，但 Mythpen 不覆盖或自动修复错误文件。修正文件后，后续新请求会再次尝试加载。

## 默认配置

```json
{
  "version": 1,
  "defaults": {
    "params": {
      "max_tokens": 4096
    },
    "operations": {
      "complete": {
        "params": {
          "temperature": 0.8
        }
      },
      "stream": {
        "params": {
          "temperature": 0.85
        }
      }
    }
  },
  "models": [
    {
      "name": "Claude Opus 5",
      "match": {
        "models": ["claude-opus-5"],
        "apiTypes": ["openai", "claude"]
      },
      "params": {},
      "omit": ["temperature"]
    },
    {
      "name": "Kimi K3",
      "match": {
        "models": ["kimi-k3", "kimi-k3-preview"],
        "apiTypes": ["openai"]
      },
      "params": {},
      "omit": ["temperature"]
    }
  ]
}
```

`version` 必须是 `1`。JSON 不支持注释。

## 配置结构

`defaults` 与每条模型规则都可以包含：

- `params`：同时作用于非流式与流式请求。
- `omit`：最终删除的参数名。
- `operations.complete`：仅作用于上游非流式请求。
- `operations.stream`：仅作用于上游流式请求。

操作配置也可以包含 `params` 和 `omit`。

`params` 可以保存任意合法 JSON 值，并以顶层参数为单位覆盖。对象和数组整体替换，不进行深层合并。`null` 会作为真实值发送；如需不发送参数，必须将名称放进 `omit`。

## 模型匹配

`match.models` 是非空模型标识数组。`match.apiTypes` 可以省略，或填写 `openai`、`claude`。

模型名匹配忽略大小写和首尾空格，同时检查完整标识及最后一个 `/` 后的末段。例如 `vendor/kimi-k3` 可以命中 `kimi-k3`，但 `kimi-k3-preview` 不会命中。版本化模型必须显式列入 `models`。

`apiTypes` 使用 Adapter 最终解析出的 Provider。自动识别的 Claude 使用 `claude`；配置为 OpenAI-compatible 的 Claude 代理使用 `openai`。

多条规则不能在相同接口类型下匹配同一模型。

## 合并顺序

同名参数按以下顺序覆盖：

1. Mythpen 协议请求体；
2. `defaults.params`；
3. `defaults.operations.<operation>.params`；
4. 调用方运行时参数；
5. 模型规则 `params`；
6. 模型规则 `operations.<operation>.params`；
7. 删除全部公共及操作级 `omit` 参数。

因此 `omit` 的优先级最高。

## 受保护字段

以下协议结构字段不能出现在 `params` 或 `omit` 中：

- `model`
- `messages`
- `system`
- `tools`
- `stream`

## 自定义示例

要给 Kimi K3 指定推理强度，应编辑已有的 Kimi K3 规则，不要新增第二条重复规则：

```json
{
  "name": "Kimi K3",
  "match": {
    "models": ["kimi-k3", "kimi-k3-preview"],
    "apiTypes": ["openai"]
  },
  "params": {
    "reasoning_effort": "high"
  },
  "omit": ["temperature"]
}
```

仅为流式续写增加参数：

```json
{
  "name": "Example Model",
  "match": {
    "models": ["example-model"],
    "apiTypes": ["openai"]
  },
  "operations": {
    "stream": {
      "params": {
        "stream_options": {
          "include_usage": true
        }
      }
    }
  }
}
```

## 错误处理

以下情况会使整个新配置失效并回退：

- 配置路径不是普通文件，或文件超过 1 MiB（1,048,576 bytes）；
- 文件无法安全打开或读取，或在读取期间发生变化；
- JSON 语法错误或 `version` 不受支持；
- 未知结构字段；
- 对象、数组或字符串字段类型不正确；
- 空模型标识、未知接口类型或重复匹配；
- 使用受保护字段；
- 顶层参数名使用 `__proto__`、`prototype` 或 `constructor`。

Mythpen 不会在加载失败时修改用户文件。
