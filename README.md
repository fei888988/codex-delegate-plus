# claude-codex-delegate

Give Claude **OpenAI's Codex models as implementers**: GPT-6 Sol, Astra and Luna, GPT-5.6 Sol,
Terra and Luna, and whatever else your Codex account lists. Claude stays the orchestrator. It plans
the work, briefs the Codex model, reviews the diff, and runs the tests.

```
you ▸ let sol 6 implement the CSV export, you review it

claude ▸ delegate(model: "sol 6", prompt: "<self-contained brief>")
         ↳ gpt-6-sol edits src/export.ts, runs tests …
claude ▸ reviews the diff, runs `bun test`, and reports back
```

It's a sibling of [claude-opencode-delegate](https://github.com/aashahin/claude-opencode-delegate),
with the same tools and workflow, backed by the Codex CLI instead of OpenCode.

It works in:

- **Claude Code** (CLI, IDE, desktop): you can ask directly, use `/codex`, use the `codex-worker` subagent, or use it from dynamic workflows.
- **Claude Desktop**, as a plain MCP server.

## How it works

```
Claude Code / Claude Desktop / subagent / workflow
        │  MCP (stdio)
        ▼
codex-delegate MCP server (Bun)
        │  spawns
        ▼
codex exec --json -m <model> -s <sandbox> -c approval_policy="never"   (or: codex exec resume <id> …)
```

The server shells out to the `codex` CLI, so it uses your existing Codex login (ChatGPT plan or API
key), `~/.codex/config.toml`, AGENTS.md files, MCP servers and rules. It does not use a separate API.

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- [Codex CLI](https://github.com/openai/codex), logged in (`codex login`). Run `codex` once so the model list is cached in `~/.codex/models_cache.json`.

## Install

### Claude Code: plugin (recommended)

```text
/plugin marketplace add aashahin/claude-codex-delegate
/plugin install codex-delegate@claude-codex-delegate
```

For a local checkout, use `/plugin marketplace add /path/to/claude-codex-delegate`.

This gives you the MCP server, the **codex-delegate** skill, the **codex-worker** subagent, and the
**/codex** command.

### Claude Code: MCP server only

```bash
git clone https://github.com/aashahin/claude-codex-delegate ~/.local/share/claude-codex-delegate
claude mcp add codex -s user -- bun ~/.local/share/claude-codex-delegate/dist/index.js
```

### Claude Desktop

Clone the repo as shown above. Then add the server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "codex": {
      "command": "/home/YOU/.bun/bin/bun",
      "args": ["/home/YOU/.local/share/claude-codex-delegate/dist/index.js"],
      "env": { "CODEX_DELEGATE_CWD": "/home/YOU/projects/my-app" }
    }
  }
}
```

Use absolute paths, because Desktop doesn't load your shell `PATH`. The server searches for `codex`
in `~/.bun/bin`, `~/.local/bin`, `~/.npm-global/bin`, `~/.cargo/bin`, `/usr/local/bin` and
`/opt/homebrew/bin`. If yours is somewhere else, set `CODEX_BIN`.

## Usage

Talk to Claude normally:

- *"Use sol 6 to implement pagination for /api/users. You review it."*
- *"Ask codex for a read-only second opinion on this diff."*
- *"Have sol 6 and 5.6 terra both implement the parser in separate worktrees, then pick the better one."*
- `/codex sol 6#high -- write unit tests for src/date.ts`
- *"Spawn codex-worker subagents: luna does the docs, sol does the tests."*

### Model names and effort

You can use exact slugs (`gpt-6-sol`) or loose names (`sol 6`, `sol6`, `gpt 6 luna`, `5.6 terra`).

- A version you name must match exactly, so `sol 6` never becomes `gpt-5.6-sol`.
- Without a version, the newest family wins: `sol` resolves to `gpt-6-sol`.
- `gpt 6` matches Astra, Sol and Luna, so you get the candidates instead of a guess.
- A slug the cache doesn't know yet (e.g. `gpt-7-nova`) is passed through as-is.
- Set reasoning effort with `effort` or a suffix: `sol 6#max`. It's checked against the levels the
  model supports. If you leave it out, `model_reasoning_effort` from your `config.toml` applies.
- If you don't name a model, `gpt-6-sol` is used. Follow-ups with `session_id` keep the session's model.

### Tools

| Tool | What it does |
|---|---|
| `list_models` | Lists your account's Codex models and their reasoning efforts. Takes an optional `filter`. |
| `delegate` | Runs a task and waits for it. Returns the response, `session_id`, token usage, tools used, the files Codex edited, and git changes. |
| `delegate_async` | Same as `delegate`, but returns a `task_id` right away. Use it for long jobs and parallel fan-out. |
| `task_result` / `task_list` / `task_cancel` | Collect results (with `wait_s`), list tasks, or stop a background task. |
| `list_sessions` | Lists recent Codex sessions for a directory, so you can find one to continue. |

`delegate` and `delegate_async` take these arguments:

- `prompt`, `model` and `effort`
- `cwd` and `images` (screenshots, mockups)
- `session_id` and `fork` to follow up in an earlier session
- `sandbox` or `auto`, `title`, and `timeout_s`

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
| `CODEX_DELEGATE_DEFAULT_MODEL` | `gpt-6-sol` | Model used when `model` is omitted. Set it to `""` to use the model in your `config.toml`. |
| `CODEX_DELEGATE_READ_MODEL` | same as the default model | Model used when `model` is omitted and the run is read-only. |
| `CODEX_DELEGATE_EFFORT` | *(from config.toml)* | Default reasoning effort. |
| `CODEX_DELEGATE_SANDBOX` | `workspace-write` | Default sandbox. |
| `CODEX_DELEGATE_AUTO` | `true` | Default for `auto`. |
| `CODEX_DELEGATE_TIMEOUT` | `1800` | Seconds before a run is killed. |
| `CODEX_DELEGATE_MAX_OUTPUT` | `40000` | Maximum number of response characters returned to Claude. |
| `CODEX_DELEGATE_CWD` | the server's cwd | Base directory for `cwd`. |

## Development

```bash
bun install
bun test            # unit tests (fixtures captured from real `codex exec --json`)
bun run typecheck
bun run build       # bundles to dist/index.js, which is committed so installs need no build step
bun run start       # run the server from source
```

To debug interactively, use `bunx @modelcontextprotocol/inspector bun dist/index.js`.

## License

MIT
