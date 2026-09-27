# icy

一个在终端运行的 AI agent：输入目标，模型自主调用工具、观察结果并继续执行。采用 B · Workbench，左侧对话与工具结果，右侧任务状态、预算和会话变更；终端小于 120 列时自动切成单栏。

## 开始使用

要求 Node.js 22+。本轮已在 macOS 本机验收；Linux 使用相同 POSIX 实现，跨平台自动化结果请查看对应提交的 [CI](https://github.com/icy88/icy-agent-cli/actions/workflows/ci.yml)。Linux 人工交互验收仍需另行执行。Windows 暂不支持 shell 工具。

```sh
npm ci
npm run build
npm link
icy
```

完成构建和 `npm link` 后，可以直接输入 `icy`。

```sh
icy "检查这个项目的启动入口"
icy run "读取 README.md 并总结项目" --read-only
icy run "读取 README.md 并检查启动说明" --read-only --json
icy sessions                  # 列出会话 ID、目标、模型与状态
icy --resume <session-id>      # 恢复界面，不自动执行原任务
icy run --resume <session-id> --json   # 仅查看任务状态
icy run --resume <session-id> --continue  # 显式以新预算继续原任务
icy run --resume <session-id> --verify "npm test"  # 非交互验收仍需 shell 授权
icy --demo                     # 无需模型的离线只读演示
icy --version
```

`--cwd <目录>` 指定工作区，默认是启动目录。`run`、`--plain`、`--json` 或非 TTY 环境使用非交互模式。执行成功的退出码为 0；遇到未批准的 shell 为 2，取消为 130，其他运行失败为 1。非交互模式没有授权弹窗，因此通常应进入 Workbench 后用 `/verify npm test` 审批并验收；`--verify` 不绕过 shell 权限。

`icy sessions --json` 输出逐行会话摘要。非交互模式只传 `--resume` 时展示任务状态，不请求模型或执行工具；恢复过程仍会校验会话、迁移旧格式并记录中断状态。`--continue`、`--verify` 都要求 `--resume`，不能与新目标或彼此混用。

## 模型配置

支持 `responses` 和 `chat-completions`。服务地址需包含服务要求的路径前缀，不自动追加 `/v1`。

历史本机接入示例使用 CC Switch 中 Happy Code / Codex 的配置：

- 地址：`https://happycodeai.com`
- 协议：`responses`
- 模型：`gpt-5.6-sol`
- reasoning effort：`xhigh`

该历史配置在 `~/.icy/config.json`，密钥单独存于本机 `~/.icy/credentials/happy-code.key`，文件权限 `0600`，没有写入项目。导入的是独立副本；CC Switch 后续修改不会自动同步。新安装可通过下面的配置或 `/model` 设置自己的服务。

其他机器可以运行 `icy config init`，再编辑新建配置；该命令不会覆盖已有配置。

```json
{
  "provider": "chat-completions",
  "baseUrl": "https://your-provider.example/v1",
  "model": "your-tool-capable-model",
  "apiKeyEnv": "ICY_API_KEY",
  "permissions": "workspace-edit",
  "maxModelTurns": 20,
  "maxToolCalls": 50
}
```

密钥由本机环境变量 `ICY_API_KEY` 提供；也可以配置 `apiKeyFile`，路径相对于 `~/.icy`，建议权限 `0600`。环境变量优先于密钥文件。`ICY_HOME` 可改变用户配置与会话目录。

`ICY_PROVIDER`、`ICY_BASE_URL`、`ICY_MODEL` 以及对应命令行参数覆盖模型设置。项目级 `.icy/config.json` 只允许设置模型名、降低运行上限，不能修改密钥来源、服务地址或扩大权限。`/model` 打开配置向导，测试通过后保存并立即生效。下次启动时，命令行参数、环境变量和项目模型设置仍按上述优先级覆盖用户配置。

### 在终端配置模型

运行 `icy` 后输入 `/model`：

1. 选择当前服务、本机 CC Switch 中的 Codex 服务，或手动配置兼容服务。CC Switch 导入使用本机 `sqlite3` 只读读取数据库，不修改 CC Switch。
2. 自动请求该服务的 `/models` 列表，输入名称筛选并选择。服务未提供列表时，可以使用导入的模型名或手动输入。
3. 手动配置依次填写完整 API 地址、API key、接口协议和模型名。密钥输入会遮蔽，绝不沿用其他服务的密钥。
4. 按 Enter 发送一次简短连接测试；通过后保存配置并立即启用。失败或 Esc 取消时，原配置保持有效。

配置写入 `~/.icy/config.json`，密钥单独保存在权限为 `0600` 的凭据文件。切换后开始新会话，原会话保留，避免把旧服务的专用推理状态传给新服务。恢复旧会话时仍需指定匹配的模型、服务和协议。连接测试验证文本响应，不执行工具。离线演示模式不配置在线服务。

## 终端操作

| 操作 | 按键或命令 |
| --- | --- |
| 提交 | Enter |
| 开启新对话，保留原会话 | `/new`；沿用当前模型、工作区及配置，重置对话上下文和工具授权 |
| 查看任务、待办、检查点和验收记录 | `/task` |
| 继续原任务 | `/continue`；显式开启并记录新的运行预算 |
| 指定并执行验收 | `/verify <命令>`；例如 `/verify npm test`，沿用 shell 审批 |
| 添加 / 完成待办 | `/todo <事项>` / `/done <编号>`；编号从 1 开始 |
| 列出 / 恢复会话 | `/sessions` / `/resume <会话 ID>`；恢复后不自动执行 |
| 命令菜单 | 输入 `/`；↑↓ 选择、Enter 执行、Tab 补全、Esc 关闭；继续输入可筛选 |
| 多行内容 | 粘贴多行；支持的终端也可 Alt/Shift+Enter，显示为 `↵` |
| 输入历史 | ↑ / ↓ |
| 编辑光标 | ← / →、Home / End、Ctrl+A / Ctrl+E |
| 清除光标前/后内容 | Ctrl+U / Ctrl+K |
| 展开工具参数、结果和 diff | Ctrl+O |
| 展开 / 收起思考内容 | Ctrl+T 或 `/thinking`；`/thinking expanded` 展开，`/thinking collapsed` 收起 |
| 输出翻页 | PgUp / PgDn |
| 取消本轮 | Esc / Ctrl+C；空闲时 Ctrl+C 退出 |
| shell 批准 | Y 一次；A 本次进程会话允许相同完整命令、cwd 和超时；N 拒绝 |
| 长命令 | PgUp/PgDn 查看完整命令，翻到最后一页后可批准 |
| 帮助 / 模型 / 清空上下文 / 退出 | `/help` / `/model` / `/clear` / `/exit` |

输入框采用单行视窗展示长文本，保留实际多行输入；按 Unicode grapheme（字素簇）编辑中文与 emoji。上限为 20,000 个 grapheme，中文单字、带组合重音的字符、组合 emoji 各计 1 个。键入或粘贴超限时整次拒绝，保留此前草稿和光标，显示提示，不截断内容；修改草稿前 Enter 不会提交。密钥输入的超限提示不会显示输入内容。`NO_COLOR=1 icy` 禁用颜色。

用户消息使用蓝色侧边色块，icy 回复使用青色侧边色块，正文沿用终端前景色和背景色，适配浅色和深色主题。去掉对话外框与整行深色背景，不再用 `you / icy` 前缀区分消息。思考以弱化的单行提示显示，默认收起；没有内容的已完成思考默认隐藏，展开后会说明接口未返回内容。每次模型请求的思考独立显示，可与回答一起翻页查看。

`Ctrl+T` 和 `/thinking` 会将显示偏好保存到 `~/.icy/ui.json`（或 `ICY_HOME/ui.json`），重启后继续使用；该文件的 `thinkingExpanded` 优先于用户配置中的同名默认值。此设置只影响显示，不改变模型推理强度。Responses 默认请求 `reasoning.summary: auto`，显示服务提供的摘要，不解码加密推理；不支持该参数的兼容服务可在 `config.json` 设置 `"reasoningSummary": false`。Chat Completions 兼容服务可通过 `reasoning_content` 或 `reasoning` 字符串返回可见思考内容。实现依据 [OpenAI Docs：Reasoning summaries](https://developers.openai.com/api/docs/guides/reasoning#reasoning-summaries)。

## 任务、会话与验收

一个会话保存对话、工具轨迹和多次运行，当前任务保存原始目标、待办、已完成项及验收记录。每次运行的 `RunState` 单独记录模型与工具调用次数、usage、预算、检查点和停止原因。状态区分执行中、等待批准、已取消、达到限制、失败、已中断、已回答和已验证完成；模型结束回答并不自动表示目标已经验收。

- 新消息开始新任务；`/continue` 延续当前目标和待办，创建一条新的运行记录及预算，关联上次运行。它不会自动重放历史工具调用；遇到 `interrupted_unknown` 应先核对实际状态。
- `/todo <事项>` 添加待办，`/done <编号>` 将对应事项标为已完成。`/task` 展示这些记录、最近检查点、停止原因、预算和最近验收结果。待办完成记录来自用户操作，不由模型自行证明。
- `/verify <命令>` 登记用户明确指定的验收命令，在当前工作区通过 `bash` 执行并记录结果，不请求模型；每次验收有独立运行记录。它沿用授权、超时和输出限制。
- “已验证完成”要求待办为空、至少登记一项验收，且所有已登记命令的最近记录都在当前 Agent 修改版本 `mutationRevision` 上成功。普通工具调用中的测试不会自动变成用户指定验收。新的普通 `write`、`edit` 或 `bash` 调用会使旧证据过期；界面明确标记过期记录。
- 验收命令也可能修改文件，因此执行前后会在本机比较工作区指纹（路径、内容、权限及链接目标）。检测到变化、取消或无法确认时，先使旧证据过期，再记录本次结果。比较不跟随符号链接，只排除当前会话的存储目录；最多检查 10,000 个条目和 64 MiB 内容，超限或读取失败按无法确认处理。对于会写入产物的检查或较大工作区，建议一开始就登记一条包含全部检查的验收命令，避免分次执行时旧证据持续过期。
- 这个状态只证明所登记检查在该修改版本上通过，不是对任意目标的自动语义证明。外部编辑器或其他进程修改文件不会自动更新 Agent 的修改版本，需要重新验收；验收命令本身的覆盖范围也由用户选择。

会话位于 `~/.icy/sessions/<id>/`，包含 v2 快照、事件和长输出。恢复前验证消息结构和调用配对；坏快照保留原件并报告位置，恢复失败释放本次取得的锁。合法但未完成的调用补齐为 `interrupted_unknown` 或 `not_executed`，活动运行标记中断，不重放副作用。若中断时正在执行 `write`、`edit` 或 `bash` 且结果未知，也会使旧验收证据过期。

v1 会话在恢复时迁移到 v2，保留原消息、工具结果和 Responses 专用状态；旧格式没有的任务状态与验收证据保持未知，不补写成成功。旧会话需先提交目标才能使用 `/continue`。恢复界面与在线执行使用同一轨迹投影，可展开工具参数、结果和 diff，保留未知状态与会话变更列表。恢复要求匹配原来的模型、协议、服务地址和工作区；失败保留当前会话。

## 提示词预处理与循环内上下文

每次运行进入主模型循环前，harness 执行需求预处理；循环内每次请求前，`ContextManager` 再组装上下文并检查大小。默认模式为 `local`，保留原始需求，不调用小模型。显式选择 `model` 才会使用当前服务地址、协议和密钥，单独调用小模型提炼达到阈值的新需求；小模型没有工具权限，也不进入工具循环。

在 `~/.icy/config.json` 中可配置：

```json
{
  "promptCompaction": "local",
  "compactionModel": "gpt-5.6-luna",
  "compactionMinChars": 200
}
```

- `local`（默认）：不做语义提炼，仅进行受限的空白清理和历史结果外置；会话始终保留用户原文，代码及明确要求原样保留的输入不做空白清理。`model`：达到阈值的新输入先由小模型提炼，再做本地处理。`off`：关闭需求提炼和工具结果外置，仍执行预算与上下文上限检查。已有显式 `model` 或 `off` 配置保持有效。
- 在 `model` 模式中，输入短于 `compactionMinChars`（默认 200 个 UTF-16 code unit）时跳过小模型，`task` 保留原文，使用空的关键字索引且不带 `original_ref`；设为 0 可对每条新输入提炼。小模型单次请求超时 15 秒、最多输出 2,048 tokens、禁用自动重试。其他兼容服务需要填写其支持的小模型名称；不可用时自动回退。
- 提炼提示要求只删除赘述和重复表达。代码块、行内代码和引号内容先替换成占位符，之后逐字还原；检查占位符顺序、路径、数字和部分明确约束。无效 JSON、检测到的约束缺失、工具调用、不完整输出、超时或服务错误均不采用结果。这些检查不能证明动作、条件、例外和顺序保持完整，因此提炼文本只作为辅助提示。
- 原始输入保存在会话中、在界面原样显示；提炼结果单独保存，恢复和继续运行复用已保存结果，不反复请求小模型。组装模型消息时，若提炼后的 `task` 与原文不同，JSON envelope **同时包含完整 `original`，并以 `original` 为权威要求**；没有 `original` 时，`task` 本身就是原文。原始输出引用也可通过 `read` 回读。
- `task`、`keywords`、`constraints`、`original_ref` 及需要时的 `original` 都序列化在用户消息的 `content` 内。Responses 和 Chat Completions 使用标准消息字段，不添加请求顶层扩展字段，不改变四工具 schema。
- `keywords` 仅索引原文中不再逐字出现在提炼后 `task` 的词项，因此任务原样时索引为空。每个历史用户消息都保留自己的索引，因此整个循环和后续对话仍能看到这些词。
- `constraints` 保留原文约束，并剔除仅来自引号和代码块内部的指令，避免把材料里的指令升级为用户要求。关键字索引只表示词项，不代表新增指令。索引能保护已提取词项的字面值，但不能代替语义校验，必要时仍应读取原文。
- 普通工具循环中出现工具结果后，若存在约束或关键词，每次请求会临时附加有长度上限的 `[icy 提醒]`，重复当前任务的约束与索引。显式续跑使用 `[icy 任务续跑]` 提醒，包含原始目标、待办和核对已保存结果的要求。这些提醒不写入会话。
- 结构化消息、完整原文和小模型请求会增加字符数、token 与延迟。`model` 模式不保证降低总费用；字符变化也不是精确 token 节省。提炼失败仍保留原文，小模型已产生的 usage 计入本次运行预算。
- 每次主模型请求前按 provider 实际序列化的消息、指令和工具定义计算字符量，避免会话同时存储规范化调用与 Responses opaque 时重复计数。达到 `maxContextChars` 的 80% 时，先外置较旧且超过 4,000 字符的工具结果；每轮外置到目标大小就停止，保留其他已读结果；同一循环复用相同内容的引用。
- 若仍超过硬上限，依次外置较旧的中等结果、把连续的较早完整“assistant 响应＋全部工具结果”合并归档为可回读 JSON（不跨越用户消息），最后才将最近的大结果替换为首尾预览与完整引用。归档原文保留全部调用 ID 与结果；活动索引只列出所有未知结果、每个文件的最后修改、最后失败命令和最近三项操作的原始字段，不生成语义摘要；所有用户消息、最近四项观察所在的完整调用批次和最新 assistant 响应留在活动视图；最新批次即使超过四个结果也全部作为最近观察。最近观察在必要时显示有界预览。用户输入预处理不再压缩工具历史，避免与每轮 ContextManager 重复外置。
- 外置只改变发送给模型的视图。源会话和归档保留完整参数、输出及 Responses opaque；活动视图中保留的调用与结果仍一一配对，opaque 原样且按原顺序发送。旧 opaque 随整个历史交换外置，不承诺每次请求都携带全部历史 opaque。写引用失败则回退；仍无法容纳时保存状态并以 `context_limit` 停止。
- NDJSON 和事件日志包含 `harness_start` / `harness_end` 与每轮 `context` 事件，记录需求处理、前后字符数、结果外置与回退情况；UI 显示压缩前后大小或失败提示。离线演示强制使用 `local`。

## 运行核心

用户输入 / 显式继续 → 记录任务与运行预算 → harness 预处理 → 每轮组装上下文并检查预算 → 主模型响应 → 完整收集工具调用 → 参数验证 → 权限检查 → 执行与检查点落盘 → 回传结果 → 下一轮。

- ToolRegistry 负责工具契约、参数校验与输出处理；PermissionPolicy 管理会话内精确授权；ToolExecutor 执行文件和进程操作，并在审批后重新检查 bash 工作目录。
- 默认只向 LLM 提供 `read`、`write`、`edit`、`bash` 四个工具，同一响应中的调用串行执行。旧工具名称不再注册，也没有隐藏别名。
- `read`：按行读取文件，返回 SHA256；也负责读取被截断的工具输出。
- `write`：创建或整体覆盖文件。覆盖现有文件时 `expectedHash` 必须匹配 `read` 返回的哈希；创建新文件时传 `null`。
- `edit`：通过 `path`、`oldText`、`newText` 精确替换文件内容。旧文本必须非空且只匹配一次，空格和换行也必须匹配；新文本可为空。不存在或存在多个匹配时拒绝修改；内部保留写入前版本校验。不是 unified diff。
- `bash`：实际使用 `/bin/bash --noprofile --norc -c`。列目录、查找文件和搜索使用 `ls`、`find`、`rg` / `grep`，测试和其他命令也走该工具。
- 默认允许工作区普通文件修改，`bash` 先确认，包括列目录和搜索命令。`--read-only` 仅提供 `read`，不能列目录或执行搜索命令。
- 错误或拒绝回传模型；同一调用连续失败 3 次停止。默认上限为 20 次模型请求、50 次工具调用。
- 请求超时默认 120 秒，建立请求时 SDK 最多重试 2 次。流中断则停止，未收齐的工具调用不会执行。
- shell 最多 60 秒，超时/取消终止 POSIX 进程组，必要时升级为 SIGKILL。
- 默认每次运行预算为 100,000 tokens，模型消息上下文上限为 120,000 字符；不是整个会话共用的一次预算。显式续跑开启新预算并保留之前的使用记录。
- provider usage 可用时记录其实际报告值，包括所提供的输入、输出、缓存用量；缺失则显示带 `~` 的估算。请求前估算输入并预留响应空间，向两种协议下发输出 token 上限；收到超额响应后标记 `budget_exceeded`，不继续发模型请求或执行其工具调用。预算耗尽或无法预留响应空间时为 `token_budget`。
- 这是**软预算**。输入估算不是精确 tokenizer，服务重试、断流和供应商计费也可能产生不可完整观测的消耗。已经发出的模型请求发生异常或取消时，按已知输入和已收到的部分输出估算记账；预处理消耗同样计入。不能把该预算理解为精确费用封顶。

文件工具拒绝路径越界、符号链接及常见敏感路径。`bash` 的搜索范围与忽略规则由实际命令决定，例如 `rg` 的行为不同于 `find`。

长输出使用 `icy-output:<id>.txt` 引用，由 `read` 读取，不能被 `write` / `edit` 修改。普通文件的 `offset` / `limit` 按行计数；输出引用按 Unicode 字符计数，最多每页 6,000 字符，结果中提供下一页 offset。它不需要额外工具，也能读取很长的单行输出。旧会话可以恢复，但其中历史工具名称不代表当前可调用工具；旧调用不会重放。

## 当前边界

shell 在当前用户的主机上运行，**不是操作系统沙箱**；批准的命令可以访问工作区之外的资源。文件路径与哈希检查不能完全消除外部进程并发修改的竞态。

暂不支持后台命令、交互式 shell stdin、Windows 进程树取消、自动上下文摘要、MCP、多 Agent。文件工具最多读取 1 MB 文本；bash 输出超过 256 KiB 会终止命令。单条结果超过 32 KiB 会显示有界首尾预览，失败命令还会按常见错误行匹配展示一段字面诊断片段；预览不能保证覆盖全部失败，完整输出仍由 `read` 引用回读。

事件和工具输出进行已知 key、常见密钥模式脱敏，清理终端控制字符；不是完整的敏感数据识别系统。模型会接收到任务需要的文件和工具结果。

## 开发与验证

```sh
npm run dev
npm run check          # 源码、测试与 TypeScript 脚本的类型检查
npm test               # 确定性行为测试与 CLI 子进程测试
npm run build
npm run test:package   # 构建后：临时打包安装、空 ICY_HOME、离线 CLI smoke test
npm run eval:prompts   # 默认离线：比较 off/local/model 的需求原文保留与预处理开销
```

自动化测试覆盖四工具循环、两种模型协议请求中的工具列表、旧工具拒绝、精确替换歧义、长输出读取、Bash 语法、协议分片、中断与异常记账、文件冲突、路径边界、授权、预算、循环内结果外置、会话校验和 v1/v2 恢复、任务检查点、验收证据过期、进程取消，以及中文/emoji 输入完整性、工具轨迹恢复和任务命令。CLI 子进程测试检查退出码、信号取消和 NDJSON 分流；包测试在临时目录安装产物并验证 `--help`、`--version` 和离线 `--demo`。

提示词评测夹具包含顺序、条件、例外、否定、验收和引用材料。`npm run eval:prompts` 使用确定性假模型，报告原文是否保留、字面要求遗漏、输入字符数、预处理 token 和耗时；它不测自主任务完成率，也不证明提炼语义等价。需要测试已配置的小模型服务时可运行 `npm run eval:prompts -- --live`，会发送合成夹具并产生模型请求，不发送工作区文件、不执行主机工具。

`npm run eval:tasks -- --live` 使用已配置的主模型，在临时工作区对三个合成编码任务分别运行 `off/local/model`，检查文件结果、验证脚本保留情况和实际测试输出，记录 usage 与耗时。它会调用模型、修改临时文件并授权指定验证命令；每个样例只执行一次，是小规模 smoke 基线，不能据此给出稳定成功率或费用排名。

仓库配置了 Node 22、macOS/Linux 的 GitHub Actions 门禁：锁文件安装、类型检查、测试、构建及包测试。发布前应确认对应提交的远程结果；工作流文件的存在不表示运行已通过，自动化测试也不能替代 Linux 人工交互验收。本轮另行完成的 9 个真实模型合成编码场景、参数、usage 和耗时见[实施记录](docs/implementation-report.md)；它们不能替代跨平台验收或大样本效果评估。

历史真实 Happy Code 验收记录（此前版本，不代表本轮功能已完成在线回归）：在独立临时目录通过 `write` 创建内容为 `before` 的 `note.txt`，用 `read` 读取、`edit` 替换为 `after`，再批准 `bash` 检查文件内容。四个工具全部成功，检查退出码为 0，模型正常完成任务。

代码入口：`src/cli.tsx`；运行循环 `src/core/`；模型协议 `src/providers/`；工具与权限 `src/tools/`；会话 `src/sessions/`；Workbench `src/ui/`。

[架构与迭代计划](docs/iteration-plan.md)记录迭代方向；[原始设计](docs/design.md)与[浏览器选型原型](design/index.html)保留作参考。原型使用模拟数据，真实执行在终端完成。实际功能以本 README 和源码为准。

协议参考：[OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)、[流式响应](https://developers.openai.com/api/docs/guides/streaming-responses)、[Ink](https://github.com/vadimdemedes/ink)。
