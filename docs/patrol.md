# Long waits and Codex patrol (0.15.0)

Patrol defaults to ON for `delegate` and `delegate_async`. Start the worker once,
then call `task_result(task_id, wait_s: 86400)` once. `wait_s` accepts 0–86400
seconds (default 0). Both waiting tools send MCP progress every 15 seconds when
the client supplies a progress token. This prevents Claude Code's 1800-second
inactivity abort; the client's total tool timeout still applies.

Optional worker input:

```json
{
  "patrol": {
    "every_s": 1800,
    "watch": "Expect 2 hours. Training may be silent for 45 minutes. Do not edit production files."
  }
}
```

`patrol: false` restores direct watchdog suspicion wakes. `every_s` has a 600-second
minimum. Omission uses policy defaults, including for read-only workers.

`policy.json` and GET/PUT `/api/policy` accept:

```json
{ "patrol": { "tier": "light", "every_s": 1800, "timeout_s": 300 } }
```

Omit `tier` to select the first (cheapest) policy tier. Provider selection follows
the existing tier/default-provider rules; a provider's model override still applies.
PUT accepts partial objects and recursively merges settings, retaining other policy
fields and user extension fields. Arrays supplied by a PUT replace their old arrays.
There is no need to rewrite an existing policy file to enable patrol.

The first check is one interval after the worker process starts. Subsequent ticks
start a fresh read-only Codex session. A tick during an existing check is skipped;
there is never more than one check per worker in flight. Patrol has no worker session
ID, run directory, host checks, checkpoints, inbox, handoffs or pending record. It
cannot replace the interrupted worker's session or take ownership of its longruns.
The worker's completion or cancellation stops the timer and aborts active patrol.
Patrol ends before host checks begin. Patrol sessions are not recorded as standalone runs.

The server supplies a bounded evidence digest: the saved original brief, watch
notes, elapsed time, phase, inflight command and idle time, latest CPU/IO sample,
about 20 recent events, the command log tail, checkpoints, asynchronous
`git diff --stat HEAD`, and prior patrol verdicts. If the command log cannot be
identified from its launcher number, the newest command log is used and named in
the digest. Missing evidence stays explicit. Patrol is instructed to judge this
digest without exploring or running tools. It checks progress, stalls, deviations
from the brief, repeated failures, loops, skipped tests, and elapsed time over
twice any stated expectation. Uncertainty requires concrete evidence too.

Results while the worker remains running:

| Result | Lead wake |
| --- | --- |
| `healthy` | None; keep waiting |
| `stalled`, `off_course`, `uncertain` | `status: patrol_alert`, with reason, evidence and optional suggestion |
| Timeout, quota/auth, crash/nonzero exit, missing/invalid verdict | `status: patrol_failed`, with error kind/message |

Alerts are queued until a waiter collects them; each is delivered once. The next
line tells the lead to keep waiting with `task_result`, redirect with `task_steer`,
or stop with `task_cancel`. Patrol never stops the worker. No failed patrol is
automatically retried; the ordinary periodic schedule continues and reports each
subsequent failure as an alert. Existing checkpoints, user inputs and handoffs
remain independent wake sources.

Watchdog suspicion triggers an out-of-cycle triage patrol. If another check is
running, triage is queued immediately behind it and uses fresh evidence. Healthy
triage rearms the existing watchdog with its doubled window and suppresses the wake.
Any other verdict or failure wakes with both the suspicion and the patrol result.
The third consecutive suspicion for the same inflight item always wakes immediately,
even during patrol. New worker output resets the existing suspicion/backoff counter.
An acknowledged alert allows the next positive wait to rearm, just like a direct
suspicion wake; `stall_after_s` can explicitly override the next window.

Worker `meta.json` stores resolved `patrol` configuration and completed `patrols`
records (`at`, `verdict`, `reason`, `evidence`, optional `suggestion`, `error`, and
`suspicionAt`). The dashboard API exposes these without UI changes. A patrol
cancelled because its worker ended does not produce an alert or completed-check
record. Final worker output adds only `patrol: N checks, M alerts` when checks ran;
M counts non-healthy verdicts and patrol failures. An uncollected patrol alert is
still delivered if the worker has since finished, labeled accordingly; the next
`task_result` collects the unchanged final outcome. This keeps a patrol failure
visible even when completion races with alert collection.
Worker quota/auth STOP always takes priority on first collection; any queued patrol
alert remains available on the next collection. Host checks and hard orphan timeouts
are unchanged.

Tests can accelerate intervals only under Node's test runner with
`CODEX_DELEGATE_TEST_FAST_PATROL=1` (minimum 0.01s), and heartbeats with
`CODEX_DELEGATE_TEST_HEARTBEAT_MS`. These overrides do not apply to normal servers.


### Repeat alerts and worker timeout (0.17.0)

Non-healthy verdicts require a boolean `new`. Set it to true for a previously unreported problem, new worker evidence of recurrence, or clear worsening (for example crossing a longer stall threshold). Set it to false for a restatement. Missing or invalid values fail loud as true. `priorAlerts` contains verdict/reason/evidence and `reported_to_lead` delivery flags as context; prior patrol records are NOT worker evidence. Use worker events, logs, commands, diff or fresh watchdog samples instead.

A non-healthy `new: false` is recorded with `repeat: true`, does not wake the lead, and is attached once to the next task result as `patrol repeat: <verdict> - <reason>, <time>`. Final summaries show `patrol: N checks, M alerts, R repeats` (repeats omitted when zero). Healthy checks never wake; patrol failures always wake. New evidence (`new: true`) still wakes, including for the same kind of problem. Watchdog triage and the third-suspicion backstop remain in effect.

With patrol enabled, the worker default timeout is policy `patrol.timeout_default_s` (positive integer, default 14400 seconds). With `patrol: false`, the existing configured default remains 1800 seconds unless configured otherwise. Explicit `CODEX_DELEGATE_TIMEOUT` overrides the patrol default; explicit tool `timeout_s` overrides both. Meta records `timeoutSec` and `timeoutSource`. `patrol.timeout_s` remains the separate per-patrol-run limit (300 seconds by default). GET/PUT `/api/policy` exposes and merges the new field without replacing other policy settings.
