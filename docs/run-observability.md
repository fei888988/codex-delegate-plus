# Run watchdog and dashboard contract

New environment variables (integer seconds; `0` disables that idle detector):

| Variable | Default | Applies to |
| --- | ---: | --- |
| `CODEX_DELEGATE_IDLE_TIMEOUT` | 600 | Codex stdout silence with no in-flight command |
| `CODEX_DELEGATE_COMMAND_IDLE_TIMEOUT` | 1200 | One in-flight command and no stdout |
| `CODEX_DELEGATE_CHECK_IDLE_TIMEOUT` | 300 | Host check stdout/stderr silence |

Both delegate tools accept `idle_timeout_s?: number` (nonnegative integer), overriding
both Codex idle windows for that call. It does not override the host check idle window.
The existing overall Codex/check deadlines remain independent.

Before stopping an idle tree, the watchdog compares two cumulative tree CPU samples
about five seconds apart. CPU activity buys one additional idle window; it cannot
extend indefinitely. Sampling failures are treated as no observed CPU activity.
Windows samples use one PowerShell Toolhelp snapshot plus .NET cumulative process
CPU times per sample (no WMI/wmic dependency); POSIX samples use `ps`. Tests inject the sampler.
Windows termination uses `taskkill /T`, with a bounded Toolhelp snapshot/Node kill
fallback when the Windows token denies taskkill.

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
Otherwise health uses the current check's last output/start time, or the last Codex
event: active below 120 seconds, quiet thereafter, stalled beyond the applicable
enabled idle deadline. A disabled idle deadline stays quiet. Legacy runs retain
their existing log-mtime fallback.

Metadata changes are coalesced to at most one write per two seconds while running,
with a heartbeat every 15 seconds and immediate initial/final writes. Unchanged
snapshots are not written. Background `task_result` reads phase, elapsed minutes
since the last Codex event, and the current command directly from task memory.

Failures start with `status: error (<exitKind>[/<errorKind>])`. A single `next:` line
advises resuming a stalled session and addressing the hanging command, retrying
network/rate-limit crashes or API errors once with the same session, or telling the
user about quota/auth environment problems. Other failures retain the error details.
