# claude-codex-delegate

v0.11.0 adds per-run model providers: both delegate tools accept `provider`, including official ChatGPT-login accounts imported from cc-switch. Login accounts use isolated Codex homes with optional token sync (enabled on import); turning sync off risks stale copies being logged out when refresh tokens rotate. See [configuration and backend API](docs/providers.md). The dashboard UI is unchanged.

[简体中文](README.md) | [English](README.en.md)

Give Claude **OpenAI's Codex models as implementers**: GPT-6 Sol, Astra and Luna, GPT-5.6 Sol,
Terra and Luna, and whatever else your Codex account lists. Claude stays the orchestrator. It plans
the work, briefs the Codex model, reviews the diff, and runs the tests.

```
you ▸ let sol 6 implement the CSV export, you review it

claude ▸ delegate(model: "sol 6", prompt: "<self-contained brief>")
         ↳ gpt-6-sol edits src/export.ts, runs tests …
claude ▸ reads the compact report + host test results, spot-checks the diff, reports back
```

It's a sibling of [claude-opencode-delegate](https://github.com/aashahin/claude-opencode-delegate),
with the same tools and workflow, backed by the Codex CLI instead of OpenCode.

Commit ownership: Codex implements, self-tests and reports, leaving changes uncommitted.
Claude reviews the changes and passing host checks, then commits when the user requested it;
pushing also requires authorization. Keep any commit step from the user's original spec with
Claude, out of delegated briefs and follow-ups.

It works in:

- **Claude Code** (CLI, IDE, and the Claude desktop app's Code tab): you can ask directly, use `/codex`, use the `codex-worker` subagent, or use it from dynamic workflows.
- **Claude Desktop chat**, as a plain MCP server (see the caveats below).

This fork (`codex-delegate-plus`) adds, on top of upstream:

- Windows support without a shell: the npm `codex` shim's `codex.js` is started with Node; the brief goes through stdin.
- Small results for the orchestrator: only Codex's final message comes back, as a JSON report (`done` / `partial` / `blocked` / `needs_decision`, summary, verification, risks, questions); the full event log stays in `~/.codex-delegate/runs/`.
- `checks`: commands the server runs on the host after Codex finishes, returned as PASS/FAIL with the failure tail.
- Per-file `+/-` counts from content hashes (catches edits to files that were already dirty).
- Delegated runs default to effort `high` (`medium` read-only) instead of your interactive default.
- Process-tree kill on cancel/timeout/exit, one writer per directory, async results persisted to disk.
- Stop, then redirect: if you stop a delegation and change your requirements, the next `delegate` in
  the same directory resumes the interrupted Codex session (context and partial edits intact) with
  the new direction. `fresh: true` opts out. Records live in `<runs dir>/pending/`.
- Live run observability: the dashboard shows a 14-day activity view, per-run Codex timelines,
  progress and health states (`active`, `quiet`, `stalled`, `orphaned`).
- Codex idle thresholds wake the lead with `status: suspected_stall` and evidence; the run stays alive.
  Use `task_result` to continue waiting or `task_cancel` to stop. Host-check idle deadlines still kill.

## How it works

```
Claude Code / Claude Desktop / subagent / workflow
        │  MCP (stdio)
        ▼
codex-delegate MCP server (Node)
        │  spawns
        ▼
codex exec --json -m <model> -s <sandbox> -c approval_policy="never" -o <last-message> --output-schema <report> -   (or: codex exec resume <id> …)
```

The server shells out to the `codex` CLI, so it uses your existing Codex login (ChatGPT plan or API
key), `~/.codex/config.toml`, AGENTS.md files, MCP servers and rules. It does not use a separate API.

## Requirements

- Node.js ≥ 24 on `PATH` (the plugin runs `node dist/index.js`)
- [Codex CLI](https://github.com/openai/codex), logged in (`codex login`). Run `codex` once so the model list is cached in `~/.codex/models_cache.json`.

## Install

### Choose an installation method

| Location / method | MCP tools | Skill and subagent |
|---|---|---|
| Claude Code plugin (recommended, including the desktop Code tab) | Included | `codex` skill and `codex-worker` subagent |
| Manual Claude Code MCP registration | Included | Copy separately if needed |
| Regular Claude Desktop chat | Included | Does not install Claude Code skills or subagents |

`dist/index.js` is committed; a normal installation needs no build. First check `node --version`, `codex --version`, and `codex login status`. Commands below use the Claude Code CLI, `claude`. If the desktop app's bundled CLI is not on PATH, use its actual executable path (PowerShell: `& "full\path\claude.exe"`). A missing terminal command alone does not prove it is absent.

### Claude Code: install this fork's plugin (recommended)

Run inside Claude Code:

```text
/plugin marketplace add fei888988/codex-delegate-plus
/plugin install codex-delegate@codex-delegate-plus
```

Or install from a local checkout:

```powershell
claude plugin marketplace add "D:\path\to\codex-delegate-plus"
claude plugin install codex-delegate@codex-delegate-plus --scope user
```

The marketplace name is `codex-delegate-plus`; the plugin name is `codex-delegate`. Upstream `aashahin/claude-codex-delegate` is a different source and does not automatically include this fork's fixes.

Reload the plugin or start a new Code session, then follow the acceptance steps below. The plugin skill is `/codex-delegate:codex`; the subagent is `codex-worker`. Approve tool use when Claude prompts. User-scope installation applies to sessions sharing that Claude Code configuration environment; confirm the desktop app actually loads that environment and plugin.

### Claude Code: manual MCP and optional skill installation

Run this PowerShell example from the checkout. It starts Node directly and preserves paths containing spaces or non-ASCII characters:

```powershell
$codexDelegateRoot = (Resolve-Path ".").Path
$codexDelegateNode = (Get-Command node -ErrorAction Stop).Source
claude mcp add --transport stdio --scope user codex -- "$codexDelegateNode" "$codexDelegateRoot\dist\index.js"
```

This registers only MCP, without `/codex` or `codex-worker`. To install those manually, run from the same checkout (back up existing files with these names first; copying overwrites them):

```powershell
New-Item -ItemType Directory -Force "$HOME\.claude\skills\codex" | Out-Null
Copy-Item ".\skills\codex\SKILL.md" "$HOME\.claude\skills\codex\SKILL.md"
# Optional: install the subagent
New-Item -ItemType Directory -Force "$HOME\.claude\agents" | Out-Null
Copy-Item ".\agents\codex-worker.md" "$HOME\.claude\agents\codex-worker.md"
```

The manually copied user skill is `/codex`; the plugin skill is `/codex-delegate:codex`. Choose an installation method so you can identify the source actually loaded.

### Using this repository or a worktree: configuration precedence

The root `.mcp.json` is a plugin declaration using `${CLAUDE_PLUGIN_ROOT}`. Ordinary project configuration does not define this plugin variable. When Claude Code starts in this repository or a worktree, a project-scoped `codex` entry can override a valid user-scoped server. Restarting alone cannot repair an invalid path or scope.

Claude Code MCP precedence is **local > project > user**. Run `claude mcp list` and `claude mcp get codex` in the actual project and inspect scope, command, arguments, and undefined-variable warnings. To use this checkout directly, register a local entry at the **source repository root**, using the absolute-path variables above:

```powershell
claude mcp add --transport stdio --scope local codex -- "$codexDelegateNode" "$codexDelegateRoot\dist\index.js"
```

This writes machine-local project configuration rather than changing the tracked `.mcp.json`. If that scope already contains the name, inspect and back it up, then edit it specifically or remove that entry with `claude mcp remove codex --scope local` before registering it again. Do not blindly delete other scopes. Desktop Code sessions may use the source root as their configuration root even while working in a worktree; independently launched worktrees need their own configuration-root check. Do not commit machine paths into the plugin declaration or globally fabricate `CLAUDE_PLUGIN_ROOT`.

### Regular Claude Desktop chat (not the Code tab)

Prefer the Code tab for its project directory, permissions, and long tasks. In regular chat, set `CODEX_DELEGATE_CWD`, use `delegate_async`, then poll `task_result` with `wait_s` under a minute.

Regular chat's `claude_desktop_config.json` and Claude Code's `~/.claude.json` are separate configurations; registration in the latter does not configure the former. Locate the actual file through the current app's developer settings, back it up, and merge the following `codex` entry into existing `mcpServers`, preserving other fields and servers. Configuration and log locations vary by installation channel or customized build; do not assume only `%APPDATA%\Claude`.

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

Use `Get-Command node` to find the actual Node executable and replace the example paths. The desktop process may have a different PATH from your terminal. **Put the Node executable directly in `command` and the script path separately in `args`; do not wrap them in `cmd /c` or concatenate a shell command.** Otherwise a path with spaces can fail with `'D:\Program' is not recognized`. Reload MCP in the corresponding client after changes.

On Windows the server searches PATH directories and `%APPDATA%\npm` for npm's `codex.js`, then for `codex.exe`. Elsewhere it checks PATH, `~/.bun/bin`, `~/.local/bin`, `~/.npm-global/bin`, `~/.cargo/bin`, `/usr/local/bin`, and `/opt/homebrew/bin`. Set `CODEX_BIN` in the server environment if needed; a `.js` path is launched with Node.

### Acceptance: check the session you will actually use

1. In the same project and configuration environment, run `claude mcp list` and `claude mcp get codex` to confirm launch paths and scope. Plugin tools may also have a plugin prefix.
2. In the actual Claude Code / Desktop session's MCP status or tool list, confirm a connected server with `delegate`, `delegate_async`, `list_models`, `task_result`, `task_inspect`, `task_list`, `task_steer`, `task_cancel`, and `list_sessions`.
3. Have that session actually call the read-only `list_models` tool and confirm a result. If you need the skill, also check `/codex-delegate:codex` (plugin) or `/codex` (manual install).

A visible skill, successful manual Node launch, or standalone `initialize` / `tools/list` exchange does not independently prove the current Claude session loaded the tools. CLI Connected status from another directory does not replace checking the current desktop session.

## Update an existing installation

Finish or properly stop active delegations before updating or restarting services.

**Marketplace plugin installation:**

```powershell
claude plugin marketplace update codex-delegate-plus
claude plugin update codex-delegate@codex-delegate-plus --scope user
```

Reload the plugin/session as required by the client, then repeat acceptance. Pulling a source checkout does not guarantee the installed plugin cache updates. If old content remains, check the installation source, cache path, and plugin/marketplace versions. Maintainers should update version metadata when publishing changed content; users should not arbitrarily change versions to bypass caching.

**MCP registered directly against a local checkout:**

```powershell
git status --short
git pull --ff-only
git log -1 --oneline
```

Handle your local changes first; do not force-reset them away if pulling fails. The repository includes the bundle, so normal users do not need to rebuild. Fixes can share a version number: check the commit, registered path, and actual loaded directory too. Reload sessions using the MCP server, and recopy manually installed skills/subagents when those files change.

**Dashboard:** Refresh the browser for changes limited to `dashboard/index.html`. Restart the existing background process after backend or module changes, then refresh. For the Windows scheduled-task installation:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dashboard-service.ps1 status
powershell -ExecutionPolicy Bypass -File scripts\dashboard-service.ps1 restart
```

For a manual launch, stop the old process and rerun `npm run dashboard`. Confirm the original process exited so you do not reconnect to an old server. Restarting can interrupt dashboard-managed continuation jobs; handle active work first.

## Installation and deployment troubleshooting

| Symptom | Check and remedy |
|---|---|
| `/codex` is missing | MCP registration does not install the skill. Install the full plugin or copy the skill, using the corresponding command name. |
| Skill visible, but no `delegate` tools | Inspect the current session's MCP status, selected scope, paths, and logs. A skill does not establish an MCP connection. |
| `'D:\Program' is not recognized` / spawn failure | Launch the actual Node absolute path directly with separate `command` and `args`; remove `cmd /c`. |
| Undefined `CLAUDE_PLUGIN_ROOT` / project server fails | Check source `.mcp.json` conflicts with user configuration; register a local absolute-path entry at the correct configuration root. |
| CLI Connected, but desktop tools missing | Compare configuration environments, project roots, plugin caches, and desktop startup logs; repair the configuration actually loaded, then reload that session. |
| Provider read/save/import API returns 404 | A new page may be using an old backend. Identify the process listening on the port and restart after backend updates. Diagnose other failures from their response body and backend logs; not every save failure is a 404. |
| Features remain old after updating | Check the Git commit, plugin cache, copied skills, and resident backend separately. Equal version numbers do not prove equal files. |
| Claude itself will not open | Inspect that installation's app/updater logs and Windows application status. A stalled app update and an MCP configuration failure are separate problems. Do not start by erasing chats or resetting all configuration. |

Resolve explicit path, scope, or process errors from logs first. Adjust `MCP_TIMEOUT` only when logs establish a startup timeout; missing tools alone do not prove a timeout or a `tools/list_changed` notification problem.

## Usage

Talk to Claude normally:

- *"Use sol 6 to implement pagination for /api/users. You review it."*
- *"Ask codex for a read-only second opinion on this diff."*
- *"Have sol 6 and 5.6 terra both implement the parser in separate worktrees, then pick the better one."*
- `/codex-delegate:codex sol 6.1 -- write unit tests for src/date.ts`
- *"Spawn codex-worker subagents: luna does the docs, sol does the tests."*

### Model names and effort

You can use exact slugs (`gpt-6-sol`) or loose names (`sol 6`, `sol6`, `gpt 6 luna`, `5.6 terra`, `sol 6.1`).

- A version you name must match exactly, so `sol 6` never becomes `gpt-5.6-sol`.
- Without a version, the newest family wins: `sol` resolves to `gpt-6.1-sol`, while `sol 6` stays on `gpt-6-sol`.
- `gpt 6` matches Astra, Sol and Luna, so you get the candidates instead of a guess.
- A slug the cache doesn't know yet (e.g. `gpt-7-nova`) is passed through as-is.
- `effort` is a required `delegate` argument that names a **cost tier** of the delegation policy.
  Each tier fixes a model and reasoning effort. The defaults, cheapest first, are `luna-xhigh`
  (gpt-6-luna#xhigh), `low` (gpt-6.1-sol#low), `medium` (gpt-6.1-sol#medium) and
  `high` (gpt-6.1-sol#high). Claude picks the cheapest
  tier that will get the task right and goes up a tier on the same session after a failure. An
  explicit `model` overrides the tier's model. A plain effort that isn't a tier (for example a
  `#xhigh` model suffix) is clamped into `CODEX_DELEGATE_EFFORTS`.

### Delegation policy (dashboard → 调度策略)

`~/.codex-delegate/policy.json` (`CODEX_DELEGATE_POLICY`) holds the tiers (id, model, effort, when to
use each), the guidance prompt added to the `delegate` tool description for Claude, the prompt
appended to every Codex brief, and an optional model allowlist. Edit it in the dashboard. Each
`delegate` call reads it, and a running MCP server re-sends its tool definitions about 2s after
the file changes. An invalid file falls back to the defaults and the reason shows up as a note.
The dashboard accepts `PUT /api/policy` only from its own page on a loopback host.
- If you don't name a model, Codex uses the `model` from your `~/.codex/config.toml` (the plugin passes no `-m`). Follow-ups with `session_id` keep the session's model.

### Fast mode

`fast: true` runs on the `priority` service tier, which Codex calls "Fast". It's quicker but uses more of your usage allowance. `fast: false` forces the normal tier. If you omit it, the `service_tier` from your `config.toml` applies, so if fast is already on there, every delegated run is fast.

### Tools

| Tool | What it does |
|---|---|
| `list_models` | Lists your account's Codex models and their reasoning efforts. Takes an optional `filter`. |
| `delegate` | Runs a task and waits for it. Returns the report, `session_id`, token usage, per-file git changes and host check results. |
| `delegate_async` | Same as `delegate`, but returns a `task_id` right away. Use it for long jobs and parallel fan-out. |
| `task_result` / `task_list` / `task_cancel` | Collect results (with `wait_s`), list tasks, or stop a background task. |
| `list_sessions` | Lists recent Codex sessions for a directory, so you can find one to continue. |

`delegate` and `delegate_async` take these arguments:

- `prompt`, `model`, `effort` and `fast`
- `cwd` and `images` (screenshots, mockups)
- `session_id` and `fork` to follow up in an earlier session
- `stall: { silent_s, command_s, long_commands: [{ match, idle_s }] }` sets soft suspicion windows. Set command rules for full tests, training, backtests or big builds; call regexes precede policy rules (default full-test rule: 1800s).
- `idle_timeout_s` sets both base windows for compatibility; explicit `stall` fields win. `task_result` wakes early on suspicion; `stall_after_s` sets the next window, otherwise each acknowledged wake doubles it. New output resets backoff.
- `sandbox` or `auto`, `title`, and `timeout_s`
- `checks`: commands run on the host after Codex (cmd.exe on Windows, `/bin/sh` elsewhere)
- `structured: false` for a free-form answer instead of the JSON report

### Sandbox

| `sandbox` | |
|---|---|
| `write` (default) | Edits, builds and tests. Uses danger-full-access; policy.sandboxWrites enables workspace-write. |
| `read-only` | No edits. `auto: false` is shorthand for this. Use it for reviews and questions. |

Approvals are always `never`, because nobody is there to answer a prompt. The panel toggle controls write sandboxing. Claude is told to review every change it gets back.

### Using it from workflows

Workflow `agent()` calls and subagents can use the MCP tools directly or through the `codex-worker`
agent. If you fan out tasks that edit files, give each one its own `git worktree` so they don't
conflict.

## Configuration (env vars)

| Variable | Default | |
|---|---|---|
| `CODEX_BIN` | auto-detected | Path to the `codex` executable. |
| `CODEX_HOME` | `~/.codex` | Where the model cache and sessions are read from. This is the same variable Codex uses. |
| `CODEX_DELEGATE_DEFAULT_MODEL` | *(from config.toml)* | Model used when `model` is omitted. When unset, the model in your `config.toml` is used. |
| `CODEX_DELEGATE_READ_MODEL` | same as the default model | Model used when `model` is omitted and the run is read-only. |
| `CODEX_DELEGATE_POLICY` | `~/.codex-delegate/policy.json` | Delegation policy (tiers, guidance prompts, model allowlist). |
| `CODEX_DELEGATE_EFFORTS` | `low,medium,high` | Range for plain efforts that aren't policy tiers; others are clamped into it. `any` = no limit. |
| `CODEX_DELEGATE_EFFORT` | *(unset)* | Fallback effort for library/API callers that omit it; overrides the two below. |
| `CODEX_DELEGATE_WRITE_EFFORT` | `high` | Effort for runs that may edit files. |
| `CODEX_DELEGATE_READ_EFFORT` | `medium` | Effort for read-only runs. |
| `CODEX_DELEGATE_STRUCTURED` | `true` | Ask for the JSON report on write runs. |
| `CODEX_DELEGATE_CONTRACT` | `true` | Append the working agreement to every brief. |
| `CODEX_DELEGATE_CHECK_TIMEOUT` | `600` | Seconds per host check. |
| `CODEX_DELEGATE_IDLE_TIMEOUT` | `600` | Seconds of Codex output silence when no command is in flight; `0` disables this detector. |
| `CODEX_DELEGATE_COMMAND_IDLE_TIMEOUT` | `600` | Seconds of silence while a command is in flight; `0` disables this detector. |
| `CODEX_DELEGATE_HARD_IDLE_TIMEOUT` | `3600` | Kill suspected background tasks with no output or task_result/task_list observation for this long; `0` disables. |
| `CODEX_DELEGATE_CHECK_IDLE_TIMEOUT` | `300` | Seconds of host-check output silence; `0` disables this detector. |
| `CODEX_DELEGATE_RUNS_DIR` | `~/.codex-delegate/runs` | Prompts, event logs, final messages, async task results. |
| `CODEX_DELEGATE_FAST` | *(from config.toml)* | `true` or `false`: the default for `fast`. |
| `CODEX_DELEGATE_SANDBOX` | `workspace-write` | Legacy default: read-only stays read-only; write modes follow policy.sandboxWrites. |
| `CODEX_DELEGATE_AUTO` | `true` | Default for `auto`. |
| `CODEX_DELEGATE_TIMEOUT` | `1800` | Seconds before a run is killed. |
| `CODEX_DELEGATE_MAX_OUTPUT` | `6000` | Maximum number of response characters returned to Claude (free-form answers). |
| `CODEX_DELEGATE_CWD` | the server's cwd | Base directory for `cwd`. |

## Dashboard

Run `npm run dashboard` and open http://127.0.0.1:4318 to view past and ongoing
delegate runs, their live timelines and health states, and the 14-day activity view. The dashboard
binds to localhost only. You can also edit the delegation policy there; policy writes are accepted
only from the dashboard page on a loopback host. It uses `CODEX_DELEGATE_RUNS_DIR`, like the MCP
server. Set `CODEX_DELEGATE_DASHBOARD_PORT` to choose a different port. The frontend is served
from `dashboard/index.html`.

See [run observability details](docs/run-observability.md) for idle watchdog behavior, health
states and timeline API fields.

On Windows it can run as a background service (a scheduled task that starts at boot, has no
window and comes back 5 s after a crash). From an elevated PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dashboard-service.ps1 install   # also: status, restart, uninstall
```

Output goes to `~/.codex-delegate/dashboard.log`. After editing `src/dashboard.ts`, run `restart`;
changes to `dashboard/index.html` only need a browser refresh.

## Development

```bash
npm install
npm test            # unit + integration tests (a fake codex drives delegate and the MCP server)
npm run typecheck
npm run build       # bundles to dist/index.js, which is committed so installs need no build step
npm start           # run the server from source (node runs the .ts directly)
```

To debug interactively, use `npx @modelcontextprotocol/inspector node dist/index.js`.

## License

[MIT](LICENSE)

## v0.7.0: sandbox and run diagnosis

Requires Node 24; `npm run build` produces `dist/index.js`.
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
