# 0.2.0：WebSocket 会话与图片工具

## 当前状态

2026-09-16：0.2.0 已部署到 `main-server`，二号已配置并重启。通过同一静态家宽出口 **72.253.169.123**，真实 WebSocket 两轮工具续传、真实 MCP 生图以及安装版官方 CLI 使用二号配置的本地文件工具闭环均通过。最终依赖锁复构建已通过，并已部署正式镜像。提交标识见仓库 main 历史和本机任务的发布报告。

真实验证摘要：

- 一个 WebSocket 连接完成两轮 `gpt-6-astra` 生成，第一轮函数调用、第二轮 `function_call_output` 与 `previous_response_id` 续传通过；收到两次 metadata、两次 completed 和正常关闭应答。
- `bridge_images` MCP 经真实 stdio 调用生成 PNG，实际 **1370 × 1148**、**1,641,411 字节**，SHA-256 为 `86719c41ae64c7f003c252b63411cc5658df982ab3881251413ee3a3f5d5dea0`。这证明项目图片路径可用，不代表原生同名 `image_gen` 已解锁。
- 本机官方 CLI `0.154.0-alpha.6.2` 加载二号实际 `official_bridge`、Astra / ultra 配置，WebSocket 和图片 MCP 均启用；随机内容读取与本地复制精确一致，最终回答符合断言。日志记录一次 WebSocket 连接、零次 HTTP 回退。此项使用实际 CLI 配置，不是桌面 UI 点击测试。

## 修复

- Node 的 Upgrade 请求独立检查网关鉴权、浏览器 Origin、固定路径、WebSocket 版本和 key；进入私有 runtime 前剥离网关与其他客户端认证头。
- Node 保留帧流及 Upgrade 同包数据，双向背压和断连传递；30 秒握手上限不作用于已经建立的持久会话。
- Rust 使用固定版本官方 `WebSocketConnector`、`AuthManager` 和同一代理/CA 工厂，固定连接官方 `/responses`。应用消息不经 JSON 重写，保留预热、连续 `response.create`、`previous_response_id`、工具结果、metadata、二进制消息、取消和关闭。
- 本机到 runtime 的 WebSocket 不协商压缩；runtime 到官方启用 pinned 官方 deflate 实现。ping/pong 逐跳处理，不能把应用语义透传说成原始 WS 帧/TLS 指纹完全相同。
- 仅在握手 401 时使用官方有界认证恢复；已建立会话及模型请求不自动重放。官方 WS 库可能只返回非101错误体的部分缓冲：完整有长度的错误体原样保留，无法确认完整时保留状态及 Retry-After，返回固定错误 JSON，并标记 `x-codex-runtime-error-body: unavailable`。
- 新增固定 `POST /v1/images/generations` 路由，沿用服务器官方账号和现有家宽代理，不引入另一家 API。
- 新增 `bridge_images` MCP 的 `get_status`、`generate_image`。凭据只读取本实例 connection.json，按已观察的官方图片 JSON 协议生成一张 PNG，返回本地路径、实际尺寸和哈希；多张可并行调用。未确认成功的生成不会自动重试。
- MCP 支持 Windows UTF-8 BOM 配置，拒绝覆盖和越界/junction 输出，HTTP200后的响应中断明确标记完成状态不确定。
- 二号配置同步改为可复用项目脚本，由 connection.json 的开关生成 WebSocket 和 MCP 配置；先检查服务能力、备份，再生效。不覆盖一号或 VS Code。
- 采集白名单增加二号图片入口。Windows Node 20 的测试入口不再依赖 shell 通配符；修复旧 HTTP 超大请求提前结束迭代时连接被销毁、无法正常返回413的问题。

原生同名 `image_gen` 受固定官方客户端的 provider/auth 注册门槛限制，本次以项目 MCP 恢复生图功能，不宣称解锁全部官方应用工具。

## 使用

服务已部署；以后为二号或另一独立实例配置时，在项目目录执行：

```powershell
# 只展示不含凭据的配置计划
.\scripts\configure-windows-client.ps1 -DryRun

# 服务器能力检查通过后备份并配置二号；具体实例可传 -InstanceRoot
.\scripts\configure-windows-client.ps1
```

关闭并重新打开二号后，用新任务加载工具。配置仍以二号独立 `codex/connection.json` 为来源，启动器调用项目同步脚本。图片工具读取同一 profile，不将 key 放进 argv 或日志。

```sh
npm test
npm run check
npm run test:capture
# 默认只打印使用方法，不调用真实模型
npm run verify:websocket
```

`verify:websocket -- --live` 才会实际请求模型，需在进程内安全提供网关 key。该验收用同一 WS 完成函数调用及工具结果续传，检查 final completed、metadata 和关闭应答；有意打断场景由本地合同测试覆盖。图片能力需实际生成一次才能确认，本次已完成真实生成，health成功不能替代。

官方 WebSocket 的 `response.completed.output` 可以为空，完整输出由此前的 `response.output_item.done` 提供。验收器现按这些完成事件汇总输出，再验证 completed，避免把成功的函数调用误报为失败；这是验收器的修正，没有在网关中补写或转换上游响应。

## 验证记录

| 检查 | 本次状态 |
|---|---|
| Windows JS 回归 | 最终 92 项：88 通过，0 失败，4 个 Unix 私有文件权限/运行时进程测试明确跳过 |
| 图片 MCP | 14 项，包括真实 stdio 子进程到本地模拟上游，再写 PNG 的完整链路 |
| Node WS 合同 | 10 项，包括多轮、metadata、分片、同包首帧、拒绝、timeout、cancel和close |
| 采集工具 | 14 项通过，包括新增图片路径与认证端点排除 |
| JS 语法 | 36 文件通过 |
| Linux Node 全量回归 | 最终锁定构建 92 项：84 通过、0 失败、8 个 Windows 专属测试跳过 |
| Rust 编译及 WS 实际库测试 | 最终锁定构建与实际库测试 7/7 通过 |
| 真实 WS 两轮 | 通过；同一连接、函数调用和结果、previous_response_id、metadata、Astra 最终回执、正常关闭均有证据 |
| 真实图片 | 通过；MCP stdio → 本项目网关 → 官方图片接口 → 本地 PNG，1370 × 1148 |
| 二号实际 CLI 工具闭环 | 通过；Astra / ultra，随机内容精确复制，WebSocket 连接 1 次、HTTP 回退 0 次 |
| 二号配置与工具加载 | 配置脚本8项离线测试通过；实际 MCP 目录包含 bridge_images 的 get_status 和 generate_image，二号已重启 |
| 配置检查 | 三份 TOML 均可解析，VS Code 连接一致性通过；二号 doctor 的 config/auth/network/mcp 检查为 ok，整体仍因非交互 terminal.env 为 fail，并有 security warning，不能写成 doctor 全通过 |

此次验收的安全证据保存在任务输出目录 `outputs/bridge-0.2.0/`：`websocket-live.json`、`image-live.json`、`client-profile-live.json`、`mcp-catalog.json`、`profile-validation.json` 和 `connection-consistency.json`；生成物为 `image-acceptance.png`。这些本机运行产物不随源码发布。

CLI 验收记录了配置文件字节发生变化，以及一条启动配置提示；验收期间维护者执行了二号重启，启动器同步 profile，属于已知的并发配置写入。实际加载的模型、provider、WebSocket、图片 MCP 及本地工具断言均通过；没有将“配置文件完全未变化”列为通过项，也未因此重复付费请求。

## 发版和回退

既有目标是 `main-server:/opt/codex-official-bridge`，服务 `codex-official-bridge-bridge-1`。它不是 Git checkout；仅同步源码，保留 `.env`、`.runtime`、`.runtime-container` 和现有认证状态。

先在独立目录构建 `codex-official-bridge:0.2.0-candidate`。有意更新依赖时可一次设置 Docker build arg `CARGO_LOCKED=0`，从候选导出新的 Cargo.lock 回填源码，再以默认锁定模式复构建。服务运行期间完成编译及离线测试，成功后才替换本项目容器。

换代前保留旧 image ID/标签；部署验证健康、未授权模型目录401、带 client_version=0.154.0-alpha.6.2 的授权目录200（7个模型；无该查询字段按官方协议返回400）、同工厂家宽出口，以及真实WS和图片。失败时回退旧镜像，保留当前令牌刷新状态，不能回滚旧auth.json。共享家宽隧道不在改动范围。

发布完成记录：

- 最终镜像：`sha256:33de4376546dd690bd146d69bf481ea65f44804190c0b1fd7a495407006a5257`，服务健康版本 `0.2.0`。
- 最终依赖锁构建：Linux Node 84/92 通过，8 项 Windows 专属跳过；Rust 7/7 通过。
- 最终镜像的 Rust 二进制、Node 网关/转发器和图片 MCP 与真实验收候选逐文件 SHA-256 一致；没有为仅验收器和文档变化重复收费生图。
- 替换后的本机二号入口再次通过 health 200、授权 models 200（7个模型）、真实上游 WS 101 与正常关闭；此次复检未发送模型生成。
- 0.1.0 旧镜像仍以 `codex-official-bridge:rollback-before-0.2.0` 保留。专用 builder 已停止，服务容器继续运行。
- 本次提交包含可复用三点采集工具；私有凭据、图片产物与采集数据不入库。提交标识以 `main` 历史为准，推送回执另存本机发布报告。

## 来源

- [固定官方工具授权门槛](https://github.com/openai/codex/blob/b5bffd3ec4db487e7e3dec59663875b0ef7b72ca/codex-rs/core/src/tools/spec_plan.rs#L699-L735)
- [固定官方客户端 WS 启用逻辑](https://github.com/openai/codex/blob/b5bffd3ec4db487e7e3dec59663875b0ef7b72ca/codex-rs/core/src/client.rs#L1013-L1022)
- [官方 MCP 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)
- 本项目三点采集批次 `20260916-213351`：真实图片JSON结构及请求协议差异。原值只保留于私有加密档案，不纳入源码。
