# claude-codex-delegate

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

- Node.js ≥ 22.18 on `PATH` (the plugin runs `node dist/index.js`)
- [Codex CLI](https://github.com/openai/codex), logged in (`codex login`). Run `codex` once so the model list is cached in `~/.codex/models_cache.json`.

## Install

### Claude Code: plugin (recommended)

```text
/plugin marketplace add aashahin/claude-codex-delegate
/plugin install codex-delegate@claude-codex-delegate
```

For this local checkout:

```bash
claude plugin marketplace add "D:\path\to\codex-delegate-plus"
claude plugin install codex-delegate@codex-delegate-plus --scope user
```

A user-scope install is picked up by every Claude Code session, including new sessions in the Claude
desktop app's Code tab (start a new session after installing). The first `delegate` call asks for
permission; choose "always allow" for the project to skip that next time. After changing the
plugin, bump `version` in `.claude-plugin/plugin.json` and run `claude plugin update`.

This gives you the MCP server, the **codex-delegate** skill, the **codex-worker** subagent, and the
**/codex** command.

### Claude Code: MCP server only

```bash
claude mcp add codex -s user -- node /path/to/codex-delegate-plus/dist/index.js
```

### Claude Desktop chat (not the Code tab)

Prefer the Code tab: it has a project directory, permissions and long tool calls. Chat has no
project directory (set `CODEX_DELEGATE_CWD`) and may time out long tool calls, so there use
`delegate_async` and then `task_result` with `wait_s` under a minute, repeated. Add the server to
`claude_desktop_config.json`:

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

Use absolute paths, because Desktop doesn't load your shell `PATH`. On Windows the server looks for
the npm-installed `codex.js` in each `PATH` dir and `%APPDATA%
pm`, then for `codex.exe`; elsewhere
in `PATH`, `~/.bun/bin`, `~/.local/bin`, `~/.npm-global/bin`, `~/.cargo/bin`, `/usr/local/bin` and
`/opt/homebrew/bin`. If yours is somewhere else, set `CODEX_BIN` (a `.js` path is run with Node).

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
- `sandbox` or `auto`, `title`, and `timeout_s`
- `checks`: commands run on the host after Codex (cmd.exe on Windows, `/bin/sh` elsewhere)
- `structured: false` for a free-form answer instead of the JSON report

### Sandbox

| `sandbox` | |
|---|---|
| `workspace-write` (default) | Codex can edit files under `cwd` and run commands, without network access. |
| `read-only` | No edits. `auto: false` is shorthand for this. Use it for reviews and questions. |
| `danger-full-access` | No sandbox: package installs, network, and the whole filesystem. Only pass it per call when a task needs it. |

Approvals are always `never`, because nobody is there to answer a prompt. The sandbox is the
boundary. Claude is told to review every change it gets back.

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
| `CODEX_DELEGATE_RUNS_DIR` | `~/.codex-delegate/runs` | Prompts, event logs, final messages, async task results. |
| `CODEX_DELEGATE_FAST` | *(from config.toml)* | `true` or `false`: the default for `fast`. |
| `CODEX_DELEGATE_SANDBOX` | `workspace-write` | Default sandbox. |
| `CODEX_DELEGATE_AUTO` | `true` | Default for `auto`. |
| `CODEX_DELEGATE_TIMEOUT` | `1800` | Seconds before a run is killed. |
| `CODEX_DELEGATE_MAX_OUTPUT` | `6000` | Maximum number of response characters returned to Claude (free-form answers). |
| `CODEX_DELEGATE_CWD` | the server's cwd | Base directory for `cwd`. |

## Dashboard

Run `npm run dashboard` and open http://127.0.0.1:4318 to view past and ongoing
delegate runs. The dashboard binds to localhost only and is read-only. It uses
`CODEX_DELEGATE_RUNS_DIR`, like the MCP server. Set `CODEX_DELEGATE_DASHBOARD_PORT`
to choose a different port. The frontend is served from `dashboard/index.html`.

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

MIT
