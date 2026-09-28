# 迭代缺口验收清单

基线：`4729b75`。目标是补齐上一轮明确列出的四类缺口，而非把短测试通过等同于充分验证。

| 缺口 | 本轮要求 | 完成证据 |
| --- | --- | --- |
| 权限与执行职责 | 提取 PermissionPolicy 与 ToolExecutor，保留四工具、只读限制、精确审批、会话隔离、路径检查和输出处理 | 已提取；精确授权、取消和目录替换回归通过；包含在252 项双平台门禁中 |
| 重复真实模型评测 | off/local/model 各覆盖 5 类任务，每项重复 3 次，逐次保存结果、usage、耗时与审批次数，失败不得被重跑覆盖 | 已完成正确配置 vLLM 的独立 45 次比较及逐项回复审查；三模式各 15/15，输入/输出用量和提炼回退分别记录；历史失败保留 |
| 真实仓库长任务 | 在当前仓库独立副本进行跨文件功能修改与测试修复；注入取消和进程终止，恢复后保留任务、配对和副作用证据，由工作区外验证器检查结果 | 两项均通过最终独立验收及新增测试审查；分别累计 12、11 次运行，经过两轮明确审查反馈，详见最终记录 |
| Linux 交互验证 | 在真正 Linux PTY 中操作完整 CLI，检查中文输入、审批、取消、重启恢复、验收和会话切换，保留终端记录与持久化断言 | Linux 实际 PTY 通过；已增加 macOS/Linux 可复现 PTY 门禁，详见下文 |

验收时同时复查原迭代计划的硬门禁、全量回归、包安装和 macOS/Linux CI。模型评测是有限样本，报告实际完成率与失败，不宣称证明所有任务可靠。后续队列（只读搜索、长命令、MCP、多 Agent）不混入本轮缺口。

下文保留各阶段诊断历史，段落中的“仍在进行／未通过”描述当时状态；当前状态以上表及文末最新记录为准。

## 重复真实模型评测

[45 次原始结果](evaluations/repeated-tasks.json)采用 Responses / gpt-5.6-sol / low，5 个合成编码任务 × 3 个模式 × 3 次重复，固定每次预算。评测在后续上下文修复之前执行，不能当作修复后版本的完成率。

| 模式 | 通过当时门禁 | 报告 token 合计 | 各次耗时合计 |
| --- | --- | --- | --- |
| off | 14/15 | 90,266 | 307.5 秒 |
| local | 15/15 | 85,861 | 288.6 秒 |
| model | 14/15 | 125,905 | 478.6 秒 |

45 次目标文件均符合外部断言，验证器与保护文件保持不变。但 cross-file 的 off 第 1 次和 model 第 2 次没有成功执行获准的验证命令，因此只计 43 次通过当时门禁。每次失败均记录 1 次拒绝、0 次批准；观察到其中一次把验证与额外 hash 命令拼接，精确授权正确拒绝。未捕获另一次被拒命令的完整文本，不推定相同原因。没有用重跑覆盖失败；样本不足以推断普遍稳定性。

## Linux 交互证据

[持久化断言](evaluations/linux-pty.json)与[真实终端画面记录](evaluations/linux-pty-transcript.txt)来自 Linux 6.12.76 / arm64 / Node 22.23.3 的实际 PTY，模型由本地 HTTP fixture 代替。Codex 操作了中文与 emoji 输入、Y/N 审批、真实进程组取消、退出后恢复、显式续跑、验证、会话切换和终端缩放；文件副作用、调用配对、新预算与锁释放均检查通过。这是代理操作的交互验收，不是真人可用性研究。

`scripts/pty-smoke.py` 将同一流程变为可复现的 POSIX PTY 门禁。`npm run test:pty` 需先构建，使用 Python 3 和本地 fixture，不需要模型凭据。CI 两个平台均新增该门禁。

## 真实仓库任务与上下文缺陷

评测在当前仓库独立副本实现会话过滤，限定四个可编辑文件，原有测试、依赖和验证器受保护。每项任务先在一次实际修改后取消，再在另一次实际修改后、结果保存前以 SIGKILL 终止工作进程，然后显式恢复原会话。外部验收同时检查功能、CLI、快照无副作用和完整类型/测试/构建；模型说完成并不足以通过。

- [初始记录](evaluations/repository-tasks.json)：两项任务均因上下文超限未通过。
- [请求计量修复后的记录](evaluations/repository-tasks-wire-size.json)：避免了规范化调用与 opaque 双重计数，但累积历史仍超限；保留失败工作区。
- [有界观察修复后的续跑](evaluations/repository-tasks-recovered.json)：在同一会话继续修改和验证，随后再次触及硬上限。
- [完整交换归档后的续跑](evaluations/repository-tasks-archived.json)：上下文可以继续压缩，但模型反复读取旧输出、耗尽预算；主动终止无进展的诊断，保留不完整失败记录。随后补充归档的原始请求路径／命令、长失败输出的字面诊断片段和首尾预览，以及聚焦最近未完成步骤的续跑提示。
- [诊断呈现修复后的续跑](evaluations/repository-tasks-diagnostics.json)：继续同一会话并显式改用 high，仍反复读取历史，停止该诊断并保留部分运行记录。
- [统一历史压缩后的续跑](evaluations/repository-tasks-single-owner.json)：统一了历史投影，但每个旧交换仍产生一个活动索引；反复读取未结束，保留失败诊断。
- [合并历史归档后的续跑](evaluations/repository-tasks-grouped.json)：连续旧交换归档为完整 JSON，不跨越用户消息；机械索引保留所有未知操作、每个文件最后修改、最后失败命令和最近三项操作。原会话仍反复读取、未通过验收；该失败诊断已保留，不继续无进展地追加预算。

这些是同一批任务的诊断与续跑阶段，不是互相独立的成功率样本。每次显式续跑单独记录新预算；不能把反复续跑描述为一次预算内完成。各阶段 patch 是评测模型的候选输出，不是本 PR 的会话过滤功能。

新增回归覆盖实际请求字符计量、最近大观察的首尾预览、中等旧结果积累、完整旧交换可逆归档、两协议调用配对与 opaque 保留、引用缓存、存储失败回退。归档不改写源历史或用户目标；旧 opaque 随完整交换外置，活动视图不再发送全部历史 opaque。该契约变化已同步 README。

## 自动化门禁与计划复核

该阶段本机全量回归：239 项通过、0 失败、0 跳过。类型检查、构建、临时包安装、macOS 实际 PTY 和 Linux 容器实际 PTY 通过；提交 `0ee6783` 又加入连续历史归档回归，远程 macOS/Ubuntu 的 [CI](https://github.com/icy2048/icy-agent-cli/actions/runs/36330631863) 均通过，包含 240 项测试及实际 PTY 门禁。此前 `06d015c` 的 Ubuntu PTY 在恢复启动时输入过早而失败；门禁已增加 raw 模式就绪与真实草稿判定，失败运行保留在 Actions 记录中。

| 原计划硬门禁 | 对应证据 |
| --- | --- |
| 输入整次接收或明确拒绝、草稿保留 | composer-limits、UI 输入边界与 emoji 回归 |
| 调用配对、坏快照与锁清理、未知副作用不自动重放 | session、agent-recovery、session-verification-recovery、真实仓库 SIGKILL 记录 |
| 原始要求完整保留、默认 local、区分字面保真与任务完成 | fidelity、harness、离线 12 类夹具和真实模型独立检查 |
| 请求预算、双协议 usage、预处理记账、明确停止原因 | budget、agent-budget、provider-budget；真实续跑每次另记预算 |
| 循环内上下文、源历史可恢复、最新观察与配对 | context 双协议回归及真实仓库诊断；完整任务结果仍待最终验收 |
| 任务/运行状态、显式续跑和登记检查证据 | run-state、review-regressions、workspace-fingerprint、UI 与 CLI 回归 |
| 历史轨迹、会话切换与发现、旧会话兼容 | transcript-recovery、ui-task、session-list、cli-resume、Linux PTY |

全量测试通过是控制流与已知回归证据，不能替代尚未通过的真实仓库任务验收，也不能将原工期估算改写为已完成的人工测试时长。


[第二组 45 次短任务](evaluations/repeated-tasks-diagnostics.json)已完整执行，**42/45 通过当时门禁**：off 15/15、local 15/15、model 12/15；报告 token 分别为 91,363、94,249、138,370，各次耗时合计分别为 776.5、743.7、817.9 秒。全部目标输出和受保护验证器正确，且都实际通过了与调用 ID 配对的获准验证命令。model 第 1 轮的三个任务在模型最终收尾前触及 90 秒截止时间，故仍计为失败；其中一次先请求 `pwd && ls -la` 被拒，随后执行获准验证。该评测与仓库评测同时运行，时间不作为受控性能对比。

第二组进程在随后“统一历史投影／合并归档”修复之前启动，其模块快照属于中间版本；不与第一组结果混算或覆盖。脚本现保留审批命令，并按 bash 调用 ID 校验验证结果，避免把文件中出现的测试成功字样当作执行证据。

[当前版本 high 新任务](evaluations/repository-tasks-current-high.json)在发生第一次修改前就耗尽预算，未达到取消注入点，按失败保留。诊断发现外置达到目标后仍继续移走已读内容，当前 ContextManager 已改成降到目标大小即停，并有保留其他七项观察的回归。[随后 low 尝试](evaluations/repository-tasks-stream-stall.json)发现流响应超过配置的 60 秒仍未结束，已停止并保留诊断。SDK 的 fetch 超时只覆盖到响应头，新增整次调用截止时间后，两协议的真实 HTTP 悬挂流回归都通过：超时保存失败与估算消耗、未执行部分工具调用。相同完整任务的当前 low 评测仍在执行，预算与验收条件未放宽；该运行中的报告待结束后单独交付。

评测进程已修复 IPC 退出清理：运行与会话关闭后主动断开 IPC，不再等父进程超时。已有 spinner 测试改为由测试明确结束运行，先验证 spinner 和递增秒数，避免 250ms 后自动完成导致负载下漏帧；相关 UI 回归通过。这些修复没有写入旧评测工作区的受保护文件。

尚未发布、合并 PR，当前完整目标仍未标为完成。

最新代码 `244b9ff` 的 [macOS/Ubuntu CI](https://github.com/icy2048/icy-agent-cli/actions/runs/36331789704) 已全部通过：各 243 项测试、类型检查、构建、实际 PTY 与包安装。真实仓库任务的完成验收仍未通过，不能由这些门禁代替。

## 2026-09-28：命令结果在后续读取中丢失

[整次模型调用超时修复后的完整评测](evaluations/repository-tasks-current.json)已结束，两个任务各执行七个阶段，均未完成最终验收。两项均通过调用配对、恰好一个未知结果、未知写入先读取核对、保护文件未修改等断言；最后都因 token 预算停止。第二项实际通过类型检查、测试和构建，但随后继续读取历史并重复检查，没有完成整个任务，仍计失败。

保存会话的离线重放确认：模型连续读取日志后，最近失败的详细诊断和已经成功的检查结果均可能从活动视图消失。`f264a22` 保留最近三条不同命令的最新结果与最近一次未解决失败，保留完整调用配对；只有原始命令及 cwd 相同的成功重跑会替换旧失败。数量有界，仍受上下文上限约束，必要时使用包含字面诊断的可回读预览。这是结果保留策略，不是把普通检查升级为任务验收证据。

新增四项回归覆盖两协议的失败诊断保留、同命令成功解除保留、其他命令或目录不会解除失败、命令结果数量有界，以及硬上限下诊断预览和原文回读。原实现的两协议诊断回归均失败，修复后 18 项上下文回归通过。全量本机与 [macOS/Ubuntu CI](https://github.com/icy2048/icy-agent-cli/actions/runs/36333197054) 均通过 247 项测试、类型检查、构建、实际 PTY 和包安装。

从上述两个失败会话继续的真实模型评测正在单独记录，不覆盖原报告。原任务、可修改文件和每次预算不变，新增预算作为显式续跑记录；需等待外部验收和候选修改审查后才能认定完成。评测脚本也保留外部命令失败的 stdout/stderr 字面诊断，防止只反馈退出码而丢失测试原因。

随后第一项仅一次续跑就修复了测试导入 CLI 时的启动副作用，并通过旧验收器。但[独立需求审查](evaluations/repository-review-findings.json)发现旧验收覆盖不足：候选实现仍要求过滤目录存在、`config init --status` 未拒绝，且新的入口判断让安装后的 `icy --help` 没有输出（Node 22 实测）。这些都是评测候选代码的问题，尚未应用到本项目源码；旧验收成功不能代表整个任务完成。

外部验收已补充全部状态值、相对目录、不存在的过滤目录、config 模式拒绝 status 和安装包 smoke check，并固定外部命令使用评测进程的 Node 路径。审查事实已作为明确反馈写入原任务会话，反馈文本一并保留；后续结果必须注明这是经过独立审查反馈后的修复，不能宣称一次自主执行就满足了全部要求。

[命令结果保留后的续跑](evaluations/repository-tasks-command-context.json)已经结束：第一项在阶段 8、第二项在阶段 9 结束模型执行并通过旧验收器；第二项阶段 8 的模型超时仍保留。这表明原先反复读取的任务能够继续修改、测试并收尾，但旧验收器遗漏的兼容性要求仍未满足。[审查后的输入记录](evaluations/repository-tasks-review-input.json)明确保存旧验收结果并撤回“整项通过”判断，两项均附上具体审查反馈；正在从同一会话执行补齐验收后的修复，不覆盖任何旧记录。

[补齐行为验收后的记录](evaluations/repository-tasks-reviewed.json)中，两项均通过功能、九种状态、目录过滤、参数限制、完整测试、构建和包安装；调用配对、未知写入先读、未改保护文件也都通过。但新增测试审查发现第一项丢掉了快照比较断言、第二项仅在非法参数时比较快照，尚未覆盖正常列举无副作用的明确要求。具体反馈继续保留在原会话和审查记录中；[测试审查输入](evaluations/repository-tasks-test-coverage-input.json)保留已通过的行为验收，同时继续将整项标为未完成。

真实续跑阶段还记录了一次终止响应解析异常。用缺失 `output` 的真实 HTTP fixture 可复现该错误；新增回归还证明失败终止事件不能被矛盾的 `completed` 字段升级成功。`ad9871e` 增加明确的响应校验，保留可用的上游错误原因；43 项 Provider/runtime 相关回归通过，本机构建、PTY 和安装包通过，[Node 22 双平台 CI](https://github.com/icy2048/icy-agent-cli/actions/runs/36334804141) 各 250 项测试及全部门禁通过。测试覆盖修复的下一次续跑已使用该运行时并记录其提交与内容 hash。

原计划每项要求及证据另见[逐项验收核对](acceptance-audit.md)。该阶段真实任务新增测试的审查尚未闭环，随后完成情况见下文。


## 2026-09-28：真实仓库任务最终验收

[最终运行记录](evaluations/repository-tasks-final.json)已完整结束，两项均通过原任务的功能、九种状态、组合目录过滤、参数边界、损坏与旧快照只读、类型检查、完整测试、构建和安装包检查。[逐项源码与新增测试复核](evaluations/repository-final-review.json)确认正常列举前后比较目录条目及原始内容，补齐了上一轮审查发现的测试遗漏。候选改动保存在两份 patch 中，未合入本项目功能。

两项分别累计 12、11 次显式预算运行，记录 token（含估算）分别为 939,404、946,043；这包含失败阶段和两轮明确审查反馈，不能表述为两次首次自主成功。两项调用配对均完整，均恰好一个未知结果，未知写入均先读取核对，受保护文件未修改。最终续跑的运行时提交是 `ad9871e`，记录包含源码 hash。

## 2026-09-28：补齐短任务执行审计

最终核对发现，历史两组短任务只验证产物、保护文件最终字节及验证执行，没有完整检查读写顺序、禁止重写分支和临时修改后还原。因此保留原始结果，但将 43/45、42/45 限定为“通过当时门禁”，不再用它们证明全部任务要求均满足。历史临时工作区已清理，不能补造其操作轨迹。

`a477d8a` 增加执行顺序、修改范围、最后一次验证及原始最终回复记录。新增两项回归覆盖遗漏/延迟读取、验证后修改、保护文件先改后还原、不改分支重复写入、失败读取和最后验证失败。第三组按固定 45 次计划执行，最终状态见下文；原始结果与回复审查分别保存，失败不被覆盖。


`edbdc30` 的 [macOS/Ubuntu CI](https://github.com/icy2048/icy-agent-cli/actions/runs/36336548485) 各通过 252 项测试、类型检查、构建、实际 PTY 及安装包。此前 `a477d8a` 的另一组 Ubuntu 运行在 `/todo` 后的界面尚未更新时断言失败，`9456f76` 将任务命令测试改为有界等待输入及预期回复帧，原内容断言保持不变。


同提交的另一组 Ubuntu PTY 在发送 `/sessions` 时超时，日志显示前一任务仍显示运行提示。原就绪检查依赖并非所有终端都会输出的同步渲染标记，可能在累计输出中匹配旧的空闲提示。门禁改为只检查最后一条实际输入提示；本机真实 PTY 流程通过，后续双平台结果待确认。该修改仅修正测试驱动，不改变 CLI 运行逻辑。


## 2026-09-28：严格评测遇到模型服务余额错误

[严格批次原始结果](evaluations/repeated-tasks-audited.json)的 45 次尝试已结束，[逐项回复审查](evaluations/repeated-tasks-response-review.json)核验完毕，[统计汇总](evaluations/repeated-tasks-summary.json)保留逐模式结果及缺失字段。前 24 次中 19 次满足执行和回复要求，5 次在 30 秒请求截止时间停止。从第 25 次起服务返回 `403 insufficient balance`，共影响 21 次，其中第 25 次完成读取后被拒，其余未执行工具。

| 模式 | 通过 / 计划尝试 | 请求超时 | 余额错误 | 报告或估算 token | 各次耗时合计 |
| --- | --- | --- | --- | --- | --- |
| off | 7/15 | 3 | 5 | 80,646 | 360.9 秒 |
| local | 8/15 | 1 | 6 | 74,263 | 384.3 秒 |
| model | 4/15 | 1 | 10 | 76,305 | 281.7 秒 |

上述分母包含服务不可用尝试，不能据此比较模型能力或宣称完成三轮正常评测。5 次超时也保留为失败：4 次未完成最终验证，1 次已有验证结果但没有最终回复。19 次通过项的回复与目标产物、读取/修改/验证顺序及保护范围一致。所有 45 次保护文件保持不变；没有回复的失败项不凭产物正确升级成功。

usage 合计包含预处理及本地估算。部分运行只有估算总数，没有输入/输出/cache 明细；汇总分别记录可用明细合计和缺失次数，不将缺失当作零，也不将余额拒绝时的本地估算当作实际账单。样本只支持上述观察，不证明一般可靠性或费用节省。

`4e5b46f` 的两组双平台 CI 均通过，其中[完整日志](https://github.com/icy2048/icy-agent-cli/actions/runs/36336757885)确认两平台各 252 项测试、类型检查、构建、实际 PTY 和安装包。当前产品实现与真实仓库任务审查已闭环；**严格重复比较仍受模型服务余额阻碍，整体目标未完成**。已请求用户恢复额度或更新本机配置；不自动充值，不重启失败批次，不覆盖旧失败。


## 2026-09-28：接入 Pi 的 vLLM 并继续补齐

按用户要求将本机主模型切到 Pi 配置中的 Chat Completions / `qwen3.8-27b`；凭据仅保存到本机 0600 私有文件，旧配置已备份。[连接记录](evaluations/vllm-connection.json)保存模型发现、实际流式响应和提炼探针。`a5dc186` 增加仅由用户配置启用的 RFC1918 HTTP 支持，项目不能自行启用，公网 HTTP 仍被拒；无工具 Chat Completions 请求不再发送 vLLM 拒绝的空 tools 数组。配置、模型保存及 Provider 回归通过；`e9af951` [双平台 CI](https://github.com/icy2048/icy-agent-cli/actions/runs/36337839369) 各 255 项测试、构建、实际 PTY 和包安装通过。

[第一组 vLLM 原始结果](evaluations/repeated-tasks-vllm.json)为 45/45 通过，回复和操作记录已逐项复核；但最终配置核对发现，主模型切换时漏设 `compactionModel`，语义提炼仍使用服务未提供的默认 `gpt-5.6-luna`。这组只能作为回退路径证据，不能作为正确配置模型提炼的比较，限制写入[汇总](evaluations/repeated-tasks-vllm-summary.json)。

已将主模型和提炼模型都设为 `qwen3.8-27b`，提炼探针返回 applied 和完整输入/输出 usage。`961231e` 为评测新增实际提炼模型及 harness 状态记录，随后执行独立的完整 45 次批次。第一组 vLLM、此前的 Responses 失败记录全部保留，不覆盖或混算。


## 2026-09-28：正确配置 vLLM 后完成重复比较

[原始 45 次记录](evaluations/repeated-tasks-vllm-configured.json)、[逐项回复审查](evaluations/repeated-tasks-vllm-configured-response-review.json)和[汇总](evaluations/repeated-tasks-vllm-configured-summary.json)已全部完成。主模型与提炼模型均为 `qwen3.8-27b`，Chat Completions 不发送 reasoning-effort 参数，使用服务默认行为。来源提交 `961231e`；后续仅变更测试与文档，不改运行时。每次仍为 100,000 token / 20 轮 / 50 工具 / 120,000 字符预算，单请求 30 秒、整次任务 90 秒，顺序执行、不重跑覆盖失败。

| 配置模式 | 完整通过 | 观察到的任务遗漏 | 输入 token | 输出 token | 总 token | 总耗时 | 批准 / 拒绝 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| off | 15/15 | 0/15 | 125,507 | 5,452 | 130,959 | 161.6 秒 | 15 / 0 |
| local | 15/15 | 0/15 | 134,775 | 5,806 | 140,581 | 171.2 秒 | 15 / 4 |
| model | 15/15 | 0/15 | 156,098 | 9,040 | 165,138 | 236.7 秒 | 15 / 3 |

三种模式的输入/输出明细均覆盖全部尝试，没有估算；服务未提供缓存 token 明细，按未知记录。model 的 7,571 个提炼 token 已含在表中，不能再次相加。15 次提炼中 14 次 applied、1 次 invalid 后保留原文回退，均完成原任务。7 次被拒请求是额外的 shell 探索命令，随后使用允许的工具完成，原始参数全部保留；批准来自评测脚本的精确命令策略，不是人工点击统计。

验收同时检查先读后改、写入范围（含临时修改后还原）、不改分支禁止重写、最后验证执行、保护文件字节和最终产物；Codex 逐项核对最终回复与执行事实，45 个结果 hash 将审查绑定到原始记录。没有发现遗漏或错误完成声明。三模式均通过的小样本不足以证明一般可靠性；本批次 model 增加了 token 与时间，没有支持改回默认模型提炼的证据，因此默认继续为 local。不同模型、配置及验收版本的历史批次不混算，也不据此宣称 Qwen 优于此前模型。

四项补充缺口至此均有完成证据：权限/执行拆分、重复真实模型比较、真实仓库取消/SIGKILL 后恢复并独立验收、Linux 实际 PTY。原计划逐项关系见[验收核对](acceptance-audit.md)。真实仓库两项是经两轮审查反馈后的恢复成功，非首次自主成功；评测中的会话过滤功能仍仅保存为候选 patch。尚未合并 PR、发布 npm 包或创建发布 tag。

## 2026-09-28：第四轮迭代：只读探索、模型诊断与会话过滤

`d8e1440` 之后在工作分支 `codex/reliable-long-runs` 新增五个功能提交：

- `5f0f9f8`：`read` 以 `depth`/`pattern`/`regex` 免审批列举目录与搜索内容，上限 500 项、200 条匹配、2,000 个文件、每文件 1 MB、10 秒；不经 shell，`--read-only` 模式也可探索。
- `58e5a17`：`/model` 增加工具调用探针——一次文本请求、一次 `icy_probe` 诊断调用与工具结果续接，失败按 auth / connect / protocol / model / text / tool_call / tool_result 分级；探针从不执行主机工具。对已配置 vLLM 实测完整通过 2.2 秒，错误模型名归入"模型不存在"；该服务对任意 API key 都返回 HTTP 200，认证失败分支无法在该服务演示，只有回归覆盖。
- `73c4b14`：会话过滤按规格实现——`icy sessions --status a,b --cwd 目录` 与 `/sessions status=... cwd=...`，九种状态值，非法状态退出 2，列举保持只读；早前评测候选 patch 未被采用。
- `b41d75f`：工具描述引导模型改用 `read` 完成列举、打印与哈希，远离 shell。
- `3b4d301`：对合并后差异的独立 grok-4.6 审查修复——正则在 `node:vm` 隔离执行（每文件 1 秒、模式 200 字符上限）、列举行走有界（500 项加 footer、5 秒预算与中断信号）、`depth: 1` 仅直接子项、空 `pattern` 拒绝、分页搜索 footer、系统提示不再建议用 bash 执行 ls/find/rg/grep、`sensitive()` 另拒 `.npmrc`/`.netrc`/`.pypirc`/`.git-credentials`/`.htpasswd`/`.docker`/`*.token`、帮助文本对齐、`icy-output` 拒绝 `depth`/`regex`、`depth` 限制搜索递归。一项审查意见有意未改：`/sessions status=failed, answered`（逗号后带空格）按用法错误处理。

[汇总](evaluations/repeated-tasks-iter4-summary.json)由脚本从下列三份原始记录计算（探索调用按工具轨迹中 `pattern` 或 `depth` 非空的 `read` 计数），同一夹具、预算与顺序，每模式 15 次：

| 批次 | 模式 | 完整通过 | 拒绝次数 | 探索调用 | 输入 token | 输出 token | 总耗时 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 基线 `961231e` | off | 15/15 | 0 | 0 | 125,507 | 5,452 | 161.6 秒 |
| 基线 `961231e` | local | 15/15 | 4 | 0 | 134,775 | 5,806 | 171.2 秒 |
| 基线 `961231e` | model | 15/15 | 3 | 0 | 156,098 | 9,040 | 236.7 秒 |
| 批次 A `17a6e59` | off | 15/15 | 3 | 17 | 171,003 | 8,037 | 238.1 秒 |
| 批次 A `17a6e59` | local | 15/15 | 6 | 11 | 159,416 | 7,421 | 217.5 秒 |
| 批次 A `17a6e59` | model | 15/15 | 1 | 14 | 174,518 | 10,077 | 261.4 秒 |
| 批次 B `3b4d301` | off | 15/15 | 0 | 27 | 176,730 | 7,677 | 234.8 秒 |
| 批次 B `3b4d301` | local | 15/15 | 1 | 15 | 165,976 | 7,314 | 215.2 秒 |
| 批次 B `3b4d301` | model | 15/15 | 0 | 10 | 167,602 | 9,289 | 247.7 秒 |

[原始记录](evaluations/repeated-tasks-vllm-configured.json)、[批次 A](evaluations/repeated-tasks-iter4-explore.json)、[批次 B](evaluations/repeated-tasks-iter4-explore-tuned.json)分别保存全部 45 次尝试与被拒命令原文。基线的 7 次拒绝全部是探索性 shell（ls/cat/rg/grep）；批次 A 的 10 次为 `node -e`、`sha256sum`、`ls -la`/`ls -1`、`shasum` 与 `cat -A`；批次 B 唯一拒绝是 `pwd && ls -la`。批次 B 全部 45 次通过执行顺序、修改范围、验证、保护文件与产物检查（`unmetRequirements` 均为空）。

如实记录的限制：

- 拒绝从 7 次降到 1 次只发生在工具描述与系统提示同时对齐之后。只改工具描述（`b41d75f` 后、提示仍冲突）的中间批次执行到 23 次时中止（23 次通过、4 次拒绝），其文件已删除，不计入样本。
- 输入 token 与总耗时高于基线：批次 B 输入 token 三种模式分别比基线高 40.8%、23.1%、7.4%（合计 +22.6%），总耗时分别高 45.3%、25.7%、4.6%（合计 +22.5%）。原因是列表/搜索结果进入上下文，工具描述也更长。
- 每模式 15 次的小样本不证明一般可靠性，也不证明费用收益。
- [独立最终回复审查](evaluations/repeated-tasks-iter4-explore-tuned-response-review.json)由 grok-4.6 逐条对照夹具要求、工具轨迹与产物完成：45 条回复均为 satisfied，无夸大或遗漏，45 个结果哈希与原始记录一致（已另行复核哈希并抽查一条）。

每次合并后本机 macOS 执行 `npm run check`、`npm test`（255→290 项）、`npm run build`、`npm run test:package` 与 `npm run test:pty` 全部通过。这些提交尚未推送，Windows CI 尚未运行；未合并 PR、未发布、未升版本号。

## 2026-09-28：Windows 兼容

- **bash**：Windows 使用 Git for Windows 的 `bash.exe`。解析顺序为 `ICY_BASH`、PATH 中排除 `System32\bash.exe`（WSL 启动器）的 `bash.exe`、标准 Git 安装位置。调用仍是 `--noprofile --norc -c`；超时或取消用 `taskkill.exe /T /F` 终止进程树并隐藏窗口（`windowsHide`）。找不到时返回 `bash_unavailable` 和中文安装提示。
- **路径与文件**：Windows 工作区比较统一驱动器字母大小写和分隔符，供会话/工作区匹配。文件工具拒绝符号链接；junction 也由 `lstat` 识别并拒绝。新文件创建在 Windows 使用带二次存在检查的 `rename` 路径；POSIX 的 hard link 失败时也回退。
- **凭据限制**：Windows 不强制 `0600`/`0700`；凭据文件安全依赖用户 profile ACL，这是明确限制。终端要求 Windows Terminal 或其他 VT-capable 终端；legacy conhost 未测试，Alt/Shift+Enter 多行输入取决于终端。
- **测试入口与跳过项**：`scripts/pty-smoke.py` 是 POSIX PTY 门禁。Windows 侧 package smoke 使用 Node 直接启动安装产物并执行离线 `--demo`，不检查 Unix executable bit；`npm test` 现在执行 `node --import tsx --test "tests/**/*.test.ts"`，在 Windows 仅跳过 CLI SIGINT/SIGTERM cancellation（`Windows has no SIGINT delivery to child processes`）、model credential permissions（`Windows does not preserve POSIX 0o600 permissions`）和 workspace mode fingerprint（`Windows does not preserve POSIX file mode changes`）。symlink fixtures 使用 `tests/helpers` 的 `makeSymlink`，Windows 目录链接失败时回退为 junction，不再跳过。
- **CI 与状态**：`.github/workflows/ci.yml` 的矩阵为 `ubuntu-latest`、`macos-latest`、`windows-latest`。每个平台执行锁文件安装、类型检查、测试和构建；`npm run test:pty` 仅在 `runner.os != 'Windows'` 时运行，Windows 改为执行 `node dist/cli.js --demo --plain` 和 `node dist/cli.js --version` 的 Windows offline smoke；`npm run test:package` 在所有平台运行。`ae48d9d` 的 [三平台 CI](https://github.com/icy2048/icy-agent-cli/actions/runs/36394601447) 全部通过：macOS/Linux 各 304 项、0 跳过；Windows 跳过 4 项 POSIX 专属用例，其余全部通过，离线 `--demo` 与安装包检查也通过。本迭代没有在 Windows 机器做真实交互验收，该项仍为“尚未”。
- **六轮 CI 才通过，Windows 特有缺陷及修复**：(1) 子进程测试把 tsx 加载器路径传给 `--import`，Windows 要求 `file://` URL（测试修正）；(2) task-audit 夹具写死 `/fixture`，Windows 解析为 `D:\fixture`（测试修正）；(3) UI 测试在输入框重新挂载、`useInput` 尚未订阅时输入被丢弃，Ubuntu 也出现过一次（测试改为等待事件循环并重试一次）；(4) 会话工作区过滤：GitHub 的临时目录是 8.3 短名 `RUNNER~1`，且过滤目录不存在时 realpath 失败，回退的短名路径与存储的长名不匹配。产品修复 `resolveWorkspacePath`（`cfec202`、`ae48d9d`）：Windows 使用原生 realpath、比较忽略大小写，不存在的路径经最近存在的祖先目录规范化后再拼回剩余部分。

## 2026-09-28：第五轮迭代：长命令支持

本轮把原先 60 秒前台 Bash 的边界扩展为可查询、可取消的 detached 后台进程：`bash` 增加 `detach` 与 `kill`，后台进程拥有 `icy-process:<id>` 引用，输出经过脱敏后写入会话目录并限制为 16 MiB；`read icy-process:<id>` 最多等待 10 秒并按 Unicode 字符分页。Workbench 提供 `/ps`、`/kill`、后台命令审批说明、启动／结束／恢复未知状态的轨迹投影；JSON/纯文本 CLI 也输出 process 事件，正常退出用 `session_closed` 清理仍运行的进程。Windows taskkill 的 128/1282（进程已退出）按成功处理，软终止的其他失败仍会升级到 `/T /F`。恢复记录只用 lstart/CreationDate 身份令牌匹配后才允许信号，不再以 `ps` 命令行过滤匹配进程。身份未确认时保留探测到的 liveness，并在任务和进程列表中显示“未确认”。

契约是：前台命令最多 60 秒，detached 命令默认且最多 30 分钟；没有交互 stdin；kill 不需额外审批，审批 key 包含 detach；进程启动和退出都会推进 `mutationRevision`，运行中的进程阻止“已验证完成”。恢复不会重启旧进程，原先 running 的记录变为 `unknown` 并带 `pidAlive`，旧验收证据失效。输出不进入内存长结果，而保存在 `~/.icy/sessions/<id>/processes/<id>.log`。

自动化测试新增了进程生命周期、Unicode 日志分页、16 MiB 限制、超时／树终止、无审批 kill、会话恢复、验收证据失效、Workbench 命令与审批／恢复显示，以及 CLI HTTP fixture 的 NDJSON 和子进程清理覆盖。动机不是声称已经观察到真实评测被长命令阻断：迭代计划的“真实任务经常被 60 秒阻断”门槛**未被评测数据满足**，已有记录中的 bash 没有一次命中 `timeout` 或 `output_limit`；本仓库自身在快速机器上的完整 `npm test` 约 24 秒，`build && test` 链接近该上限，因此仍有实际开发场景价值。本功能尚未运行 live-model evaluation batch。

诚实边界：detached 进程不提供操作系统沙箱，没有 per-process 资源限制，不支持交互输入，也不自动重启；detached 子进程会继承写入 icy 的管道，如果 icy 自身崩溃（不是正常退出），继续写输出的子进程会收到 EPIPE/SIGPIPE 并通常退出，崩溃后的尾部输出会丢失；恢复只观察 PID 身份，不接管旧进程。Windows CI 状态为“尚未运行”，Windows 真机状态为“尚未进行”，本轮尚未推送，三平台 CI 结果为“尚未运行”。未升版本、未提交发布或 PR。

审查与修复过程：首版由 gpt-5.6-luna 分两个单元实现（工具／进程／持久化层，UI／CLI／文档），编排方拒绝了其中一处越界改动——非交互模式对 detached 请求自动授权——并恢复为"未批准的 bash 一律退出 2"。grok-4.6 的第一轮独立审查给出 4 项阻塞（恢复后 PID 复用误杀、`closeAll` 漏掉 `unknown` 进程且超时不续、持久化失败毒化保存队列、`unknown` 存活进程不阻止验收）与 6 项其他问题；修复后的第二轮审查确认 R1–R4、R7、R9、R10 关闭，另指出 Windows `taskkill` 非零退出中断终止流程、identity 误判把存活进程标为 `pidAlive=false`、看门狗一次性失效、identity 捕获无超时、交互退出失败仍返回 0 等缺陷，均已修复并各自加回归。实现方一次声称"测试已补齐"而实际未写，编排方按测试数核对后另行补齐。本机最终门禁：类型检查、343 项测试（连续三次全部通过）、构建、安装包 smoke、POSIX PTY smoke 全部通过；管道导致 icy 崩溃后子进程 SIGPIPE 的问题有意不改架构，记录为边界。
