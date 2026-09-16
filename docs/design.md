# Codex Official Bridge — 最小核心流程

> 历史文档：本文仅描述首版 `BRIDGE_MODE=legacy` 的 app-server 适配方案。当前桌面服务使用 native 原始协议转发，详见 [architecture.md](architecture.md) 与 [快速交接](../HANDOFF.md)。下文“当前”“暂不支持”等措辞均指 legacy 阶段。

## 目标与边界

以未修改的官方 `codex app-server --listen stdio://` 为推理后端，提供限定范围的 `POST /v1/responses`。客户端执行工具，服务端保持待回答的 `item/tool/call`，下一次 HTTP 请求提交工具结果后继续同一官方回合。网关不读取或转发 OAuth token，不自行调用 ChatGPT 后端，不声称无法被上游识别。

用户授权：在工作台新建独立项目，实现最小流程。目标目录没有现成开发规范；参考已有 Trellis 跨层数据流指南。原项目脚本缺失，不向原项目创建任务或修改任何生产配置。

## 实现范围

- Node.js 20+，ES modules，零运行时第三方依赖。
- 单官方账号、单活动会话；loopback HTTP，Bearer Key 必填。
- 文本输入和输出；普通 JSON-schema `function` 工具；JSON 和 typed SSE 输出。
- 函数 `strict:true` 明确拒绝；省略与 false 统一使用官方实际发送的 false。
- 用量暂时返回 `usage:null`。官方 last 是最近一次推理，total 是线程累计，二者都不能直接当作每段 HTTP 响应的消耗。
- `previous_response_id` 续接：工具调用可跨 HTTP 请求等待；ID 仅在本进程内有效。
- 后续普通用户消息复用官方线程；工具表、模型、推理档位和 instructions 在线程内固定。
- 会话超时、客户端断连、子进程退出：明确失败并清理，避免重放副作用。
- 不支持字段/工具/多模态显式拒绝。暂不兼容原生 Codex 完整工具表、custom/freeform、WebSocket、`/responses/compact`、多账号、多用户或持久化恢复。
- 拒绝在服务端执行内置工具及审批；只允许注册的外部函数工具回传。

## 数据流与职责

`HTTP Responses → 请求验证 → 会话状态机 → stdio JSON-RPC → 官方 Codex → OpenAI`

`item/tool/call → function_call + response.completed → 本地工具 → function_call_output + previous_response_id → 原 JSON-RPC result → 同一 turn 继续`

HTTP response 完成不代表官方 turn 完成：工具等待时官方回合仍挂起。每个调用绑定 HTTP response ID、官方 thread/turn、RPC request ID、call_id。最小版一次返回一个外部调用；并行到达的调用排队，不能丢弃或改写成普通文本。

## 文件职责

- `src/rpc.mjs`：唯一 stdio JSONL 边界，子进程、RPC correlation、超时与退出。
- `src/protocol.mjs`：Responses 输入验证、工具定义、官方事件投影。
- `src/bridge.mjs`：线程/回合/工具等待状态，续接和取消。
- `src/server.mjs`、`src/main.mjs`：HTTP 鉴权、大小限制、SSE 和启动/退出。
- `scripts/`：隔离登录、状态检查、官方进程协议验证。
- `examples/tool-client.mjs`：客户端执行示例函数，提交结果，展示多轮闭环。
- `test/`：有状态协议桩、HTTP 端到端测试和子进程故障测试。
- `README.md`、`docs/validation.md`：启动方式、支持边界、实测结果。

## 验收

1. 文本与 SSE 均有正确终止事件，输出不冒充上游原始 Responses ID。
2. 工具调用在客户端执行，工具结果回复原 RPC ID，官方 turn 不重启。
3. 后续普通消息进入同一线程，无重复历史注入。
4. 不支持的工具、未知会话、错误 call_id、工具定义变更与并发请求明确拒绝。
5. 断连/超时/子进程死亡均终止等待，释放活动会话。
6. 自动化测试不调用付费模型；尽可能增加真实官方进程握手和受控上游验证。真实账号生成测试单独标记，不能将 mock 结果写成真实上游验证。

## 官方依据

- https://learn.chatgpt.com/docs/app-server
- 本机 `codex-cli 0.154.0-alpha.6.2` 生成的 schema：动态工具为实验字段，`thread/inject_items` 可追加原始历史，但本版用线程续接，不做任意历史同步。
