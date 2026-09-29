# 第六轮起的迭代计划：单一写者、可信边界与终端交互

制定日期：2026-09-29。基线：`main` / `4efd309`（第五轮长命令支持及其竞态修复已合并，三平台 CI 通过，344 项测试）。本文接续 [原迭代计划](iteration-plan.md) 第 5 节的后续队列，依据是两份独立审查：[整库代码审查](evaluations/code-review-2026-09-29.md) 和 [UI/交互审查](evaluations/ui-review-2026-09-29.md)（均为 grok-4.6 只读审查，素材含 [离线 demo 真实录屏](evaluations/ui-tour-demo-transcript.txt)）。审查意见的复现状态在各条目中标注：**已核对**表示编排方读源码确认逻辑成立，**未复现**表示尚未构造失败用例，验收时必须先补复现。

## 1. 当前判断

单 Agent 串行工具循环、调用配对、恢复不重放、软预算、机械压缩、长命令这些契约本身是自洽的，测试对串行主路径覆盖充分。但第五轮引入了第二个快照写者（ProcessManager）和第一个与 Agent 并发修改工作区的主体（detached 进程），暴露出三类结构性问题：

1. **会话快照没有单一写者。** `SessionStore.save()` 是"最后 rename 者胜"的整对象快照；Agent、进程管理器的 `saveQueue` 和 `onChange` 回调各自调用 `save()`。两次序列化之间的另一方修改会被覆盖（已核对：`store.ts` 无互斥，`processes.ts` 独立队列，`agent.ts` 回调内再 `save()`；未复现丢失轮次的用例）。
2. **文件工具的边界假设"没有并发修改者"。** `workspacePath` 只在解析时 `lstat`，随后的 `stat`/`readFile`/`readdir`/`rename` 会跟随之后被替换的符号链接（已核对）。第五轮之前这只是"外部编辑器"脚注，现在获批的后台脚本就是同会话内的并发修改者。
3. **工具、权限、UI 都是四工具的闭合特例。** `schemas` 是闭合对象，策略只认 `bash`，执行器是四分支 `switch`，`kill`/进程读取以 `bash`/`read` 参数形式"夹带"；App 同时是命令路由、审批、信号处理和布局。MCP 与多 Agent 不能在这个形状上继续堆分支。

UI 侧最重的问题：运行期输入框常驻却只接受两个命令、提交后才提示；大量英文状态与错误码；只读/演示模式下 `/verify` 不弹审批却会把随后按下的 `y` 变成新任务；后台命令审批卡片缺少主机风险与授权范围说明。

## 2. 交付顺序

### 迭代六：单一写者与可信边界（v0.2.0 候选，约 5–7 个工作日）

目标：并发写者不再丢状态；后台进程从 spawn 起就可恢复；文件工具在同会话并发修改下仍守住边界；提供者兼容性不再让整轮失败。

1. **PR A：会话单一写者。** `SessionStore` 内建串行保存队列（可重入或批量补丁），所有写者只通过它；进程 `onChange` 只通知不保存，`markMutation` 并入进程持久化补丁；进程记录在 spawn 成功后**立即**持久化，identity 捕获放到之后并作为补丁更新。
   - 验收：注入慢 `save` 的用例证明 Agent 轮次与进程状态更新交错时两者都落盘；在 identity 捕获期间 SIGKILL icy，恢复后进程行存在且可 `/kill`；原有 344 项回归通过。
   - 风险：`save → onChange → save` 若未彻底移除会死锁；用带超时的回归覆盖。
2. **PR B：文件工具的并发安全。** 读写改为基于文件描述符：`O_NOFOLLOW` 打开后用 `fstat` 复核类型，目录行走在进入每级前重新 `lstat`，写入的临时文件与目标同目录且 rename 前再次校验父目录未被换成链接；Windows 新建文件走"不替换"路径（当前 `stat`+`rename` 有 TOCTOU，已核对）；`explore` 的忽略名与敏感名统一大小写不敏感，敏感名补 `.envrc`、`id_ecdsa`、`*.pub` 例外说明。
   - 验收：用真实后台脚本在 `read`/`search`/`write` 执行中途把目录换成指向 `~/.ssh` 的链接，工具必须拒绝而不是返回内容；Windows CI 用 `platform: 'win32'` 真实路径测试并发创建不覆盖；补路径逃逸与 `edit` 唯一性的属性测试（随机路径、Unicode、重叠匹配）。
3. **PR C：提供者与会话小缺陷。** Chat Completions 按能力标志发送 `max_tokens` 或 `max_completion_tokens`；Responses 的 `include: reasoning.encrypted_content` 改为可配置且默认跟随 `reasoningSummary`；流式工具调用名去重（重复全名不再拼接成 `readread`）；`response.failed` 之后的 `response.completed` 不得升级为可执行调用；`/clear` 终止本会话后台进程；进程内 `/resume` 保留"本会话允许"授权（README 已如此承诺）。
   - 验收：双协议 HTTP fixture 各加对应用例；`/model` 探针对不支持 `include` 的服务给出协议级诊断而不是每轮失败。
4. **PR D：测试与工程卫生。** 看门狗与 identity 超时用可注入时钟，去掉对 `watchdogs: Map` 和 `hasRef()` 的实现细节断言；`package.json` 的 `files` 排除 `docs/evaluations`（约 7 MB 评测记录不应进 npm 包）；CI 对 `docs/evaluations/**` 加路径过滤；`npm test` 目标从约 25 秒降到 15 秒以内。
5. **评测补课（与 PR 并行）。** 第五轮没有真实模型批次：在现有 `eval:tasks` 夹具中加入一个必须使用 `detach` 才能完成的任务（例如超过 60 秒的测试链），三模式各 5 次，记录 detach 使用率、轮询次数、`kill` 使用与审批次数。样本小，不作可靠性结论，只验证模型能按工具描述正确使用句柄。

### 迭代七：终端交互修正（v0.2.x，约 4–6 个工作日）

目标：用户在每个关键时刻都知道发生了什么、能做什么；不再有英文机器码直接面对用户。

6. **PR E：运行期输入模型。** 运行中输入框显示持久提示 `运行中 · 仅 /ps /kill /task /help /thinking · Esc 取消`；第一次 Esc 清空非空草稿，第二次 Esc 才取消运行；允许排队一条后续消息，运行结束后自动提交（Claude Code 行为），取代提交后才出现的"只接受 /ps 和 /kill"提示；`/task`、`/help`、`/thinking` 在运行中可用。
7. **PR F：状态与错误中文化。** 页脚状态（`Ready`/`Stopped`/`Awaiting approval`/`Running read`）、`/task` 的检查点与停止原因枚举、`/ps` 状态、工具错误码（`process_not_found`、`read_only`、`permission_denied`、`token_budget`、`verification_failed` 等）统一映射为中文并附下一步提示（如"达到预算，/continue 开启新预算"）；审批拒绝后在用户通道写一行"已拒绝该命令"；Ctrl+T 与 `/thinking` 行为一致并在页脚显示展开/收起状态；演示模式头部不显示真实 API 主机。
8. **PR G：只读/演示模式与遗留按键。** `/verify` 在只读或演示模式前置拒绝并说明原因；没有审批弹窗时按下的 `y`/`n`/`a` 不得进入输入框成为新任务（保留为无操作并提示）；`/continue`、`/verify` 无任务时不先打印乐观通知。
9. **PR H：审批卡片与授权语义。** 后台命令卡片保留主机逃逸提示，写明 30 分钟硬上限、日志路径、16 MiB、无 stdin、崩溃后 EPIPE；"A 本会话允许"明确为"相同 command+cwd+timeout+detach"，并说明 `/new` 后失效；审批时可查看触发该命令的最近轨迹而不是整屏替换。
10. **PR I：发现性与信息密度。** `/help` 补 Y/A/N、翻页规则、Esc 与 Ctrl+C 区别、多行输入、`/kill` 的 id 规则、`/verify` 的只读限制；命令面板在输入参数时保留用法提示，对 `/hepl` 类拼写给出最近命令；`/sessions` 交互版显示状态；`/ps` 以 `icy-process:` 引用为主、pid 为辅，`/kill` 收到疑似 pid 时明确说明；`/help`、`/task`、`/ps`、`/sessions` 改为临时浮层而非永久 `!` 通知（较大，可拆到后续）；非交互 `--help` 列出全部 NDJSON 事件名，`--continue` 缺 `--resume` 的退出码与 README 对齐为 2。
    - 验收：UI 审查第 6 节列出的未覆盖场景逐项进入 `tests/ui-*.test.ts` 与 `scripts/pty-smoke.py`（至少补 `/kill`、`/help`、运行中后续输入、只读 `/verify`、遗留 `y`）；80 列下 `/task` 与审批卡片有截图断言。

### 迭代八：可扩展的工具表与界面拆分（为 MCP 做准备，约 6–8 个工作日）

11. **PR J：工具表与策略泛化。** `ToolRegistry` 改为按工具描述表注册（名称、schema、风险等级、执行器），`PermissionPolicy` 按风险等级而不是硬编码 `bash` 判断；`kill` 与进程读取成为独立的策略动词或独立工具，不再以 `bash`/`read` 参数夹带；审批 key 格式与 NDJSON 事件保持兼容并有迁移测试。四个内置工具的对外 schema 与审批语义不变。
12. **PR K：Agent 与 App 拆分。** 把会话切换、进程事件绑定、工作区指纹、验收从 `Agent` 拆到独立协作对象，`Agent` 只编排一次运行；`App.tsx` 拆成不依赖 Ink 的命令路由器和视图，`setListener`/审批桥接放进 effect。
13. **PR L：MCP 客户端（只读工具优先）。** 在工具表上接入 MCP stdio 服务器，首版只允许声明为只读的工具免审批、其余一律审批；工具结果走既有外置与脱敏；`/model` 探针扩展为工具连通性探针。

### 后续队列（不排期）

- **后台任务编排**：非交互 `icy run` 退出即终止后台进程的契约要先改为"可选保活+可查询"，再谈编排；需要每任务预算与任务图。
- **多 Agent**：等 PR J/K 之后；额外需要文件修改冲突与授权传播设计。
- **自动上下文摘要**：只能作为 `ContextManager` 的新后端、在现有调用配对与 opaque 不变量之内实现，不做第二个历史改写者；先建评测门禁。
- **Windows 实机交互验收**：仍未进行；`taskkill`/`tasklist` 路径只有注入覆盖。

## 3. 门禁与证据要求

- 每个 PR 沿用现有门禁：锁文件安装、类型检查、全量测试、构建、安装包 smoke、POSIX PTY smoke、三平台 CI；合并前独立审查（grok-4.6），阻塞项关闭后再合并。
- 审查中标注"未复现"的缺陷，修复 PR 必须先提交能失败的复现用例，再提交修复；不能只改代码。
- 迭代六结束时重新跑第五轮的 45 次重复评测夹具（含新增 detach 任务），与 [批次 B](evaluations/repeated-tasks-iter4-summary.json) 对比拒绝次数、token 与耗时；差异如实记录，不宣称改进。
- 迭代七的每个交互改动都要有真实 PTY 录屏（沿用 `docs/evaluations/ui-tour-demo-transcript.txt` 的生成方式）作为审查素材，并把关键画面加入 `scripts/pty-smoke.py`。
- 版本：迭代六合并并通过评测复跑后升 0.2.0，一次性升版；迭代七、八为 0.2.x / 0.3.0。

## 4. 明确不做的事

- 不改变四工具对模型的外部契约（名称、参数、审批语义），MCP 工具是增量而不是替换。
- 不在迭代六之前接入 MCP 或第二个 Agent；审查结论是"先做写者拆分与工具表"，编排方同意。
- 不把 detached 进程改为子进程自持日志描述符（会失去写盘前脱敏和字节上限的即时执行）；icy 崩溃导致子进程 SIGPIPE 继续作为文档边界。
