# Legacy app-server 函数桥接（历史原型）

一个验证核心流程的最小原型：接收限定范围的 Responses 请求，由**未修改的官方 `codex app-server`** 管理推理会话；模型发起的外部函数调用返回客户端执行，客户端提交结果后继续原来的官方回合。

当前目标是证明“官方进程作为实际出口，工具在客户端执行”这条链路可以工作。**这还不是可直接替换 CPA、供原生 Codex CLI 完整使用的后端。** 原生客户端的完整工具表、历史同步和压缩协议尚未适配。

## 核心流程

```text
本地示例客户端                         网关与官方 Codex
    │                                      │
    ├─ POST /v1/responses ────────────────→ 网关
    │   用户文本 + function 工具定义          └─ 官方 app-server 启动 thread / turn
    │                                             │
    │                                      官方进程访问模型上游
    │                                             │
    │                                      收到 item/tool/call，保持 RPC 挂起
    │←─ function_call + response.completed ────────┤
    │                                      │
    ├─ 在客户端读取本地文件                  │
    ├─ previous_response_id                │
    │  + function_call_output ────────────→┤
    │                                      └─ 回复原 RPC id，同一 turn 继续
    │←─ 模型文本 + response.completed ──────────────┤
```

工具等待时，HTTP 的 `response.completed` 只表示这段响应结束；官方回合仍在等待工具结果。网关不把工具结果重新拼成提示词，也不为同一次工具续接创建新回合。后续普通用户消息通过 `previous_response_id` 复用同一官方线程。

网关不读取或转发 OAuth token，不自行调用 ChatGPT 后端。登录、认证刷新和上游通信交给官方进程。运行时尝试关闭服务端内置工具，意外的审批与未注册工具请求会被拒绝；示例客户端只提供读取临时便签的白名单函数。**工具隔离依赖模型：`gpt-5.5` 已通过受控上游检查；`gpt-5.6-sol` 仍会暴露代码执行及协作工具，未通过隔离检查，不能据默认模拟模型的通过结果推定它就绪。**

## 当前范围

| 项目 | 支持情况 |
| --- | --- |
| 运行方式 | Node.js 20+、ES modules、零第三方运行依赖 |
| 账号与会话 | 一个网关进程、一个官方进程、一个账号、一个活动会话 |
| HTTP | `POST /v1/responses`，JSON 或 typed SSE；Bearer Key 鉴权 |
| 输入 | 文本，或单条用户文本消息；续接时可提交一个工具结果 |
| 工具 | 普通 JSON Schema `function`；`strict` 省略或 `false` |
| 会话续接 | `previous_response_id`；仅接受当前会话最新响应 ID |
| 运行状态 | `GET /healthz` |
| 用量统计 | 暂时返回 `usage:null`，不用于计费 |
| 暂不支持 | `custom` / freeform / grammar 工具、多模态、WebSocket、`/responses/compact`、任意历史注入 |
| 暂不支持 | 多账号调度、多用户分发、持久化恢复、生产运维面板 |

**`strict:true` 会明确拒绝。** 当前官方 app-server 的动态函数工具会以上游 `strict:false` 发送，网关不能承诺保留严格模式。客户端仍应校验工具名称和参数；示例已这样处理。

工具定义、模型、推理档位和 `instructions` 在线程内固定。正在生成或等待工具结果时，新会话请求会被拒绝。进程重启、生成失败、断连或会话过期后，旧响应 ID 不能继续使用。当前实现不会自动重放工具调用。

## 启动前准备

需要 Node.js 20+ 和官方 Codex CLI。无需运行 `npm install`。本机验证使用 `codex-cli 0.154.0-alpha.6.2`；app-server 动态工具接口仍可能随版本变化，更换二进制后应重新运行检查。

```sh
cd /Users/shenxi/Desktop/WORK-SPACE/codex-official-bridge
cp .env.example .env
```

编辑 `.env`，至少设置以下三项。Key 可以通过 `openssl rand -hex 32` 生成；模型名使用准备登录的账号实际可用的名称。

```dotenv
BRIDGE_API_KEY=replace-with-your-private-random-key
BRIDGE_MODEL=your-available-model
BRIDGE_CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex
BRIDGE_PORT=8789
```

`BRIDGE_CODEX_BIN` 是本项目使用的变量名。上面的路径是当前 Mac 检测到的官方二进制；在服务器上安装官方 CLI 后，可以设置为 `codex` 或实际绝对路径。

**`npm` 命令不会自动加载 `.env`。** 在要执行命令的终端中先运行：

```sh
set -a
source .env
set +a
```

默认状态目录为项目内 `.runtime/codex-home`，工作目录为 `.runtime/empty-workspace`。登录与启动脚本会只为子进程设置对应的 `CODEX_HOME`，不会切换你日常 Codex 的登录状态。如需另一个专用目录，在 `.env` 设置 `BRIDGE_CODEX_HOME=/absolute/path/to/dedicated/codex-home`，之后所有脚本使用同一个值。

该目录应专供本项目使用，避免复用带有第三方 provider、MCP 或插件配置的日常 Codex 目录。默认目录不包含这些自定义配置。

## 官方登录与诊断

```sh
npm run login
npm run doctor
```

`login` 调用官方 `codex login --device-auth`，按终端提示完成设备码登录；认证信息由官方 CLI 保存到隔离目录。`doctor` 初始化真实 app-server 并查询登录状态，不发送模型生成请求：

- `official_process_handshake: "passed"`：官方进程协议握手成功。
- `signed_in: true`：隔离实例已有登录账号。
- `signed_in: false`：还未登录，命令退出码为 `2`。

如果账号未启用设备码授权，在有浏览器的本机改用 `npm run login -- --browser`。它调用官方 `codex login` 并打开浏览器，通过本机回调完成授权，仍保存到同一个隔离目录。

## 运行网关与本地工具示例

第一个终端加载 `.env` 后启动：

```sh
npm start
```

默认监听 `http://127.0.0.1:8789/v1`。目前仅监听本机回环地址，不提供直接公网部署入口。

第二个终端进入同一项目，加载相同 `.env`，执行一次示例：

```sh
cd /Users/shenxi/Desktop/WORK-SPACE/codex-official-bridge
set -a
source .env
set +a
npm run demo
```

示例会在**运行示例的机器**上创建临时 `note.txt`，写入每次随机生成的 nonce。首轮提示不包含 nonce；模型调用 `read_local_note` 后，示例进程读取文件并提交工具结果，最终检查模型回答是否包含原 nonce。结束后删除临时目录。

成功时显示：

```text
PASS: local tool execution, previous_response_id continuation, and nonce verification.
```

示例最多处理 8 段响应，不执行任意 shell 命令。真实登录后运行 `demo` 会调用真实模型并消耗账号额度。

测试 typed SSE 模式时，在上一会话完成后执行：

```sh
npm run demo -- --stream
```

示例支持 `--model MODEL` 覆盖 `BRIDGE_MODEL`，`BRIDGE_URL` 默认是 `http://127.0.0.1:8789/v1`。例如网关将来运行在服务器上，可先建立 SSH 本地端口转发，再在本机运行示例；本机文件无需放到服务器。当前没有多用户隔离和调度，不应把这个单会话原型直接当作共享分发服务。

## 请求示例

首轮注册函数。`strict` 省略；也可明确填写 `false`。

```json
{
  "model": "your-available-model",
  "input": "请调用 read_local_note，然后根据便签回答。",
  "tools": [{
    "type": "function",
    "name": "read_local_note",
    "description": "读取客户端本地便签。",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    }
  }],
  "stream": false
}
```

收到 `function_call` 后，在客户端执行函数，用实际响应 ID 和实际 `call_id` 续接；无需再次提交工具表：

```json
{
  "previous_response_id": "首轮返回的响应ID",
  "input": [{
    "type": "function_call_output",
    "call_id": "首轮返回的call_id",
    "output": "客户端读取到的实际文件内容"
  }],
  "stream": false
}
```

## 验证与实际结论

```sh
npm run check
npm test
npm run verify:official
# 指定目标模型进行工具隔离和协议检查，仍不调用真实模型。
BRIDGE_VERIFY_MODEL=gpt-5.5 npm run verify:official
```

| 检查 | 验证内容 | 是否使用真实账号或模型 |
| --- | --- | --- |
| `check` | 所有 `.mjs` 文件语法 | 否 |
| `test` | 本地协议桩上的 HTTP、会话、工具续接、错误和 RPC 进程行为 | 否 |
| `verify:official` | 真实官方二进制 + 本机受控上游的完整工具往返 | 否 |
| 登录后 `demo` | 真实账号、真实模型和客户端文件工具的闭环 | 是 |

默认模拟模型 `bridge-fixture` 与指定 `gpt-5.5` 已通过**真实官方二进制连接本机受控上游**的工具闭环：一次线程启动、一次回合启动、两次模型请求，外部工具结果恢复同一回合，并回传随机 nonce；这两个配置下上游只看到注册的外部函数工具。指定 `gpt-5.6-sol` 时检查明确失败。

**2026-09-16，更换为另一个 Pro 账号并完成官方登录后，`gpt-5.5` 的真实 JSON 与 typed SSE 工具闭环均已通过。** 两次示例分别在客户端执行 1 次 `read_local_note`，读取当次本地随机 nonce；工具结果经官方模型处理后，最终回答均包含对应 nonce，示例均输出 `PASS`。这证明当前函数工具子集可以通过真实账号和模型完成客户端工具往返。

同一新账号下，`gpt-5.6-sol` 的一次纯文本请求也成功返回 `OK`（`reasoning.effort=low`、`tools=[]`、HTTP 200、`status=completed`）。它只证明这次文本生成成功；Sol 的服务端工具隔离仍未通过，原生 Codex 兼容边界不变。

此前账号的历史观察是：`gpt-5.6-sol` 和 `gpt-5.5` 均由官方返回模型容量已满；绕过桥接、同一旧账号直接运行官方 `codex exec` 的 `gpt-5.5` 对照也返回相同错误。该观察与新账号的成功结果均不足以确定账号风控或普遍限流的原因，也不能用于比较模型质量。

受控上游验证证明有限协议可以贯通，不证明所有模型兼容或长期稳定性。原生桌面 Codex 首请求仍会收到 400，详见 [原生客户端兼容差异](native-client-gap.md)。二号桌面配置尚未切换。官方进程出站也不能保证无法识别多人分发，更不能保证解除账号限制。

## 配置项

| 变量 | 默认值 / 用途 |
| --- | --- |
| `BRIDGE_API_KEY` | 必填；客户端访问网关的私有 Key |
| `BRIDGE_CODEX_BIN` | `codex`；官方 CLI 的命令或路径 |
| `BRIDGE_CODEX_HOME` | `<项目>/.runtime/codex-home`；隔离登录目录 |
| `BRIDGE_MODEL` | 默认模型；未配置时客户端必须提供 |
| `BRIDGE_PORT` | `8789`；监听端口 |
| `BRIDGE_REQUEST_TIMEOUT_MS` | `120000`；单次 HTTP 生成的最长等待 |
| `BRIDGE_SESSION_TTL_MS` | `300000`；空闲会话和待提交工具结果的有效期 |
| `BRIDGE_URL` | 仅示例使用；默认 `http://127.0.0.1:8789/v1` |

网关 Key 与官方账号登录凭据互相独立。`.env`、`.runtime` 中的账号状态不要提交到代码仓库。生成超时或工具等待过期后，应开始新会话；上游进程退出后应重启网关。

协议设计见 [docs/design.md](design.md)，实测记录见 [docs/validation.md](validation.md)，官方接口依据见 [Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)。
