# Codex 桌面三号接入 Sub2API（2026-09-17）

> 最新更新（2026-09-18）：按用户要求，三号 Key #52 / 分组 #4 已从 #12 切到 #13「框架测试-四号实例」，上游活动认证邮箱实时核验为 `lfxwalkerjohn@gmail.com`。链路为 Sub2API → `https://origin-api.monasapi.com/codex/account-4` → main-server account-4。#13 保留原分组 #2，新增分组 #4；#12 移出 #4。事务同步 scheduler_outbox，Redis 确认 #13 GroupIDs=[2,4]、#12 不再有分组。客户端入口不变，实际模型为 gpt-5.6-sol / xhigh，无需重启。三号真实最小请求 HTTP 200 / response.completed，约 2.1 秒；用量 #189637（2026-09-18 11:00:04 +08:00）归属 Key52 / Account13，输出 5 Token。该验证不代表长期连接稳定性已验收。下方记录均为历史状态。

> 后续更新（2026-09-17）：二号和三号已改接 wangzizai666@gmail.com 的一号网关；三号使用新测试车 #12，旧采集已停止。本文下方为历史记录，勿执行旧路由恢复。当前记录：`Codex二三号改接一号实例-20260917.md` / `docs/first-instance-switch-20260917.md`。

## 已配置链路

```text
macOS Codex Third Account
  → https://sub2api.monasapi.com/v1
  → 分组 #4「新框架测试分组」/ 专用 Key #52
  → 账号 #11「框架测试-七号车」
  → http://172.20.0.1:28880 / BWH 专用 SSH 隧道
  → main-server codex-official-bridge-account-2 / 127.0.0.1:8880
  → 官方账号 a0919155451@gmail.com
```

这里的“桌面三号”是 Mac 客户端编号；它连接的是服务器 account-2（原七号车），不是服务器 account-3。出口继续使用已部署的 IP2，见 [IP2 部署记录](ip2-egress-20260917.md)。

## 客户端

- 启动器：`/Users/shenxi/Desktop/Codex Third Account.app`。
- 独立 CODEX_HOME：`/Users/shenxi/Library/Application Support/Codex-Third-Account/codex`。
- 独立桌面数据：`/Users/shenxi/Library/Application Support/Codex-Third-Account/desktop`。
- provider：`sub2api_framework`，显示名称 `OpenAI`，Responses HTTP/SSE，WebSocket 关闭。
- 配置与 API Key 认证文件均为 0600，父目录 0700；Key 不写入本文。
- 官方模型目录从对应 bridge 获取并保存为该 CODEX_HOME 的 `models.json`，提供 7 个模型的原生能力元数据。
- 初始创建选择 Astra / ultra；桌面启动后实际配置变为 Sol / high，验证使用实际配置，没有强行改回。最终生效值以客户端 config.toml 为准。
- 本机一号、二号配置未修改，原网关与认证未重启或复制。

独立配置目录和自定义 provider 参数参考 [官方配置说明](https://learn.chatgpt.com/docs/config-file/config-reference)。

## Sub2API 配置与历史记录

- 复用用户已创建、当时没有账号和 Key 的分组 #4「新框架测试分组」。
- 只绑定新账号 #11，API Key 类型；复用对应 bridge 网关凭据，没有向 Sub2API 导入 OAuth AT/RT。
- 账号并发 4，优先级 1，倍率 1，开启 Responses 透传；WebSocket 仍为 off。
- 分组复制生产分组 #2 的 Astra 自定义定价：每百万 Token 输入 $15.42、缓存读取 $1.542、输出 $77.10、缓存写入 $19.275。沿用分组原有长上下文计费开关。
- 专用 Key #52「Codex 三号 · 框架测试」归管理员用户 #1，绑定分组 #4，使用普通余额计费，没有充值或迁移余额。
- 原 #7、#9 已在此前操作中软删除。最初尝试对 #7 绑定分组后发现软删除使调度池为空；本次已撤销对 #7 的分组、schedulable 与 extra 修改，保留原软删除和暂停状态，再创建 #11。历史账号未复活。
- 调整过的 #7 99% 暂停阈值同样已恢复。新 API Key 入口不复制旧 OAuth 额度快照；官方配额仍由上游执行。实时官方查询当时显示 Pro、周用量 99%、allowed=true、limit_reached=false。
- 通过数据库事务写入配置并同时发布 scheduler_outbox 账号/分组事件；没有重启 Sub2API、数据库或共享隧道。

## 验证结果

- 桌面三号进程已启动，启动参数指向独立桌面数据目录。
- 使用安装版官方 CLI `0.154.0-alpha.6.2` 加载三号真实配置，Sol / high，经整条链路执行随机文件原样复制并返回 DONE，退出码 0。
- 本地文件字节一致、输入未改、模型回合完成；这是 CLI 加载桌面配置的工具合同验收，不是桌面 UI 点击验收。
- 中途发生一次 upstream_capacity，随后恢复完成，不能宣称上游没有偶发繁忙。
- 用量 #187343、#187349 均属于 Key #52、分组 #4、账号 #11；费用分别 $0.017233、$0.008435，合计 $0.025668，total_cost 与 actual_cost 一致。
- Astra 的实际生成、本链路 WebSocket、图片、长期并发尚未在本次测试覆盖。

无凭据证据：项目 `.runtime/third-client/profile-result.json` 与 `verification.json`。包含凭据的操作前备份仅在 BWH `/root/codex-third-client-20260917/before.json` 和本机受保护 `.runtime/third-client/` 中，不随源码交付。

## 撤回范围

关闭桌面三号后，可只暂停/软删除 Sub2API #11 并停用 Key #52。保留原账号 #7、#9 的历史删除状态；不要把操作前 OAuth 备份重新启动成另一个刷新端。分组 #4 原有设置与本次修改前记录已私有备份。无需停用服务器 account-2、account-3 或共享 IP2 隧道。
