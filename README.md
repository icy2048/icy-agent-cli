# icy

一个在终端运行的 AI agent：输入目标，模型自主调用工具、观察结果并继续执行。采用 B · Workbench，左侧对话与工具结果，右侧当前任务与变更；终端小于 120 列时自动切成单栏。

## 开始使用

要求 Node.js 22+。当前已在 macOS 验收；Linux 使用相同 POSIX 实现但尚未在 Linux 主机验收，Windows 暂不支持 shell 工具。

```sh
npm install
npm run build
npm link
icy
```

本机已构建并执行 `npm link`，可以直接输入 `icy`。

```sh
icy "检查这个项目的启动入口"
icy run "读取 README.md 并总结项目" --read-only
icy run "读取 README.md 并检查启动说明" --read-only --json
icy --resume <session-id>
icy --demo                     # 无需模型的离线只读演示
icy --version
```

`--cwd <目录>` 指定工作区，默认是启动目录。`run`、`--plain`、`--json` 或非 TTY 环境使用单次执行。非交互模式遇到未批准的 shell 会停止，退出码为 2；取消为 130，其他运行失败为 1。

## 模型配置

支持 `responses` 和 `chat-completions`。服务地址需包含服务要求的路径前缀，不自动追加 `/v1`。

本机沿用 CC Switch 中 Happy Code / Codex 的配置：

- 地址：`https://happycodeai.com`
- 协议：`responses`
- 模型：`gpt-5.6-sol`
- reasoning effort：`xhigh`

配置在 `~/.icy/config.json`。密钥单独存于 `~/.icy/credentials/happy-code.key`，文件权限 `0600`，没有写入项目。导入的是独立副本；CC Switch 后续修改不会自动同步。

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

输入框采用单行视窗展示长文本，保留实际多行输入；按 Unicode grapheme 编辑中文与 emoji。`NO_COLOR=1 icy` 禁用颜色。

用户消息使用蓝色侧边色块，icy 回复使用青色侧边色块，正文沿用终端前景色和背景色，适配浅色和深色主题。去掉对话外框与整行深色背景，不再用 `you / icy` 前缀区分消息。思考以弱化的单行提示显示，默认收起；没有内容的已完成思考默认隐藏，展开后会说明接口未返回内容。每次模型请求的思考独立显示，可与回答一起翻页查看。

`Ctrl+T` 和 `/thinking` 会将显示偏好保存到 `~/.icy/ui.json`（或 `ICY_HOME/ui.json`），重启后继续使用；该文件的 `thinkingExpanded` 优先于用户配置中的同名默认值。此设置只影响显示，不改变模型推理强度。Responses 默认请求 `reasoning.summary: auto`，显示服务提供的摘要，不解码加密推理；不支持该参数的兼容服务可在 `config.json` 设置 `"reasoningSummary": false`。Chat Completions 兼容服务可通过 `reasoning_content` 或 `reasoning` 字符串返回可见思考内容。实现依据 [OpenAI Docs：Reasoning summaries](https://developers.openai.com/api/docs/guides/reasoning#reasoning-summaries)。

## 提示词预处理

每次用户提交后、主模型自主循环前，harness 执行一次预处理。默认使用当前服务地址、协议和密钥，单独调用 `gpt-5.6-luna` 提炼每条新需求；主模型保持原配置，小模型没有工具权限，也不进入工具循环。代码参考遵循 [OpenAI Docs 的消息角色与提示词设计](https://developers.openai.com/api/docs/guides/prompt-engineering)。

在 `~/.icy/config.json` 中可配置：

```json
{
  "promptCompaction": "model",
  "compactionModel": "gpt-5.6-luna"
}
```

- `model`（默认）：每条新输入先由小模型提炼，再做本地上下文压缩。`local` 只做本地处理，不新增语义提炼请求；`off` 将原始上下文交给主模型。
- 不再按输入长度或压缩比例跳过提炼，“你好”这样的短输入也调用一次小模型；允许任务文本保持原样。旧的 `compactionMinChars` 设置不再生效。小模型单次请求超时 15 秒、最多输出 2,048 tokens、禁用自动重试。其他兼容服务需要填写其支持的小模型名称；不可用时自动回退。
- 提炼只删除赘述和重复表达。代码块、行内代码和引号内容先替换成占位符，之后逐字还原；检查占位符顺序、路径、数字和明确约束。无效 JSON、约束缺失、工具调用、不完整输出、超时或服务错误均不采用结果。语义等价无法由这些规则完全证明，因此始终保留原文与可读取引用。
- 原始输入保存在会话中、在界面原样显示；提炼的 JSON 单独保存，恢复会话和同一次自主循环继续使用，不反复调用小模型。主模型需要核对原文时可通过 `read` 读取 `icy-output:` 引用。
- 组装主模型消息时，将 `task`、`keywords`、`constraints`、`original_ref` 序列化到用户消息的 `content` 中；Responses 和 Chat Completions 均使用标准消息字段，不往服务请求顶层添加不支持的字段，也不改变四工具的 schema。
- `keywords` 合并 LLM 标注的原文词项与本地提取的中文词项、标识符、命令、路径、URL 和数字。所有候选都核对原文来源，不依赖小模型记忆。每个历史用户消息都保留自己的索引，因此整个循环和后续对话仍能看到这些词。
- `constraints` 保留原文约束，并剔除仅来自引号和代码块内部的指令，避免把材料里的指令升级为用户要求。关键字索引只表示词项，不代表新增指令。索引能保护已提取词项的字面值，但不能代替语义校验，必要时仍应读取原文。
- 短输入的结构化消息可能比原文更长；这是为保留关键字而接受的开销，不会伪报为压缩收益。提炼失败时仍组装原文任务与关键字索引。
- 本地层保留最近四条工具结果；更早且超过 4,000 字符的结果替换成完整输出引用，保留调用 ID、顺序、成功/失败状态等信息。不会修改会话原始结果，不会删除 Responses 的推理状态。
- 预处理只执行一次，本次工具循环新产生的结果直接回传主模型。字符统计反映模型消息上下文的长度，不是精确 token 节省；小模型本身有额外延迟和 token 开销，其 usage 计入当前任务预算，不能据此保证总费用降低。
- NDJSON 和事件日志包含 `harness_start` / `harness_end`，记录模式、字符变化、语义提炼结果、小模型 usage。预处理失败回退原上下文；仍超过上下文上限时正常停止，不静默丢弃要求。离线演示强制使用本地模式。

## 运行核心

用户输入 → harness 预处理（每条输入由小模型语义提炼 + 本地历史压缩）→ 主模型响应 → 完整收集工具调用 → 参数验证 → 权限检查 → 执行 → 回传结果 → 再次请求主模型。

- 默认只向 LLM 提供 `read`、`write`、`edit`、`bash` 四个工具，同一响应中的调用串行执行。旧工具名称不再注册，也没有隐藏别名。
- `read`：按行读取文件，返回 SHA256；也负责读取被截断的工具输出。
- `write`：创建或整体覆盖文件。覆盖现有文件时 `expectedHash` 必须匹配 `read` 返回的哈希；创建新文件时传 `null`。
- `edit`：通过 `path`、`oldText`、`newText` 精确替换文件内容。旧文本必须非空且只匹配一次，空格和换行也必须匹配；新文本可为空。不存在或存在多个匹配时拒绝修改；内部保留写入前版本校验。不是 unified diff。
- `bash`：实际使用 `/bin/bash --noprofile --norc -c`。列目录、查找文件和搜索使用 `ls`、`find`、`rg` / `grep`，测试和其他命令也走该工具。
- 默认允许工作区普通文件修改，`bash` 先确认，包括列目录和搜索命令。`--read-only` 仅提供 `read`，不能列目录或执行搜索命令。
- 错误或拒绝回传模型；同一调用连续失败 3 次停止。默认上限为 20 次模型请求、50 次工具调用。
- 请求超时默认 120 秒，建立请求时 SDK 最多重试 2 次。流中断则停止，未收齐的工具调用不会执行。
- shell 最多 60 秒，超时/取消终止 POSIX 进程组，必要时升级为 SIGKILL。
- usage 可用时显示实际 tokens，否则显示带 `~` 的估算值。默认累计预算 100,000 tokens，历史上限 120,000 字符，超限明确停止。
- 会话快照、事件和长输出位于 `~/.icy/sessions/<id>/`。恢复时未知执行结果标记为 `interrupted_unknown`，不自动重放副作用。

文件工具拒绝路径越界、符号链接及常见敏感路径。`bash` 的搜索范围与忽略规则由实际命令决定，例如 `rg` 的行为不同于 `find`。

长输出使用 `icy-output:<id>.txt` 引用，由 `read` 读取，不能被 `write` / `edit` 修改。普通文件的 `offset` / `limit` 按行计数；输出引用按 Unicode 字符计数，最多每页 6,000 字符，结果中提供下一页 offset。它不需要额外工具，也能读取很长的单行输出。旧会话可以恢复，但其中历史工具名称不代表当前可调用工具；旧调用不会重放。

## 当前边界

shell 在当前用户的主机上运行，**不是操作系统沙箱**；批准的命令可以访问工作区之外的资源。文件路径与哈希检查不能完全消除外部进程并发修改的竞态。

暂不支持后台命令、交互式 shell stdin、Windows 进程树取消、自动上下文摘要、MCP、多 Agent。文件工具最多读取 1 MB 文本；bash 输出超过 256 KiB 会终止命令。单条结果超过 32 KiB 会截断并提供 `read` 可读取的输出引用。

事件和工具输出进行已知 key、常见密钥模式脱敏，清理终端控制字符；不是完整的敏感数据识别系统。模型会接收到任务需要的文件和工具结果。

## 开发与验证

```sh
npm run dev
npm run check
npm test
npm run build
```

自动化测试覆盖四工具循环、两种模型协议实际请求中的工具列表、旧工具拒绝、精确替换歧义、长输出读取、Bash 语法、协议分片、响应中断、文件冲突、路径边界、授权、预算、恢复、进程取消、配置权限、中文/emoji 编辑、多行粘贴和双栏/单栏布局。

真实 Happy Code 验收：在独立临时目录通过 `write` 创建内容为 `before` 的 `note.txt`，用 `read` 读取、`edit` 替换为 `after`，再批准 `bash` 检查文件内容。四个工具全部成功，检查退出码为 0，模型正常完成任务。

代码入口：`src/cli.tsx`；运行循环 `src/core/`；模型协议 `src/providers/`；工具与权限 `src/tools/`；会话 `src/sessions/`；Workbench `src/ui/`。

[原始设计](docs/design.md)与[浏览器选型原型](design/index.html)保留作参考。原型使用模拟数据，真实执行在终端完成。

协议参考：[OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)、[流式响应](https://developers.openai.com/api/docs/guides/streaming-responses)、[Ink](https://github.com/vadimdemedes/ink)。
