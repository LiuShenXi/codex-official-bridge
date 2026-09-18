# 调度状态与控制合同

日期：2026-09-18。状态：原型后的实现设计，尚未接入正式 Node/Rust 数据通路。沿用现有 native runtime；与[主设计](scheduler-design-v1.md)、[出站一致性合同](scheduler-fidelity-contract.md)配套。独立原型的 19 项测试不能替代本文新增合同的验收。

## 1. 责任与状态分离

Node Scheduler 是唯一准入决策者；SQLite 是绑定和容量权威；Rust 持有认证、原始请求、发送闸门与上游观察器。HTTP、WS、compact、图片共享同一个准入服务。客户端工具执行不移到服务器，管理后台不拥有第二份状态。

| 状态轴 | 状态/含义 |
| --- | --- |
| execution | QUEUED / RESERVED / DISPATCHING / RUNNING / CANCELLING / UNKNOWN_EXECUTION / SUCCEEDED / FAILED / CANCELLED；明确未发送另记证据 |
| delivery | ATTACHED / DRAINING / LOCALLY_DELIVERED / INTERRUPTED；本地交付完成不是客户端业务 ACK |
| lease | HELD / DEBT / RELEASED_PROVEN / WAIVED_UNCERTAINTY |
| attempt | PREPARED / SEND_COMMITTED / SEND_STARTED / ENDED / REVOKED_NOT_SENT |
| task guard | active_operation / delivery_pending / unknown_execution / delivery_unconfirmed / manual_pause，可组合，分别有原 request 引用 |

一个 lease 固定引用原 principal/account/global/task 资源向量。HELD→DEBT 是原地转换，只占一份容量；不能先减 active 再加 debt 产生可插入新请求的窗口。释放针对 lease_id，不对账号计数盲目减一。人工接受不确定性释放的是调度预算，不能把执行结果伪造为完成。

可信终态提交后释放生成名额，旧操作未完成交付时保留 task.delivery_pending；其他任务可使用释放的容量。交付结束清除此项，明确中断转 delivery_unconfirmed。任务绑定始终保留。

## 2. 任务来源与接入合同

服务端由 Key 得到 principal，由入口配置或该 Key 授权集合得到 namespace。HTTP/WS、重连、Key 轮换、客户端重启不得改变 namespace。任务键为 `(principal, namespace, external_task_id)`；thread-id 采用固定版本实测合同。session-id、x-client-request-id、turn_id 均不能直接充当逐模型操作 ID。

### 2.1 来源登记

拟议 `POST /v1/bridge/tasks` 接收 `external_task_id, origin_kind, parent_task_id?`。namespace 只能取授权值；principal 不接受客户端指定；业务接口不接收任意 account_id。

| origin_kind | 处理 |
| --- | --- |
| fresh | 鉴权后的明确空白任务声明，登记为 UNBOUND；首次数据仍核对已知旧历史/不透明上下文，冲突则拒绝 |
| fork | 父任务必须可访问且已绑定，默认同 principal/namespace；原子登记并继承父账号，父账号当前不可用也不换号 |
| resume | 只查询已经登记的同任务；未知 resume 不得变成 fresh |
| import | 独立管理接口；核实旧任务、真实账号和来源后绑定；不是任意跨账号迁移 |

同键同来源登记幂等；来源、父任务或原账号冲突返回409，不能覆盖已有绑定。原生 fork 的已验证握手父标识可自动完成上述 fork 登记；父未知或身份冲突则拒绝。ordinal 不能单独证明整个历史合法。

登记成功返回 task_id、origin 状态和 registration_revision；不预先消耗生成容量。fresh 选号在实际准入时完成；WS 在上游握手前完成绑定与连接准入。

未知 root 的第一版流程：不触达上游，返回 `task_origin_required`，按任务键建立有数量/期限上限的 pending 元数据；显式登记后由调用方在同一任务重新提交。pending 不保留请求正文、不占账号、不后台重跑；到期只删 pending，不删正式绑定。CLI 提供 pending 查询和登记；原生 UI 能否原任务重试需单独验收。

### 2.2 两种入口的交付边界

- 严格共享池服务显式登记调用方及通过验收的生命周期适配器。未知 root 不根据“库里没有”“没有 prior”“window=0”或空预热自动标 fresh。
- 原生仅改 URL 的兼容入口固定一个不可变账号，同样走调度内核。首次观察的可识别任务映射到此账号，来源记 `fixed_account_unverified`，不能假记 fresh；已知来源冲突仍拒绝，外来旧上下文需要迁移核验。缺少稳定任务身份必须返回 task_identity_required，不能降级放行后只说不承诺任务保护。
- fixed_account_unverified 不自动转为池内自由选号任务；入口维护、Key 轮换、原账号不可用都不得悄悄改指另一账号。它只保证不在账号池中漂移，不替任意历史来源作证。

严格池透明接入所需的最小客户端适配，是在 fresh/fork/resume 时可靠登记，并保证登记 ACK 前该任务没有模型出站，包含 startup prewarm。官方 core 的预热可能早于 thread/start 返回，不能假定 UI 回调登记来得及。静态 origin=fresh 请求头会错误标记 resume/fork，禁止采用。该动态适配器尚未实现；不能靠一个新增服务端 API 宣称桌面开箱即用。

## 3. 排队、重试及错误合同

每个提交分配内部 request_id；每次实际上游发送有 attempt_id。内部新 ID 不是新的业务意图证明。

| 调用合同 | 同任务多个提交 |
| --- | --- |
| 原生无逐操作键 | 从第一个提交入队起设置 active_operation；额外无法区分意图的生成拒绝，不再入队。task 最多一个待执行/执行中的逻辑操作 |
| 显式稳定幂等键 | `(principal, task, key)` 唯一；同 key 原始内容冲突则409；重复请求查询原状态，不重新发送、不伪造响应流 |
| 显式不同操作键且允许排队 | 可按 task FIFO 排队，最多主设计的任务队列上限；先前 UNKNOWN/交付障碍必须阻止后续派发 |

显式幂等键第一版只支持同逻辑输入、同原始内容的合同。未来若要支持官方恢复的“增量→完整历史”等变形，必须有客户端确认的逻辑操作映射，并另存每 attempt 原始摘要；当前不能把不同字节自动解释成新操作重发。

所有传输在入队前及 SEND_COMMIT 事务内都查 task guard。WS 重连、HTTP fallback、去掉 previous_response_id、改用完整历史或更换内部 request_id，均不能绕过已有障碍。原生客户端自行做的协议恢复原样接受校验，不由框架替它删字段。

检查区分当前操作与额外提交：当前 guard 所引用的操作可继续其合法状态转换；原生额外提交被拒绝。显式不同操作键可在 active_operation 后有界排队，但不能越过尚未消除的生成/交付障碍派发；UNKNOWN/交付未确认拒绝新入队。转换到下一队首时以事务替换 guard 引用，不能靠临时清空产生竞争窗口。

| 本地原因 | HTTP / WS语义 | 调度后果 |
| --- | --- | --- |
| task_origin_required / context_origin_conflict | 409 / 同原因 error 或握手拒绝 | 不绑定随机账号，不触达模型上游 |
| task_busy | 429 / 同原因 error | 无逐操作键时不新增同任务排队项 |
| account_busy / queue_timeout | 429，可信 Retry-After 才提供 | 只等待原账号；超时没有发送 |
| task_execution_unresolved | 409 / 同原因 error | 原任务 DEBT/障碍继续存在 |
| account_capacity_uncertain | 503 / 同原因 error | 原账号容量全被未知占用时立即说明，不伪称普通短队列 |
| task_delivery_unconfirmed | 409 / 同原因 error | 生成已结清，但不重新生成补答案 |
| coordinator_unavailable | 503或连接终止 | 停止新准入，已发操作按证据收尾 |

具体 WS error envelope、关联字段及 Close fallback 必须用固定版本官方客户端验收，不能仅凭状态码推断。实测409/关闭/retryable:false仍可能触发重试；持久 guard 才是保护。错误中不暴露账号邮箱、凭据和其他用户任务。入口请求/握手限频、pending 限额和审计聚合限制反复拒绝的本地开销，不能把每次拒绝都扩成无限队列或大量持久正文。

所有 response.create（含 generate:false）都需来源、模型、任务、容量准入。预热单独记录 operation_kind，但不使用廉价健康检查旁路；其完成与交付语义需以固定协议验证。原型曾放行预热，正式验收必须补上。

已完整本地交付后的迟到重试与用户主动重复提问可能不可区分；原生无操作键模式不承诺端到端 exactly-once。正文 hash、等待一段时间或 turn_id 都不能消除这种歧义。

## 4. 发送许可与事件确认

### 4.1 唯一发送顺序

1. Scheduler 短事务复查绑定/来源/权限/配置/FIFO/容量，提交 lease=HELD、request=RESERVED 和 attempt ID。此时无发送权。
2. worker PREPARE：持有原始正文/消息，验证路由、摘要、代际与内存预算；建立本地 attempt 槽，返回 READY，不能发生成。
3. Scheduler 用 expected revision/state 做 CAS；仍可发送才写 attempt=SEND_COMMITTED、request=DISPATCHING，持久提交后发一次性 SEND_COMMIT。
4. worker 在统一发送/撤销互斥区校验代际、许可 nonce、attempt 与摘要，标记 SEND_STARTED，再调用网络发送。离开此闸门后即视作可能已发；网络报错不能自动证明未发送。
5. SEND_COMMIT 重收只返回已有状态，不再发送。超时不创建另一 attempt；无证据就按 UNKNOWN 处理。
6. 关联响应归属、终态与 lease 的事务提交后 ACK。worker 在 ACK 前保留关键事件；对应成功终态在提交前不得完整交付下游。

401 的现有有界恢复仍占同一 request lease；每个实际发送重复 PREPARE/COMMIT。中间明确401只结束 attempt；取消、撤权或任一 attempt 未知后不得继续恢复。不能在官方恢复之外再套通用429/5xx重试循环。

### 4.2 本地控制消息

独立 capability 认证的本地双向通道；外部请求不能指定内部字段。公共 envelope：protocol_version、message_id、worker_id、generation、scheduler_epoch。执行消息带 task/request/lease/attempt/account、config_revision 和可选 connection_id。历史证据保留 original_epoch/generation，不能套当前代际后结算。

| 消息 | 核心字段/规则 |
| --- | --- |
| HELLO / FENCE / SNAPSHOT | 协议版本、barrier ID、活跃 attempt 和未 ACK 事件；冻结/快照与发送闸门原子排序 |
| ADMIT | 已验证身份、路由、模型、来源、transport、deadline、预算引用；HTTP/WS共用实现 |
| PREPARE / READY | 完整关联、原始数据 HMAC/长度、数据持有引用；不含明文模型内容，不赋予发送权 |
| SEND_COMMIT | 持久提交引用、一次性 nonce、attempt 和摘要；不可消费两次 |
| REVOKE / RESULT | 精确 attempt 与原因；结果只能是 PROVEN_NOT_SENT 或 MAY_HAVE_SENT |
| ATTEMPT_EVENT | event_seq、kind、原关联、证据类型、必要response ID、usage；kind区分STARTED、OWNER、REJECTED、TERMINAL、OBSERVER_LOST、NOT_SENT |
| EVENT_ACK | 精确事件身份、提交 revision、duplicate/结算结果；不确认尚未提交的事件 |

控制摘要仅在私有通道/状态库，不能塞进上游模型头或正文。事件唯一键 `(worker_id, generation, event_seq)`，同时验证内容摘要；同键异内容报协议冲突。终态包含足够的响应归属，不能因早期 OWNER 事件丢失而凭空成功。ACK 不跨过未提交的序号间隙。

关键元数据 outbox 有界，每个在途 attempt 预留终态空间，满时拒绝新 PREPARE，不丢终态腾位置。第一版可用内存 outbox，worker 崩溃丢证据诚实降级 UNKNOWN；需要自动恢复此类故障时另验持久 journal。ACK 允许遗忘事件，不允许遗忘 permit 已消费/已撤销的防重放记录。防重放记录也必须有界：达到预算时停止新派发、排空并更换 generation，或使用经过验收的序号回收屏障；不可随意TTL淘汰后继续接受旧许可。新 generation 永不接受旧许可。

### 4.3 竞争裁决表

| 竞争窗口 | 条件更新与结果 |
| --- | --- |
| QUEUED取消/超时 | 撤队、释放正文预算；没有发送权 |
| RESERVED取消先提交 | 撤销 lease/attempt；迟到READY拒绝 |
| SEND_COMMIT先提交、取消后到 | 进入CANCELLING并REVOKE，不能直接回收 |
| REVOKE在worker消费前 | 在互斥区永久撤销该attempt，确认NOT_SENT；迟到COMMIT拒绝 |
| REVOKE在消费后 | MAY_HAVE_SENT，保留占用并观察 |
| 取消与终态竞争 | 可信终态决定真实outcome，取消只影响交付；不能把成功改成取消 |
| 重复终态 | 同原lease幂等ACK；矛盾证据暂停核对，绝不二次释放 |
| 人工释债先于迟到终态 | 补原outcome/用量/证据，不再释放；不写入新请求流 |
| 迟到终态先于人工释债 | 管理操作CAS失败并返回已结清 |
| 重启时无SEND_COMMIT | 隔离旧派发能力后，凭未具发送权的证据取消RESERVED |
| 重启时已有SEND_COMMIT，worker退出 | 退出只阻止未来发送，不证明过去未发；无独立证据则UNKNOWN |

所有结算按原 lease/attempt/worker generation 和 row revision 处理，禁止用“当前任务的活跃请求”代替原关联。管理修改权限/维护、取消、READY 和 SEND_COMMIT 都需参加这套 CAS。

## 5. 上游观察与下游交付

HTTP upstream reader 由 worker 独立持有，不能随下游 Body drop 自动消失。WS 拆为上游 reader、发送闸门、下游 writer，不能继续以任一 pump 退出就丢弃两端的方式管理执行证据。这是正式代码仍需实现的变更。

观察器用有界只读解析窗口检查协议；原始字节/应用消息进入有界交付缓冲。每个输入片段先在副本中解码/解析，凡其足以完成 OWNER/TERMINAL 事件，必须等对应数据库 ACK 才转发该原始片段；不得重新编码原文。压缩SSE跨块、多事件同块、解码器滞后及WS大消息必须验证这个屏障，不能只测未压缩单事件。

下游慢读触达队列或期限上限时，明确终止该交付、记录 interrupted，丢弃尚未交付缓冲，切换 DETACHED_DRAIN；不丢输出后假称成功。客户端取消/断连也停止新的生成与交付，进入有界上游观察。观察期间只读取旧操作的事件，不自动重新连接取结果、不发送新生成。

观察取得可信终态则在同一事务提交结果、释放生成并保留必要交付障碍；只读到EOF/Close/HTTP200不够。观察期限、字节/解析预算耗尽或上游断流，清理本地reader；仅尚无持久终态的HELD lease转DEBT，保留任务障碍。终态已提交而ACK丢失或随后下游超时，只核对提交并更新交付/观察状态，不能复活债务或再次释放。未来若使用官方取消命令，必须先验证命令、对应ACK及其停止含义；目前不假定该能力存在。

这种被动观察会改变取消后的连接关闭时序，属于明确的兼容变更。内容一致不代表取消时序一致，须通过固定官方客户端取消/重连fixture后才能启用；不能用过去relay的结果冒充新结构通过。

### 5.1 资源预算

生成名额、上游传输/观察器、下游连接、交付缓冲分别计数。保留 detached upstream socket 也要占连接预算。内存总额至少包括 raw请求、解码副本、单条完整WS消息/SSE事件、交付队列、观察窗口及outbox；401恢复仍保留的请求体转计attempt缓存，不能在出队时从总预算中消失。

开发起点：账号/任务生成上限各1，用户2；原生每任务待执行项1，显式操作键模式最多4；用户队列16、全局128、等待15秒并受客户端deadline约束。UNKNOWN/交付障碍直接拒绝，不占队列。

观察时长可以用300秒作为本地fixture起点，测试使用虚拟时钟；该值仅限定本地观察资源，不是上游完成时间或生产已验证参数。生产的观察时长、输出缓冲、最大解码事件和总内存必须在协议大样本与慢读测试后显式定值，不能直接使用原型64字节/8连接。缺少这些预算的配置不得作为正式池配置发布。

## 6. 未决及交付恢复

UNKNOWN没有自动TTL。账号并发1时一次无终态取消确实可能长期占满。生成债务未解除前不把该账号选给新任务；容量大于1时可使用其剩余已核实容量。其他账号继续服务仍受用户/全局预算约束，不能承诺全局全被债务占满时仍可运行。

管理状态必须展示：原任务/lease/attempt、最后证据、observer存活、占用资源、产生原因和可用操作。首次UNKNOWN产生可订阅事件；重复客户端重试只聚合计数，不重复告警轰炸。

| 恢复动作 | 权限与后果 |
| --- | --- |
| reconcile | 收集原worker未ACK事件/观察结果；无证据保持保护 |
| resolve-unknown | 提供可信终态或NOT_SENT证据，按revision结算原lease |
| accept-uncertainty | 独立管理权限、精确lease/revision、理由和风险接受；先撤销未消费许可/隔离旧发送能力，再记WAIVED_UNCERTAINTY；结果仍UNKNOWN |
| resolve-delivery / resume-task | 单独处理任务障碍，记录已消费结果的证据或明确接受恢复歧义；不改账号、不后台重跑 |

人工释债只释放预算，默认不清任务障碍，避免正在重试的客户端立即穿透。已发计算不能由发送屏障撤销。迟到终态只补旧记录；维护、重登录、额度刷新、出口恢复、提高并发、worker重启都不是可信停止证据。

可信交付确认优先为适配器对具体operation的已消费终态ACK。单独 previous_response_id 不是通用证明：ID可能在response.created就已暴露；收到工具调用也不自动证明收到终态。某种后继请求若要用于自动清障，须以固定客户端协议单独验证因果关系，未验证默认不自动清除。

无逐操作ID客户端的人工清障不会创造幂等能力；下一条仍可能是晚到重试。管理端必须说明这个边界，强语义的继续需要客户端新operation合同。第一版不持久缓存完整答案，不假造SSE补发，不以正文hash代替用户意图。

## 7. 降低额外变化的调度措施

- task→account持久不变；account→真实身份不可偷换；认证仅一个活动维护者。
- account→egress固定，模型/WS/认证刷新使用该出口，无故障直连或自动换出口。更改出口需要显式维护、排空和重新验收，保留审计。
- 单账号默认1，并发、队列、握手和控制重试有界；额度/模型/出口分别反馈。普通403/429不能凭状态码一律判封禁/周额度用尽。
- 冷却由明确反馈触发，使用可信Retry-After/重置时间；恢复探测单实例、限频，不让队列一起冲击账号，不以生成请求试探所有账号。
- 调度仅选择目标、控制时机、记录状态；不换模型、不增删工具/历史、不代客户端重放，内部元数据不得进入上游正文。
- 版本固定、变化逐项对照；出站未知差异阻断该版本发布，先在测试worker定位，不把用户任务自动迁往另一账号或版本。

## 8. 实现前必须通过的新增合同

| 验收 | 判据 |
| --- | --- |
| 原生fresh/fork/resume与预热 | 严格池登记ACK前无模型出站，已知fork继承，未知root两种传输均拒绝；固定入口先持久记录唯一账号且不假记fresh，缺身份/来源冲突拒绝 |
| 同任务重复提交 | 原生排队期间不积累第二项；显式操作键按合同幂等/排序 |
| 真实客户端WS重试→HTTP | 在CANCELLING/UNKNOWN/交付障碍下，额外上游发送为0 |
| PREPARE/COMMIT/revoke全部交错 | 只有确切NOT_SENT才安全回收；重复COMMIT至多消费一次 |
| 终态提交与交付 | DB提交前不交付完整成功终态；生成释放不等待慢下游 |
| HTTP/WS断连后迟到终态 | reader能收尾，终态结清原lease；无终态到观察截止仍有债务 |
| 401恢复中取消/撤权 | 同lease不提前释放；后续attempt不得新发 |
| worker/协调器真实进程崩溃 | ACK前后、发送前后结果符合证据；无计数清零或后台重放 |
| 人工释债、重复和迟到终态 | 结算一次、原outcome可追溯、旧事件不改新lease |
| 大压缩事件/慢读/日志洪泛 | 全内存预算可测且有界；不得靠截断继续成功 |
| 出站对照 | 主体原始内容零新增差异；取消时序变化另验并明确记录 |

这些条目目前是验收要求，不是已执行的测试结果。19项原型测试、8阶段身份与12类错误的证据见[报告](../../codex-bridge-scheduler-validation/validation/REPORT.md)。支持范围只有固定版本core与本地mock；后续桌面/平台矩阵及正式worker验收按主设计M0–M3推进。
