# 快速交接

更新日期：2026-09-16。本文给下一台电脑或下一个 AI 续接；路径与验收是当日快照，接手先检查运行状态。

## 当前状态

- 默认 `native` 模式已在主服务器 Docker 部署；本地 Agent 执行项目工具，服务器仅负责官方账号认证与模型通信。
- 服务端是链接固定官方 Codex 源码库的独立 Rust 程序，不是原封不动运行官方 CLI，也不能保证规避检测或解除账号限制。
- 单个上游账号、单个网关 Key；多账号池、用户隔离、配额和调度尚未实现。
- 真实 Sol 本地文件工具、二号实际 Sol/xhigh 配置、V2 压缩后续聊均通过。
- 用户随后在二号桌面发起真实任务，并明确确认“已正常完成”。服务器仅被动观测到响应方向字节，未捕获终止 SSE；不能从抓包独立断言 `response.completed`。
- 未执行桌面 UI 自动化验收：工具禁止操作 `com.openai.codex`，不得绕过；官方 CLI/app-server 验证单独记账。
- 当日测试快照：29 个 `.mjs` 语法通过、60 项 Node 测试和 3 项 Rust 测试通过；不是未来版本的自动保证。

## 先读什么

1. [README.md](README.md)：当前范围、二号配置与常用命令。
2. [docs/architecture.md](docs/architecture.md)：请求链路、职责、认证与流式边界。
3. [docs/deployment.md](docs/deployment.md)：既有主服务器、家宽出口、隧道与恢复位置。
4. [docs/validation.md](docs/validation.md)：哪些真正测过、历史失败及证据边界。
5. 需要改构建时再读 [docs/native-build.md](docs/native-build.md)；`docs/design.md`、`docs/native-client-gap.md` 和 `docs/legacy-bridge.md` 包含历史方案，不能覆盖 native 现状。

## 精确位置与入口

| 项目 | 位置或名称 |
| --- | --- |
| 当前 Mac 源码 | `/Users/shenxi/Desktop/WORK-SPACE/codex-official-bridge` |
| 主服务器 | SSH 别名 `main-server`，`23.19.230.146` |
| 服务端源码/Compose | `/opt/codex-official-bridge` |
| 容器/镜像 | `codex-official-bridge-bridge-1` / `codex-official-bridge:local` |
| 服务端监听 | `127.0.0.1:8879`，没有公网监听 |
| 二号 API 地址 | `http://127.0.0.1:8879/v1`，经本机 SSH 隧道 |
| 二号 CODEX_HOME | `/Users/shenxi/Library/Application Support/Codex-Second-Account/codex` |
| 二号配置 | 上述目录的 `config.toml`，不要修改一号 `~/.codex/config.toml` |
| 二号启动器 | `/Users/shenxi/Desktop/Codex Second Account.app` |
| 本机官方 CLI | `/Applications/ChatGPT.app/Contents/Resources/codex` |
| 隧道 LaunchAgent | `~/Library/LaunchAgents/com.monas.codex-official-bridge-tunnel.plist` |
| 隧道日志 | `~/Library/Logs/CodexOfficialBridge/tunnel.log` |

代码从 `src/main.mjs` 进入；`src/server.mjs` 做路由/鉴权，`src/native-runtime.mjs` 管理子进程和原始 HTTP/SSE，`native-runtime/src/main.rs` 使用官方认证/HTTP 库。`src/bridge.mjs` 是保留的 legacy 路线。

## 下一台电脑接入既有服务

源码仓库与分支是 `https://github.com/LiuShenXi/codex-official-bridge.git` / `main`。仓库当前公开，回家后从这里开始；提交代码需要该电脑自己的 GitHub 授权：

```sh
git clone --branch main https://github.com/LiuShenXi/codex-official-bridge.git
cd codex-official-bridge
```

1. Node.js 20+ 即可运行 JS 检查，不需要 `npm install`。仅使用服务器不需要本机编译 Rust。
2. 家用电脑生成自己的 SSH 密钥，由服务器管理员单独授权，配置自己的 `main-server` 别名；可将隧道权限限定到服务端 `127.0.0.1:8879`。不要复制公司电脑的整份 SSH 私钥或覆盖已有配置。
3. 若本机已有该隧道，先复用；否则在终端保持以下前台连接，再配置客户端。端口被占用时先识别占用者，不要直接杀进程。

```sh
ssh -N -T -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:8879:127.0.0.1:8879 main-server
```

本机现有 LaunchAgent 会自动重连；新电脑可在手动隧道验证后配置自己的保活服务。无需重启服务器或共享家宽隧道。

备份目标客户端配置，再合并下面片段；不要直接覆盖完整文件。新电脑的 CODEX_HOME 和 CLI 路径应按实际安装选择。

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

保留 provider 的 `name = "OpenAI"`：固定客户端版本用它决定部分加密字段和压缩能力。`remote_compaction_v2` 在已验版本默认开启。客户端只需网关 Key，不复制上游 OAuth 账号；Key 经私有渠道交付，配置文件保持仅本人可读。

## 最少检查与验证

先做不消耗模型的检查；以下在源码根目录执行。官方 CLI 路径按本机调整。

```sh
npm run check
npm test
BRIDGE_CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex npm run verify:desktop
BRIDGE_CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex BRIDGE_DESKTOP_MODEL=gpt-5.6-sol npm run verify:desktop
```

`verify:desktop` 使用 loopback 假上游和临时账号目录，但由真实官方 CLI 执行工具；它不会调用真实上游。

健康检查需先将已有网关 Key 安全放入当前进程环境 `BRIDGE_API_KEY`；不要将实际值写在命令参数、仓库或聊天里。只显示状态码：

```sh
node --input-type=module <<'JS'
if (!process.env.BRIDGE_API_KEY) throw new Error('BRIDGE_API_KEY is required');
const r = await fetch('http://127.0.0.1:8879/healthz', {
  headers: { authorization: 'Bearer ' + process.env.BRIDGE_API_KEY },
  signal: AbortSignal.timeout(5000)
});
console.log('health HTTP', r.status); process.exitCode = r.ok ? 0 : 1;
JS
```

`/healthz` 只证明 runtime 就绪，不能替代账号或模型验收。有运维权限时可用 `ssh main-server 'cd /opt/codex-official-bridge && docker compose ps'` 查看容器状态。

需要再次真实验收时才执行以下命令，会消耗模型用量；不要仅因拿到源码就重复运行。将 `BRIDGE_CLIENT_HOME` 改为目标客户端目录，示例默认当前 Mac 二号：

```sh
export BRIDGE_CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex
export BRIDGE_CLIENT_HOME='/Users/shenxi/Library/Application Support/Codex-Second-Account/codex'
npm run verify:client-profile
npm run verify:live-compact
```

前者加载实际配置验证本地文件闭环；后者验证 V2 压缩及精确回忆，临时使用 low effort。两者不操作 UI。隔离配置验收另用 `verify:live-desktop`，需要 `BRIDGE_URL=http://127.0.0.1:8879/v1` 和环境中的 `BRIDGE_API_KEY`，默认 Sol。

## 凭据与构建维护

- 活动上游认证的权威目录：服务器 `/opt/codex-official-bridge/.runtime/codex-home`，容器挂载为 `/var/lib/codex-auth`；官方库可能持续刷新其中状态。
- 活动网关 Key：服务器 `/opt/codex-official-bridge/.env`，0600；运行控制目录 `/opt/codex-official-bridge/.runtime-container`。文档只记录路径。
- 不上传 `.env*`（仅 `.env.example` 可交付）、`.runtime/`、`.runtime-container/`、客户端完整配置、日志、账号文件或 SSH 私钥。Git 仓库不等于凭据备份。
- 当前 Mac 的旧本地认证副本不是权威状态；不要启动持旧副本的 legacy 进程，不要用旧认证覆盖服务器。
- 修改前二号配置私有备份在 `.runtime/backups/second-config-before-native-20260916-173345.toml`，不随源码交付；恢复客户端配置不等于恢复上游账号。
- 只在后续代码/依赖变更需要部署时构建、重启。进入服务器 `/opt/codex-official-bridge`，按 `docs/deployment.md` 的固定 builder 执行；不要把“新电脑接入”变成重新部署。
- 服务器目录当前是源码部署副本，没有 `.git`，不能直接 `git pull`；更新时只同步已审查源码，保留服务器现有 `.env`、`.runtime/`、`.runtime-container/`，不要用空的新克隆覆盖整目录。
- 官方源码固定 `rust-v0.154.0-alpha.6.2` / `b5bffd3ec4db487e7e3dec59663875b0ef7b72ca`，Rust 1.95.0。保留 Cargo.lock 与 Docker 基础镜像 digest，不直接升级 latest。
- 现有出口依赖主服务器 `cloudbrowser-tunnel` → BWH → `72.253.169.123`；其他服务也使用此隧道，不要为本项目停止它。
- Rust 异常退出会令 Node 退出 1，由 Docker `unless-stopped` 重启；主动停止本项目用 `docker compose stop bridge`。

## 优先待办与边界

1. 增加不含请求正文、凭据或账号身份的请求级观测：关联 ID、状态、首字节/总时长、字节数、断连原因；区分上游结束、客户端取消和 deadline。
2. 评估长任务超时：Compose 的 `BRIDGE_REQUEST_TIMEOUT_MS=600000` 是读完请求体后开始、覆盖等待响应与整个 SSE 的绝对期限；不是空闲超时，持续流动也会在 600 秒切断。当前配置上限也为 600000；需设计、测试后再调整策略。
3. 多账号调度、并发容量、用户隔离与用量归属尚未实现；先定义需求和故障隔离，再扩展。不能把单账号成功外推为拼车平台已经完成。
4. WebSocket 未实现；图片、全部应用工具、长时间运行与多客户端并发尚未完整验收。旧 `/responses/compact` 本次官方返回 404，已成功的是 `/responses` 上的 V2 压缩。
5. 模型容量错误曾在旧账号官方直连复现；不据此断言账号风控、普遍限流或“降智”。后续排障保留官方状态及安全元数据，避免读取会话正文或凭据。

接手后先确认用户要继续开发还是仅连接服务；按当前服务器状态推进，不重复登录、搬迁凭据、重建或真实模型测试。
