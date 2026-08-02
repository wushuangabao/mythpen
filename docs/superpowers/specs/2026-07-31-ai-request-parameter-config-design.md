# AI 请求参数配置设计

## 背景

Mythpen 当前在 `server/ai-adapter.js` 中直接构造 OpenAI-compatible 与 Anthropic Claude 请求。`temperature`、`max_tokens` 等参数由代码固定生成，模型兼容例外也写在代码中。此前 `claude-opus-5` 需要省略 `temperature`，随后 `kimi-k3` 又因只接受固定采样参数而返回 HTTP 400。这说明继续按模型增加硬编码判断难以维护。

本设计将可调的顶层 API 参数改为用户可编辑、按模型匹配的数据配置，同时保留 Mythpen 对协议结构、工具循环和流式响应的控制权。

## 目标

- 在当前 Mythpen 数据目录中提供用户可编辑的 `ai-request-parameters.json`。
- 支持为任意模型增加或覆盖普通顶层 API 参数。
- 支持显式删除不得发送的参数。
- 同时覆盖 OpenAI-compatible 和 Anthropic Claude 的非流式、流式请求。
- 配置修改后无需重启，在下一次新建 AI 请求时生效。
- 配置损坏时继续使用最后一次有效配置或内置默认配置。
- 用配置替代现有 Claude Opus 5 硬编码例外，并内置 Kimi K3 兼容规则。

## 非目标

- 不允许配置接管 `model`、消息、工具或流式协议结构。
- 不修改 API Key、API URL、接口类型或模型选择的数据库设置。
- 不修改设置页“测试连接”的请求地址、参数或成功判定。
- 不在运行中的同一次工具循环里切换配置快照。
- 不调用真实 AI 接口进行自动化测试。
- 不为已有用户配置自动合并未来版本新增的模型规则。

## 权威文档

进入实现后，第一项改动必须创建 `docs/ai-request-parameters.md`。该文件是用户和后续实现维护者理解此功能的权威来源，必须写清：

- 配置文件位置与首次生成行为；
- 热加载触发点和生效边界；
- 完整 JSON 结构；
- 模型与接口类型匹配规则；
- 参数合并顺序；
- `params`、`omit` 和操作级覆盖语义；
- 受保护字段；
- 校验失败与回退行为；
- Claude Opus 5、Kimi K3 及自定义参数示例。

实现代码、默认配置和测试必须与该文档保持一致。

## 配置位置与生命周期

配置文件固定为：

```text
<当前 Mythpen 数据目录>/ai-request-parameters.json
```

“当前 Mythpen 数据目录”沿用 `server/storage-paths.js` 的解析结果，因此配置会随现有数据目录迁移流程一起复制，也不会因应用升级被覆盖。

配置文件不存在时，服务使用内置默认配置创建一份 UTF-8、带缩进并以换行结尾的 JSON 文件。创建只发生在文件不存在时，不覆盖已有文件。

用户主动删除配置文件后，下一次新建 AI 请求会重新生成默认文件。

## 配置结构

默认配置采用以下结构：

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

### 顶层字段

- `version`：必填整数，首版固定为 `1`。
- `defaults`：所有模型共享的默认参数。
- `models`：模型规则数组。

### 参数作用域

`defaults` 和每条模型规则均可包含：

- `params`：适用于 `complete` 与 `stream` 的公共参数。
- `omit`：最终必须从请求体删除的公共参数名数组。
- `operations.complete`：仅作用于上游非流式请求。
- `operations.stream`：仅作用于上游流式请求。

每个操作级对象同样可包含 `params` 和 `omit`。

`params` 中的值可以是任意合法 JSON 值。参数以顶层键为单位覆盖；如果值是对象或数组，会整体替换，不进行深层合并。例如配置新的 `thinking` 对象时，不会保留较低优先级 `thinking` 中的子字段。

`omit` 专门表达“不发送此参数”，不能用 `null` 代替。`null` 是合法 JSON 值，放入 `params` 时会作为真实参数值发送。

## 模型匹配

每条模型规则的 `match` 包含：

- `models`：一个或多个模型标识，必填。
- `apiTypes`：可选，仅允许 `openai` 和 `claude`；省略时可匹配两种接口类型。

`apiTypes` 匹配 Adapter 最终解析出的 Provider 类型，而不是数据库中可能为空的原始 `api_type`。因此自动检测出的 Claude 模型按 `claude` 匹配，显式配置为 OpenAI-compatible 的 Claude 代理按 `openai` 匹配。

匹配前对请求模型名和配置模型名执行：

1. 转成字符串；
2. 去除首尾空格；
3. 转成小写；
4. 同时保留完整标识和最后一个 `/` 后的末段标识。

规则使用精确匹配，不支持前缀、通配符或正则表达式。例如 `vendor/kimi-k3` 可以命中 `kimi-k3`，但 `kimi-k3-preview` 不会命中，必须显式写入 `models`。

同一个请求最多只能命中一条规则。配置校验会拒绝在重叠接口类型下重复声明相同模型标识，避免依赖规则顺序产生隐式优先级。

## 参数合并顺序

请求参数按以下顺序生成，后面的步骤覆盖前面的同名普通参数：

1. Mythpen 构造的协议请求体；
2. `defaults.params`；
3. `defaults.operations.<operation>.params`；
4. 调用方传入的运行时参数，例如路由传入的 `temperature`；
5. 命中模型规则的 `params`；
6. 命中模型规则的 `operations.<operation>.params`；
7. 删除全局和模型规则在公共、操作级 `omit` 中列出的参数。

`omit` 始终最后执行，因此模型兼容规则不会被路由传入的 `temperature` 重新覆盖。

## 受保护字段

以下字段与 Mythpen 协议实现、响应解析或工具循环强耦合，不允许出现在任何 `params` 或 `omit` 中：

- `model`
- `messages`
- `system`
- `tools`
- `stream`

OpenAI-compatible 与 Anthropic Claude 的请求结构不同，但共享相同的可调参数解析结果。Provider 仍负责生成自己的消息、工具和流式字段。

## 热加载

不使用 `fs.watch`。配置在每次调用 `createAIAdapter` 时按需检查：

1. 获取配置文件的 `mtimeMs` 和文件大小；
2. 与内存缓存中最后一次成功加载的文件签名比较；
3. 签名未变化时直接复用缓存；
4. 签名变化时读取 UTF-8 JSON，并执行完整校验；
5. 校验成功后原子替换内存中的有效配置；
6. 校验失败时保留原有效配置。

配置快照在 Adapter 创建时确定。同一个 `/api/ai/chat/stream` 工具循环中的所有上游调用使用同一快照，即使用户在循环执行期间修改文件，也只会影响下一次新请求。

同步的文件状态检查和读取发生在请求边界，配置文件体积很小，不引入后台监听器、定时器或第三方依赖。

## 校验与安全回退

加载器必须校验：

- 顶层值、`defaults`、模型规则、`params` 和操作配置均为普通 JSON 对象；
- `version` 等于 `1`；
- `models`、`apiTypes` 和 `omit` 为符合约束的字符串数组；
- 每条规则具有非空 `name` 和至少一个非空模型标识；
- `apiTypes` 仅包含受支持类型；
- 没有重复或重叠的模型匹配；
- `params` 和 `omit` 不包含受保护字段；
- 参数名不允许 `__proto__`、`prototype` 或 `constructor`；
- 配置中不存在无法识别的结构字段。

加载失败时：

- 如果进程内已有成功加载的用户配置，继续使用该配置；
- 如果服务启动后尚未成功加载用户配置，使用编译进程序的内置默认配置；
- 输出包含配置路径和具体失败原因的服务端警告；
- 不覆盖、删除或自动修正用户的错误文件；
- 后续每次新请求继续尝试加载，用户修正后即可恢复；
- 对同一失败文件签名抑制重复警告，文件再次变化后重新报告。

读取或校验成功后，解析结果作为独立快照保存；请求合并不得修改默认配置、规则对象或其他请求的参数对象。

## 内置配置与升级

程序中保留与首次生成文件完全一致的内置默认配置，用于：

- 首次创建外部配置文件；
- 外部配置在冷启动时无效的安全回退；
- 打包为单文件 sidecar 时保证基础兼容规则始终可用。

已有外部配置不会在升级时自动覆盖或合并。未来若需要自动迁移，应通过递增 `version` 另行设计；首版只接受 `version: 1`。

## 组件边界

建议新增独立模块负责：

- 定义内置默认配置和受保护字段；
- 解析、校验并规范化用户配置；
- 按模型、接口类型和操作解析最终普通参数；
- 管理文件签名、最后一次有效配置和失败日志抑制；
- 在数据目录中确保默认配置文件存在。

`server/ai-adapter.js` 只消费该模块提供的配置快照和参数解析结果，不直接读取文件或包含模型特判。

配置模块不管理 API URL、认证头、响应转换、工具执行或项目数据。

## 测试

使用 Node 内置 `node:test` 编写纯本地测试，不访问真实模型接口。

测试至少覆盖：

- 默认配置生成与文件已存在时不覆盖；
- 未知模型的 `complete`、`stream` 默认参数；
- Claude Opus 5 和 Kimi K3 省略 `temperature`；
- 大小写、空格、供应商前缀和接口类型匹配；
- 公共参数、操作参数和调用方参数的合并优先级；
- `omit` 的最终优先级；
- 任意新增参数及嵌套 JSON 值的整体覆盖；
- 受保护字段和危险键被拒绝；
- 重复模型规则被拒绝；
- 文件变化后下一次 Adapter 创建加载新配置；
- 无效热加载保留最后一次有效配置；
- 冷启动无效配置回退至内置默认配置；
- 同一 Adapter 使用固定配置快照；
- 多次请求不会污染共享配置对象；
- OpenAI-compatible 和 Anthropic Claude 的 `complete`、`stream` 四条路径均使用统一解析结果。

验证命令包括：

```bash
node server/tests/ai-request-parameters.test.js
pnpm test:server
pnpm tsc --project tsconfig.app.json --noEmit
pnpm lint
```

同时运行语法检查和 sidecar 构建验证，确认外部配置生成逻辑及内置默认配置可被发行构建正常包含。

## 验收标准

- 数据目录中能获得可编辑的 `ai-request-parameters.json`。
- 修改有效配置后，下一次新 AI 请求使用新参数，无需重启。
- Claude Opus 5 与 Kimi K3 请求不包含 `temperature`。
- 用户能够通过 `params` 增加或覆盖普通顶层 API 参数。
- 用户能够通过 `omit` 删除普通顶层 API 参数。
- 受保护字段无法被覆盖或删除。
- 无效配置不会中断原本可工作的 AI 请求。
- “测试连接”代码保持不变。
- 权威文档、默认配置、实现和测试描述一致。
