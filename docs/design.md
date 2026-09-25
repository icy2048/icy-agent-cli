# icy CLI · v0.1 设计提案

状态：已选择 B · Workbench，v0.1 已实现并在本机安装 `icy` 命令。以下保留初始设计提案，实际功能、配置及已知边界以 [README](../README.md) 为准。浏览器选型原型仍使用模拟数据。

## 1. 第一版要做到什么

在任意项目目录输入 `icy`，描述一个目标。Agent 自己决定下一步：读取文件、搜索内容、修改文件、执行命令，观察结果后继续，直到给出结论、需要用户补充信息或达到运行限制。

第一版是单 Agent、单活动任务、多轮工具调用。具备流式文字、工具状态、权限确认、取消运行和本地会话恢复。暂不做多 Agent、MCP、浏览器自动化、向量知识库、后台任务或插件市场。

建议先以 macOS / Linux 为验收平台；Windows 后续单独处理终端和子进程树取消的差异。

## 2. 技术与分层

采用 TypeScript + Node.js，React + Ink 绘制终端界面。Node 版本选择实际安装时仍受支持、且满足锁定依赖要求的 LTS。依赖在实现时锁定，不使用浮动版本作为验收基线。

Ink 提供 React 终端布局和键盘输入能力，适合复用组件与状态驱动渲染，见 [Ink 官方仓库](https://github.com/vadimdemedes/ink)。浏览器原型只用于选型，真正的 CLI 使用字符布局，不依赖浏览器。

```text
icy 命令入口
  ├─ Config / 工作目录 / 会话加载
  ├─ Terminal UI 或非交互输出
  │     ↑ AgentEvent             ↓ 用户输入 / 取消 / 权限决策
  └─ AgentRuntime
        ├─ ContextBuilder / 上下文与预算
        ├─ ModelAdapter / 流式响应与协议归一化
        ├─ ToolRegistry / 工具定义、参数验证
        ├─ PermissionPolicy / 操作授权
        ├─ ToolExecutor / 超时、输出限制、取消
        └─ SessionStore / 消息、工具结果、运行事件
```

核心不依赖 React、终端尺寸或颜色。UI 订阅事件，命令行批处理和测试直接调用同一个 Runtime。

建议目录：

```text
src/
  cli.ts                    # 参数解析与启动
  core/{agent,context,events,types}.ts
  providers/{types,responses,chat-completions}.ts
  tools/{registry,paths,bash}.ts # registry 仅向 LLM 注册 read/write/edit/bash
  permissions/policy.ts
  sessions/store.ts
  config/load.ts
  ui/{App,Transcript,ToolCall,Approval,Composer,StatusBar}.tsx
tests/
  agent-loop.test.ts
  permissions.test.ts
  tool-execution.test.ts
  session-recovery.test.ts
```

## 3. 核心循环：模型决定动作，Runtime 控制执行

```text
用户目标 → 构造上下文 → 请求模型
                        ├─ 工具调用 → 校验 → 授权 → 执行 → 保存并回传结果 ─┐
                        │                                               │
                        └─ 本轮完成 → 最终答复                            │
                             ↑                     再次请求模型 ←────────┘
```

这是原生 function calling 循环，不靠正则从模型的普通文字中提取命令。模型可以连续提出多轮工具调用。工具调用由应用执行，再把结果交回模型；协议依据 [OpenAI 官方 function calling 文档](https://developers.openai.com/api/docs/guides/function-calling)。

伪代码（表达执行顺序，非现成实现）：

```ts
appendUserMessage(input);
for (let turn = 0; turn < limits.maxModelTurns; turn++) {
  checkAbortAndBudget();
  const response = await provider.complete(context, tools, signal);
  appendProviderResponse(response); // 含完整工具调用及 provider 必需的不透明状态
  if (response.incomplete) return stopWithReason(response.reason);
  if (!response.toolCalls.length) {
    return response.text ? finish(response.text) : stopWithReason('empty_response');
  }
  for (const call of response.toolCalls) {
    checkAbortAndBudget();
    const result = await validateAuthorizeAndExecute(call, signal);
    appendToolResult(call.id, result); // 成功、拒绝、超时、异常都形成可匹配结果
  }
}
return stopWithReason('max_model_turns');
```

执行细则：

- 流式文字可以立即显示；工具名、调用 ID、参数必须收集完整并通过校验后才执行。
- 第一版工具按模型返回顺序串行执行，防止读取与写入竞争；不做未经依赖分析的并行。
- 同一响应里混有说明文字和工具调用时，先完成全部调用结果回传，不能因为出现文字就结束。
- UI 展示简短行动说明、正在请求模型的状态和工具事实，不要求模型公开内部推理。
- 未知工具、非法 JSON、参数缺失、文件不存在、命令失败等以结构化错误返回，模型有机会修正。
- 相同工具、参数与错误连续出现 3 次时停止并说明；正常工具输出不足以证明任务完成时，模型需要自行验证。
- 初始限制提议：最多 20 次模型请求、50 次工具执行、单次 shell 60 秒；可由用户配置。达到限制就结束本次运行，不静默重启。
- token 总预算与上下文上限分开控制；预算按 provider usage 累计，缺失则标记估算。达到上限或无法安全容纳完整调用链时明确停止，第一版不静默丢弃消息或自动摘要。
- 网络超时、429、5xx 最多重试 2 次并退避；中途断流丢弃未完成响应。401 / 403 / 参数错误直接给出可操作信息。工具副作用不随模型请求重试而重复执行。

## 4. 模型适配层

统一接口收发 messages、tool definitions、text delta、tool call、usage、finish reason；provider 的专有续接数据按不透明字段保存，避免丢失推理项或调用关联。

第一阶段先贯通一个 Responses API adapter；随后增加经过兼容测试的 Chat Completions adapter，方便连接支持 tools 的兼容服务。provider、baseUrl 和 model 显式配置，不假定所有模型都支持相同协议。模型名称不写死。

```json
{
  "provider": "responses",
  "baseUrl": "https://api.openai.com/v1",
  "model": "<用户配置的支持工具调用的模型>",
  "apiKeyEnv": "ICY_API_KEY",
  "permissions": "workspace-edit",
  "maxModelTurns": 20,
  "maxToolCalls": 50
}
```

用户级配置保存在 `~/.icy/config.json`。项目级 `./.icy/config.json` 只覆盖展示、模型选择和运行限制等允许字段；不能覆盖 API key 来源、服务地址或放宽权限。项目提供的规则文本需要区分来源，只作为低于用户与系统约束的项目上下文。

API key 从环境变量读取，不写进项目、会话、命令历史或日志。启动时验证配置并显示实际 provider、model、服务主机和工作目录；不要自动扫描其他应用的凭据。

## 5. 第一版工具

| 工具 | 参数与结果 | 执行约束 |
| --- | --- | --- |
| `read` | path、offset、limit → 文本与 SHA256 | 文件按行分页；输出引用按字符分页；二进制与大小检查 |
| `write` | path、content、expectedHash → 新文件或更新结果 | 已存在文件需要匹配版本；返回 diff；临时文件原子替换 |
| `edit` | path、oldText、newText → 精确替换结果与 diff | 旧文本必须唯一匹配；保留写入前哈希校验 |
| `bash` | command、cwd、timeoutMs → stdout/stderr/exitCode | Bash 执行；先授权；有限输出；关闭 stdin；进程树取消 |

按用户选择收敛为四个工具。列目录与搜索通过 `bash` 执行，长输出通过 `read` 的 `icy-output:` 引用读取，不另外注册工具。`--read-only` 只提供 `read`。

所有工具统一返回 `{ok, content, error?, truncated?, durationMs}`，错误包含稳定 code。执行前生成 `toolCallId` 关联记录，执行后原子记录结果。

默认单条输出最多 32 KiB；较长内容落入会话文件并向模型返回明确截断标记和可分页读取的引用，不能悄悄删去失败信息。shell 输出中的 ANSI 控制字符需清理，防止终端控制序列影响 UI。

## 6. 自主执行与权限

默认 `workspace-edit`：文件读取及普通文件改动自动进行，文件改动保留 diff。搜索、列目录与其他命令统一通过 `bash`，默认先确认实际 command、cwd 和超时。用户可把**某条完整命令、cwd 和超时**授权到本次会话，避免重复批准，不以 `npm` / `python` 等宽泛前缀判断安全。

额外 `read-only` 模式只开放读取工具。第一版不提供无需边界的全自动 shell 模式。用户拒绝某工具时，将拒绝结果回传模型，让它尝试其他办法或结束；不要反复弹出同一请求。

这是应用权限策略，不是操作系统沙箱。shell 中的脚本和依赖可访问当前用户可访问的主机资源；工作目录约束不能限制 shell 的全部副作用。原型中的确认用于展示这项真实设计限制。

文件工具使用规范化绝对路径与 realpath 检查，拦截 `..`、符号链接越界和敏感路径；新文件校验最近存在父目录。第一版拒绝写入路径中的符号链接；真实使用中重新校验仍有外部并发改动风险，后续需要隔离执行来提供更强保证。默认屏蔽 `.env*`、私钥、凭据目录，并允许安全示例文件；模型无法自行提升授权。

工具结果和仓库文字都是不可信数据，不能修改执行权限或覆盖用户目标。发送到模型的上下文仅包含任务需要的数据；文件内容与命令输出可能含敏感信息，做常见密钥模式脱敏但不宣称完整 DLP。

## 7. 终端交互

目标命令（这些命令在本次方案阶段尚未实现）：

```sh
icy                          # 当前目录开始交互
icy "检查这个项目的启动入口"    # 初始任务后留在交互界面
icy run "总结这个项目"         # 单次非交互运行
icy run "总结这个项目" --json  # stdout 为 NDJSON 事件，stderr 为诊断
icy --resume <session-id>     # 恢复消息与工作目录
icy --help
icy --version
```

通过 package.json 的 `bin: {"icy": "dist/cli.js"}` 和可执行文件 shebang 提供入口。开发时构建后 `npm link`，发布后 npm 全局安装；npm 包名称可另选，终端命令保持 `icy`。

交互支持 `/help`、`/model`、`/clear`、`/exit`。Enter 提交，粘贴多行视作同一输入，支持输入历史。运行时 Esc 或 Ctrl+C 取消本轮并中止模型网络请求、终止 shell 进程树；空闲时 Ctrl+C 退出并恢复终端光标与 raw mode。

状态栏显示 cwd、model、权限模式、当前步骤与实际 token 用量；provider 未提供用量则显示未知。读取文件、修改文件、等待批准、运行失败等有文字状态，颜色仅辅助。

非 TTY 自动使用普通文本；禁用动画和确认弹窗，未预授权的操作返回 `approval_required`，退出码区分成功、失败、被取消。`NO_COLOR`、窄窗口、中文宽字符必须验收。

## 8. 三个 UI 方向

三个方案使用同一个示例：为 CLI 增加 `--version`，读取入口、应用修改、确认执行测试、回传测试结果。浏览器里的运行耗时与输出均为模拟。

| 方向 | 布局 | 好处与代价 |
| --- | --- | --- |
| A · Stream / 极简对话 | 一列连续输出，工具内联折叠 | 原生终端感，复制与滚屏自然，第一版最省实现成本；长任务状态需要向上查找 |
| B · Workbench / 双栏工作台 | 左侧对话，右侧当前任务与变更 | 长任务更容易观察，建议方向；需要额外处理终端宽度、焦点和重绘 |
| C · Trace / 执行轨迹 | 步骤列表与紧凑事件流，详细结果折叠 | 调试工具链清晰；日常对话比 A 更有日志感 |

推荐 B，终端小于 110 列时退化成 A 的单栏结构。右栏只放当前任务、当前工具和变更文件，不长期占位展示无关指标。浏览器中的圆角、按钮点击与像素间距只是选型辅助；终端落地使用字符边框、键盘选择与字符宽度。

## 9. 会话与恢复

`~/.icy/sessions/<id>/` 存放元数据、messages、NDJSON 事件和截断输出，用户目录限制访问权限。元数据记录 cwd、schema 版本、provider 和 model，不含 key。

工具从 pending → running → succeeded / failed / cancelled 逐步落盘。恢复时已完成结果可继续提供给模型；崩溃时处于 running 的副作用工具标记 `interrupted_unknown`，要求用户核对，不自动重放。恢复失败/半行 NDJSON 时保留损坏记录并明确提示，不伪造工具成功。

## 10. 实施顺序与完成标准

1. **可启动骨架**：bin、配置、普通文本 REPL、provider adapter。验收安装后 `icy --help` 与输入对话。
2. **自主循环**：工具注册、完整调用回传、文件工具和 shell、运行限制。验收真实完成“读 → 改 → 执行验证 → 总结”的多轮闭环。
3. **运行控制**：权限决策、取消、超时、流中断、会话落盘与恢复。验收拒绝能回传模型，取消不会残留子进程，恢复不重复执行写入。
4. **选定 UI**：流式文字、工具详情、diff、确认、尺寸变化、普通文本降级。验收 80/120 列、中文输入和多行粘贴。

先用确定性假模型覆盖多轮循环、工具 ID 对应、非法参数、重复错误、预算退出、未知执行结果恢复；再用一次明确配置的真实模型做临时工作目录端到端验收。文件边界、权限、取消及重复执行必须有行为测试，UI 使用交互 smoke test。

本次原型仅验收视觉与本地交互；真实模型、工具权限、终端输入、CLI 安装均留待实施阶段验证。
