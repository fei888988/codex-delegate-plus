# Run watchdog and dashboard contract

Version 0.6.0 uses soft Codex stall suspicions: they wake the lead and **never kill**.

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

A sync `delegate` returns `status: suspected_stall (still running, not killed)` and a
`task_id`, session/run IDs, elapsed/idle time, command (up to 300 characters), threshold,
matched rule and evidence. The same run continues in the background, including host
checks, report parsing and diff counts. `task_result` returns that full normal outcome
when it finishes. `task_cancel` on a converted editing run retains Stop-to-redirect pending
session behavior in its cwd.

`task_result(task_id, wait_s?, stall_after_s?)` returns early on suspicion. An unseen
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
Sampling failure still wakes the lead. Windows uses Toolhelp plus .NET (no WMI/wmic);
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
type ErrorKind = "quota" | "rate_limit" | "auth" | "network" | "context" | "other";
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
  stalled: boolean;
  stall?: Stall;
};

// New/extended meta.json fields; API responses also include health.
// New runs always include phase, pid, heartbeatAt and the three idle windows.
// Old runs may lack these fields.
type ProgressFields = {
  phase?: "codex" | "checks" | "done";
  pid?: number;                 // MCP server PID
  codexPid?: number;
  lastEventAt?: number;         // any Codex stdout line, including non-JSON lines
  inflight?: { type: string; command?: string; startedAt: number }; // oldest item
  heartbeatAt?: number;
  exitKind?: ExitKind;
  errorKind?: ErrorKind;
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
