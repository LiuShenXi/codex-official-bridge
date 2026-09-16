# 验收记录

日期：2026-09-16。客户端：macOS、Node.js v20.19.0、官方 `codex-cli 0.154.0-alpha.6.2`。服务端：main-server 上的 Docker、Rust 1.95.0、同版本官方源码库。

## 最新 native 验收

| 检查 | 结果 | 证据边界 |
| --- | --- | --- |
| 语法与自动化 | 29 个 `.mjs` 语法通过，60 项测试通过 | 包含真实子进程生命周期及协议替身 |
| Rust 构建 | 成功，3 项测试通过 | 固定官方 commit，测试和服务主程序均重编 |
| Docker | healthy；运行库齐全；仅 loopback 8879 | 1 CPU / 1 GiB / 128 PID、只读根盘、UID 1000 |
| 两模型离线 native 合同 | 5.5 / Sol 通过 | 真实官方 CLI → Node 原始转发 → 受控模型服务，无真实上游 |
| 隔离账号的 live Sol | 通过 | 官方 CLI 经真实 Rust / 账号 / 家宽，本地文件逐字复制、输入未改、最终 DONE |
| 二号实际 profile | Sol / xhigh 通过 | 实际 provider、Key、CodeMode 配置，本地文件及模型回合成功；不是 UI 操作 |
| 官方模型目录 | HTTP 200，7 个模型，包含 Sol | 通过实际网关和官方认证 |
| 容器 Rust 出口 | 72.253.169.123 | `--check-egress` 使用同一 HTTP 工厂，固定 IP 回显地址，不载入认证 |
| 无效代理 | exit 1 / egress_transport_failed | 单独测试容器改为无效 SOCKS，无直连回退；共享隧道未中断 |
| V2 压缩 | 通过 | 官方 app-server 同二号 provider，3 回合、1 次 contextCompaction、压缩后随机 nonce 精确回忆 |
| 旧 unary compact | 官方 HTTP 404 | 原样转发，不能作为旧接口可用证据 |
| 桌面 UI | 未自动验收 | 二号已配置、启动；工具明确禁止操作 com.openai.codex |
| 用户实际桌面请求 | 用户确认正常完成 | 被动观察到网关、Rust runtime 与代理连接及持续回传约 1.73 MB；未捕获该请求 HTTP 状态、完整工具续接与终止 SSE |

## 用户在桌面二号执行的真实任务

2026-09-16，用户在已配置的桌面二号发起真实任务，随后明确回复“已正常完成”。服务端被动检查确认 SSH 转发 → Node 网关 → 私有 Rust runtime → 配置的 SOCKS 代理存在活动连接。某次采样时网关收到 124,005 字节、已回传 1,727,317 字节，且仍有新数据到达；这些是 TCP 传输字节数，包含协议开销，不是模型 token 或纯文本字数。该连接随后结束，服务容器保持 healthy。

监听从任务中途介入。专用响应事件捕获启动时原请求已经结束，后续捕获的少量周期性 HTTP 200 为健康检查，不作为真实模型成功证据。本次成功依据是用户的桌面完成确认与服务器传输记录共同支持；未独立覆盖完整工具续接、HTTP 状态或终止 SSE，也不用于判断模型质量或账号风控。临时观察程序已停止并从服务器清理，没有保存原始包、提示词、项目内容或凭据。原始安全摘要留在本机 `.runtime/real-desktop-observation-20260916.json`，不随源码包分发；本文保留其可交接结论。

## 原生工具与账号证据

离线合同使用 `name = "OpenAI"`，逐轮比较网关入口和替身出口的原始请求字节。5.5 保留 `custom/apply_patch`；Sol 保留 additional_tools 中的 `functions.exec`。真实官方客户端执行工具、修改临时文件，并续传原始 custom 调用及结果。5.5 的字符串输出与 Sol 的数组输出没有被转换归一。

真实 Sol 测试在空的临时 HOME / CODEX_HOME 中运行官方 CLI，客户端只持网关 Key。随机内容仅写入本机 input.txt，未放入提示词；模型通过本地工具生成 output.txt，逐字一致，输入未修改，最终回答 DONE。记录 `.runtime/live-sol.json` 不包含随机内容、账号或凭据。

另一次测试直接加载二号的真实配置，未覆盖 model/provider/effort/features：Sol / xhigh、official_bridge / OpenAI、CodeMode 均按实际配置生效，文件闭环通过。测试末尾的额外全配置 hash 守卫发现文件发生变化，初版脚本因此 exit 1；变化来源未确定，脚本未写配置。工具和最终回答断言此前已全部通过，随后只读复核所需设置正确，将 hash 变化单独记录，没有重跑模型。证据 `.runtime/client-profile-result.json` 保留原守卫结果、配置 warning 和调整理由。没有运行期错误。

## 长上下文压缩

手工旧 `/v1/responses/compact` 请求返回 404。已核对固定版本官方客户端的 URL 拼接与本实现相同，未通过改写错误掩盖该结果。

此版本 `remote_compaction_v2` 默认 true，OpenAI provider 的 V2 路径会在 input 末尾附加 compaction_trigger，并走普通 `/responses`。验收脚本通过真实官方 app-server 调用 thread/compact/start，等待 contextCompaction 完成和 turn/completed，再发送回忆请求。三个回合均完成，压缩后的随机 nonce 精确一致；未注入 dynamicTools、未出现额外交互审批。测试使用二号 provider，临时回合 effort=low，配置文件前后字节一致，临时 HOME / workspace 已清理。安全证据 `.runtime/compact-v2-live.json`。

## 构建与运行问题修复

- 接收畸形 origin-form URL 时曾可能抛未捕获异常：现在返回 400，并有原始 socket 回归。
- 控制文件读取期间子进程退出曾可能误报 ready：读取后复核退出状态；确定性进程回归通过。
- 运行时退出曾只让 Node unhealthy：现 Node 退出 1，让 Docker supervisor 重启；正常 SIGTERM 保持退出 0。两种真实主进程测试通过。
- 超限 chunked 请求完整返回 413，同一 keep-alive 连接仍可服务下一有效请求。
- 网关 Key、账号身份头及 x-openai-fedramp 等在客户端边界移除；实际账号身份由官方库提供。上游错误、Retry-After、加密内容、usage、流事件和未知字段按原样保留。
- Docker COPY 保留源文件时间曾让 Cargo 目标缓存错误沿用旧主程序；出口探测暴露了问题。Dockerfile 现触碰本项目 main.rs，构建日志确认测试和服务二进制均重新编译，最新出口命令实际通过。

## 已部署与未验收边界

账号状态经 SSH 迁到主服务器专用挂载，原本机 legacy 进程已停止。二号配置先作 0600 私有备份，再设置 loopback 8879 / 独立 Key。SSH LaunchAgent 自动重连；服务容器 healthy；专用 buildx builder 已停止，缓存保留。

Rust runtime 是基于官方源码的扩展，不是未修改的官方 CLI。上述成功不能证明模型质量不变、长期稳定或分发不可检测。WebSocket、多账号调度、公共发布、全部应用工具及图片未完整验收。界面自动化被工具按应用标识禁止，不能绕过该限制，也不把 CLI/app-server 结果称为桌面 UI 验收。

## 历史：legacy 已执行

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 17 个 `.mjs` 文件语法通过（追加错误分类回归后） |
| `npm test` | 44 个用例通过，0 失败（最初 31 个，追加 13 个错误分类回归） |
| `BRIDGE_CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex npm run verify:official` | 真实官方进程连接受控本机上游，完整工具闭环通过 |
| 同一 `BRIDGE_CODEX_BIN` 下首次 `npm run doctor` | 初始未登录阶段：官方协议握手成功，预期退出码 2；后续已完成官方登录 |
| 新 Pro 账号下 `gpt-5.5` JSON demo | 真实模型工具闭环通过；客户端执行 1 次 `read_local_note`，随机 nonce 回传校验 `PASS` |
| 同一新账号下 `gpt-5.5` typed SSE demo | 真实流式工具闭环通过；客户端执行 1 次 `read_local_note`，当次新 nonce 回传校验 `PASS` |
| 同一新账号下 `gpt-5.6-sol` 纯文本对照 | `reasoning.effort=low`、`tools=[]`；HTTP 200、`status=completed`、文本 `OK` |

自动化测试覆盖 JSON、SSE、普通消息续接、工具结果续接、并行工具排队、错误会话/调用 ID、鉴权、大小限制、并发拒绝、超时/断连、进程退出、迟到回合清理、事件写出异常、RPC 解析以及子进程环境隔离。

## 真实官方进程的证据

集成验证使用未修改的官方二进制、临时 HOME/CODEX_HOME 和只监听回环地址的受控 Responses 服务；没有使用真实账号或调用 OpenAI 模型。

- 2 次模型协议请求，1 次 `thread/start`，1 次 `turn/start`。
- 1 次官方 `item/tool/call`，客户端执行 1 次函数。
- 首轮完成后官方等待工具结果；结果回复原 RPC request ID，恢复同一个回合。
- 随机 nonce 仅在客户端执行函数时生成，经官方第二次模型请求抵达受控上游，最终返回客户端且完全一致。
- 实際上游工具表只包含 `bridge_fn_0`，严格模式为 `false`。
- 上游认证头只含固定的测试凭据，未继承本机账号或网关密钥。
- 结束后清理测试子进程、监听端口和临时目录。

当前官方 CLI 禁止覆盖内置 `openai` provider，因此验证脚本仅在测试包装器中将 `thread/start.modelProvider` 改为自定义 `fixture`，其地址指向本机。生产代码保持 `openai`。这项受控验证只证明官方进程的协议与会话行为；后续真实订阅账号验证另见下文。

## 检查发现并修复的问题

- 子进程环境重新合并父环境会重新引入已剔除的 API Key 与父会话变量：改为完整传递清理后的环境，并用真实子进程验证变量确实不存在。
- 官方动态工具固定发送 `strict:false`：拒绝 `strict:true`，避免静默改变契约。
- 完成事件写出失败可能留下永远等待的 Promise：操作完成状态独立于流事件状态，失败也及时结束并释放会话。
- 超时发生在 `turn/start` 返回之前时，迟到的成功回合仍须清理：补充迟到回合 interrupt，并验证不会打断之后的新会话。
- 除常规 skills 配置外，还需要关闭 `orchestrator.skills.enabled`，受控上游才只看到外部函数。
- 两次推理各报告 23 tokens，官方第二次 last 为 23、total 为 46：当前不做错误归账，统一返回 `usage:null`。

## 历史：legacy 尚未验证与后续边界

后续实测已执行真实账号登录与生成，另一个 Pro 账号上的 `gpt-5.5` JSON 与 typed SSE 工具闭环均已通过，`gpt-5.6-sol` 的一次纯文本请求也成功，详情见末节。

首版 legacy 只提供单会话 Responses 子集。当时原生 Codex CLI 的 custom/freeform 工具、完整上下文与 compact 协议、多账号调度和生产部署均未实现；后续 native 改造的当前状态见文首。受控上游的结果不能用于判断真实模型质量、账号风控、限流或长期稳定性。

## 同日历史记录：启动服务、首次账号登录与容量错误

- 当时本机 Node.js legacy 服务已启动于 `http://127.0.0.1:8789/v1`，鉴权健康检查 200；本机 Docker daemon 未运行，与后续主服务器 Docker 构建是不同阶段。
- 网关 API Key 随机生成，保存在项目 `.env`（0600），未在文档或输出中记录。
- 设备码登录因账号未开启该功能而未完成；随后使用 `npm run login -- --browser` 成功授权，独立目录内账号类型为 ChatGPT Pro。未复用桌面二号的账号凭据。
- 模型列表查询成功。首次登录账号的真实 JSON demo 分别尝试 `gpt-5.6-sol` 与 `gpt-5.5`，官方均返回 `Selected model is at capacity. Please try a different model.`，未到达客户端工具执行。
- 使用同一旧账号、同一官方二进制直接运行 `codex exec -m gpt-5.5` 进行最小文本对照，也收到相同容量错误，说明当时的失败可在桥接之外复现。
- 新增 `BRIDGE_VERIFY_MODEL` 检查目标模型：`gpt-5.5` 通过；`gpt-5.6-sol` 未通过，实际请求在 input 内嵌的工具声明中暴露 `functions.exec`、`functions.wait` 和 collaboration 工具。默认 fixture 的通过结果不能外推到 Sol。
- 桌面二号已定位独立配置，但未修改。真实原生客户端发送的 custom grammar、additional_tools 和完整历史超出当前网关合同，不能只改地址就使用。
- 修正错误分类：官方 `serverOverloaded` 映射为 503 / `upstream_overloaded`，usage/rate/budget 限制映射为 429 / `upstream_usage_limit`；流式 error 通知与最终失败事件统一处理，不再全部掩盖为笼统 502。该映射经自动化回归验证。

这些是首次账号的历史观察，不能据此确定账号风控或普遍限流的原因。

## 同日追加：新账号的真实工具闭环与纯文本验证通过

- 更换为另一个 Pro 账号，并通过官方登录流程完成隔离实例授权；不记录账号邮箱或凭据。
- 使用 `gpt-5.5` 分别运行真实 JSON demo 与 typed SSE demo，两次均成功返回客户端函数调用。
- 每次客户端实际执行 1 次 `read_local_note`，读取临时本地文件中的当次随机 nonce；首轮提示未包含该 nonce。
- 客户端将实际文件内容作为 `function_call_output` 提交，通过 `previous_response_id` 续接；两种传输的最终真实模型回答均包含对应 nonce，示例均输出 `PASS`。临时 nonce 不写入本记录。
- 同一新账号下，补充一次 `gpt-5.6-sol` 纯文本请求：`reasoning.effort=low`、`tools=[]`，返回 HTTP 200、`status=completed`、文本 `OK`。
- Sol 的这次文本成功不证明动态工具隔离或原生客户端兼容。`gpt-5.6-sol` 的服务端工具隔离仍未通过，未因更换账号而判定解决。

legacy 阶段结论：真实账号下 `gpt-5.5` 的 JSON 与 typed SSE 客户端函数工具闭环均可运行，`gpt-5.6-sol` 的一次纯文本生成也成功。当时原生桌面二号尚未适配、配置未切换，多账号分发和生产部署未完成。这些成功不证明新 native 架构可用、长期稳定，或能够规避上游检测、解除账号限制；native 最新状态见文首。
