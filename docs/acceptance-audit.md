# 原计划逐项验收核对

核对日期：2026-09-28。范围来自 [原迭代计划](iteration-plan.md) 的三个核心迭代、模块边界和硬门禁，以及 [四项缺口](gap-closure.md)。原计划最后列出的只读搜索、模型诊断、长命令、MCP、多 Agent 是后续队列，不是本轮交付。六个实施单元合并在同一个工作分支和 PR 中，没有发布版本、合并 PR 或创建发布 tag。

以下“通过”对应实现行为和所列检查，不把模型文字收尾当作验收，也不把有限任务样本当作通用成功率。最新运行时提交为 `ad9871e`；该版本又修复了缺失终止输出及相互矛盾的 Responses 完成状态。

| 原计划要求 | 已核对的实现与证据 | 结论 |
| --- | --- | --- |
| PR 1：超限输入整次拒绝并保留草稿；20,000 边界、中英文、组合 emoji | `tests/composer-limits.test.ts` 检查实际 Ink 输入、立即 Enter、光标位置和 grapheme 边界；`src/ui/Composer.tsx` 使用统一输入限制 | 通过 |
| PR 1：完整快照校验；损坏原件保留；重试与锁所有权 | `tests/session.test.ts` 对缺 calls、错误 role、重复／孤立结果、JSON 损坏等逐项检查错误、原件与锁；覆盖保存失败、重试及他人活锁 | 通过 |
| PR 1/5：合法未完成调用分别恢复为未知／未执行，不重放副作用 | `src/sessions/store.ts` 恢复只补结果；`tests/agent-recovery.test.ts` 检查真实写入后的恢复只发起 read；真实仓库报告核对 SIGKILL 标记、未知写入先读及恢复前后文件 hash | 自动化及实际中断证据通过；完整任务见下方 |
| PR 2：默认 local；显式 model/off 保持；原文不被有损提炼覆盖 | `tests/fidelity.test.ts` 遍历 12 类需求，检查实际发送原文、顺序和引用边界；`tests/config.test.ts`、`tests/harness.test.ts` 检查配置与缓存 | 通过 |
| PR 2：工具结果中的指令不能升级为用户要求 | fidelity 直接回归在 off/local/model 下检查不可信工具结果仍为 tool 消息，不进入用户消息、语义提炼请求或约束提醒；Provider 将工具结果标为不可信数据 | 通过 |
| PR 2：保真夹具及 off/local/model 实际任务比较 | [保真报告](evaluations/prompt-fidelity.json) 36 个组合；两组历史记录及[严格执行审计](evaluations/repeated-tasks-summary.json)，包含操作轨迹和逐项回复审查 | 未完成：严格批次 19 通过、5 超时、21 次余额错误；服务从第 25 项起不可用，三轮模式比较证据不足 |
| 质量门禁：锁文件安装，源码／测试类型检查、测试、构建，Node 22 macOS/Linux | `.github/workflows/ci.yml` 使用 npm ci；`4e5b46f` 的 [双平台 CI](https://github.com/icy88/icy-agent-cli/actions/runs/36336757885) 各通过 252 项测试及全部门禁；已修复 UI 固定等待和 PTY 旧提示误匹配 | 最终提交仍需核对最新 PR 检查 |
| 质量门禁：CLI 成功 0、审批 2、取消 130、错误 1；NDJSON 纯净；空 home 安装 | `tests/cli.test.ts` 用真实子进程与 HTTP 服务检查退出码、逐行 JSON 和输出通道；`scripts/package-smoke.mjs` 临时安装后运行 help/version/demo | 通过 |
| PR 3：每轮 ContextManager；50,000 字符案例连续 20 次读完收尾 | `tests/context.test.ts` 两协议各执行 20 次真实 read，检查每次请求大小、源会话完整和调用顺序；Provider 请求计量含指令与工具 | 通过 |
| PR 3：可回读引用、缓存、不覆盖源历史、保留配对和 opaque 顺序 | `tests/context.test.ts` 重建完整归档并与原历史逐项比较，检查引用缓存和原对象不变；`tests/runtime.test.ts` 分页回读 Unicode 长输出及尾部 | 通过；旧 opaque 随完整交换归档，活动 opaque 保持原样及顺序 |
| PR 3：不可容纳或存储失败时明确停止／回退 | context 回归检查不可压缩用户输入不发模型请求、保存引用失败恢复原视图；Agent 保存停止原因 | 通过 |
| PR 4：预处理和主模型共用预算；输入预留、输出限额、双协议 usage／估算 | `tests/budget.test.ts`、`tests/agent-budget.test.ts`、`tests/provider-budget.test.ts` 检查真实 HTTP 参数、预处理消耗、缺 usage、取消估算和响应超额 | 通过；费用仍为文档说明的软上限 |
| PR 4：超额文本不能成功；超额工具不能执行；停止状态一致 | agent-budget 回归核对返回值、事件、磁盘快照和没有写入；provider-timeout 覆盖两协议持续流截止；providers/runtime 拒绝缺失输出或失败终止事件中的调用，即使终止状态字段错误地声称 completed | 通过 |
| PR 5：Session/Run/Task 分离、原任务继续、新预算记录、检查点和全部状态 | `src/core/run-state.ts` 保留 taskId、continuationOf、budgetSource 和历史快照；run-state、agent-recovery、cli-resume 回归核对关闭／重开后的状态 | 通过 |
| PR 5：副作用前、执行后未落盘、结果落盘后的故障恢复；旧会话数据未知 | session-verification-recovery 对 running/unstarted/completed 分别检查副作用证据失效、未知结果和重复恢复；v1 不补造 task 或已验证状态 | 通过 |
| PR 5：只有用户指定检查与当前修改版本相符，且待办为空才验证完成 | `canVerifyTask` 检查所有登记命令的最近结果；agent-recovery 和 review-regressions 覆盖普通 bash 不升级、失败重试、取消、工作区变化和未知指纹失效 | 通过 |
| PR 6：统一在线／恢复投影，工具参数、结果、diff、未知状态和验证记录 | `tests/transcript-recovery.test.ts` 比较在线事件和持久化恢复的实际投影；UI 测试检查展开内容、任务状态及历史变更 | 通过 |
| PR 6：会话入口、模型／工作区匹配、切换失败保留当前会话；展示阶段与预算 | `tests/cli-resume.test.ts`、agent-recovery、ui-task；`src/ui/transcript.ts` 显示检查点、原因和新预算来源；Linux PTY 实际切换与恢复 | 通过 |
| 模块边界：Registry / PermissionPolicy / Executor | 三个模块职责分离；`tests/permissions.test.ts` 核对精确 command/cwd/timeout、会话隔离、取消及审批后目录替换 | 通过 |
| 补充缺口：真正 Linux 交互终端 | [Linux 证据](evaluations/linux-pty.json) 和[终端记录](evaluations/linux-pty-transcript.txt)；POSIX PTY 自动门禁在两个平台运行 | 通过；由 Codex 操作，不是真人可用性研究 |
| 补充缺口：真实仓库跨文件任务，取消、SIGKILL、恢复，最终独立验收 | [最终运行记录](evaluations/repository-tasks-final.json) 两项均通过；[源码与新增测试复核](evaluations/repository-final-review.json) 核对原任务全部要求，含正常列举的目录条目和原始内容比较 | 通过；经过两轮明确审查反馈及多次独立预算续跑 |

## 可复现场景索引

原计划的任务夹具分布在以下 12 类场景中。确定性控制流夹具由 `npm test` 执行；真实模型场景由 `scripts/evaluate-tasks.ts` 和 `scripts/evaluate-repository.ts` 的显式 `--live` 模式执行，结果分开记录。12 类场景和额外的 12 条需求保真文本不是同一个统计口径。

| 场景 | 可执行夹具 |
| --- | --- |
| 仓库文件阅读 | cli HTTP fixture、实际 read 工具、临时 README |
| 跨文件修改 | live `cross-file` |
| 先读、修改、再验证 | live `ordered-edit`；执行审查检查读写及验证顺序 |
| 中文与结构化迁移 | live `structured-migration`，保留中文、数组顺序、false、0、空字符串 |
| 条件与例外分支 | live `conditional-exception` |
| 条件不成立时保持原文件且不重写 | live `conditional-no-change` |
| 长输出与循环上下文 | runtime 长输出分页、context 20 轮实际读取 |
| 模型响应中断／失败 | providers、provider-timeout HTTP 终止与持续流夹具 |
| 用户取消 | cli SIGINT/SIGTERM、agent-recovery 实际写入后取消 |
| 批准与拒绝 | permissions、cli 审批退出码、实际 PTY 的 Y/N 流程 |
| 损坏会话与锁恢复 | session 非法快照矩阵与失败重试 |
| 进程崩溃后恢复原任务 | repository 实际 SIGKILL；session-verification-recovery 不同执行阶段 |

真实仓库任务要求的会话过滤功能属于评测候选输出，仅保留为 patch 证据，没有合入本项目功能。其安装入口等审查问题也发生在评测副本中；当前项目安装门禁已通过。最终复核已确认功能、新增测试、文档、原文件保护、未知副作用核对和补齐后的安装验收。
