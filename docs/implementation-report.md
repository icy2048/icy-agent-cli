# 可靠性与长任务迭代实施记录

日期：2026-09-27。基线：`450a87a`。工作分支：`codex/reliable-long-runs`。

本轮把[迭代计划](iteration-plan.md)的六个实施单元合并到当前工作分支，作为一个包含兼容迁移与回归测试的交付提交。尚未发布 npm 包或 Git tag。版本号保持 0.1.0；发布版本应在远程平台门禁确认后确定。PR 与远程验证状态以本分支对应的 GitHub 记录为准。

## 已实施范围

| 计划单元 | 交付 | 验收证据 |
| --- | --- | --- |
| PR 1 输入与恢复 | 20,000 grapheme 上限整次拒绝、保留草稿及光标；会话完整 schema 和调用配对校验；锁后重读、失败释放、保存临时文件清理 | `composer-limits.test.ts`、`session.test.ts`；输入/emoji/secret/立即 Enter；损坏 JSON、畸形消息、重复/孤立 ID、保存/锁失败 |
| PR 2 保真与默认值 | 未显式配置默认 `local`；显式 `model` 的改写消息同时携带权威原文；缓存和原文引用保留；12 类需求夹具、3 模式评测 | `fidelity.test.ts`、`harness.test.ts`；[离线报告](evaluations/prompt-fidelity.json)，36 个模式×场景组合原文全部保留 |
| 质量门禁 | src/tests/TS 脚本类型检查；CLI 真实子进程和 HTTP fixture；临时 npm 包安装；Node 22 macOS/Linux CI 配置 | `cli.test.ts`、`cli-resume.test.ts`、`scripts/package-smoke.mjs`、`.github/workflows/ci.yml` |
| PR 3 循环上下文 | 每次主模型请求前组装；达到 80% 字符阈值外置旧大结果；保留最近四项、配对、opaque、源历史；同一循环引用复用 | `context.test.ts`；50,000 字符上限下连续 20 次读取 6,000 字符文件完成；引用可回读；存储失败回退；无法缩减时明确停止 |
| PR 4 预算 | 同一运行累计预处理和主模型消耗；估算包括协议请求、指令与工具；下发剩余输出上限；响应超额不执行工具；异常/取消估算记账 | `budget.test.ts`、`provider-budget.test.ts`、`agent-budget.test.ts`；双协议 HTTP 参数与 usage；超额文本/工具、无 usage、预处理耗尽/取消 |
| PR 5 任务与检查点 | v2 会话与 v1 迁移；任务/运行/预算/待办/验收记录；显式续跑新预算；未知副作用不重放；用户指定检查证据门禁 | `run-state.test.ts`、`agent-recovery.test.ts`、`review-regressions.test.ts`、`workspace-fingerprint.test.ts`；崩溃阶段、真实文件修改后续跑、已知结果保存失败、验收命令修改/失败/取消使旧证据过期、检查失败重试、会话切换失败 |
| PR 6 发现与恢复视图 | 统一在线/历史轨迹投影；结果/diff/未知状态；会话发现与选择；任务、续跑、待办和验收命令 | `transcript-recovery.test.ts`、`ui-task.test.ts`、`session-list.test.ts`、`cli-resume.test.ts`；模型结束与验证通过分开显示 |

测试文件均位于 `tests/`。`session-verification-recovery.test.ts` 另行覆盖进程崩溃后未知写入使旧证据失效，以及重复恢复、未执行调用和 v1 兼容。当前操作说明以 [README](../README.md) 为准。

## 用户可用入口

```sh
icy sessions --json
icy run --resume <id> --json
icy run --resume <id> --continue
```

Workbench 支持 `/task`、`/continue`、`/verify <命令>`、`/todo <事项>`、`/done <编号>`、`/sessions`、`/resume <id>`。`/verify` 使用原 bash 审批，非交互 `--verify` 遇到未授权命令仍退出 2。只查看恢复状态不请求模型，但恢复过程会迁移旧快照并标记中断。

## 验证记录

最终在隔离的干净源码副本中执行了锁文件安装 `npm ci`、`npm run check`、`npm test`、`npm run build` 和 `npm run test:package`，全部通过：**227 项测试，0 失败、0 跳过**。包测试确认临时安装后的 `--help`、`--version` 与离线 `--demo` 正常；当前工作区也已重新构建。交付前又复验了类型检查、227 项测试、构建与包测试。以上是本地 macOS 结果；远程 Node 22 macOS/Linux 门禁请检查对应提交的 [GitHub Actions](https://github.com/icy88/icy-agent-cli/actions/workflows/ci.yml)，Linux 人工交互验收仍需另行执行。

交付已提交至 [PR #1](https://github.com/icy88/icy-agent-cli/pull/1)。首个交付提交 `c0ee96b` 的 [PR CI](https://github.com/icy88/icy-agent-cli/actions/runs/36326263880) 已在 macOS 和 Ubuntu 上通过全部门禁。该次运行提示旧版 Actions 的 Node 20 运行时已弃用，因此工作流另行更新到官方 Node 24 Actions 并固定提交 SHA；项目测试版本仍为 Node 22，后续提交以 PR 最新检查为准。

真实模型使用合成的临时项目，工具限定当前工作区，shell 仅批准精确的 `node verify.cjs`。验证器由评测端独立检查，不能仅凭模型文字或它修改后的测试判断成功。[实际结果](evaluations/live-tasks.json)使用 Responses、`gpt-5.6-sol`、`reasoningEffort=low`，每次运行沿用 100,000 token / 20 模型轮次 / 50 工具调用预算：

| 模式 | 通过场景 | 累计报告 token | 累计耗时（四舍五入） |
| --- | --- | --- | --- |
| off | 3 / 3 | 18,160 | 93 秒 |
| local | 3 / 3 | 17,573 | 90 秒 |
| model | 3 / 3 | 23,320 | 127 秒 |

场景包含按顺序读取/修改/验证、条件与例外保留、跨文件修改；保护文件与验证器均保持不变。该小样本下 `model` 没有体现节省，因此继续采用保守的 `local` 默认值。

离线保真评测只证明本测试集的原文与字面要求保留，不宣称证明语义等价。真实编码评测比较 `off/local/model` 的小样本任务完成、usage 和耗时；每个场景仅运行一次，不能据此推断稳定成功率或压缩节省比例。

## 保留的边界与后续工作

- token 是软预算，字符估算、缺 usage、重试及供应商计费都有误差；显式续跑是用户开启的新预算，不伪装成同一次运行未超限。
- “已验证完成”只表示用户登记的检查在当前 Agent 修改版本通过且待办为空；检查覆盖范围由用户指定，不能自动证明所有自然语言目标。外部编辑不更新 Agent 的修改版本，需要重新验收。
- 验收前后在本机比较工作区指纹；内容、路径、权限或链接目标变化，以及取消、读取异常或超过 10,000 条目 / 64 MiB 上限时，都使旧证据过期。只排除当前会话存储，不跟随链接；这不是原子文件系统快照。对于会产生文件的检查或超限工作区，适合一开始就登记一条包含全部检查的完整验收命令。
- v1 没有的任务状态保持未知；旧历史仍可阅读，先提交一个目标后再使用检查点续跑。
- 自动语义摘要、后台进程、受限只读探索、模型能力诊断、MCP 和多 Agent 仍在后续队列；权限默认值与四工具集合保留。
- 当前已提取 ContextManager、Budget、RunState 与轨迹投影；授权与工具执行仍在 ToolRegistry 内，独立 PermissionPolicy/Executor 的进一步拆分可随后续工具能力实施，不改变本轮运行契约。
- 发布前须确认对应提交的远程 macOS/Linux CI；本地通过不能替代远程结果，自动化门禁也不能替代 Linux 人工交互验收。
