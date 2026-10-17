# claude-codex-delegate

[简体中文](README.md) | [English](README.en.md)

让 Claude 把实现工作交给 OpenAI Codex 模型：GPT-6 Sol、Astra、Luna，GPT-5.6 Sol、Terra、Luna，以及你的 Codex 账号当前提供的其他模型。Claude 仍然负责统筹：规划任务、编写交接说明、检查改动并运行测试。

```text
你 ▸ 让 sol 6 实现 CSV 导出，你来审查

Claude ▸ delegate(model: "sol 6", prompt: "<完整、独立的任务说明>")
        ↳ gpt-6-sol 修改 src/export.ts，运行测试……
Claude ▸ 查看精简报告和主机测试结果，抽查差异并汇报
```

这是 [claude-opencode-delegate](https://github.com/aashahin/claude-opencode-delegate) 的姊妹项目，使用相同的工具和工作流，底层执行器是 Codex CLI，而不是 OpenCode。

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
- 空闲看门狗：分别设置 Codex 输出、正在执行的命令和主机检查的无输出期限；终止前会短暂采样整个进程树的 CPU 活动，避免把仍在工作的任务误判为卡住。

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

- Node.js ≥ 22.18，且位于 `PATH` 中（插件运行 `node dist/index.js`）。
- [Codex CLI](https://github.com/openai/codex)，并已登录（运行 `codex login`）。先运行一次 `codex`，让模型列表缓存到 `~/.codex/models_cache.json`。

## 安装

### Claude Code：安装插件（推荐）

```text
/plugin marketplace add aashahin/claude-codex-delegate
/plugin install codex-delegate@claude-codex-delegate
```

从本地检出目录安装：

```bash
claude plugin marketplace add "D:\path\to\codex-delegate-plus"
claude plugin install codex-delegate@codex-delegate-plus --scope user
```

用户级安装会被所有 Claude Code 会话使用，包括 Claude 桌面版的 Code 标签页（安装后请新开一个会话）。首次调用 `delegate` 时会请求权限；如果希望项目以后不再询问，可选择“始终允许”。修改插件后，请更新 `.claude-plugin/plugin.json` 中的 `version`，再运行 `claude plugin update`。

此安装方式会提供 MCP 服务器、`codex-delegate` 技能、`codex-worker` 子代理和 `/codex` 命令。

### Claude Code：只安装 MCP 服务器

```bash
claude mcp add codex -s user -- node /path/to/codex-delegate-plus/dist/index.js
```

### Claude Desktop 聊天（非 Code 标签页）

优先使用 Code 标签页：它有项目目录、权限管理，并且更适合运行较长的工具调用。普通聊天没有项目目录（需要设置 `CODEX_DELEGATE_CWD`），长工具调用也可能超时；在聊天中请使用 `delegate_async`，然后用 `task_result` 和小于一分钟的 `wait_s` 多次获取结果。将服务器加入 `claude_desktop_config.json`：

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

请使用绝对路径，因为 Desktop 不会读取 shell 的 `PATH`。在 Windows 上，服务器会在各个 `PATH` 目录和 `%APPDATA%\npm` 中寻找 npm 安装的 `codex.js`，之后再查找 `codex.exe`。其他平台会检查 `PATH`、`~/.bun/bin`、`~/.local/bin`、`~/.npm-global/bin`、`~/.cargo/bin`、`/usr/local/bin` 和 `/opt/homebrew/bin`。如果 Codex 位于其他位置，请设置 `CODEX_BIN`（如果指向 `.js` 文件，服务器会用 Node 启动它）。

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
- `delegate` 必须传入 `effort`，它指的是委派策略中的成本档位。每个档位都固定对应模型和推理强度。默认档位从低到高为 `luna-xhigh`（gpt-6-luna#xhigh）、`low`（gpt-6.1-sol#low）、`medium`（gpt-6.1-sol#medium）和 `high`（gpt-6.1-sol#high）。Claude 会优先选能完成任务的最低成本档位；失败后会在同一会话中提高档位。显式指定 `model` 会覆盖档位中的模型。普通推理强度（例如模型后缀 `#xhigh`）会被限制在 `CODEX_DELEGATE_EFFORTS` 允许的范围内。

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
| `task_result` / `task_list` / `task_cancel` | 获取任务结果（可传 `wait_s`）、列出任务或停止后台任务。 |
| `list_sessions` | 列出指定目录的近期 Codex 会话，便于继续已有会话。 |

`delegate` 和 `delegate_async` 支持这些参数：

- `prompt`、`model`、`effort` 和 `fast`
- `cwd` 和 `images`（截图、模型图等）
- `session_id` 和 `fork`，用于继续已有会话
- `idle_timeout_s`，覆盖本次调用的两个 Codex 输出空闲时限
- `sandbox` 或 `auto`、`title` 和 `timeout_s`
- `checks`：Codex 完成后由主机运行的命令
- `structured: false`：不使用 JSON 报告，改为自由格式回答

### 沙箱

| `sandbox` | 说明 |
|---|---|
| `workspace-write`（默认） | Codex 可修改 `cwd` 下的文件并运行命令，但没有网络访问权限。 |
| `read-only` | 不允许编辑；`auto: false` 等同于此模式。适用于代码审查和问答。 |
| `danger-full-access` | 不启用沙箱，允许安装软件包、访问网络和整个文件系统。只有任务确实需要时才传入。 |

审批始终设置为 `never`，因为没有人会在后台等待并回答审批提示。安全边界由沙箱提供。Claude 会被要求审查 Codex 返回的每项改动。

### 在工作流中使用

工作流中的 `agent()` 调用和子代理可以直接使用 MCP 工具，也可以通过 `codex-worker` 代理使用。如果并行安排的任务都要修改文件，请给每个任务分配独立的 Git worktree，避免互相覆盖。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CODEX_BIN` | 自动检测 | Codex 可执行文件路径。 |
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
| `CODEX_DELEGATE_COMMAND_IDLE_TIMEOUT` | `1200` | 命令执行期间允许无输出的秒数；`0` 表示禁用。 |
| `CODEX_DELEGATE_CHECK_IDLE_TIMEOUT` | `300` | 主机检查命令允许无输出的秒数；`0` 表示禁用。 |
| `CODEX_DELEGATE_RUNS_DIR` | `~/.codex-delegate/runs` | 保存任务说明、事件日志、最终消息和异步任务结果的目录。 |
| `CODEX_DELEGATE_FAST` | 来自 `config.toml` | 默认 `fast` 值。 |
| `CODEX_DELEGATE_SANDBOX` | `workspace-write` | 默认沙箱模式。 |
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
