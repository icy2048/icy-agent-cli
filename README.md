# icy-agent-cli

一个在终端运行的 AI coding agent：输入目标，模型调用工具、读取结果并继续执行。界面采用 B · Workbench：左侧是对话与工具结果，右侧是当前任务、预算和会话变更；终端小于 120 列时自动切为单栏。

## 安装与快速开始

需要 Node.js 22+。当前实现面向 macOS / Linux 的 POSIX 环境；Windows 暂不支持 shell 工具。

```sh
npm ci
npm run build
npm link
icy
```

常用命令：

```sh
icy "检查这个项目的启动入口"
icy run "读取 README.md 并总结项目" --read-only
icy run "读取 README.md 并检查启动说明" --read-only --json
icy sessions [--status <状态>[,<状态>...]] [--cwd <目录>]
icy --resume <session-id>
icy run --resume <session-id> --json
icy run --resume <session-id> --continue
icy run --resume <session-id> --verify "npm test"
icy config init
icy --demo
icy --version
```

| 参数 | 作用 |
| --- | --- |
| `--provider chat-completions\|responses` | 选择接口协议 |
| `--base-url <地址>` / `--model <模型>` | 覆盖服务地址或模型 |
| `--cwd <目录>` | 指定工作区；普通运行默认是启动目录，`sessions` 中是过滤条件 |
| `--resume <ID>` | 恢复会话；不自动重放中断的工具 |
| `--continue` / `--verify <命令>` | 在 `run --resume` 下以新预算继续，或执行用户指定验收 |
| `--read-only` | 只向模型提供 `read` |
| `--plain` / `--json` | 使用非交互输出；`--json` 输出 NDJSON |
| `--status <状态>[,<状态>...]` | 仅用于 `icy sessions`，可重复或逗号分隔 |
| `--demo` / `--help` / `--version` | 离线只读演示、帮助、版本 |

`run`、`--plain`、`--json` 或非 TTY 环境使用非交互模式。成功退出码为 `0`；未批准的 shell 为 `2`，取消为 `130`，其他运行失败为 `1`。状态过滤、`--status` 用错位置和缺少非交互目标等部分用法错误使用 `2`。非交互模式没有授权弹窗；通常应进入 Workbench 用 `/verify npm test` 审批并验收，`--verify` 不绕过 shell 权限。

`icy sessions --json` 逐行输出会话摘要。`--status` 支持 `running`、`awaiting_approval`、`cancelled`、`limited`、`failed`、`answered`、`verified`、`interrupted`、`legacy`；`--cwd` 相对启动目录解析，目录可以不存在。指定过滤条件时，不返回无法读取的会话；无过滤条件时仍显示其错误摘要。只传 `--resume` 的非交互命令只展示任务状态，不请求模型或执行工具，但仍会校验会话、迁移旧格式并记录中断。`--continue`、`--verify` 都要求 `--resume`，且不能和新目标或彼此混用。

## 模型配置

支持 `responses` 和 `chat-completions`。`baseUrl` 必须包含服务要求的路径前缀，icy 不会自动追加 `/v1`。

用户配置位于 `~/.icy/config.json`，也可用 `ICY_HOME` 改变用户配置、会话和输出目录。`icy config init` 创建配置但不覆盖已有文件。

```json
{
  "provider": "chat-completions",
  "baseUrl": "https://your-provider.example/v1",
  "model": "your-tool-capable-model",
  "apiKeyEnv": "ICY_API_KEY",
  "permissions": "workspace-edit",
  "promptCompaction": "local",
  "maxModelTurns": 20,
  "maxToolCalls": 50
}
```

| 配置键 | 说明 |
| --- | --- |
| `provider` | `chat-completions` 或 `responses`；默认前者 |
| `baseUrl` | 服务完整地址；远程服务必须 HTTPS |
| `allowPrivateHttp` | 仅用户配置可设为 `true`，允许 RFC1918 私有 IPv4 的 HTTP |
| `model` | 主模型名 |
| `apiKeyEnv` / `apiKeyFile` | 密钥环境变量名（默认 `ICY_API_KEY`）/ 相对 `ICY_HOME` 的密钥文件 |
| `reasoningEffort` | `low`、`medium`、`high` 或 `xhigh` |
| `reasoningSummary` | Responses 是否请求可见 reasoning summary；设为 `false` 可关闭 |
| `thinkingExpanded` | 思考内容的显示默认值；`ui.json` 中的同名设置优先 |
| `promptCompaction` | `local`、`model` 或 `off`；默认 `local` |
| `compactionModel` | `model` 模式使用的小模型；默认 `gpt-5.6-luna` |
| `compactionMinChars` | `model` 模式阈值，默认 200 个 UTF-16 code unit；设为 0 表示每条新输入都请求 |
| `permissions` | `workspace-edit` 或 `read-only`；默认 `workspace-edit` |
| `maxModelTurns` / `maxToolCalls` | 每次运行最多模型请求数 / 工具调用数；默认 20 / 50 |
| `maxTokens` / `maxContextChars` | 每次运行软 token 预算 / 模型消息字符上限；默认 100,000 / 120,000 |
| `requestTimeoutMs` | 每次完整模型调用截止时间；默认 120,000 ms |

密钥优先使用 `config.apiKeyEnv` 指定的本机环境变量（默认是 `ICY_API_KEY`），其次读取 `apiKeyFile`；密钥文件建议权限 `0600`，且必须位于 `ICY_HOME` 内。模型向导写入用户配置并把密钥单独保存为 `0600` 凭据文件，不写入项目、会话或日志。模型设置的有效优先级是命令行参数 > `ICY_PROVIDER` / `ICY_BASE_URL` / `ICY_MODEL` > 项目允许字段 > 用户配置和默认值；命令行的 `--provider`、`--base-url`、`--model` 覆盖环境和配置。项目级 `.icy/config.json` 只允许设置模型名和降低 `maxModelTurns`、`maxToolCalls`、`maxTokens`、`maxContextChars`，不能改变密钥来源、服务地址、`allowPrivateHttp` 或扩大权限。

远程地址必须使用 HTTPS。本机 `localhost`、`127.0.0.1` 和 `[::1]` 可用 HTTP；私有 IPv4 只有在用户配置显式设置 `allowPrivateHttp: true` 时允许，范围是 `10/8`、`172.16/12`、`192.168/16`，公网 HTTP 仍被拒绝。局域网 vLLM 使用 `chat-completions` 和服务实际模型名；若启用 `promptCompaction: "model"`，还应把 `compactionModel` 设为服务提供的模型名，可以与主模型相同。HTTP 会在局域网明文传输请求和凭据，只为自己信任的服务启用。

### `/model` 向导

运行 `icy` 后输入 `/model`：

1. 选择当前服务、本机 CC Switch 的 Codex 服务，或手动填写兼容服务。CC Switch 通过本机 `sqlite3` 只读读取数据库，不修改它；导入后是独立副本，后续不会自动同步。
2. 向导请求服务的 `/models` 列表并支持名称筛选。服务没有标准列表时，可使用已导入的模型名或手动输入。
3. 手动配置完整 API 地址、API key、协议和模型名。key 输入会遮蔽，且不会沿用其他服务的 key。
4. 按 Enter 先测试文本响应，再用诊断专用的 `icy_probe` 测试工具调用和工具结果续接。探针从不执行主机工具；失败区分 `auth`、`connect`、`protocol`、`model`、`text`、`tool_call`、`tool_result`，也会指出工具不支持或调用不正确。Esc 取消时原配置保持有效。

测试通过后才保存并立即启用；切换服务后开始新会话，旧会话保留，不把旧服务的专用推理状态传给新服务。恢复旧会话仍要求匹配原来的模型、provider、服务地址、协议和工作区。离线演示不配置在线服务。

## 终端操作

### 命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 查看命令与快捷键 |
| `/model` | 配置服务、选择模型并测试连接 |
| `/new` | 开启新对话，保留旧会话；沿用当前模型、工作区和配置，重置上下文与工具授权 |
| `/thinking` | 切换思考展开 / 收起；也可用 `/thinking expanded` 或 `/thinking collapsed` |
| `/clear` / `/exit` | 清空当前会话上下文 / 退出 icy |
| `/task` | 查看任务、待办、预算、检查点和验收记录 |
| `/continue` | 用新预算继续原任务；已执行工具不会自动重放 |
| `/verify <命令>` | 执行并登记用户指定验收，沿用 bash 审批 |
| `/todo <事项>` / `/done <编号>` | 添加 / 完成待办；编号从 1 开始 |
| `/sessions [status=<状态,...>] [cwd=<目录>]` | 列出会话并按任务状态、工作区过滤；恢复不会自动执行 |
| `/resume <会话 ID>` | 恢复指定会话 |

`/sessions` 的状态值与命令行相同；`cwd` 可为相对路径，按启动目录解析。过滤使用 `status=failed,answered` 这样的无空格逗号列表。命令菜单由 `/` 打开：继续输入可筛选，↑↓ 选择，Enter 执行，Tab 补全，Esc 关闭。

### 快捷键

| 操作 | 按键 |
| --- | --- |
| 提交 / 多行输入 | Enter / 粘贴多行；支持的终端可用 Alt+Enter 或 Shift+Enter，换行显示为 `↵` |
| 输入历史 | ↑ / ↓ |
| 移动与编辑 | ← / →、Home / End、Ctrl+A / Ctrl+E |
| 删除光标前 / 后 | Ctrl+U / Ctrl+K |
| 展开工具参数、结果和 diff | Ctrl+O |
| 展开 / 收起思考 | Ctrl+T 或 `/thinking` |
| 输出翻页 | PgUp / PgDn |
| 取消本轮 / 退出 | Esc / Ctrl+C；空闲时 Ctrl+C 退出 |
| shell 审批 | 最后一页按 Y 允许一次、A 允许本次进程会话中的相同完整命令/cwd/超时、N 拒绝 |
| 长命令审批 | PgUp / PgDn 查看完整命令；必须翻到最后一页后才能 Y/A |

输入框是单行视窗，但保留真实多行内容；按 Unicode grapheme（字素簇）编辑中文和 emoji。上限是 20,000 个 grapheme，中文单字、组合重音字符和组合 emoji 各计 1 个；键入或粘贴超限时整次拒绝，保留草稿和光标，不截断，Enter 也不会提交，并显示提示。密钥输入的超限提示不显示密钥内容。`NO_COLOR=1 icy` 可禁用颜色。

用户消息使用蓝色侧边色块，icy 回复使用青色侧边色块，正文沿用终端前景色和背景色以适配浅色与深色主题；不使用对话外框、整行深色背景或 `you / icy` 前缀。思考默认收起并以弱化的单行提示显示；没有内容的已完成思考默认隐藏，展开后说明接口未返回内容。每次模型请求的思考独立显示，可与回答一起翻页查看。显示偏好保存到 `~/.icy/ui.json`（或 `ICY_HOME/ui.json`），重启后继续；它只影响显示，不改变模型推理强度。Responses 默认请求 `reasoning.summary: auto`，只显示服务提供的摘要，不解码加密推理；不支持该参数的服务可设置 `reasoningSummary: false`。Chat Completions 服务可通过 `reasoning_content` 或 `reasoning` 返回可见思考内容。

## 工具与权限

默认只向模型提供 `read`、`write`、`edit`、`bash` 四个工具；旧工具名称不再注册，也没有隐藏别名；同一响应中的调用按返回顺序串行执行。默认权限是 `workspace-edit`，文件读写在工作区内进行，`bash` 需明确批准；`--read-only` 和离线演示只提供免审批的 `read`。拒绝或执行错误会回传模型；相同工具、参数和错误连续失败 3 次会停止。

| 工具 | 行为与边界 |
| --- | --- |
| `read` | 读取 UTF-8 文本并返回行号和 SHA256；也可免审批列目录（`path` 为目录）或搜索内容（`pattern`）。目录 `depth` 为 1–5（默认 1，1 只列直接子项），最多 500 项；搜索是区分大小写的固定字符串，或 `regex=true` 的 JavaScript 正则（模式最多 200 字符），最多扫描 2,000 个文件、每文件 1 MB、最多 200 条匹配，搜索最多运行 10 秒，正则每文件最多 1 秒。普通文件最多 1 MB。 |
| `write` | 创建或整体覆盖 UTF-8 文件。覆盖现有文件必须传入此前 `read` 的 SHA256；新文件必须传 `expectedHash: null`。内容最多 1 MB，返回 diff；`icy-output:` 引用不可写。 |
| `edit` | 按 `path`、`oldText`、`newText` 做精确替换；`oldText` 非空且必须只匹配一次，空格和换行也必须匹配；不是正则或 unified diff，缺失/多次匹配会拒绝。写入前后保留哈希校验；文本参数最多 1 MB。 |
| `bash` | 使用 `/bin/bash --noprofile --norc -c`，仅用于测试、构建和 `read` 无法完成的命令；每条命令（包括只读命令）都要批准。无交互 stdin，单次最多 60 秒，命令参数最多 20,000 字符；批准等待结束后会重新校验 cwd，超时或取消会终止 POSIX 进程组。 |

文件工具拒绝越出工作区、NUL、符号链接路径和敏感路径。敏感名称包括 `.git`、`.icy`、`.ssh`、`.aws`、`.gnupg`、`.kube`、`.docker`、`.npmrc`、`.netrc`、`.pypirc`、`.git-credentials`、`.htpasswd`、`credentials`、`id_rsa`、`id_ed25519`、非示例的 `.env*`，以及 `.pem`、`.key`、`.p12`、`.pfx`、`.token` 结尾的文件；`.env.example`、`.env.sample`、`.env.template` 例外。`bash` 的搜索范围和忽略规则由实际命令决定，例如 `rg` 与 `find` 不同；bash 不是文件工具的越界保护替代品。

工具结果超过 32 KiB 时保存为 `icy-output:<id>.txt` 并返回有界预览；失败命令还可能返回常见错误行的字面诊断片段，不能保证覆盖所有失败。bash 输出超过 256 KiB 会终止命令。`read` 读取普通文件时 `offset` / `limit` 按行计数；读取输出引用时按 Unicode 字符计数，每页最多 6,000 字符，结果带下一页 offset。输出引用不能用 `write` / `edit` 修改；无需额外工具即可读取，也能读取很长的单行输出。

## 任务、会话与验收

- **会话**保存对话、工具轨迹和多次运行；**任务**保存原始目标、待办、完成项和验收记录；**运行（RunState）**是一次独立的模型/工具执行，保存调用数、usage、预算、检查点和停止原因。一个会话同时只有一个活动任务。状态包括执行中、等待批准、已取消、达到限制、失败、已中断、已回答和已验证完成。
- 新消息创建新任务。`/continue` 延续原目标和待办，创建新的运行记录与预算并关联上次运行；不重放历史工具。遇到 `interrupted_unknown`，先核对实际状态。
- `/todo` 和 `/done` 是用户操作；模型不能自行把待办标为完成。`/task` 显示最近检查点、停止原因、预算和最近验收结果。模型结束回答不等于目标已验收。
- `/verify <命令>` 不请求模型，在当前工作区通过 `bash` 执行并记录；使用 shell 审批、超时和输出限制，每次验收有独立运行记录。普通工具循环中的测试不会自动成为用户指定验收。
- “已验证完成”要求待办为空、至少有一项用户登记的验收，且每个登记命令的最近成功记录都对应当前 Agent 修改版本 `mutationRevision`。新的普通 `write`、`edit` 或 `bash` 会使旧证据过期，并在界面标出；该状态只证明登记的检查通过，不是对任意自然语言目标的语义证明。
- 验收命令可能修改文件。执行前后会在本机比较工作区指纹（路径、内容、权限和链接目标）；不跟随符号链接，只排除当前会话存储目录，最多检查 10,000 个条目和 64 MiB 内容。检测到变化、取消、读取失败或无法确认时，旧证据过期。对会写入产物的检查或较大工作区，建议一开始登记一条包含全部检查的验收命令，避免分次执行时旧证据持续过期。外部编辑器或其他进程的修改不会自动更新 Agent 修改版本，需要重新验收。

会话保存在 `~/.icy/sessions/<id>/`（或 `ICY_HOME/sessions/<id>/`），包含 v2 快照、事件日志和长输出。恢复前会校验消息结构、工具调用配对和调用 ID；损坏快照保留原件并报告位置，恢复失败会释放本次锁。合法但未完成的调用补齐为 `interrupted_unknown` 或 `not_executed`，活动运行标为中断，不重放副作用；结果未知的 `write`、`edit`、`bash` 也会使旧验收证据过期。

v1 会话恢复时迁移到 v2，保留原消息、工具结果和 Responses 专用状态；旧格式没有的任务状态和验收证据保持未知，不补写成功。旧会话必须先提交目标才能 `/continue`。旧历史中的工具名称不代表当前可调用工具，旧调用不会重放。在线执行和恢复使用同一轨迹投影，可展开工具参数、结果和 diff，并保留未知状态和会话变更列表。恢复要求匹配原模型、协议、服务地址和工作区；失败时保留当前会话。

## 上下文、预算与需求预处理

- 每次提交先由 harness 做一次需求预处理；主模型循环中每次请求前再由 `ContextManager` 组装上下文并检查大小。
- 每次运行默认最多 20 次模型请求、50 次工具调用和 100,000 tokens；模型消息上下文上限为 120,000 字符。预算按运行计算，不是整个会话共用；显式 `/continue` 开启新预算并保留之前的 usage。
- 这是软预算：字符到 token 的换算不是 tokenizer，provider usage 可能缺失，重试、断流和供应商计费可能不可完整观测；可用时记录 provider 报告的输入、输出和缓存 usage，缺 usage 时显示带 `~` 的估算。请求前会估算输入、预留响应空间并下发输出上限；响应超额时标记 `budget_exceeded`，不继续请求模型或执行该响应中的工具；预算耗尽或无法预留响应空间时以 `token_budget` 停止。
- 每次完整模型调用（含流读取和 SDK 重试）默认截止 120 秒；SDK 最多重试 2 次，重试不延长本次截止。响应头到达后流仍未结束也会以 `model_request_timeout` 停止；中断/超时的未收齐工具调用不执行，已发送消耗按可观测信息估算记账。
- `promptCompaction` 为三种模式：`local`（默认）只做受限空白清理和历史结果外置，不调用小模型，代码及明确要求原样保留的输入不清理；`model` 在达到 `compactionMinChars` 后调用当前服务的小模型提炼，模型没有工具权限，也不进入主工具循环，失败自动回退；`off` 关闭需求提炼和工具结果外置，但仍检查预算和上下文上限。提炼请求最多 15 秒、最多输出 2,048 tokens、不自动重试；`compactionModel` 未设置时使用 `gpt-5.6-luna`，小模型产生的 usage 计入本次运行预算。结构化 envelope、完整原文和额外请求会增加 token 与延迟，`model` 模式不保证降低费用，字符变化也不是精确 token 节省。
- 原始用户输入始终保存在会话并在界面原样显示。`model` 模式的 `icy.user-request.v2` 内容包含 `task`、`keywords`、`constraints`、需要时的 `original_ref` 和完整 `original`；`original` 是权威要求，完整原文可用 `read` 通过 `original_ref` 回读。Responses 和 Chat Completions 使用标准消息字段，不添加请求顶层扩展，也不改变四工具 schema。提炼只要求删除赘述和重复，不补事实；代码块、行内代码、引号、路径、数字和明确约束会做占位符/字面校验。提炼失败、不完整、约束缺失、无效 JSON、工具调用或超时均不采用结果；这些检查不能证明动作、条件、例外和顺序都完整，提炼结果只是辅助提示。`keywords` 只是原文词项索引，`constraints` 不把引号和代码中的指令提升为用户要求。
- 循环内每次主模型请求前，按 provider 实际序列化的消息、指令和工具定义计算字符量。达到上限 80% 后，先外置较旧且超过 4,000 字符的工具结果，并复用相同内容的引用；仍不够时处理较小旧结果、把连续的完整 assistant＋工具交换归档为可回读 JSON，最后才为最近的大结果保留首尾预览和完整引用。源会话、归档、调用 ID、工具配对和 Responses opaque 保留；外置只改变发送给模型的视图，旧 opaque 随完整交换外置，不保证每次请求携带全部历史 opaque；写引用失败会回退，仍无法容纳时以 `context_limit` 停止。用户输入预处理不压缩工具历史。
- 活动视图还保留所有用户消息、最近四项观察所在的完整调用批次（最新批次即使超过四项也全部保留）、最新 assistant 响应、最近三条不同 shell 命令的最新结果和最近一个未解决的失败命令。旧交换的机械索引只保留未知结果、每个文件最后修改、最后失败命令和最近三项操作的原始字段，不生成语义摘要；只有相同命令与相同 `cwd` 的成功结果会解除对应失败。此规则不推断任务完成，也不把工具测试升级成验收证据。
- 普通工具循环有约束或关键词时会临时附加 `[icy 提醒]`；显式续跑使用 `[icy 任务续跑]`，含原始目标、待办和核对已保存结果的要求；这些提醒不写入会话。NDJSON 与事件日志包含 `harness_start`、`harness_end` 和每轮 `context` 事件。相关字段包括 `beforeChars`、`afterChars`、`savedChars`、`compactedToolResults`、`fallback`、`semantic`、`preprocessingTokens`、`preprocessingEstimated`、`recentToolPreviews`、`archivedExchanges`；UI 会显示压缩前后大小或失败提示。离线演示强制使用 `local`。

完整的上下文归档、opaque 保留、需求提炼校验、回退和历史诊断见 [docs/design.md](docs/design.md) 与 [docs/gap-closure.md](docs/gap-closure.md)。运行编排和 `ToolRegistry` / `PermissionPolicy` / `ToolExecutor` 的职责说明也见 [docs/design.md](docs/design.md)。

## 当前边界

shell 在当前用户主机上运行，**不是操作系统沙箱**；获批命令可以访问工作区之外的资源，路径与哈希检查也不能消除外部进程并发修改的竞态。文件工具最多读取 1 MB 文本，单条结果超过 32 KiB 只显示有界预览，bash 输出超过 256 KiB 会终止命令。事件和工具输出只按已知 key、常见密钥模式脱敏并清理终端控制字符，不是完整的敏感数据识别系统；模型仍会收到任务需要的文件和工具结果。暂不支持后台命令、交互式 shell stdin、Windows 进程树取消、自动上下文摘要、MCP、多 Agent。

## 开发与验证

| 脚本 | 用途 |
| --- | --- |
| `npm run dev` | 直接运行 `src/cli.tsx` |
| `npm run check` | 源码、测试和 TypeScript 脚本类型检查 |
| `npm test` | 确定性行为测试与 CLI 子进程测试 |
| `npm run build` | 清理、编译并生成可执行入口 |
| `npm run test:package` | 构建后临时打包安装、空 `ICY_HOME`，并检查安装产物的 `--help`、`--version`、离线 `--demo` |
| `npm run test:pty` | 构建后的本地 POSIX PTY smoke test；不需要模型凭据 |
| `npm run eval:prompts` | 默认离线比较 `off` / `local` / `model` 的原文保留和预处理开销；`--live` 才请求配置的小模型服务 |
| `npm run eval:tasks -- --live` | 默认在临时工作区用已配置主模型各运行一次五类合成编码任务，可用 `--repetitions` / `--concurrency`；检查文件结果、验证脚本保留、实际验收输出和保护文件；会产生模型请求、临时修改和指定验收授权 |
| `npm run eval:repository -- --live` | 在仓库临时副本运行真实仓库任务的中断、恢复和独立验收评测 |

测试覆盖四工具循环、两种协议的工具列表和请求分片、旧工具拒绝、参数/精确替换歧义、Bash 语法、文件冲突、路径与敏感路径边界、授权/取消/进程终止、长输出、预算/超时/异常记账、上下文外置、会话校验与 v1/v2 恢复、任务命令和检查点、工具轨迹恢复、验收证据过期、目录列举与搜索、模型探针、会话过滤、中文/emoji 输入以及 CLI/PTY/包安装行为。

`eval:prompts` 的离线夹具包含顺序、条件、例外、否定、验收和引用材料；默认使用确定性假模型，不发送工作区文件或执行主机工具；`--live` 只发送合成夹具到配置的小模型服务。它只报告原文是否保留、字面要求遗漏、字符数、预处理 token 和耗时，不测自主任务完成率，也不证明语义等价。`eval:tasks -- --live` 默认每个样例只执行一次；即使输出正确，也不能据此给出稳定成功率、费用排名或压缩收益。真实模型结果、历史失败、重复批次和上下文诊断保存在 [docs/evaluations/](docs/evaluations/)；限制与审计见 [docs/gap-closure.md](docs/gap-closure.md)。

仓库的 Node 22 macOS/Linux [GitHub Actions 门禁](https://github.com/icy2048/icy-agent-cli/actions/workflows/ci.yml)包含锁文件安装、类型检查、测试、构建和包测试；工作流文件的存在不表示对应提交已经通过，发布前应确认远程结果。Linux PTY 有自动门禁，但不替代真人人工交互验收。历史真实 Happy Code 验收曾在独立临时目录完成 `write`、`read`、`edit` 并批准 bash 检查，四个工具成功且检查退出码为 0；这不是当前在线回归承诺。

代码入口是 `src/cli.tsx`；运行循环在 `src/core/`，模型协议在 `src/providers/`，工具与权限在 `src/tools/`，会话在 `src/sessions/`，Workbench 在 `src/ui/`。

## 文档索引

- [架构与迭代计划](docs/iteration-plan.md)：架构评估、交付顺序和后续队列。
- [原始设计](docs/design.md)：设计提案、工具/权限契约和实现分层；浏览器原型使用模拟数据，真实执行在终端完成。
- [缺口验收清单](docs/gap-closure.md)：上下文、任务恢复、模型诊断、只读探索及历史评测限制。
- [逐项验收核对](docs/acceptance-audit.md)：实现要求与自动化/PTY/真实任务证据的逐项对应。
- [实施记录](docs/implementation-report.md)：实施范围、脚本验证、历史边界和真实模型场景记录。
- [评测资料](docs/evaluations/)：提示词、任务、PTY、仓库任务和重复批次的原始记录与审查。

协议参考：[OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)、[流式响应](https://developers.openai.com/api/docs/guides/streaming-responses)、[Reasoning summaries](https://developers.openai.com/api/docs/guides/reasoning#reasoning-summaries)。
