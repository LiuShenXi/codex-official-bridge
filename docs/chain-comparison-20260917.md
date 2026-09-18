# 二号直连 / 三号 Sub2API：GPT-6 生图测试观察

采样截止：2026-09-17 11:16（北京时间）。这是运行中快照，任务尚有未终止请求；监测和临时路由保留，没有关闭客户端或恢复正在使用的路径。

## 主要结论

1. 两边主请求均为 `gpt-6-astra` / `medium`，最后用户输入哈希相同，但实际几乎同时开始，随后各自工具上下文不同。因此不具备严格的串行、等长上下文延迟对照条件。
2. 两边成功的 `response.completed.model` 都是 `gpt-5.6-luna`。三号进入 Sub2API 与转发到 bridge 的请求仍为 Astra；返回到 Sub2API 前已标记 Luna。不能认定为 Sub2API 把请求模型改成 Luna，也不能仅凭此字段判定真实运行权重。当前证据不能认证一次成功的 GPT-6 实际模型测试。
3. 尚无 `/v1/images/generations` 请求。两边请求中列出的工具没有图片生成工具，MCP 配置均只有 node_repl 和 computer-use；二号调用 `tools.image_gen` 明确收到 TypeError。两边主要在查找工具和处理过载，并未完成可对照的图片接口生成。此前让用户写“使用内置生图工具”的建议不适用于这两份配置。

## Sub2API 转发差异

以相同 `response.completed.id` 确认因果配对的 11 条成功响应：

- 11/11 条 SSE 的解析后 JSON 事件及顺序相同，未发现文本、工具调用或 usage 事件被改写。HTTP 实体字节不同；入站响应多出 SSE 注释行，不能称为逐字节透明代理。
- 首次无历史工具结果的请求体字节相同。后续请求删除历史 `reasoning` 和 `custom_tool_call_output` 项的 `id`，并重新序列化 JSON。配对样本中，其余字段语义相同，包括 model、reasoning、工具内容和 call_id。
- 转发删除 `session-id`、`thread-id`、`x-client-request-id`，增加 `accept-encoding`。授权头替换为上游 bridge key 属预期；Host/端口变化混有反向代理观测点影响。
- 遇上游过载，二号直接接到 HTTP 200 流内的 error / response.failed；三号会先尝试重试，部分请求最终变为 HTTP 503。不能以 HTTP 200 计为推理成功。
- 7 条较短的配对耗时差为约 1.17–1.36 秒，另有约 2.93、3.16、10.33、15.06 秒。较大差值包含重试等待。该差值包含公网、Cloudflare、隧道、Sub2API 和监测代理开销，不能当作纯 Sub2API CPU 开销，也不能作为直接模型生成速度比较。

## 额度核验

已核对的前 8 条三号成功记账（usage_logs 187514、187515、187518、187521、187523、187526、187528、187529）：

- 实扣合计 1.469778888 站内计费单位，这是样本合计，并非任务最终总额。
- 8/8 条严格符合当前 Astra 定价：未缓存输入 15.42 / 百万 token，缓存读取 1.542 / 百万 token，输出 77.1 / 百万 token，倍率为 1。
- 8 条均记录 requested_model=Astra、upstream_response_model=Luna、upstream_model_mismatch=true，却仍按 Astra 计费。
- 图片数量和图片输出 token 均为 0。因此只能说“按当前 Astra 价格计算的算术正确”；不能确认模型归属正确，也未验证图片计费。

## 下一步

优先核实 bridge→官方上游的模型字段来源，再给两份实例启用项目已有的 `bridge_images` MCP，并使其分别读取本轮直连/经 Sub2API 的监测入口，重新进行相同提示词的图片对照。此建议尚未实施，不宣称原生同名 image_gen 已解锁。

当前活动采集和恢复步骤见 `docs/chain-capture-20260917.md`。不得在用户任务仍有请求时直接重启或恢复路径。用户修改了模型和配置后，恢复应逐项还原本轮临时路由，保留其他用户更改，不能整文件盲目覆盖。

加密原始记录与安全分析快照位于 Git 忽略的 `.runtime/chain-capture/run/`，私钥仅存本机；公开报告没有原始提示词、密钥和鉴权头值。
