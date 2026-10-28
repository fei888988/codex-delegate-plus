---
name: codex
description: Claude leads, a Codex model (GPT-6.1 Sol by default) does the work. Delegate implementation, debugging, tests or analysis to the Codex CLI while Claude briefs, picks the cheapest cost tier (model + reasoning effort) that will get the task right, and accepts the result. Use by default for implementation, debugging, tests, refactoring, code investigation and data analysis whenever the codex tools are available, even if the user does not mention Codex; skip it for quick single edits, frontend design and judgement calls. Also use when the user invokes /codex, or says things like "让 codex 做", "交给 sol", "use sol 6.1 to implement X", "have codex do it, you review", "get a second opinion from codex".
argument-hint: "[model] -- <task>  (e.g. sol 6.1 -- add input validation to the signup form)"
---

# Codex does the work, you lead

Task from the user (may be empty if the skill was triggered by conversation): $ARGUMENTS

If that text has `--`, the part before it names the model. Pass it to `model` unchanged and the
server resolves it. "fast" means `fast: true`. With no model named, omit `model`; codex then uses
the model in `~/.codex/config.toml` (gpt-6.1-sol).

The `codex` MCP server runs Codex (`codex app-server`) in the project. Codex has its own shell and apply_patch, so
it reads the code, implements the change and runs the tests itself. **You are the lead**: you own the
goal, the effort choice, the decisions and the acceptance. Your tokens are the expensive ones, so
spend them on judgement, not legwork.

Tools: `delegate` (preferred: one call, no polling); `delegate_async` + `task_result` with a large
`wait_s` for parallel runs and for long writer tasks the user may redirect; `task_steer` to add the
user's new or changed requirements to a running task (no cancel, Codex keeps its context; it reads
the message at its next step, edits already made stay); `list_models`, `list_sessions`, `task_list`,
`task_cancel` (to stop the task).

Long scripts and steering: `task_steer(now: true)` makes Codex read your message at once while a
long command it started keeps running. Say in the message what should happen to it: keep going,
check its log or partial results first and then decide, or stop it. Use `task_inspect` first if you
need to see its progress yourself. Add `kill: true` only when it must stop immediately. Codex has to
wait for or stop every kept command before finishing; the result lists each one under "background
commands kept across a redirect" with its outcome. If one says STOPPED BY THE SERVER, Codex forgot
it: decide whether it needs rerunning.

Checkpoints: for long or open-ended tasks (roughly 10+ minutes, several phases, or an investigation
whose findings could change the plan) pass `checkpoints: true`. Codex writes a short stage report at
points where direction may change and keeps working; `delegate` / `task_result` return early with
`status: checkpoint` and the report. Read it, then either `task_result(task_id, wait_s)` (on course)
or `task_steer` (change direction). Don't re-investigate what the report states. Skip checkpoints for
short, well-specified work: each one costs you a turn.

Long waits and patrol: patrol is on by default. A cheap read-only Codex checks the running worker
every 30 min (first check at 30 min, so short runs cost nothing) and wakes you only on
`patrol_alert` (stalled / off_course / uncertain, with evidence) or `patrol_failed` (the patrol
itself broke). So wait once with `task_result(task_id, wait_s: 86400)`, never in short repeated
waits. For long runs, pass `patrol.watch` with what only you know: expected duration, what counts
as off-course for this task (files or interfaces not to touch, steps not to skip), and commands
that are normally silent for long. On an alert the worker is still running: judge the evidence,
then keep waiting, `task_steer`, or `task_cancel`.

If a result says codex is out of quota (or not logged in): stop. Don't finish the work yourself and
don't sleep or poll for the reset; report what Codex finished, what is left, the reset time, and ask
the user how to proceed.

## 1. Decide whether to delegate

Delegate anything that needs investigation, multi-file changes or test runs. If you can already see
a change and make it in one or two edits, do it yourself, unless the user explicitly asked for Codex.

Opinion and direction calls are never delegated. When the question asks for judgement (which
approach, architecture or direction to take, whether a plan, design or trade-off is right, what to
prioritise or recommend), Codex only gathers objective facts and data: what the code actually does,
measurements, test or benchmark results, documented behaviour, counts and comparisons. Ask it for
findings, not conclusions. You form the judgement and make the final call; never adopt Codex's
opinion or recommendation as the answer.

## 2. Choose the cost tier (`effort`, required)

`effort` names a tier of the user's delegation policy. Each tier fixes a model and a reasoning
effort. The tool description lists the tiers cheapest first, says when to use each, and carries
the user's cost guidance. Those come from the dashboard and override this section where they
differ. Defaults, cheapest first: `light` (gpt-6-luna#xhigh), `scout` (gpt-6.1-terra#low),
`routine` and `ops` (gpt-6.1-terra#medium), `low` / `medium` / `high` (gpt-6.1-sol),
`deep` (gpt-6.1-sol#xhigh, escalation only).

First decide which of three kinds the task is, then pick the tier within that kind:

| Kind | What it is | Ladder |
|---|---|---|
| Read-only | Facts only, no edits | `light` → `scout` → `low` (risky code review: `high`) |
| Code change | New or changed behaviour | `light` → `routine` → `low` → `medium` → `high` → `deep` |
| Operations | Run a fixed spec; light glue code only | `ops` |

- **Read-only.** `light` when you know where to look and want a value, line, date or count back.
  `scout` (the default) when facts must be pieced together from several files, logs, data or test
  output. `low` when the question needs real reasoning, such as a root cause across modules;
  `high` when reviewing code that touches money, live trading, concurrency or security. Always
  ask for file:line on every fact and spot-check the ones your decision rests on: read-only
  results have no checks behind them.
- **Code change.** `routine` for small changes that follow an existing pattern (single-file bug with
  a known cause, tests for existing behaviour, config and script tweaks). Ordinary multi-file
  work stays on `low`. Keep Terra off writes that process untrusted external content.
- **Operations.** `ops` when the method, parameters, data and steps are already fixed: run a
  pre-registered backtest or study, train a model with a set data source and method, run an
  existing test suite or benchmark, batch-generate data. Codex may write glue code (config,
  runner scripts, path fixes) and assemble a new runner from the frozen functions the spec
  names (e.g. reuse `execute`, `shifted`, `bootstrap` from an existing study and only wire in
  the new variant), but must not change the method. If the run needs data-handling choices the
  spec leaves open (missing days, dividend or split adjustment, new data sources), it is a
  code change: use `low`. In the brief, state the spec
  exactly (or point to the prereg file and commit) and say any deviation means stop with
  `needs_decision`. Then:
  - a bug that needs diagnosis: continue the same `session_id` on `low` (`medium` if hard),
    never a higher Terra effort;
  - an unclear or contradictory spec: Codex stops; you decide, or ask the user;
  - live trading or production operations are never `ops`: use Sol, and only with the user's
    explicit go-ahead;
  - a long run is no reason to avoid Terra. Long commands go through the server's launcher
    (`longrun.mjs`), which works the same for every model; it is not a Sol feature. A Terra
    result that is `partial` after a warning like `Model metadata for gpt-6.1-terra not found`
    is an environment problem (codex-cli's model catalog had not caught up): resume the same
    `session_id` on `ops` once. Do not move it to Sol unless the retry also fails for a reason
    that is not environmental.

  Designing the experiment, choosing parameters and judging the results stay with you (or a
  code-change tier), not `ops`. For the first few `ops` runs, check the reported settings
  against the spec before trusting the results.
- Cost matters, and quality isn't up for trade. Take the cheapest tier that will get it right. When
  unsure, take the cheaper one, unless the task is in the risky class the top tier names
  (security, money, concurrency, data migration, unclear root cause). There a failed attempt costs
  more than the difference.
- Escalate on evidence: after a check FAIL or a wrong result, continue the **same `session_id`** on
  the next tier of the same kind. Tiers pin their model, so escalating can switch models.
- Model overload: the server already waits and resumes the same thread on its own (policy
  `overload`), so an `errorKind overloaded` result means its tolerance ran out. Then move read-only
  work to `light` or `scout` and small writes to `routine`, continuing the same `session_id`; work
  that needs `medium` or above waits for Sol, or ask the user. Never take the work over yourself.
- Each call picks its own tier, including resumes. The tier belongs to the call, not the session:
  before resuming a `session_id`, decide the kind and tier for *this* call's work and pass that,
  even if the session ran on another tier before. A `low` session whose next step is a re-run of
  a fixed spec resumes on `ops`; a small follow-up fix to a `high` run can drop back down.
  Never keep a tier only because the session used it last time.
- In your final report, give the tier you used and the reason in one phrase.

## 3. Write a lean brief (`prompt`)

Codex cannot see this conversation, but it can read the repo. Write what and why, not how:

1. **Goal** and the user-visible behaviour wanted.
2. **Where to start**: entry points you already know. Don't pre-read the codebase to spell out
   steps; Codex investigates. If you can't scope the task, first send a read-only question
   (`sandbox: "read-only"`, `effort: "light"` or `"scout"`; `"low"` when it needs real reasoning).
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
6. **One concern per task**: a large multi-file brief tends to time out or end with incomplete
   work. Split it into smaller tasks (parallel if the files don't overlap).
7. **Ask for a removals list**: have Codex report every existing behaviour it removed, disabled,
   narrowed or "simplified".

If the user already wrote a full spec, pass its implementation requirements through **as written**
and add only what's missing; retain any commit step with you as described below.
Always pass `cwd` as the absolute project (or worktree) path. A working agreement and a JSON report
format are appended automatically.

Commit ownership: Codex leaves changes uncommitted. Never ask it to commit in a brief or follow-up.
If the user's spec includes a commit request, keep that step with you and delegate the implementation
requirements. After acceptance and passing host checks, commit only the intended changes yourself
when the user requested a commit; push only when authorized.

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
