# Run watchdog and dashboard contract

Version 0.15.0 adds default-on [Codex patrol](patrol.md) to triage soft stall
suspicions before waking the lead. Healthy patrols keep the lead asleep; alerts,
patrol failures and the third consecutive suspicion wake it. Soft suspicion and
patrol never kill the worker. `patrol: false` restores direct suspicion wakes.

| Variable | Default | Applies to |
| --- | ---: | --- |
| `CODEX_DELEGATE_IDLE_TIMEOUT` | 600 | No output with no command in flight |
| `CODEX_DELEGATE_COMMAND_IDLE_TIMEOUT` | 600 | Command in flight with no output |
| `CODEX_DELEGATE_HARD_IDLE_TIMEOUT` | 3600 | Suspected background task with neither output nor task_result/task_list observation for this long |
| `CODEX_DELEGATE_CHECK_IDLE_TIMEOUT` | 300 | Host check stdout/stderr silence (still kills hung checks) |

`0` disables the corresponding detector; a zero base command window also disables long-command rules. Total `timeout_s`, cancellation/Stop, and server shutdown still kill.
Both delegate tools accept `stall?: { silent_s?: number, command_s?: number,
long_commands?: { match: string, idle_s: number }[] }`. Seconds are nonnegative integers.
Command rules are case-insensitive JS regexes, first match wins; invalid regexes are ignored.
Call rules precede policy.json rules. The built-in policy matches
`unittest discover|pytest|npm (run )?test|node --test` at 1800 seconds.
`idle_timeout_s` remains compatible and sets both base windows; explicit stall fields win.
Policy base windows fall back to the environment defaults. Host checks are unaffected.

With patrol disabled (or at the third consecutive suspicion), a sync `delegate`
returns `status: suspected_stall (still running, not killed)` and a
`task_id`, session/run IDs, elapsed/idle time, command (up to 300 characters), threshold,
matched rule and evidence. The same run continues in the background, including host
checks, report parsing and diff counts. `task_result` returns that full normal outcome
when it finishes. `task_cancel` on a converted editing run retains Stop-to-redirect pending
session behavior in its cwd.

`task_result(task_id, wait_s?, stall_after_s?)` accepts waits up to 86400 seconds.
With patrol enabled, pass `wait_s: 86400` once; 15-second MCP progress heartbeats
(when a progress token is present) prevent Claude Code's inactivity abort.
It returns early for `patrol_alert` / `patrol_failed`, existing notify inputs,
handoffs and checkpoints, or a direct/backstop suspicion. An unseen
wake is delivered once; a subsequent positive wait acknowledges it and doubles that
item's next window from the time waiting resumes. `stall_after_s` instead sets the
current item's next window (0 disables until new output). Polling without waiting does
not re-arm or repeatedly sample. Any new output event clears suspicion and backoff.
Async tasks use identical wake semantics. Active waiters and task_result/task_list
observations prevent the hard-idle orphan guard; an unobserved suspected background
task is killed with `exitKind: "stalled"`, retaining the existing resume hint.

CPU no longer automatically extends Codex windows. At suspicion, best-effort evidence
includes process-tree CPU delta over a short sample, descendant count, and the busiest
descendant's PID, name, CPU delta in milliseconds, and RSS/working set in bytes.
Sampling failure still produces suspicion (triaged by patrol when enabled).
Windows uses Toolhelp plus .NET (no WMI/wmic);
POSIX uses `ps`. Host-check CPU extension behavior remains unchanged.

Live meta adds `suspicion` (suspectedAt, wakes, thresholdSec, matchedRule, evidence,
command/idle details), `effectiveThresholdSec`, `stallWindowSince`, `matchedRule` and `stallPolicy`.
Existing fields remain compatible. Dashboard health uses the effective command rule
and reports a pending suspicion as `stalled`; this health label does not mean killed.

The following TypeScript shapes describe the JSON fields exactly. `?` fields are
omitted when unavailable (never serialized as `undefined`). All numeric timestamps
are Unix epoch **milliseconds**; timeline `ts` is an ISO timestamp or `null`.

```ts
type ExitKind = "completed" | "timeout" | "stalled" | "cancelled" | "crashed" | "api_error";
type ErrorKind = "quota" | "rate_limit" | "auth" | "network" | "overloaded" | "context" | "other";
type Stall = {
  kind: "silent" | "command";
  idleMs: number;
  command?: string;
  commandStartedAt?: number;
};

// New RunResult fields. ok is true only for exitKind === "completed".
type ResultFields = {
  exitKind: ExitKind;
  errorKind?: ErrorKind;
  overloadRetries?: number;
  overloadLastProgressAt?: number;
  overloadConsecutive?: number;
  overloadDurationMs?: number;
  stalled: boolean;
  stall?: Stall;
};

// New/extended meta.json fields; API responses also include health.
// New runs always include phase, pid, heartbeatAt and the three idle windows.
// Old runs may lack these fields.
type ProgressFields = {
  phase?: "codex" | "overload_wait" | "checks" | "done";
  pid?: number;                 // MCP server PID
  codexPid?: number;
  lastEventAt?: number;         // any Codex stdout line, including non-JSON lines
  inflight?: { type: string; command?: string; startedAt: number }; // oldest item
  heartbeatAt?: number;
  exitKind?: ExitKind;
  errorKind?: ErrorKind;
  overload?: { attempt: number; consecutive: number; limit: number; totalRetries: number; nextRetryAt?: number; lastProgressAt?: number; lastError?: string };
  stall?: Stall;
  checksStartedAt?: number;
  idleTimeoutSec?: number;
  commandIdleTimeoutSec?: number;
  checkIdleTimeoutSec?: number;
  checks?: CheckSummary[];
  health?: "ok" | "active" | "quiet" | "stalled" | "orphaned"; // derived by API only
};

type CheckSummary = {
  command: string;
  startedAt: number;
  state?: "running" | "done";
  lastOutputAt?: number;
  // Present after completion:
  ok?: boolean;
  exitCode?: number | null;
  timedOut?: boolean;
  stalled?: boolean;
  durationMs?: number;
  lastLine?: string;
};

// CheckResult returned internally: all completion fields are required.
type CheckResult = {
  command: string;
  startedAt: number;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stalled: boolean;
  durationMs: number;
  lastLine: string;
  tail?: string;                // failures only; omitted from meta.json
};

// runCodex onProgress callback (in memory; id is omitted from persisted inflight):
type CodexProgress = {
  codexPid?: number;
  lastEventAt: number;
  inflight?: { id: string; type: string; command?: string; startedAt: number };
};

// GET /api/runs/:id/timeline?after=0
type Timeline = {
  runId: string;
  sessionId: string | null;
  source: "rollout" | "events";
  entries: TimelineEntry[];
  nextSeq: number;
  done: boolean;
};
type TimelineEntry = {
  seq: number;
  ts: string | null;
  kind: "user" | "assistant" | "reasoning" | "command" | "tool" | "tool_output"
    | "file_change" | "tokens" | "error" | "system";
  title: string;
  text: string;
  status?: string;
  exitCode?: number | null;
  durationMs?: number;
  callId?: string;
};
```

`GET /api/runs` keeps its existing envelope (`generatedAt`, `runsDir`, `version`,
`runs`, `pending`, `tasks`). Each run includes the progress fields above, including
`health`, and still omits `report` and limits `prompt` to 300 characters.
`GET /api/runs/:id` keeps the full metadata plus `promptFull` and `lastMessage`.
The new timeline route is GET-only. Existing policy routes are unchanged.

`after` is a nonnegative safe integer, exclusive. Sequence numbers are physical
JSONL line numbers, starting at 1; malformed lines can leave gaps. Each response
contains at most 500 entries. Pass `nextSeq` as the next `after`. An empty page
preserves the supplied cursor. `done` means the run is no longer running, even if
more pages remain. Rollout and fallback event cursors belong to their `source`;
reset the cursor to zero if a later poll changes source from events to rollout.

Rollout lookup honors `CODEX_HOME`, searching the UTC start date and following day
under `sessions/YYYY/MM/DD/rollout-*-<sessionId>.jsonl`. Found paths are cached;
missing paths are retried on later polls. The full session rollout is exposed,
including prior turns when a session was resumed. Fallback `events.jsonl` timestamps
are `null`. Call/output durations are paired by `call_id`, even across the cursor.
Titles collapse whitespace and cap at 200 characters. Text caps at 20,000 characters
including the `…[truncated N chars]` marker. Developer/system prompt boilerplate is represented
by short `system` markers. Unknown metadata records are also kept as system markers.

Finished runs have `health: "ok"` (this is liveness, not success). Running runs are
orphaned if their server PID is dead or a present heartbeat is older than 90 seconds.
Otherwise health uses the current check's last output/start time, or the current Codex suspicion window (last event, or the last acknowledged wake): active below 120 seconds, quiet thereafter, stalled beyond the applicable
enabled idle deadline. A disabled idle deadline stays quiet. Legacy runs retain
their existing log-mtime fallback.

Metadata changes are coalesced to at most one write per two seconds while running,
with a heartbeat every 15 seconds and immediate initial/final and suspicion transition writes. Unchanged
snapshots are not written. Background `task_result` reads phase, elapsed minutes
since the last Codex event, and the current command directly from task memory.

Failures start with `status: error (<exitKind>[/<errorKind>])`. A single `next:` line
advises resuming a stalled session and addressing the hanging command, retrying
network/rate-limit crashes or API errors once with the same session, or telling the
user about quota/auth environment problems. Other failures retain the error details.

App-server model capacity failures have `errorKind: "overloaded"`. They resume
the same thread and model automatically, without completing the run or waking the
lead. The policy `overload` section merges missing fields with defaults:
`{ backoff_s: [30, 60, 60, 120, 120], max_total_retries: 30 }`.
Backoff entries are integer seconds between 0 and 120. Each consecutive failure
without progress consumes one entry; after five such retries another no-progress
failure exhausts the default schedule. A newly completed command, file change or
agent message, or new output tokens, resets the counter to zero and restarts at
the first delay. Duplicate items and unchanged token totals do not reset it.
The total retry cap and original run timeout still apply regardless of progress.
Models never switch automatically. The exec engine only classifies overloads.

During backoff `phase: "overload_wait"` keeps heartbeats active, disables stall
windows, and is active dashboard health (ownership/heartbeat checks still apply).
Patrol does not launch during the wait; a patrol already in flight cannot publish
an alert or error while the worker is waiting. Cancellation and inbox interrupt
end the run promptly; steer starts the next turn immediately with the overload
continuation message and the steer text. Queued inbox inputs still drain normally.
Live launcher jobs remain in `kept` and in the continuation preamble; overload
recovery never kills them. Final cleanup and kept-command reminders still apply.

`meta.overload.attempt` counts overloaded failed turns; `consecutive` counts
no-progress failures since the latest progress (zero for a turn with progress),
`limit` is the schedule length, and `totalRetries` counts actual turn/start
retry requests. `nextRetryAt` records the scheduled retry time and is cleared on
resume; a terminal cancellation/timeout during the wait may retain it. `lastProgressAt`
is the most recent progress timestamp, initially the run start; `lastError`
holds the latest overload message. Final values remain in metadata after exit.
Result `overloadRetries`, `overloadConsecutive`, `overloadLastProgressAt`
and `overloadDurationMs` expose retry count, final consecutive count, last progress
and elapsed time since the first overload. Exhaustion returns
`api_error/overloaded`, skips host checks and advises the lead to continue the
same session at the same tier or a cheaper policy tier, without taking over.
Successful recovery adds only `model overload: auto-resumed N times` for overload.

App-server `turn.usage` events contain cumulative run usage (`cumulative: true`),
excluding earlier turns in a resumed session. Metadata/result `tokens` now retain
usage on failed, cancelled and timeout exits too. Completed-turn events carrying
the same cumulative usage are deduplicated; exec per-turn usage still sums.

## v0.7.0 diagnostics and retention contract

Both delegate tools advertise `sandbox: "read-only" | "write"` and accept optional
`add_dirs: string[]`. Legacy `workspace-write` and `danger-full-access` inputs map
to write. The policy field `sandboxWrites` defaults to false, including when absent
from existing files; false maps write to danger-full-access, true to workspace-write.
Read-only remains read-only, including `auto: false` unless sandbox is explicit.
`CODEX_DELEGATE_SANDBOX=read-only` still supplies a read-only default; other legacy
environment values select write and follow the toggle. GET/PUT `/api/policy` return,
validate and persist both `sandboxWrites` and `retention` like existing policy keys.
User-editable policy guidance is unchanged; the server appends the logging instruction
with the absolute run directory to the Codex prompt.

Each launch passes `--add-dir <runDir>` plus each requested additional directory,
including resumed sessions. Workspace-write also creates `<runDir>/tmp`, sets TEMP
and TMP for the child only, then deletes tmp when the run ends. The effective sandbox
is recorded in run metadata and final results. Additional directories do not change
the selected sandbox mode.

Codex is instructed to tee commands expected to exceed about one minute to
`<runDir>/cmd-<n>.log`. Suspicions include the newest file's byte size and last 15
lines, bounded to approximately 1.5KB. Logging is cooperative and may be absent.
Every 60 seconds during an inflight Codex command the server samples process-tree
evidence, storing a ten-point ring in `meta.json.trend`. Points include timestamp,
command/start time, cumulative CPU milliseconds, RSS bytes, optional IO read/write
bytes, process details, and command-log byte count. Windows uses Toolhelp/.NET and
GetProcessIoCounters without WMI; inaccessible IO counters are omitted and unavailable
command lines are skipped. The busiest process name/PID remains available when
process sampling succeeds. RSS covers the process tree.

Wake trends show interval CPU/IO deltas, RSS and log growth, followed by working/hung
judgment hints. Missing counters remain unknown; process exits can reduce cumulative
totals, so deltas are clamped at zero and are evidence, not a definitive hang test.
`commands: { command, durationMs }[]` records paired command start/completion events.
The command class strips paths, simple environment assignments, cd prefixes and
shell wrappers, retaining `python -m <module>` and npm/pnpm/yarn subcommands.
Historical matching Codex commands and host checks supply nearest-rank p50/p90
seconds when n >= 3, excluding the current run. Unpaired/interrupted commands do not
contribute timing samples.

`task_inspect(task_id)` is read-only: a fresh sample and delta against the last
periodic/suspicion sample, newest command log tail (or saved success tail), last five
events, and top ten cwd files modified within 30 minutes. Files are sorted by mtime;
.git/node_modules and symlinks are skipped and traversal is capped at 20,000 entries.
Inspection does not update observation timestamps, acknowledge a suspicion, re-arm
windows or persist its sample. Process sampling failure is reported gracefully.

Command event outputs are scanned for PermissionError, WinError 5, Access is denied,
拒绝访问, EACCES and EPERM. `denials: { count, paths }` groups paths and deduplicates
cumulative updates per command. Final/wake reports lead with `sandbox_denied`, paths
and recovery advice. `lastInflight` and `lastEvidence` retain diagnostics after exit.
An explicit or automatic session resume finds the latest terminated matching run;
failed/interrupted/denied attempts add a <600-character "Previous attempt diagnosis"
prefix with exit kind, denied paths, last command and evidence.

Retention fields (positive numeric limits, missing fields merge defaults):

| Policy field | Default | Behavior |
| --- | ---: | --- |
| retention.cmdLogMaxMB | 5 | At sampling and exit, truncate oversized logs keeping tail |
| retention.failedLogDays | 3 | Remove retained command logs after this many days |
| retention.runDays | 30 | Remove finished run directories after this many days |
| retention.totalMaxMB | 1024 | Remove oldest unprotected runs first over this runs-directory cap |

Successful runs save each command log's last 2048 bytes in `cmdLogTails`, then delete
those files; runs with failed host checks retain their logs too. Cleanup occurs at
MCP startup and hourly on an unref'd timer, using the latest policy. Running records
with a live server/child PID or recent heartbeat are protected across server instances.
Ambiguous legacy running records without liveness fields are conservatively protected.
Protected runs and non-run records may keep the directory above the cap. Pending
resume and stored task records are not removed by run-directory cleanup.

## Server exit recovery (v0.17.1)

MCP and dashboard startup asynchronously sweep only run metadata. A running run is
interrupted when its owner PID is dead (ESRCH; EPERM remains alive), or its heartbeat
is over 10 minutes old, covering PID reuse. A fresh heartbeat always protects a run;
the current process's runs and all terminal states are skipped. Missing ownership
and heartbeat evidence is left alone. A snapshot is re-read immediately before an
atomic temporary-file rename; concurrent metadata changes skip recovery.

Graceful exit writes only this process's tracked, still-running metadata, without a
directory walk. Recovery sets `state: "interrupted"`, `phase: "done"`, the existing
`exitKind: "cancelled"`, and `interruptedReason: "owning server exited"`. `endedAt`
is the last heartbeat, falling back to lastEventAt/startedAt for legacy records;
duration is recomputed and inflight cleared. Dashboard health then uses the normal
terminal-run `ok` label rather than orphaned. Stored-task interruption and its resume
message are unchanged. Pending redirects, handoffs, inbox and kept jobs are untouched;
recovery does not kill processes. Abrupt exits are repaired at the next startup.
