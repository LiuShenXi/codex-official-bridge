# Codex 桌面二号、三号改接一号实例（2026-09-17）

用户指定目标账号：wangzizai666@gmail.com。已核验 main-server 原网关认证中的邮箱。

## 最终链路

- 桌面二号 → 本机 127.0.0.1:8879/v1 → 原 SSH 隧道 → main-server 原一号网关 127.0.0.1:8879。
- 桌面三号 → https://sub2api.monasapi.com/v1 → 原 Key #52 / 测试分组 #4 → 新账号 #12「框架测试-一号实例」→ BWH 172.20.0.1:28879 → 专用 SSH 隧道 → 同一原一号网关。
- 两份客户端保留 gpt-6-astra / medium、HTTP/SSE、WebSocket 关闭及既有工具设置；均已启动独立桌面进程。
- 新测试车为 apikey，active / schedulable=true，并发4、优先级1、倍率1、Responses透传。只保存网关 Key，未复制 OAuth 登录凭据。原一号网关未重启。
- 测试分组 #4 只绑定 #12，定价、倍率、余额、Key #52 不变。旧 #11「框架测试-七号车」移出测试组并暂停调度，地址从临时采集端口恢复到 28880；未删除。生产分组及原服务器 account-2/account-3 保持原配置。

## 隧道和采集收尾

- BWH 新服务 codex-bridge-first-tunnel.service，enabled / active。复用专用隧道用户和密钥，仅新增授权 permitopen 127.0.0.1:8879；新增 Docker 内网监听172.20.0.1:28879。原 8880/8881 通道未重启。
- 在途采集为零后，停止本机三个 local.codex.chain-capture.* 服务及 BWH codex-chain-capture-20260917.service。加密记录已下载保留。
- 旧采集状态已标记被本次切换替代，不再使用旧 stop 流程覆盖新客户端配置。

## 验证

- BWH 到一号、本机到一号的鉴权模型目录均200，各7个模型。
- 安装版官方CLI 0.154.0-alpha.6.2分别加载桌面二号/三号实际配置，按顺序完成随机文件读取、原样复制、DONE返回，均退出0且文件字节一致，无运行阶段错误。
- CLI启动有配置警告，另自动将临时验证目录记为可信项目；未改变实际模型、档位或接入路径。
- 三号用量 #188345、#188347 均为 Key52 / Group4 / Account12，requested_model及upstream_response_model均为gpt-6-astra；实际费用合计0.4704642站内计费单位。
- Redis账号缓存确认 #12 可调度、GroupIDs=[4]、邮箱与一号地址正确。
- 两个桌面独立进程启动确认；未执行桌面UI点击发请求验收，也未覆盖WebSocket、图片或长时并发。

## 证据和回退

本机私有证据/操作脚本：项目 .runtime/first-instance-switch/，两个 profile 验证JSON及受保护操作前快照。BWH备份 /root/codex-first-instance-switch-20260917/before.json；main-server 同目录保存 authorized_keys.before。含密钥备份仅本机/服务器受保护目录保存，不进源码或本文。

若回退，应先暂停新车并排空请求，按当前需求重新选择分组绑定和客户端路由；不要直接恢复已停止的18885/18886/28882采集入口，也不要从冷备启动另一份OAuth刷新端。
