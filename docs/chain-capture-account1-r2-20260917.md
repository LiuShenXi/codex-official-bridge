# 一号实例：桌面二号直连 / 三号 Sub2API 抓包（2026-09-17 第二轮）

> 后续更新：本轮采集已因本机入站记录完整性异常撤下，三号恢复正常Sub2API路径。二号被另项操作改接account-4，现已接入生图MCP；不能再按同账号分析。详见 `docs/client-repair-20260917.md` / 知识库 `Codex二号生图与三号断流修复-20260917.md`。

状态：三点采集已启动，等待用户测试。本轮独立目录，勿混入早前七号账号采集。

- 二号 → 127.0.0.1:18885/direct-bridge → 127.0.0.1:18884 SSH → main-server原一号8879。
- 三号 → 127.0.0.1:18886/sub2api-inbound → https://sub2api.monasapi.com → Key52/Group4/Account12「框架测试-一号实例」→ BWH172.20.0.1:28882/sub2api-outbound → 原28879 SSH → 同一main-server8879。
- 目标邮箱wangzizai666@gmail.com；两边保持gpt-6-astra/medium，HTTP/SSE，WebSocket关闭；原组定价/倍率/余额/Key未改。
- 加载官方app-server config/read确认两份有效配置；三处models探测200；Redis #12确认出站地址28882、仅Group4、可调度。仅重开两个隔离桌面，无模型生成自测。
- 抓包代码17项单元测试通过；本地模拟压缩正文、重复头、SSE、WS消息/关闭、加密认证完整性自检通过。

## 位置和控制

本机项目目录：`.runtime/chain-capture-account1-20260917-r2/`。
私钥仅本机run/private.pem；远端只部署公钥。记录含完整请求/响应/鉴权，原值加密存储，不输出凭据或完整提示词。
远端：BWH `/root/codex-chain-capture-account1-20260917-r2/`。
远端服务：`codex-chain-capture-account1-20260917-r2.service`。
本机服务前缀：`local.codex.chain-capture-account1-r2.`，后缀direct-bridge/sub2api-inbound/tunnel。

从仓库根目录运行：
```sh
.runtime/chain-capture/venv/bin/python .runtime/chain-capture-account1-20260917-r2/control.py status
.runtime/chain-capture/venv/bin/python .runtime/chain-capture-account1-20260917-r2/control.py collect
```
采集结束、三处在途均为零后再stop：
```sh
.runtime/chain-capture/venv/bin/python .runtime/chain-capture-account1-20260917-r2/control.py stop
```
stop只恢复本轮入口字段，保留用户模型等修改；恢复二号8879、三号Sub2API域名、Account12上游28879，再停止并收集记录。其后重开二/三号桌面。当前请勿提前运行stop或此前旧目录的恢复脚本。

分析器：`scripts/request-capture/analyze_capture.py`。仅合并本轮run/records及collect后的run/remote-records/records，使用本轮run/private.pem，排除run/selftest。run/ready.json记录准备完成时点，run/state.private.json含原始配置/账号快照和用量基线。

## 对照要求

建议相同项目中分别新建任务，用相同提示词，二号完成再发三号。按响应ID与请求内容配对三号入站/出站，检查model/reasoning、工具定义和续传、上下文/未知字段、压缩、请求头、SSE事件、usage和错误/重试；二三号之间同时检查上下文差异，避免仅凭输出不同判断转发改写。
计时使用各采集点内部单调时钟；跨主机不直接相减绝对时间。代理、TLS和网络会影响观测。采集为HTTP实体/解析后头/SSE/WS应用消息，不等同于原始TCP/TLS/HTTP2帧；后台采集未结束时缺少session_end不能认定损坏。
