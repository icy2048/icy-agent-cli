# grok-4.6 整库代码审查（2026-09-29，基线 main 4efd309）

审查为只读独立审查，原文如下；编排方未逐项复现，复现状态见 docs/iteration-plan-6.md。

## 1. Correctness and safety

### 1. High — unsynchronized `session.json` writers drop turns or process state
`SessionStore.save` is a last-rename-wins snapshot of one mutable object. `ProcessManager` has its own `saveQueue`; `Agent` and the process `onChange` handler call `save()` beside it.

```121:128:src/sessions/store.ts
  async save() {
    parseSessionData(this.data, this.data.id);
    this.data.updatedAt = new Date().toISOString();
    const temp = path.join(this.dir, `session-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, this.sanitize(JSON.stringify(this.data)), { mode: 0o600, flag: 'wx' });
      await rename(temp, path.join(this.dir, 'session.json'));
```

```95:98:src/tools/processes.ts
  private queueSave() {
    this.saveQueue = this.saveQueue.catch(() => {}).then(() => this.store.save());
    return this.saveQueue;
  }
```

```24:33:src/core/agent.ts
  private bindProcessEvents(owner: SessionStore) {
    owner.getProcessManager(async record => {
      if (owner.data.task && record.status !== 'spawn_error') {
        markMutation(owner.data);
        await owner.save();
      }
```

**Failing scenario:** Approve `detach: true` `sleep 0` (or any short command). The child exits while the agent is in the next `history.push` + `store.save()` after the following model turn. Process persist stringifies first (old messages, new process status); agent save stringifies later (new assistant message). If the process rename finishes last, disk keeps the process update and loses the assistant/tool batch. Crash then: valid schema, missing turn, `/ps` shows a process with no matching call. This gets worse with MCP or a second agent writing the same snapshot.

### 2. High — detached spawn is not durable until after identity capture
```379:387:src/tools/processes.ts
    const remaining = Math.max(0, input.timeoutMs - (Date.now() - Date.parse(record.startedAt)));
    active.timeout = setTimeout(() => { void this.terminate(active, 'timeout', false).catch(() => {}); }, remaining);
    record.identity = await this.captureIdentity(child.pid);
    if (active.settled) return record;
    await this.persist(record, true, clone(record));
```

`executeTool` has already checkpointed `running = call.id` (`src/core/agent.ts:95–96`). Identity capture can take up to 3s (`src/tools/processes.ts:221–226`).

**Failing scenario:** `bash` with `detach: true` spawns, then icy is killed during `ps`/`CreationDate`. Disk has an unmatched call (`interrupted_unknown` on resume) and **no** process row. POSIX `detached: true` (`src/tools/bash.ts:61`) leaves an orphan child. Resume cannot `/kill` it. `SessionStore.resume` only recovers records that made it into `processes` (`src/sessions/store.ts:78`).

### 3. High — Windows new-file create can overwrite a concurrent create
```67:78:src/tools/executor.ts
        const fallback = async () => {
          // rename() can replace a target on some platforms, so check again immediately before it.
          try { await this.stat(target); throw new Error('file_changed'); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              if (error instanceof Error && error.message === 'file_changed') throw error;
              throw new Error('file_changed');
            }
          }
          await this.rename(temp, target);
        };
        if (this.platform === 'win32') await fallback();
```

POSIX `link(temp, target)` fails if the name exists. Windows skips `link` and uses `rename`, which replaces. The `stat`/`rename` gap is a TOCTOU.

**Failing scenario:** Two writers create `app.ts` with `expectedHash: null` (agent vs editor, or two overlapping runs). On Windows the later rename silently replaces the other file. The comment at line 89 (“no overwrite…”) is false on this path. `tests/windows-paths.test.ts:58` exercises the **darwin** + mocked-`link` fallback, not `platform: 'win32'`.

### 4. High — file-tool symlink checks do not hold against a live detached process
`workspacePath` `lstat`s components then returns (`src/tools/paths.ts:73–81`). `read` then `stat`/`readFile`, which follow links (`src/tools/executor.ts:41–47`). Directory walk `lstat`s, then later `readdir`s/`readFile`s the same path (`src/tools/explore.ts:46–61`, `218–232`).

**Failing scenario:** User has already approved a detached script that, after a delay, does `rm -rf src/inner && ln -s ~/.ssh src/inner`. A later `read`/`search` on `.` `lstat`s `inner` as a directory, then follows the planted link and returns private files that `sensitive()` / `symlink_not_allowed` would have blocked as a search root. Same window on `write`: last `workspacePath` succeeds, parent is swapped, `rename` writes through the link. This is not an “external editor” footnote; detached bash is a first-class concurrent mutator in the same session.

### 5. Medium — Chat Completions always sends `max_completion_tokens`; Responses always `include: ['reasoning.encrypted_content']`
```68:68:src/providers/model.ts
    return { model: this.config.model, messages: input, ...(maxOutputTokens !== undefined ? { max_completion_tokens: maxOutputTokens } : {}), ...
```

```104:104:src/providers/model.ts
    return { model: this.config.model, instructions: this.options.instructions ?? instructions, input, ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}), tools: tools.map(t => ({ type: 'function', ...t, strict: true })), stream: true, store: false, include: ['reasoning.encrypted_content'], ...
```

Agent always passes a request budget (`src/core/agent.ts:200–207`), so every Chat request carries `max_completion_tokens`. Compatible stacks that only implement `max_tokens` (older vLLM / llama.cpp OpenAI shims) fail the whole run. `reasoningSummary: false` still requests encrypted reasoning content; a local Responses-compatible server that rejects `include` fails every turn, including `/model` probe.

### 6. Medium — Chat tool-call name is concatenated; Responses last terminal event wins
```83:89:src/providers/model.ts
      for (const delta of choice.delta.tool_calls ?? []) {
        const call = calls.get(delta.index) ?? { id: '', name: '', arguments: '' };
        if (delta.id) call.id = delta.id;
        if (delta.function?.name) call.name += delta.function.name;
```

```119:131:src/providers/model.ts
      if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') {
        ...
        response = { text, reasoning: summary || reasoning, calls: r.output.filter(o => o.type === 'function_call').map(...), opaque: r.output, ...};
      }
```

**Name:** Providers that repeat the full function name on later deltas produce `readread` → `unknown_tool`. Tests only send the name once (`tests/providers.test.ts:33–35`).

**Terminal events:** `response.failed` then `response.completed` on the same stream overwrites `incomplete` and returns `function_call`s. Agent will execute them (`src/core/agent.ts:211–223`). The regression test only puts `status: 'completed'` on a **failed event type**, not two events (`tests/providers.test.ts:80–88`).

### 7. Medium — resume classification is sound; live `/clear` and in-process `/resume` are not
`SessionStore.resume` + `interruptActiveRun` close unmatched calls as `interrupted_unknown` iff `running === call.id`, else `not_executed`, and do not replay (`src/sessions/store.ts:80–88`, `src/core/run-state.ts:154–161`). Live `closePending` prefers a known in-memory result over relabeling (`src/core/agent.ts:118–144`). That path is in good shape.

Gaps:

- `/clear` wipes messages/task/runs and leaves `processes` running (`src/core/agent.ts:286–289`). **Scenario:** detached `npm test`; `/clear`; `/ps` still shows the job writing into the same session dir; there is no task, so later `onChange` `markMutation` throws (`requireTask`) and is swallowed in `persist` (`src/tools/processes.ts:101–102`).
- `ToolRegistry.forSession` builds a new `PermissionPolicy` (`src/tools/registry.ts:20`). In-process `/resume` drops “A” grants for the rest of this process, despite README “本次进程会话”.

### 8. Medium — compaction pairing is preserved; opaque is dropped from the wire by design; errors are swallowed
Archive only commits a complete consecutive assistant+tool batch (`src/core/context.ts:112–126`, `172–173`). Tests check call/result IDs and byte-for-byte archive restore (`tests/context.test.ts:153–183`).

Costs:

- Archived assistants are replaced with `calls: []` and **no** `opaque`. Responses encrypted items leave the live request (documented, but any “automatic summary” that is not a full archive restore will desync `call_id` / `function_call_output`).
- The `catch` at `src/core/context.ts:198–200` treats disk errors, `measure()` bugs, and unexpected exceptions as “use uncompressed history”. A logic bug in `completeEnd` can look like a successful fallback until `context_limit`.
- `measure()` is invoked on every externalize/archive step → quadratic JSON of the whole request. A 180-read fixture already exists (`tests/context.test.ts:212`). Automatic summaries on top of this will dominate turn latency.

### 9. Medium — budget/timeout accounting is consistent and soft; incomplete calls are not executed
Timeout/cancel charges estimated input + partial text (`src/core/agent.ts:240–243`, `src/core/budget.ts:45–51`). `budget_exceeded` closes remaining calls as `not_executed` (`src/core/agent.ts:217`). Provider deadline spans the stream (`src/providers/model.ts:47–50`). Missing coverage: cached vs total double-count is whatever the vendor sends; there is no test that process-exit `save` and `accounting()` cannot clobber each other (finding 1).

### 10. Lower — path policy holes that tests do not fuzz
- `sensitive()` is case-insensitive; explore `IGNORED_NAMES` is not (`src/tools/explore.ts:23`, `32–34`). On Windows, `Node_Modules` / `DIST` are walked and searched.
- `.envrc`, `id_ecdsa`, `id_rsa.pub` are not blocked; `id_rsa` is. Example-based tests only (`tests/runtime.test.ts:104–114`).
- Explore hides `dist/` and `node_modules/` from a coding agent working in a JS repo (`src/tools/explore.ts:23`).

---

## 2. Architecture vs iteration-plan §4

Target: `Agent` = one run; `ContextManager` = model view; `RunState/Budget` = persistence; `SessionStore` = schema/lock/checkpoint; `ToolRegistry / PermissionPolicy / Executor` split; App = display/input.

| Module | Lines | Drift |
|---|---|---|
| `ProcessManager` | 572 | Not in §4. Owns spawn, logs, Windows kill, identity, watchdogs, **and** snapshot writes. |
| `App.tsx` | 308 | Command router, approvals, SIGINT, model apply, process `/ps`/`/kill`, layout. `setListener` / `approval.current` run during render (`src/ui/App.tsx:112–119`). |
| `Agent` | 291 | Run loop **plus** session switch, process event binding, workspace fingerprint, verification, grant listener. |
| `ToolExecutor` | 174 | Files, explore, process poll/kill/start. |
| `PermissionPolicy` | 45 | Hard-coded `bash` / `kill` special cases (`src/tools/permissions.ts:19–27`). |

**Duplication:** kill-prefix parsing in `Agent.killProcess` (`src/core/agent.ts:60–67`) and `ProcessManager.resolveKillReference` (`src/tools/processes.ts:483–489`). Identity/liveness option aliases (`captureIdentity` / `identityCapture` / `identity`, four liveness names) in `src/tools/processes.ts:84–85`.

**Hidden coupling:** `SessionStore` constructs `ProcessManager`; `ProcessManager` mutates `store.data.processes` and calls `store.save`; `Agent.bindProcessEvents` registers `onChange` that `markMutation` + `save` + `event` + UI emit. `resume` calls `getProcessManager().recover()` **before** the UI listener exists (`src/sessions/store.ts:78` vs `src/core/agent.ts:55`).

**State copies:** `store.data` (truth), `Agent.busy` / `executing` / `startedCalls` / `endedCalls` (in-memory, empty after resume), `ProcessManager.active` / `waiters` / `watchdogs`, React `taskState`/`runState`/`entries` cloned from events. A lost snapshot write (finding 1) desyncs all four.

**What this blocks**

- **MCP:** `schemas` is a closed object (`src/tools/definitions.ts:9–25`); policy is bash-only; executor `switch` is four cases.
- **Multi-agent:** one `busy` flag, one store, one process manager, App bound to a single `Agent`.
- **Background orchestration:** `cli.tsx` `finally` always `close()` → `closeAll('session_closed')` (`src/cli.tsx:139–148`). Non-interactive `icy run` cannot leave a job alive. No per-job budget or task graph.
- **Automatic context summaries:** `ContextManager` is a mechanical archive, not a summarizer; `semantic.ts` is user-prompt-only. Adding a summary model without a single writer and a stable opaque/call pairing API will corrupt Responses history.

**Refactors, in order**

1. **Store-level write mutex; process `onChange` must not call `save()`.** One queue on `SessionStore.save`, re-entrant or batched patches (`markMutation` included in the process persist). **Risk: low** if all writers go through it; **deadlock risk** if `save` → `onChange` → `save` is left in place.
2. **Persist the process row immediately after spawn; keep logs/status as patches, not full snapshot rewrites.** Optionally a `processes.json` / journal. **Risk: medium** (resume/schema). Required before background jobs.
3. **Split `App.tsx`:** command router (testable without Ink) vs view; `setListener` in `useEffect`. **Risk: medium** (Ink input/approval regressions). Required before a second transcript.
4. **Generalize `ToolRegistry` + `PermissionPolicy` to a list of independently authorized tools** (name, schema, risk class, executor). Kill/read-process become tools or policy verbs, not bash smuggled args. **Risk: medium** (approval key format, NDJSON). Required for MCP.
5. **Provider capability flags** (`max_tokens` vs `max_completion_tokens`, optional `include`, optional `strict`). **Risk: low–medium.** Required before more hosts, not before MCP UI.

Do not start MCP by stuffing more `case`s into `ToolExecutor` or more branches into `Agent.run`.

---

## 3. Test suite health

Runtime is dominated by **sleeps and UI polling**, not 344 equal units.

| Drag | Where | Why |
|---|---|---|
| ~5.8s + 2s + 3.5s wall | `tests/processes.test.ts:303`, `:327`, `:341` | Watchdog retry and identity-timeout real clocks |
| 35–40ms × up to 100 | `tests/ui.test.ts`, `ui-task.test.ts`, `ui-processes.test.ts`, `composer-limits.test.ts` | `tick()` until frame matches |
| 15s kill ceiling | `tests/cli.test.ts:57`, `cli-resume.test.ts:54` | Child CLI + HTTP |
| 1200-file listing | `tests/explore.test.ts:54–65` | Disk-heavy, not a logic unit |

**Timing-dependent:** process drain `setImmediate` loop (`src/tools/processes.ts:196–201`) covered by `tests/processes.test.ts:111`; watchdog tests will flake under load.

**Implementation-detail asserts:** `tests/processes.test.ts:300–308` and `:325–326` cast `watchdogs: Map` and `timer.hasRef()`. Refactor 1–2 will churn these.

**Missing property/fuzz:** path escape, junction/ADS, case folding, `expectedHash: null` create race, edit uniqueness (Unicode / overlapping `indexOf`). Current edit tests are four literals (`tests/runtime.test.ts:120–140`).

**Windows:** live process-group tests are skipped as a block (`tests/processes.test.ts:19–20`, `{ skip: !posix && skipWindows }` on the interesting ProcessManager cases). Remaining Windows skips: SIGINT CLI (`cli.test.ts:124`), `0o600` (`models.test.ts:38`), POSIX mode fingerprint (`workspace-fingerprint.test.ts:41`). File-symlink tests use `makeSymlink` junctions; they never run the win32 create-overwrite path.

`npm test` at ~25s is plausible: a handful of `processes.test.ts` sleeps plus Ink waits, then a large fast unit set.

---

## 4. Dependency and build hygiene

```8:13:package.json
  "files": [
    "dist",
    "README.md",
    "docs"
  ],
```

`docs/evaluations/` is ~7.0 MB (51 files). `npm pack` ships live-task dumps with the CLI.

- `skipLibCheck: true` (`tsconfig.json:6`); no eslint/prettier.
- `typescript` 7.0.2 and `@types/node` 26.6.2 with `engines.node: >=22` — types can name APIs Node 22 does not have.
- Scripts: `test` glob is quoted (Windows-safe); `check` includes tests/scripts; `prepack` builds. Fine.
- CI (`.github/workflows/ci.yml`): SHA-pinned checkout/setup-node, lockfile `npm ci`, matrix ubuntu/mac/windows, `fail-fast: false`, 15 min. No `npm audit`, no coverage. Windows skips `test:pty` for `--demo --plain` + `--version`. `on: push` with no path filter (eval JSON noise will burn the matrix).

---

## (a) Five defects to fix first

1. **Store-level serialized `save()`** — stop Agent / ProcessManager / `onChange` from last-rename-winning `session.json` (`src/sessions/store.ts:121`, `src/tools/processes.ts:95`, `src/core/agent.ts:25–29`).
2. **Persist the process record immediately after spawn**, before identity capture (`src/tools/processes.ts:379–387`).
3. **Windows new-file create must not replace** (`src/tools/executor.ts:78`); test `platform: 'win32'`, not only darwin+mock `link`.
4. **Re-check with `lstat`/`O_NOFOLLOW` at open and before directory descent** so a detached plant cannot make `read`/`search`/`write` follow a new symlink (`src/tools/executor.ts:41–47`, `src/tools/explore.ts:218–232`).
5. **Protocol knobs:** omit `reasoning.encrypted_content` unless configured; send `max_tokens` (or both) on Chat Completions (`src/providers/model.ts:68`, `:104`).

## (b) Three refactors before MCP / multi-agent

1. **Single session writer** (mutex + process patches; `onChange` is notify-only).
2. **Pluggable tool/policy table** replacing the four-way `switch` and bash-shaped `kill`.
3. **Peel session/process binding out of `Agent` and command routing out of `App.tsx`** so a second agent or MCP server is not a new `busy` flag inside the Ink tree.

## (c) Verdict

The four-tool single-agent loop (pairing, resume-without-replay, soft budgets, mechanical compaction) is internally consistent and well tested for the serial happy path. It is **not** ready for MCP, multi-agent, or background orchestration: two writers already race on one snapshot, detached work is not durable across the spawn window, file-tool boundaries do not survive the product’s own detached processes, and the tool/permission/UI surfaces are closed special cases. Adding MCP or a second agent on top of this will multiply finding 1 and freeze `App.tsx` / `ToolExecutor` into the wrong shape. Do the writer split and the tool table first; treat automatic summaries as a new `ContextManager` backend behind the existing pairing invariants, not a second history rewriter.
