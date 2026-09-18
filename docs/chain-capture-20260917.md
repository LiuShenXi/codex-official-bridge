# 桌面二号直连与三号 Sub2API 对照监测（2026-09-17）

> 后续更新（2026-09-17）：二号和三号已改接 wangzizai666@gmail.com 的一号网关；三号使用新测试车 #12，旧采集已停止。本文下方为历史记录，勿执行旧路由恢复。当前记录：`Codex二三号改接一号实例-20260917.md` / `docs/first-instance-switch-20260917.md`。

状态：采集已启动，等待用户自行发送真实请求。用户已明确同意两边统一账号、出口、模型和思考档位，采集结束恢复二号原配置。三号也应恢复其原始 Sub2API 直连地址。

## 当前路径

- 桌面二号 → 本机 127.0.0.1:18885（direct-bridge）→ 独立 SSH 127.0.0.1:18884 → main-server 127.0.0.1:8880（account-2 / 七号账号）。
- 桌面三号 → 本机 127.0.0.1:18886（sub2api-inbound）→ https://sub2api.monasapi.com → group 4「新框架测试分组」/ account 11「框架测试-七号车」→ BWH 172.20.0.1:28882（sub2api-outbound）→ 原 172.20.0.1:28880 隧道 → 相同 account-2。
- 两边配置均为 gpt-5.6-sol / high，HTTP Responses / SSE，WebSocket 禁用；共享账号和 IP2 出口。
- BWH 只临时修改 account 11 的 credentials.base_url。分组、定价、倍率、余额和 API key 均保持原值。原 bridge 和原 SSH 服务未重启。

## 验证

- 17 项单元测试通过。
- 隔离的本机模拟测试通过：压缩请求字节、重复请求/响应头、SSE 字节、WebSocket 双向消息/关闭、加密认证和完整终止记录。
- 模型目录探测：二号 200 / 7 models，三号 200 / 19 models，BWH 出站点 200 / 7 models。Sub2API 的 /models 是其自身目录；两个桌面仍使用各自本地官方模型目录。
- 初始探测漏带 client_version 时 bridge 返回 400，补齐后 200。此为准备阶段 GET /models，分析真实推理时排除。
- 用官方 app-server config/read 验证两份配置均为 Sol/high 和对应本机监测端口。仅启动/配置检查，未发送真实推理。
- 重启目标 profile 后确认两个隔离桌面主进程存在；没有完成桌面 UI 发请求测试。

## 采集存储与控制

本机私有目录（已被 Git 忽略）：`.runtime/chain-capture/`。
- `venv`：mitmproxy 11.0.2 和分析依赖。
- `run/private.pem`：仅本机所有者可读的 RSA 私钥，不上传。
- `run/records`：两个本机观测点的加密原始数据。
- `run/state.private.json`：原始配置、account 11 快照、用量基线、应用后配置，含密钥，不输出正文。
- `run/ready.json`：非敏感采集起点。
- `control.py`：本次部署的状态、采集、恢复控制脚本。

BWH 私有目录：`/root/codex-chain-capture-20260917`，仅有公钥，原始数据加密保存。服务：`codex-chain-capture-20260917.service`；仅绑定 Docker 内网地址。
本机 launchd 标签：`local.codex.chain-capture.direct-bridge`、`local.codex.chain-capture.sub2api-inbound`、`local.codex.chain-capture.tunnel`。不会因当前对话结束退出。

从仓库根目录执行（不要输出配置文件/私钥正文）：

```sh
.runtime/chain-capture/venv/bin/python .runtime/chain-capture/control.py status
.runtime/chain-capture/venv/bin/python .runtime/chain-capture/control.py collect
```

`collect` 将 BWH 加密数据下载至 `run/remote-records/records`。对照分析只纳入 `run/records` 和 `run/remote-records/records`，不要混入 `run/selftest`。分析器支持：

```sh
.runtime/chain-capture/venv/bin/python scripts/request-capture/analyze_capture.py \
  --root PRIVATE_COMBINED_CAPTURE_ROOT \
  --key-file .runtime/chain-capture/run/private.pem \
  --labels direct-bridge sub2api-inbound sub2api-outbound \
  --output PRIVATE_REPORT_BASENAME
```

结束时先确认没有活跃请求，再恢复：

```sh
.runtime/chain-capture/venv/bin/python .runtime/chain-capture/control.py stop
```

该命令先以乐观校验恢复 account 11 原地址和两个客户端原始配置，再停止采集并下载远端加密数据。若用户更改过配置，脚本会拒绝覆盖，应逐项恢复本轮临时字段并保留无关更改。恢复后重开目标桌面二号、三号，不要关闭当前主客户端。不要复跑 prepare/switch/start，也不要删除原始加密数据。

## 对照方法与边界

建议在同一项目分别新建任务，使用相同提示词，可包含只读工具调用和后续追问。二号完成后再发三号，避免同账号并发干扰；注意第二次请求可能受缓存预热影响。

1. 在三号入站/出站之间核对同一请求的模型、reasoning、tools、instructions/input、previous_response_id、未知字段、压缩、工具续传、请求头以及完整 SSE 内容。通过响应 ID、请求体和时间顺序联合确认配对，不能只靠最后用户文本哈希。
2. 二号与三号客户端对比输入结构、工具循环、重试、错误、响应 usage 和完成模型。两个独立模型响应本来就可能不同，不能据此断言 Sub2API 改写内容。
3. 对照 key 52 / account 11 / group 4 在用量基线之后的 usage_logs，核验 input/output/cached tokens、计价与 actual_cost。
4. 单个采集点内计算响应头、首个有效 SSE/文本事件、完成耗时。跨主机不直接相减绝对时钟。反向代理会改变 Host/authority/端口并增加传输开销；这些监测效应必须单独标明。不能用一次请求给出稳健延迟结论。
5. 采集是应用层：保留解析后的有序重复头和 HTTP 实体字节/SSE 回调块；不声称保留 TCP/TLS/HTTP2 帧或原始 transfer-chunk 分块。运行中的 session 缺少 session_end 是尚未关闭，不应直接判定损坏。
