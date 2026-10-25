# claude-codex-delegate

v0.15.0：默认开启低成本 Codex 巡检，健康时不唤醒 lead；`task_result` 支持最长 86400 秒等待及每 15 秒进度心跳。详见 [巡检与长等待](docs/patrol.md)。

v0.11.0 支持每次委派选择模型供应商：`delegate` / `delegate_async` 新增 `provider` 参数，也支持从 cc-switch 导入官方 ChatGPT 登录账户。登录账户使用独立 Codex 主目录，可选 token 同步（导入时默认开启）；关闭同步后，refresh token 轮换可能使其他副本失效并退出登录。详见[配置与后端 API](docs/providers.md)。本次未修改仪表盘界面。

[简体中文](README.md) | [English](README.en.md)

让 Claude 把实现工作交给 OpenAI Codex 模型：GPT-6 Sol、Astra、Luna，GPT-5.6 Sol、Terra、Luna，以及你的 Codex 账号当前提供的其他模型。Claude 仍然负责统筹：规划任务、编写交接说明、检查改动并运行测试。

```text
你 ▸ 让 sol 6 实现 CSV 导出，你来审查

Claude ▸ delegate(model: "sol 6", prompt: "<完整、独立的任务说明>")
        ↳ gpt-6-sol 修改 src/export.ts，运行测试……
Claude ▸ 查看精简报告和主机测试结果，抽查差异并汇报
```

这是 [claude-opencode-delegate](https://github.com/aashahin/claude-opencode-delegate) 的姊妹项目，使用相同的工具和工作流，底层执行器是 Codex CLI，而不是 OpenCode。

提交分工：Codex 完成修改、自测和报告，保留未提交的改动。Claude 验收改动并确认主机检查通过后，在用户要求提交时执行提交；推送同样需要用户授权。用户原始需求中的提交步骤由 Claude 保留，不写入委派简报或后续指令。

它可用于：

- **Claude Code**（命令行、IDE 和 Claude 桌面版的 Code 标签页）：可以直接提出任务，也可以使用 `/codex`、`codex-worker` 子代理或动态工作流。
- **Claude Desktop 聊天**：作为普通 MCP 服务器使用（请阅读下方的注意事项）。

此分支（`codex-delegate-plus`）在上游基础上增加了：

- Windows 无 shell 支持：通过 Node 启动 npm 安装的 Codex `codex.js`，并通过标准输入传递任务说明。
- 精简的编排结果：只返回 Codex 的最终消息，并整理成 JSON 报告（`done`、`partial`、`blocked`、`needs_decision`、摘要、验证结果、风险和问题）；完整事件日志保存在 `~/.codex-delegate/runs/`。
- `checks`：Codex 完成后由主机执行的命令，以 PASS/FAIL 和失败输出尾部的形式返回。
- 按文件统计 `+/-` 行数：使用内容哈希计算，因此也能识别任务开始前已经有改动的文件。
- 委派任务默认使用 `high` 推理强度（只读任务使用 `medium`），不依赖交互式会话的默认值。
- 取消、超时或进程退出时终止整个子进程树；同一目录一次只允许一个写入任务；异步结果会持久化到磁盘。
- 停止后可重定向任务：停止委派并修改要求后，同一目录里的下一次 `delegate` 会在原 Codex 会话上继续，保留上下文和已有的部分改动。使用 `fresh: true` 可改为全新会话。记录保存在 `<runs dir>/pending/`。
- 实时运行观测：仪表板显示近 14 天活动、Codex 运行时间线、进度和健康状态（`active`、`quiet`、`stalled`、`orphaned`）。
- 默认开启 [Codex 巡检](docs/patrol.md)：健康巡检不唤醒 Claude；偏离、卡住、不确定或巡检失败会唤醒，worker 继续运行；同一执行项第三次连续疑似卡住必定唤醒。`patrol: false` 恢复直接 `suspected_stall` 唤醒，主机检查机制不变。

## 工作原理

```text
Claude Code / Claude Desktop / 子代理 / 工作流
        │  MCP（stdio）
        ▼
codex-delegate MCP 服务器（Node）
        │  启动
        ▼
codex exec --json -m <model> -s <sandbox> -c approval_policy="never" -o <last-message> --output-schema <report> -
（或：codex exec resume <id> …）
```

服务器会调用 Codex CLI，因此复用已有的 Codex 登录状态（ChatGPT 方案或 API Key）、`~/.codex/config.toml`、`AGENTS.md` 文件、MCP 服务器和规则，不会另行调用一套独立 API。

## 环境要求

- Node.js ≥ 22.18（与 `package.json` 中的 `engines` 一致；推荐 Node.js 24），且位于 `PATH` 中（插件运行 `node dist/index.js`）。
- [Codex CLI](https://github.com/openai/codex)，并已登录（运行 `codex login`）。先运行一次 `codex`，让模型列表缓存到 `~/.codex/models_cache.json`。

## 安装

### 先选择安装方式

| 使用位置 / 方式 | MCP 工具 | 技能和子代理 |
|---|---|---|
| Claude Code 插件（推荐，包含桌面版 Code 标签页） | 有 | `codex` 技能、`codex-worker` 子代理 |
| Claude Code 手动注册 MCP | 有 | 需另行复制安装 |
| Claude Desktop 普通聊天 | 有 | 不会安装 Claude Code 的技能和子代理 |

本仓库已经提交 `dist/index.js`，正常安装不必构建。先确认 `node --version`、`codex --version` 和 `codex login status` 可用。下文的 `claude` 指 Claude Code CLI；若桌面版自带 CLI 未加入 PATH，请使用实际可执行文件的完整路径（PowerShell 用 `& "完整路径\claude.exe"` 调用），不能仅凭终端找不到 `claude` 就认定它未安装。

### Claude Code：安装本分支插件（推荐）

在 Claude Code 中执行：

```text
/plugin marketplace add fei888988/codex-delegate-plus
/plugin install codex-delegate@codex-delegate-plus
```

也可从本地检出目录安装：

```powershell
claude plugin marketplace add "D:\path\to\codex-delegate-plus"
claude plugin install codex-delegate@codex-delegate-plus --scope user
```

这里的 marketplace 名称是 `codex-delegate-plus`，插件名称是 `codex-delegate`。上游 `aashahin/claude-codex-delegate` 是另一个安装来源，不会自动安装本分支的修复。

安装后重新加载插件或新开 Code 会话，并按下方步骤验收。插件技能使用 `/codex-delegate:codex`，子代理为 `codex-worker`。首次调用工具时按 Claude 的提示授权。用户级安装适用于同一 Claude Code 配置环境下的会话；仍需确认桌面版实际加载了该环境和插件。

### Claude Code：手动安装 MCP 与可选技能

在检出目录运行以下 PowerShell 命令；它直接启动 Node，能保留含空格、中文的路径：

```powershell
$codexDelegateRoot = (Resolve-Path ".").Path
$codexDelegateNode = (Get-Command node -ErrorAction Stop).Source
claude mcp add --transport stdio --scope user codex -- "$codexDelegateNode" "$codexDelegateRoot\dist\index.js"
```

这只注册 MCP，不会提供 `/codex` 或 `codex-worker`。需要手动安装时，在同一检出目录执行（已有同名文件时先备份，此操作会覆盖它们）：

```powershell
New-Item -ItemType Directory -Force "$HOME\.claude\skills\codex" | Out-Null
Copy-Item ".\skills\codex\SKILL.md" "$HOME\.claude\skills\codex\SKILL.md"
# 可选：安装子代理
New-Item -ItemType Directory -Force "$HOME\.claude\agents" | Out-Null
Copy-Item ".\agents\codex-worker.md" "$HOME\.claude\agents\codex-worker.md"
```

手动复制的用户技能叫 `/codex`；插件安装的技能使用 `/codex-delegate:codex`。选择一种安装方式，避免保留多个来源却不清楚实际加载哪一份。

### 在本仓库或 worktree 中使用：注意配置优先级

源码根目录的 `.mcp.json` 是插件声明，使用 `${CLAUDE_PLUGIN_ROOT}`。普通项目配置加载时没有这个插件变量；在本仓库或其 worktree 中启动 Claude Code，项目级的同名 `codex` 可能覆盖有效的用户级服务。单纯重启不会修复路径或作用域错误。

Claude Code 的 MCP 优先级为 **local > project > user**。先在实际使用的项目目录运行 `claude mcp list`、`claude mcp get codex`，检查作用域、命令、参数以及未定义变量警告。需要直接使用本地源码时，在**源码根目录**用上面的绝对路径变量注册 local 配置：

```powershell
claude mcp add --transport stdio --scope local codex -- "$codexDelegateNode" "$codexDelegateRoot\dist\index.js"
```

这会写入本机项目配置，而不是修改仓库的 `.mcp.json`。若该作用域已经有同名服务，先检查并备份，再有针对性地修改或通过 `claude mcp remove codex --scope local` 移除该条后重新注册。不要盲目删除其他作用域。桌面版 Code 会话可能使用源码根目录作为配置根目录，即使工作目录位于 worktree；独立启动的 worktree 则需确认自己的配置根目录。不要把机器路径提交到插件声明，也不要全局伪造 `CLAUDE_PLUGIN_ROOT`。

### Claude Desktop 普通聊天（非 Code 标签页）

优先使用 Code 标签页：它有项目目录、权限管理，并且更适合长任务。普通聊天请设置 `CODEX_DELEGATE_CWD`，使用 `delegate_async`，巡检开启时用 `task_result(wait_s: 86400)` 一次长等；两种等待工具在客户端提供 progress token 时每 15 秒发送心跳，避免 30 分钟静默中止。

普通聊天的 `claude_desktop_config.json` 与 Claude Code 的 `~/.claude.json` 是不同配置；向后者注册不代表前者已加载。通过当前应用的开发者设置定位实际配置文件，备份后将以下 `codex` 条目合并到已有 `mcpServers`，保留其他字段和服务。不同安装渠道或定制版本的配置、日志位置可能不同，不要只假定 `%APPDATA%\Claude`。

```json
{
  "mcpServers": {
    "codex": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["D:\\path\\to\\codex-delegate-plus\\dist\\index.js"],
      "env": { "CODEX_DELEGATE_CWD": "D:\\projects\\my-app" }
    }
  }
}
```

用 `Get-Command node` 确认实际 Node 路径，替换示例中的路径；桌面进程的 PATH 可能与终端不同。**直接将 Node 可执行文件放在 `command`，脚本路径单独放在 `args`，不要包装成 `cmd /c` 或拼成一个命令字符串。** 否则含空格路径可能报 `'D:\Program' is not recognized`。修改后让对应客户端重新加载 MCP。

Windows 上服务器会在 PATH 目录及 `%APPDATA%\npm` 中寻找 npm 安装的 `codex.js`，之后查找 `codex.exe`；其他平台检查 PATH、`~/.bun/bin`、`~/.local/bin`、`~/.npm-global/bin`、`~/.cargo/bin`、`/usr/local/bin` 和 `/opt/homebrew/bin`。必要时在服务器环境中设置 `CODEX_BIN`；指向 `.js` 时会用 Node 启动。

### 安装验收：在真正使用的会话里检查

1. 在同一项目和配置环境运行 `claude mcp list`、`claude mcp get codex`，确认实际启动路径和作用域；插件工具也可能带插件前缀。
2. 在实际 Claude Code / Desktop 会话的 MCP 状态或工具列表中确认服务器已连接，且有 `delegate`、`delegate_async`、`list_models`、`task_result`、`task_inspect`、`task_list`、`task_steer`、`task_cancel`、`list_sessions`。
3. 让该会话实际调用一次只读的 `list_models`，确认返回结果。需要技能时再确认 `/codex-delegate:codex`（插件）或 `/codex`（手动安装）可见。

技能可见、Node 手动启动成功、独立 `initialize` / `tools/list` 成功，都不能单独证明当前 Claude 会话已加载工具。其他目录里的 CLI 显示 Connected，也不能替代桌面版当前会话的检查。

## 更新已安装版本

先结束或妥善停止正在执行的委派，再更新或重启服务。

**通过 marketplace 安装的插件：**

```powershell
claude plugin marketplace update codex-delegate-plus
claude plugin update codex-delegate@codex-delegate-plus --scope user
```

然后按客户端要求重新加载插件/会话，并重新验收。只在源码目录 `git pull` 不代表已安装的插件缓存更新。若刷新后仍加载旧内容，核对安装来源、缓存路径及插件/marketplace 版本；维护者发布内容变更时应同步更新版本元数据，用户不应为了绕过缓存随意修改版本。

**直接注册本地检出目录的 MCP：**

```powershell
git status --short
git pull --ff-only
git log -1 --oneline
```

先处理自己的本地改动；拉取失败时不要用强制重置覆盖它们。仓库自带构建产物，无源码开发需求时不必重新构建。修复可能沿用同一版本号，因此同时核对提交号、注册路径和实际加载目录。重新加载使用该 MCP 的会话；手动复制的技能/子代理有更新时也要重新复制。

**仪表板：** 只有 `dashboard/index.html` 改动时刷新浏览器即可；后端或其模块变更时需重启现有后台进程，再刷新页面。Windows 计划任务安装使用：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dashboard-service.ps1 status
powershell -ExecutionPolicy Bypass -File scripts\dashboard-service.ps1 restart
```

手动启动的服务需停止原进程后重新运行 `npm run dashboard`。确认原进程已退出，避免误连旧服务。重启可能中断仪表板管理的续跑任务，先处理正在执行的工作。

## 安装与部署排错

| 现象 | 检查与处理 |
|---|---|
| 找不到 `/codex` | MCP 安装不含技能；安装完整插件或复制技能，并使用对应命令名称。 |
| 技能可见，但没有 `delegate` 等工具 | 检查当前会话的 MCP 状态、所选作用域、启动路径和日志；技能不能代替 MCP 连接。 |
| `'D:\Program' is not recognized` / spawn 失败 | 用实际 Node 绝对路径直接启动，分离 `command` 和 `args`，去掉 `cmd /c`。 |
| 未定义 `CLAUDE_PLUGIN_ROOT` / project 服务失败 | 检查源码 `.mcp.json` 与用户配置冲突；在正确配置根目录设置 local 绝对路径条目。 |
| CLI Connected，桌面会话仍没有工具 | 核对同一配置环境、项目根目录、插件缓存和桌面启动日志；修复实际加载的配置后重新加载该会话。 |
| 服务商读取、保存或导入接口返回 404 | 新页面可能连到旧后台；核对监听端口的进程并在后端更新后重启。其他错误按响应正文及后台日志诊断，不要把所有保存失败都当成 404。 |
| 更新后功能仍旧 | 分别核对 Git 提交、插件缓存、复制的技能和常驻后台；版本号相同不等于文件相同。 |
| Claude 应用本身无法打开 | 检查该安装实例的应用/更新日志和 Windows 应用状态；应用更新挂起与 MCP 配置失败是不同问题。不要先清空聊天数据或重置全部配置。 |

先根据日志中的明确错误处理路径、作用域或进程问题。只有日志证实启动超时才调整 `MCP_TIMEOUT`；不能仅凭工具缺失就认定超时或 `tools/list_changed` 通知有问题。

## 使用方法

像平时一样向 Claude 描述任务：

- “用 sol 6 为 `/api/users` 实现分页，你来审查。”
- “请让 Codex 只读地复查这份差异。”
- “让 sol 6 和 5.6 terra 在独立 worktree 中分别实现解析器，然后比较结果并选出更好的版本。”
- `/codex-delegate:codex sol 6.1 -- 为 src/date.ts 编写单元测试`
- “启动 codex-worker 子代理：luna 写文档，sol 写测试。”

### 模型名称和推理强度

可以使用精确的模型标识（例如 `gpt-6-sol`），也可以使用较宽松的名称（例如 `sol 6`、`sol6`、`gpt 6 luna`、`5.6 terra`、`sol 6.1`）。

- 指定版本时必须精确匹配，因此 `sol 6` 不会被解析成 `gpt-5.6-sol`。
- 不指定版本时会选择最新的模型系列：`sol` 会解析为 `gpt-6.1-sol`，而 `sol 6` 仍然指向 `gpt-6-sol`。
- `gpt 6` 同时匹配 Astra、Sol 和 Luna，会返回候选项而不是擅自猜一个。
- 模型缓存中还没有的标识（例如 `gpt-7-nova`）会原样传递给 Codex。
- `delegate` 必须传入 `effort`，它指的是委派策略中的成本档位。每个档位都固定对应模型和推理强度。默认档位从低到高为 `light`（gpt-6-luna#xhigh）、`low`（gpt-6.1-sol#low）、`medium`（gpt-6.1-sol#medium）和 `high`（gpt-6.1-sol#high）。Claude 会优先选能完成任务的最低成本档位；失败后会在同一会话中提高档位。显式指定 `model` 会覆盖档位中的模型。普通推理强度（例如模型后缀 `#xhigh`）会被限制在 `CODEX_DELEGATE_EFFORTS` 允许的范围内。

### 委派策略（仪表板 → 调度策略）

`~/.codex-delegate/policy.json`（可通过 `CODEX_DELEGATE_POLICY` 更改位置）保存成本档位（id、模型、推理强度及适用场景）、添加到 Claude 的 `delegate` 工具说明中的引导语、追加到每份 Codex 任务说明中的提示，以及可选的模型允许列表。可在仪表板中编辑。每次调用 `delegate` 都会读取策略文件；文件变化后，运行中的 MCP 服务器会在约 2 秒内重新发送工具定义。无效文件会回退到默认值，并显示原因说明。仪表板只接受来自本机回环地址和自身页面的 `PUT /api/policy` 写入请求。

如果没有指定模型，Codex 会使用 `~/.codex/config.toml` 中的 `model`（插件不会传入 `-m`）。通过 `session_id` 继续任务时会沿用原会话模型。

### Fast 模式

`fast: true` 会使用 `priority` 服务档位，即 Codex 所称的“Fast”模式。速度更快，但消耗更多使用额度。`fast: false` 会强制使用普通档位。不传该参数时，会沿用 `config.toml` 中的 `service_tier`；如果配置文件已经启用 Fast，每次委派也会使用 Fast。

### 工具

| 工具 | 说明 |
|---|---|
| `list_models` | 列出账号可用的 Codex 模型和推理强度；可选传入 `filter`。 |
| `delegate` | 执行任务并等待完成。返回报告、`session_id`、token 用量、各文件 Git 改动和主机检查结果。 |
| `delegate_async` | 与 `delegate` 相同，但会立即返回 `task_id`。适合长任务和并行委派。 |
| `task_result` / `task_list` / `task_cancel` | 获取任务结果（`wait_s` 0–86400 秒；巡检开启时一次长等）、列出任务或停止后台任务（先发 `turn/interrupt`，会话可继续）。 |
| `task_steer` | 给运行中的任务追加指令（App Server 的 `turn/steer`）。默认 Codex 在下一步读取，保留上下文和已做的改动。`now: true` 立刻打断 Codex 的思考让它读指令，但它通过启动器跑的长命令**继续运行**；插话里说明要不要停、先查什么。Codex 必须对这条命令负责（等它跑完或停掉），结束时还在跑的会被提醒两次，仍不处理则由服务器停掉并在结果里标为"被遗忘"。`kill: true` 连长命令一起停。要整个停掉用 `task_cancel`。 |

长命令启动器：服务器给每次运行放一个 `longrun.mjs`，并要求 Codex 用它跑超过约 1 分钟的命令（`node longrun.mjs <runDir> run <n> -- 程序 参数…`）。它和直接运行一样阻塞并输出，另外把输出写到 `cmd-<n>.log`、末尾写 `EXIT=<退出码>`，并让命令脱离 Codex 的进程树，所以打断 Codex 不会连带杀掉它。`status` / `wait` / `stop <n>` 用于查看、重新等待、停止。运行结束时没人处理的长命令一律由服务器停止并报告。

`checkpoints: true`（`delegate` / `delegate_async`）：长任务里 Codex 在可能改变方向的节点（调查完准备动手、发现与需求矛盾、耗时或难回退的步骤之前）把阶段报告写到运行目录的 `checkpoint-<n>.md`，然后继续干活。服务器约每 2 秒检查一次，新报告一出现，`delegate` 或带 `wait_s` 的 `task_result` 就提前返回 `status: checkpoint` 和报告内容；Claude 看完决定继续等（`task_result`）还是插话（`task_steer`）。同步 `delegate` 因此也能在节点上插话。
| `list_sessions` | 列出指定目录的近期 Codex 会话，便于继续已有会话。 |

`delegate` 和 `delegate_async` 支持这些参数：

- `prompt`、`model`、`effort` 和 `fast`
- `cwd` 和 `images`（截图、模型图等）
- `session_id` 和 `fork`，用于继续已有会话
- `stall: { silent_s, command_s, long_commands: [{ match, idle_s }] }` 设置软怀疑期限；完整测试、训练、回测、大构建应配置命令规则。调用规则优先于 policy.json，默认完整测试规则为 1800 秒。
- `idle_timeout_s` 兼容设置两个基础期限，显式 `stall` 字段优先。`task_result` 在怀疑卡住时提前返回；`stall_after_s` 设置下一窗口，否则每次确认后继续等待将窗口翻倍，新输出重置。
- `sandbox` 或 `auto`、`title` 和 `timeout_s`
- `checks`：Codex 完成后由主机运行的命令
- `structured: false`：不使用 JSON 报告，改为自由格式回答

### 沙箱

| `sandbox` | 说明 |
|---|---|
| `write` (default) | Edits, builds and tests. Uses danger-full-access; policy.sandboxWrites enables workspace-write. |
| `read-only` | 不允许编辑；`auto: false` 等同于此模式。适用于代码审查和问答。 |

审批始终设置为 `never`，因为没有人会在后台等待并回答审批提示。安全边界由沙箱提供。Claude 会被要求审查 Codex 返回的每项改动。

### 在工作流中使用

工作流中的 `agent()` 调用和子代理可以直接使用 MCP 工具，也可以通过 `codex-worker` 代理使用。如果并行安排的任务都要修改文件，请给每个任务分配独立的 Git worktree，避免互相覆盖。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CODEX_BIN` | 自动检测 | Codex 可执行文件路径。 |
| `CODEX_DELEGATE_CHECKPOINT_POLL_MS` | `2000` | 检查新阶段报告文件的间隔（毫秒）。 |
| `CODEX_DELEGATE_ENGINE` | `app-server` | 执行引擎。`app-server` 通过 JSON-RPC 驱动 Codex，支持 `task_steer` 插话；`exec` 回退到一次性的 `codex exec --json`（不能插话）。 |
| `CODEX_HOME` | `~/.codex` | 模型缓存和会话目录；与 Codex 本身使用的变量相同。 |
| `CODEX_DELEGATE_DEFAULT_MODEL` | 来自 `config.toml` | 未指定 `model` 时使用的模型；未设置时读取 `config.toml`。 |
| `CODEX_DELEGATE_READ_MODEL` | 与默认模型相同 | 只读任务未指定 `model` 时使用的模型。 |
| `CODEX_DELEGATE_POLICY` | `~/.codex-delegate/policy.json` | 委派策略，包括成本档位、引导语和模型允许列表。 |
| `CODEX_DELEGATE_EFFORTS` | `low,medium,high` | 不属于策略档位的普通推理强度范围；设为 `any` 可取消限制。 |
| `CODEX_DELEGATE_EFFORT` | 未设置 | 库/API 调用未传 `effort` 时使用的备用值；优先级高于下面两项。 |
| `CODEX_DELEGATE_WRITE_EFFORT` | `high` | 可能会编辑文件的任务使用的推理强度。 |
| `CODEX_DELEGATE_READ_EFFORT` | `medium` | 只读任务使用的推理强度。 |
| `CODEX_DELEGATE_STRUCTURED` | `true` | 修改文件的任务是否要求返回 JSON 报告。 |
| `CODEX_DELEGATE_CONTRACT` | `true` | 是否将工作约定追加到每份任务说明。 |
| `CODEX_DELEGATE_CHECK_TIMEOUT` | `600` | 每条主机检查命令的最长运行秒数。 |
| `CODEX_DELEGATE_IDLE_TIMEOUT` | `600` | Codex 没有正在执行的命令时，允许标准输出静默的秒数；`0` 表示禁用。 |
| `CODEX_DELEGATE_COMMAND_IDLE_TIMEOUT` | `600` | 命令执行期间允许无输出的秒数；`0` 表示禁用。 |
| `CODEX_DELEGATE_HARD_IDLE_TIMEOUT` | `3600` | 后台疑似卡住任务既无输出又无人调用 task_result/task_list 达到此期限才终止；`0` 禁用。 |
| `CODEX_DELEGATE_CHECK_IDLE_TIMEOUT` | `300` | 主机检查命令允许无输出的秒数；`0` 表示禁用。 |
| `CODEX_DELEGATE_RUNS_DIR` | `~/.codex-delegate/runs` | 保存任务说明、事件日志、最终消息和异步任务结果的目录。 |
| `CODEX_DELEGATE_FAST` | 来自 `config.toml` | 默认 `fast` 值。 |
| `CODEX_DELEGATE_SANDBOX` | `workspace-write` | Legacy default: read-only stays read-only; write modes follow policy.sandboxWrites. |
| `CODEX_DELEGATE_AUTO` | `true` | 默认 `auto` 值。 |
| `CODEX_DELEGATE_TIMEOUT` | `1800` | 达到此秒数后终止委派任务。 |
| `CODEX_DELEGATE_MAX_OUTPUT` | `6000` | 自由格式回答返回给 Claude 的最大字符数。 |
| `CODEX_DELEGATE_CWD` | MCP 服务器的当前目录 | `cwd` 的基准目录。 |

`idle_timeout_s` 是单次调用的可选非负整数参数，可同时覆盖本次 Codex 的两项空闲时限，但不覆盖主机检查的空闲时限。所有空闲时限设为 `0` 时，会禁用对应的空闲检测；任务总超时仍独立生效。

## 仪表板

运行 `npm run dashboard`，然后打开 http://127.0.0.1:4318，即可查看过去和正在执行的委派任务、实时运行时间线、健康状态和近 14 天活动。仪表板只绑定到本机地址。你也可以直接在仪表板中编辑委派策略；策略写入只接受来自本机回环地址和仪表板页面的请求。它和 MCP 服务器共用 `CODEX_DELEGATE_RUNS_DIR`。设置 `CODEX_DELEGATE_DASHBOARD_PORT` 可更换端口。前端文件为 `dashboard/index.html`。

Windows 上可以将仪表板作为后台服务运行（通过计划任务在开机时启动、隐藏窗口，并在崩溃 5 秒后重启）。请在管理员 PowerShell 中运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dashboard-service.ps1 install   # 也支持 status、restart、uninstall
```

输出日志保存在 `~/.codex-delegate/dashboard.log`。修改 `src/dashboard.ts` 后请运行 `restart`；修改 `dashboard/index.html` 后刷新浏览器即可。

关于空闲看门狗行为、健康状态和时间线 API 字段，请参阅[运行观测说明](docs/run-observability.md)。

## 开发

```bash
npm install
npm test            # 单元和集成测试；集成测试用虚拟 Codex 驱动 delegate 和 MCP 服务器
npm run typecheck
npm run build       # 打包到 dist/index.js；该文件会提交到仓库，安装时不必构建
npm start           # 从源码运行服务器（Node 可直接运行 .ts 文件）
```

如需交互式调试，可运行 `npx @modelcontextprotocol/inspector node dist/index.js`。

## 许可证

[MIT 许可证](LICENSE)

## v0.7.0: sandbox and run diagnosis

The package supports Node.js ≥22.18 (Node.js 24 recommended); `npm run build` produces `dist/index.js`.
Choose `sandbox: "read-only"` for investigation/review/questions and `sandbox: "write"`
for edits, builds and tests. Write defaults to Codex `danger-full-access`.
The dashboard policy API (`GET/PUT /api/policy`) accepts `sandboxWrites: true` to
use `workspace-write` instead. Older policy files default to false. Legacy tool
values `workspace-write` and `danger-full-access` are still accepted as `write`;
`auto: false` selects read-only unless sandbox is explicit. The result and run
metadata report the effective sandbox.

`add_dirs: ["D:/shared"]` adds writable directories for the panel sandbox. Every run
also passes its run directory via `--add-dir`. Workspace-write runs set `TEMP` and
`TMP` to `<runDir>/tmp`, created before launch and removed after completion.
Server-appended guidance asks Codex to tee commands expected to exceed a minute to
`<runDir>/cmd-<n>.log`. Logging is cooperative: if Codex does not tee, the report
says no command log is available.

Suspected-stall reports include the latest log's size/tail, CPU/RSS/IO/log-growth
trends sampled every 60 seconds (last 10 points), and historical command-class
p50/p90 duration when at least three timings exist. `task_inspect(task_id)` fetches
fresh evidence with a delta, the newest log tail, five recent events and the top ten
recently modified files in cwd (30 minutes; skips `.git` and `node_modules`). It
does not acknowledge wakes or extend the task's lifetime. Permission-denial reports
lead wake/final output with grouped paths and recovery advice; resuming a failed,
interrupted or denied session prepends a short previous-attempt diagnosis.

Policy `retention` defaults to `{ "cmdLogMaxMB": 5, "failedLogDays": 3,
"runDays": 30, "totalMaxMB": 1024 }`; omitted keys merge with defaults and limits
must be positive numbers. The sampler bounds command logs by keeping their tail.
Successful runs archive the last 2KB of each log in metadata, then delete those log
files. Failed/cancelled/stalled logs expire after three days; runs expire after
30 days or oldest first over the 1GB cap. Cleanup runs at MCP startup and hourly.
Live runs are protected, so the size cap may temporarily be exceeded.
See [run observability](docs/run-observability.md) for metadata and sampling details.
