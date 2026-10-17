---
name: codex
description: Claude leads, a Codex model (GPT-6.1 Sol by default) does the work. Delegate implementation, debugging, tests or analysis to the Codex CLI while Claude briefs, picks the cheapest cost tier (model + reasoning effort) that will get the task right, and accepts the result. Use when the user invokes /codex, or says things like "让 codex 做", "交给 sol", "use sol 6.1 to implement X", "have codex do it, you review", "get a second opinion from codex".
argument-hint: "[model] -- <task>  (e.g. sol 6.1 -- add input validation to the signup form)"
---

# Codex does the work, you lead

Task from the user (may be empty if the skill was triggered by conversation): $ARGUMENTS

If that text has `--`, the part before it names the model. Pass it to `model` unchanged and the
server resolves it. "fast" means `fast: true`. With no model named, omit `model`; codex then uses
the model in `~/.codex/config.toml` (gpt-6.1-sol).

The `codex` MCP server runs `codex exec` in the project. Codex has its own shell and apply_patch, so
it reads the code, implements the change and runs the tests itself. **You are the lead**: you own the
goal, the effort choice, the decisions and the acceptance. Your tokens are the expensive ones, so
spend them on judgement, not legwork.

Tools: `delegate` (preferred: one call, no polling); `delegate_async` + `task_result` with a large
`wait_s` for parallel runs; `list_models`, `list_sessions`, `task_list`, `task_cancel`.

## 1. Decide whether to delegate

Delegate anything that needs investigation, multi-file changes or test runs. If you can already see
a change and make it in one or two edits, do it yourself, unless the user explicitly asked for Codex.

## 2. Choose the cost tier (`effort`, required)

`effort` names a tier of the user's delegation policy. Each tier fixes a model and a reasoning
effort. The tool description lists the tiers cheapest first, says when to use each, and carries
the user's cost guidance. Those come from the dashboard and override this section where they
differ. Defaults: `luna-xhigh` (gpt-6-luna#xhigh) → `low` (gpt-6.1-sol#low) →
`medium` (gpt-6.1-sol#medium) → `high` (gpt-6.1-sol#high).

- Cost matters, and quality isn't up for trade. Take the cheapest tier that will get it right. When
  unsure, take the cheaper one, unless the task is in the risky class the top tier names
  (security, money, concurrency, data migration, unclear root cause). There a failed attempt costs
  more than the difference.
- Escalate on evidence: after a check FAIL or a wrong result, continue the **same `session_id`** one
  tier up. Tiers pin their model, so escalating from `luna-xhigh` moves the session to gpt-6.1-sol.
- Each call picks its own tier. A small follow-up fix to a `high` run can drop back down.
- In your final report, give the tier you used and the reason in one phrase.

## 3. Write a lean brief (`prompt`)

Codex cannot see this conversation, but it can read the repo. Write what and why, not how:

1. **Goal** and the user-visible behaviour wanted.
2. **Where to start**: entry points you already know. Don't pre-read the codebase to spell out
   steps; Codex investigates. If you can't scope the task, first send a read-only question
   (`sandbox: "read-only"`, usually `effort: "low"` or `"medium"`).
3. **Constraints**: interfaces that must not change, files not to touch, no new dependencies.
4. **Done when**: acceptance criteria. Put the test/build commands in `checks` (e.g.
   `["npm test"]`); the server runs them on the host after Codex and returns PASS/FAIL.
   The sandbox may lack host-only dependencies (a specific Python, pyarrow, local CLIs), so
   `checks` is the real evidence. Ask that new tests not depend on machine-local tools on PATH.
5. **Invariants Codex can't see**: anything that lives only in this conversation or the project's
   history: past incidents and the fixes they produced, why an odd-looking line must stay (a
   `Kill($true)`, a retry or token-refresh path), exact business time windows, "library code has no
   process-wide side effects". Write each one as "must keep X, because Y". Codex simplifies or
   removes whatever it can't see a reason for, and tests usually still pass afterwards.
6. **One concern per task**: a large multi-file brief tends to time out or end without the commit
   you asked for. Split it into smaller tasks (parallel if the files don't overlap).
7. **Ask for a removals list**: have Codex report every existing behaviour it removed, disabled,
   narrowed or "simplified".

If the user already wrote a full spec, pass it through **as written** and add only what's missing.
Always pass `cwd` as the absolute project (or worktree) path. A working agreement and a JSON report
format are appended automatically.

Sandbox: `workspace-write` (default, no network); `read-only` for questions and reviews;
`danger-full-access` only when the task must install packages or use the network (tell the user).

## 4. Read the result and accept

You get Codex's status (`done` / `partial` / `blocked` / `needs_decision`), a summary, its
self-reported verification, risks, questions, per-file `+/-` counts and the host check results.

- **needs_decision / questions**: decide (ask the user only if it's truly theirs), then continue the
  same `session_id` with the answer.
- **Check FAIL or wrong behaviour**: continue the same session with the concrete failure, one tier
  up as above. Fix it yourself only if that's clearly smaller.
- **Read the removals first**: in the diff, go through removed and weakened code before the
  additions: deleted branches, narrowed conditions or time windows, dropped arguments and flags,
  disabled recovery paths. Silent regressions hide there, because the old behaviour often had no
  test. Check them against the invariants from the brief.
- **Acceptance**: PASS checks are your evidence. Read `git diff -- <path>` only where design or risk
  matters, or where the `+/-` counts look out of proportion. Don't re-read everything or re-run
  passing checks.
- High-risk change: get an independent review with a fresh read-only `delegate`: "review the
  uncommitted diff for bugs against these requirements: …".

Report briefly: tier (model#effort), what changed, check results, your verdict.

## 5. The user pressed Stop and changed direction

Stopping a `delegate` call kills the Codex run, and no result comes back. The server remembers the
interrupted session per `cwd`. Call `delegate` again in the same `cwd` with just the new direction
(and an effort fitting the new request). It resumes that session with Codex's context and partial
edits intact, tells Codex the new message wins, and the result starts with `continued: …`.

- Don't inspect the working tree or re-send the old brief first. Say what changed.
- `fresh: true` only if the user wants to drop the interrupted work and start clean. Then say what to
  revert.

## 6. Improve this skill and the project after the run

When review found a problem the brief or this skill should have prevented:

- **Generic** (it would recur in any project): change this skill by a few lines. Do it only for a
  real pattern, not a one-off (sandbox hiccup, flaky network, a model glitch). Keep the skill short:
  merge or replace rules instead of only appending. Edit the plugin source, copy the file into the
  active plugin cache, commit, and tell the user what changed.
- **Project-specific**: add it as "must keep X, because Y" to the project's `AGENTS.md`, which Codex
  reads on every run (or the nearest nested `AGENTS.md` for that module), and tell the user. Use
  Claude's memory only for what Codex doesn't need.
- Never record passwords, tokens, cookies, auth files or login links.

## Parallel work

One `delegate_async` per subtask, then `task_result` with a large `wait_s` for each. Runs that edit
files need separate git worktrees (`git worktree add`) or non-overlapping files.
