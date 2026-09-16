# 原生 Codex 客户端兼容性核验

> 历史文档：本文记录 legacy 方案的协议缺口，解释后来为何改造服务端。当前 native 网关已完成原生工具、真实桌面配置和 V2 压缩验证；当前设计见 [architecture.md](architecture.md)，验证边界见 [validation.md](validation.md)。下文“当前最小桥”均指当时的 legacy 实现。

核验日期：2026-09-16。二进制：`codex-cli 0.154.0-alpha.6.2`。

## 结论

当前最小桥可供项目示例客户端使用，但不能仅靠修改桌面 Codex 的 `base_url` / API key 变成可用的原生 Codex 后端。真实 CLI 的首个请求即超出本桥合同；即使关闭已知可关闭的内置工具，仍出现语法型 `custom` 工具。

官方 app-server 的 `thread/start.dynamicTools` 当前只能表达 `function`，以及内部只含 `function` 的 `namespace`。它不能无损表示下面捕获到的 `custom` / grammar 工具。将它们删掉、包装成普通 function 或改写成提示词都会改变语义，不能作为地址配置的隐含步骤。

## 验证方式

- 使用真实、未修改的官方 `codex exec`，为每次测试新建临时 `CODEX_HOME` 和空工作目录。
- 自定义 model provider 只指向 `127.0.0.1` 的受控 Responses 服务，`requires_openai_auth=false`；不登录、不加载真实凭据。
- 使用 `--ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check --sandbox read-only --strict-config`。
- 应用项目 `src/runtime.mjs` 中的全部 `ISOLATED_CONFIG`，并关闭 `features.enable_request_compression`，以读取本地请求的 JSON 结构。
- 本地服务只返回固定测试文本；两个模型选项下的 CLI 均以 exit code 0 结束。未向真实 OpenAI 请求推理。
- 本文仅记录字段、类型和工具名；不保留输入文本、完整指令、请求头或密钥。临时目录已清理。

## 捕获结果

### CLI 模型选项 `gpt-5.6-sol`

请求路径：`POST /v1/responses`。

顶层字段：

```text
model, input, tool_choice, parallel_tool_calls, reasoning, store, stream,
include, prompt_cache_key, text, client_metadata
```

没有顶层 `tools`。工具位于 `input[0]`：该 item 的类型是 `additional_tools`，role 为 `developer`，包含 `id` 和 `tools`。

| namespace | 工具类型 | 工具名 | 额外形状 |
|---|---|---|---|
| functions | custom | exec | format.type = grammar |
| functions | function | wait | strict = false |
| collaboration | function | followup_task | strict = false |
| collaboration | function | interrupt_agent | strict = false |
| collaboration | function | list_agents | strict = false |
| collaboration | function | send_message | strict = false |
| collaboration | function | spawn_agent | strict = false |
| collaboration | function | wait_agent | strict = false |

其余 input 为四条 developer message 和两条 user message，均含 `id`，内容 part 类型为 `input_text`。`reasoning` 包含 `effort` 和 `context`。请求没有 `previous_response_id`。

### CLI 模型选项 `gpt-5.4`

请求路径相同。顶层字段：

```text
model, instructions, input, tools, tool_choice, parallel_tool_calls,
reasoning, store, stream, include, prompt_cache_key, text, client_metadata
```

顶层 `tools` 仍包含一个工具：

| 工具类型 | 工具名 | 额外形状 |
|---|---|---|
| custom | apply_patch | format.type = grammar |

input 包含一条 developer message 和两条 user message；`reasoning` 包含 `effort`。

### 共同的接口差异

已直接将捕获的请求交给当前 `validateRequest`：首个错误是 `unsupported_field`，`param=tool_choice`。

这只是第一层错误。继续放宽顶层字段仍不能解决：

- 原生客户端发送多条带角色和 ID 的 input；本桥只支持单条 user 文本，续接依赖桥接生成的 `previous_response_id`。
- 原生请求带 `include=["reasoning.encrypted_content"]`；本桥目前不回传原始加密 reasoning。
- `additional_tools`、namespace、custom grammar 工具均超出当前桥接输入合同。
- `tool_choice`、`parallel_tool_calls`、`text.verbosity`、推理 context 等不能为了通过校验而静默丢弃。
- 当前验证是首请求的真实线协议捕获，尚未验证原生客户端多回合、工具结果历史和 compaction；不能据此声称完整兼容。

## 最短可行路径

当前版本的真实账号功能验证应使用 `examples/tool-client.mjs` 或遵循本桥明确合同的客户端。这能验证官方账号登录、真实官方上游、文本返回和客户端 function 工具闭环。

桌面 Codex 指向该地址只能验证网络到达，并会收到明确的 400；不能算任务完成。原生桌面适配属于下一项协议工作，需要先明确处理 custom grammar 工具的机制，再保留角色历史、命名空间、reasoning 和生命周期语义。当前官方 dynamicTools 能力不足以承诺该机制；不要把现有配置开关描述为已解决。

## 依据

- 本机真实 CLI 对 loopback 的请求形状捕获。
- 本机 app-server stable / experimental JSON schema：`DynamicToolSpec`、`DynamicToolNamespaceTool`、`ThreadInjectItemsParams`。
- [官方 app-server 文档](https://learn.chatgpt.com/docs/app-server)：动态工具与原始历史注入是不同接口；后者不能补齐工具定义能力。
