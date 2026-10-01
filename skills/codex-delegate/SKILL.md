---
name: codex-delegate
description: Delegate coding or analysis work to an OpenAI model through the Codex CLI (GPT-6 Sol, Astra, Luna, GPT-5.6 Terra… anything `list_models` shows) while Claude stays the orchestrator. Use when the user says things like "use sol 6 to implement X", "have codex do it", "delegate this to gpt-6", "let sol write it and you review", "get a second opinion from codex", or asks to run/compare several Codex models, including from subagents and workflows.
---

# Delegating to Codex models

The `codex` MCP server runs tasks with `codex exec` in the user's project. The delegated model has
Codex's own tools (shell, apply_patch), so it can implement code, not just answer. **You stay the
orchestrator**: you plan, write the brief, and review what comes back.

## Tools

| Tool | Use |
|---|---|
| `list_models` (`filter?`) | See model slugs and the reasoning efforts each supports. |
| `delegate` | Run a task and wait for the result. |
| `delegate_async` → `task_result` (`wait_s`) | Long tasks, or several runs in parallel. Also `task_list`, `task_cancel`. |
| `list_sessions` | Find a `session_id` to continue. |

In a plugin install the tools are named like `mcp__plugin_codex-delegate_codex__delegate`. With a
manual install they are `mcp__codex__delegate`.

## Picking the model and effort

- Pass what the user said: `model: "sol 6"`, `"gpt 6 luna"`, `"5.6 terra"`. The server matches loose
  names against the account's model list. A name without a version picks the newest family
  (`"sol"` → `gpt-6.1-sol`). `"gpt 6"` alone is ambiguous: pick from the candidates, or ask the user
  if their intent is unclear.
- Reasoning effort: `effort: "high"`, or a suffix, `"sol 6#high"`. Levels are low, medium, high, xhigh
  and max, plus ultra on some models. If the user doesn't ask for one, omit it and Codex's configured
  default applies. Use `low` for trivial, mechanical edits.
- If the user names no model, omit `model`. Codex then uses the model from `~/.codex/config.toml` (`list_models` marks it `(default)`).
- Speed: `fast: true` uses the Fast (priority) tier, which is quicker but uses more of the user's allowance. `fast: false` forces the normal tier. Omit it to inherit `service_tier` from config.toml. Use it when the user asks for fast or for normal speed.
- On a follow-up with `session_id`, omit `model` to keep the session's model.

## Writing the brief (`prompt`)

The delegated model **cannot see this conversation**. Write a self-contained brief:

1. **Goal**: what to build or fix, and why.
2. **Context**: the relevant files and paths, the existing patterns to follow, and the commands to build and test.
3. **Constraints**: what not to touch, and the style to follow. Tell it not to commit unless you want a commit.
4. **Done when**: the acceptance criteria, e.g. "`bun test` passes" or "prints X".
5. **Report**: ask for a short summary of the changes and anything left undone.

Keep `cwd` at the project root unless the task is scoped to a subdirectory. Use `images` for
screenshots or mockups.

## Sandbox

| `sandbox` | Can do |
|---|---|
| `workspace-write` (default) | Edit files under `cwd` and run commands. **No network.** |
| `read-only` (or `auto: false`) | Read and run read-only commands. Use it for reviews, questions and second opinions. |
| `danger-full-access` | Anything, including installing packages and using the network. Use it only when the task needs that, and say so in your reply. |

If a run fails because it couldn't install a dependency or reach the network, install it yourself
or re-run with `danger-full-access`.

## After it returns: review, don't trust blindly

The result reports status, `session_id`, token usage, the tools used, **files edited by codex**
(every file it patched) and **git changes** (the new porcelain entries).

1. Read the diff (`git diff`, or read the new files) for the files it lists.
2. Run the tests or build yourself.
3. To fix something, either continue the **same session** with `delegate` and `session_id`, giving
   precise feedback, or fix it yourself if that's quicker.
4. Tell the user which model did what, and your verdict on it.

## Parallel and multi-model patterns

- **Fan out**: call `delegate_async` once per subtask, then `task_result` with `wait_s` for each.
  Parallel tasks that edit files must use **separate git worktrees** (`git worktree add`) or
  non-overlapping files, because they share the directory.
- **Compare**: give the same brief to 2–3 models (e.g. sol 6 and 5.6 terra) in separate worktrees, then
  diff the results and pick or merge the best one.
- **Second opinion**: `sandbox: "read-only"` with a prompt like "review this diff for bugs: …".
- **Subagents / workflows**: the `codex-worker` agent wraps this loop. Spawn it with the model and task
  in its prompt, e.g. "Use codex model sol 6 to add tests for src/foo.ts".
