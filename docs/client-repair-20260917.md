# 桌面二号生图工具与三号断流修复（2026-09-17）

## 变更

- 二号新增 `bridge_images` MCP（项目 scripts/desktop-image-mcp.mjs），connection.json仅本机0600存储当前网关Base URL/Key，tool_timeout_sec=660；新增该profile专用AGENTS说明直接使用已配置工具。
- 修复图片客户端对带路径前缀的网关地址支持，正确保留 `/codex/account-4`，生成与健康地址均在该网关下。固定请求模型仍为gpt-image-2。新增路径前缀回归测试，图片MCP测试15/15、36个mjs语法检查通过。
- 本次操作期间发现二号已被另一项配置操作改为 `https://origin-api.monasapi.com/codex/account-4/v1`、gpt-5.5/high，因此保留当前设置，没有盲目恢复旧一号。该网关邮箱/部署见account4文档。
- 三号撤去本轮采集，恢复 `https://sub2api.monasapi.com/v1`，Sub2API #12上游恢复BWH28879→main-server8879。测试分组和账号不变。二号当前四号网关、三号当前一号网关，已不是同账号对照。
- 本轮三处抓包进程和专用18884隧道停止，r2记录保留。此前状态文件已过期，不应把其中ready/active_flows当成当前真值。入站记录frame155认证失败且后续帧边界异常；原因尚未确诊。该轮不具备完整响应对比条件，不能据此断言Sub2API改写或损坏流。

## 验证

- 官方app-server mcpServerStatus/list确认二号加载bridge_images，提供generate_image/get_status。
- 真实MCP stdio调用generate_image，经二号当前account-4网关，gpt-image-2返回PNG 1370×1148、1,662,557字节。实际测试图：`/Users/shenxi/Library/Application Support/Codex-Second-Account/codex/generated_images/bridge-tool-verification-20260917.png`。
- 最初用二号当前gpt-5.5/high文字模型发起工具流程，模型在调用工具前返回at capacity；这次未生成图片。其后上述独立MCP验证成功。不能将模型容量问题归为缺少生图工具。
- 三号加载真实桌面配置的官方CLI文件工具读写/续传合同通过，无运行阶段错误，退出0，输入输出字节一致；原截图中的三号错误出现在18886抓包入口。恢复后通过，不等于已精确定位抓包内部根因。

本机私有备份与证据：`.runtime/client-repair-20260917/`。原始配置备份含凭据，不输出。抓包恢复详情：`.runtime/chain-capture-account1-20260917-r2/run/state.private.json`，已标记stopped_at及二号外部改动。图片MCP未接入三号，本次只修复二号缺工具和三号断流。

## 文字模型复核

二号当前四号账号下，gpt-5.5/high再次请求get_status工具仍在模型阶段返回capacity；仅在单次测试中覆盖为gpt-6-astra/medium也同样返回capacity，未写回默认模型。图片实际接口可用不代表文字模型当前可用。已询问用户保留四号或将二号切回正常一号；回答前保留四号。

用户最终选择：保留二号四号账号，等待文字模型容量恢复。二号继续gpt-5.5/high和account-4，生图MCP启用；三号Astra/medium和Sub2API一号链路。两个桌面已重新打开。未创建自动重试或定时监控。
