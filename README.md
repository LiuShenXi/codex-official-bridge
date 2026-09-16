# Codex Official Bridge

面向官方 Codex 桌面 / CLI 的单账号模型网关。**Agent、项目文件和原生工具都在本地；服务器保留请求原始字节、完整历史与 SSE，只负责官方账号认证和模型通信。**

2026-09-16：已在主服务器 Docker 上运行。真实 Sol 工具闭环、二号实际 Sol/xhigh 配置和 V2 上下文压缩续聊均通过。用户随后在桌面二号发起真实任务并确认正常完成；服务器侧观察到持续回传数据。该次被动观测未覆盖完整工具续接和终止 SSE，桌面 UI 自动化仍未执行。

## 接手入口

- [快速交接](HANDOFF.md)：回家后连接既有服务、继续开发的最短步骤。
- [详细架构](docs/architecture.md)：组件职责、协议流、认证、出口、运行与扩展边界。
- [部署与恢复](docs/deployment.md)、[构建说明](docs/native-build.md)、[验收证据](docs/validation.md)。

源码包不含 `.env`、OAuth 登录状态、SSH 私钥、桌面配置备份、日志或编译缓存。新电脑需要单独配置 SSH 访问和网关 Key；现有服务器是活动认证状态的维护端。

运行时采用固定版本的官方 Codex 认证、provider、HTTP 库，属于**基于官方源码的独立程序，不是未修改的官方 CLI**。原生协议保留不能保证隐藏多人分发行为、解除账号限制或模型质量不变。

## 已部署的链路

```text
本地 Codex 二号（原生 Agent、工具与文件）
  → http://127.0.0.1:8879/v1 + 网关 Key
  → 本机自动重连 SSH 通道
  → main-server Docker / Node 网关
  → 私有 Rust runtime / 官方认证与 HTTP 库
  → 主服务器现有 SOCKS 隧道 → 搬瓦工 → 静态家宽
  → 官方 Codex 模型后端
```

服务器项目目录 `/opt/codex-official-bridge`，容器 `codex-official-bridge-bridge-1`，仅监听宿主 `127.0.0.1:8879`。容器内同一 Rust HTTP 工厂实测出口为 **72.253.169.123**；将该测试容器的代理改为无效地址后请求失败，没有回退直连。未中断共享隧道。

容器限制 1 CPU / 1 GiB / 128 PID，使用非 root 用户和只读根文件系统。账号状态与运行控制目录为专用可写挂载，账号文件不进入镜像。当前只有一个服务端账号和一个网关 Key，没有多账号池或用户配额。

## 验收结果

| 检查 | 结果与边界 |
| --- | --- |
| JavaScript | 29 个文件语法通过；60 项测试通过 |
| Rust / Docker | 固定源码成功构建，3 项边界测试通过，动态库完整，容器 healthy |
| 原生工具离线合同 | 真实官方 CLI 经 Node 网关，5.5 的 custom/apply_patch、Sol 的 functions.exec 均实际修改本地文件，原始请求字节一致 |
| 真实 Sol | 隔离本地账号的官方 CLI 经服务器读取、复制本地随机内容并正确完成 |
| 二号实际配置 | Sol / xhigh / official_bridge，加载实际配置后原生本地文件操作通过 |
| 模型目录 | 官方返回 200，7 个模型，包含 Sol |
| V2 压缩和续聊 | 官方 app-server 使用二号 provider，完成记忆 → 压缩 → 精确回忆；3 个回合、1 次 contextCompaction |
| 旧 unary compact | 本次官方 `/responses/compact` 返回 404，按原样保留；不能宣称旧接口可用 |
| 桌面 UI | 二号已启动，自动化工具按应用标识禁止操作；未执行 UI 点击验收 |
| 用户真实桌面任务 | 用户确认二号正常完成；观察到约 1.73 MB TCP 响应数据，未捕获该请求的 HTTP 状态、完整工具续接及终止 SSE |

二号配置测试时观察到配置文件发生变化，来源未确定；事后重新核对 model/provider/effort/Key 存在/CodeMode 均正确。文件工具与最终回答断言此前已通过，未因此额外重复调用模型。详见 [验收记录](docs/validation.md)。

## 协议与范围

- `POST /v1/responses`：原始 JSON 或压缩字节、原生 custom/namespace 工具、完整历史、加密内容、usage、未知字段及 SSE。
- `GET /v1/models?client_version=…`：原样转发 Codex 模型目录。
- `POST /v1/responses/compact`：原样转发旧路由及错误；当前客户端使用 V2 压缩，在 `/responses` 的 input 末尾附加 `compaction_trigger`。
- `GET /healthz`：鉴权后查询私有运行时存活情况，不单独代表模型可用。
- 请求上限 16 MiB；转发包含背压、断连取消、状态与 Retry-After 保留。网关不接受任意上游 URL，不在服务端执行 Agent 工具。
- WebSocket 未实现，二号 provider 明确关闭。图片、全部应用工具、多客户端并发与长期稳定性尚未完整验收。

固定版本下，provider `name = "OpenAI"` 会影响加密字段保留与压缩能力；二号使用独立 provider ID，同时保留该名称。`remote_compaction_v2` 在此版本默认开启，已通过真实官方协议流程验证。

## 二号配置

实际文件：`/Users/shenxi/Library/Application Support/Codex-Second-Account/codex/config.toml`。已在项目 `.runtime/backups/` 保存修改前的私有备份，文件权限 0600。仅二号配置被修改。

```toml
model = "gpt-5.6-sol"
model_reasoning_effort = "xhigh"
model_provider = "official_bridge"

[model_providers.official_bridge]
name = "OpenAI"
base_url = "http://127.0.0.1:8879/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
experimental_bearer_token = "YOUR_PRIVATE_GATEWAY_KEY"

[features]
enable_request_compression = false
code_mode = true
code_mode_host = true
```

上面是合并示意，不能直接覆盖已有配置。实际 Key 已配置，不写入文档。当前账号登录状态由服务器维护，客户端只持网关 Key。

## 构建与维护

固定官方源码 `rust-v0.154.0-alpha.6.2` / `b5bffd3ec4db487e7e3dec59663875b0ef7b72ca`，Rust 1.95.0，源码依赖锁保存在 `native-runtime/Cargo.lock`。Docker 基础镜像也固定 digest。

在主服务器项目目录：

```sh
docker buildx build --builder codex-bridge-builder --load \
  --progress=plain -t codex-official-bridge:local .
docker compose up -d --no-build
docker compose ps
docker compose logs --tail=50 bridge
```

构建器目前已停止释放资源，缓存保留；下一次 buildx 构建可重新启动它。首次构建约 15 分钟，后续可复用依赖。Dockerfile 强制刷新本项目 Rust 源文件时间，防止 COPY 保留旧时间戳时 Cargo 错误沿用旧主程序。

容器镜像不包含官方登录 CLI。官方登录在容器外完成，将专用 CODEX_HOME 通过私有挂载提供；官方认证库负责后续刷新。不要同时运行持有旧认证副本的本地 legacy 进程。

本机 SSH 自动重连配置在 `~/Library/LaunchAgents/com.monas.codex-official-bridge-tunnel.plist`，日志在 `~/Library/Logs/CodexOfficialBridge/tunnel.log`。部署、停止与恢复位置见 [部署记录](docs/deployment.md)，构建细节见 [native-build.md](docs/native-build.md)。

## 开发与验证

Node.js 20+，无需 npm install。

```sh
npm run check
npm test
BRIDGE_CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex npm run verify:desktop
BRIDGE_CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex BRIDGE_DESKTOP_MODEL=gpt-5.6-sol npm run verify:desktop
```

`verify:desktop` 是无真实账号的离线合同。`verify:live-desktop`、`verify:client-profile`、`verify:live-compact` 会消耗真实模型用量；后两者需要 `BRIDGE_CLIENT_HOME` 指向已配置的客户端目录。不要把真实 Key 写进命令参数或输出。

主要运行变量：`BRIDGE_MODE=native`、`BRIDGE_API_KEY`、`BRIDGE_NATIVE_BIN`、`BRIDGE_CODEX_HOME`、`BRIDGE_PORT`。本地默认端口 8789；Compose 固定 8879。原生启动等待默认 120 秒，单请求默认 120 秒，Compose 为 600 秒。`BRIDGE_MODEL` 和 `BRIDGE_SESSION_TTL_MS` 仅用于 legacy。

首版 app-server 函数工具方案保留为 `BRIDGE_MODE=legacy`，说明见 [legacy-bridge.md](docs/legacy-bridge.md)；它的工具转换与会话限制不适用于默认 native 模式。
