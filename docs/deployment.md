# 主服务器 Docker 部署记录

日期：2026-09-16。用户授权在主服务器以 Docker 构建、运行，并要求经搬瓦工静态家宽出站。

## 隔离与路径

- 主机：SSH 别名 `main-server`，工作目录 `/opt/codex-official-bridge`。
- 源码仓库：`https://github.com/LiuShenXi/codex-official-bridge.git`，分支 `main`。服务器目录目前是复制部署的源码，没有 `.git`；后续更新只同步审查后的源码，保留活动 `.env`、`.runtime/` 和 `.runtime-container/`。不要在该目录直接假定 `git pull` 可用，也不要以新克隆覆盖私有状态。
- 专用 builder：`codex-bridge-builder`，限制 1.5 CPU / 3 GiB，无 swap；不修改默认 builder。
- 镜像：`codex-official-bridge:local`，固定官方源码 commit 与基础镜像 digest。
- 服务：本项目 `docker-compose.yml`；host network，网关只监听 `127.0.0.1:8879`。
- 账号目录：服务器 `.runtime/codex-home`，挂载到 `/var/lib/codex-auth`，UID/GID 1000:1000，目录 0700、认证文件 0600。
- 运行目录：服务器 `.runtime-container`，挂载到 `/app/.runtime`，UID/GID 1000:1000、0700。
- 网关 Key：服务器 `.env`，root:root、0600；文档不记录实际值。
- 构建日志：服务器 `.runtime/build.log`。服务镜像不包含账号文件或官方登录 CLI。

先前在本机运行的 legacy 服务 PID 16823 已停止；其专用 `auth.json` 经 SSH 迁到服务器，未复制日常桌面账号或项目历史。服务器成为这份认证状态的活动维护端后，不应同时启动持旧副本的本地 legacy 进程。

## 出口链路

```text
容器内官方认证 / 模型 HTTP 请求
  → socks5h://172.30.80.1:11080
  → 主服务器现有 cloudbrowser-tunnel
  → BWH xray
  → 静态家宽 72.253.169.123
  → 官方上游
```

复用既有隧道，未更改 BWH、CPA、镜像聊天服务或主服务器的全局路由。Compose 显式设置大小写 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY，NO_PROXY 仅含回环地址。该设置作用于本服务容器；源码直接在缺失代理环境的主机运行时仍可能直连，不能把 Docker 的出口约束泛化到任意运行方式。

已从主服务器通过该 SOCKS 地址请求 IP 回显服务，结果为 `72.253.169.123`。容器内 Rust 同 HTTP 工厂已实测同一出口；独立测试容器使用无效代理时 exit 1 / egress_transport_failed，没有回退直连。

## 本机接入

已安装当前用户 LaunchAgent：

`~/Library/LaunchAgents/com.monas.codex-official-bridge-tunnel.plist`

它保持 `127.0.0.1:8879 → main-server:127.0.0.1:8879` 的 SSH 转发，断线后自动重启。日志位于 `~/Library/Logs/CodexOfficialBridge/tunnel.log`，没有网关 Key。使用 Library 日志目录是因为 launchd 向 Desktop 目录写日志曾导致 EX_CONFIG；调整后已验证进程运行与本机端口监听。

二号现已使用 `http://127.0.0.1:8879/v1` 与独立网关 Key。切换前备份其独立配置，不覆盖一号配置。配置修改前已私有备份，Sol/xhigh 实际 profile 工具闭环通过；具体完成状态见 [validation.md](validation.md)。

## 运维命令

在服务器项目目录执行：

```sh
docker buildx build --builder codex-bridge-builder --load \
  --progress=plain -t codex-official-bridge:local .
docker compose up -d --no-build
docker compose ps
docker compose logs --tail=50 bridge
```

不要直接输出 `.env`、`auth.json` 或完整 `docker inspect` 环境。验证同一 Rust HTTP 路径的出口使用：

```sh
docker compose run --rm --no-deps \
  --entrypoint /usr/local/bin/codex-official-runtime bridge --check-egress
```

该命令仅访问固定 IP 回显地址，不读取账号、不附加 OAuth 认证，不增加任意上游 HTTP 接口。

停止本项目服务用 `docker compose stop bridge`。构建完成后可用 `docker buildx stop codex-bridge-builder` 释放构建器进程；缓存仍保留供后续构建。不要停止共享 `cloudbrowser-tunnel`，其他服务也依赖它。

## 当前进度

Docker 镜像已构建，服务容器 healthy，模型目录200，真实 Sol / 二号实际 Sol-xhigh 文件工具闭环通过，官方 V2 压缩及续聊通过。容器同 HTTP 工厂出口72.253.169.123、无效代理不回退均已验证。二号已配置和启动；UI 自动化工具禁止操作 com.openai.codex，未做 UI 点击验收。专用 builder 已停止释放资源，缓存保留。

随后用户在二号手动发起真实任务并确认完成；服务端观测到持续返回约 1.73 MB TCP 数据，之后连接结束且容器健康。本次被动检查未捕获完整结束事件或工具续接，详细证据边界见 [validation.md](validation.md)。

二号修改前备份：项目 `.runtime/backups/second-config-before-native-20260916-173345.toml`。若需撤回客户端接入，应先关闭二号，再从该备份恢复配置；仅停止本项目服务，不停止共享家宽隧道。服务器认证文件可能已经由官方库刷新，恢复旧本地认证副本不是安全的账号回退方式。
