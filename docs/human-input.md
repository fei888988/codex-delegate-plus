# Human input during an app-server run

The dashboard is a separate loopback HTTP process. It communicates through each
run's `inbox/`; only the MCP process owning that active app-server run polls it,
at `checkpointPollMs`. Exec runs ignore inboxes.

All mutation endpoints use the policy endpoint's guard: loopback Host, matching
Origin when supplied, and `application/json`. Bad guards return 403. Run metadata
includes `engine`. Availability requires `state: running`, `engine: app-server`,
and a heartbeat no older than 90 seconds. Unavailable writes return 409 with
`reason: not_running|exec_engine|stale_heartbeat`.

| Endpoint | Contract |
| --- | --- |
| `GET /api/runs/:id/inputs` | `{available, reason?, inputs, longruns, interrupt}` |
| `POST /api/runs/:id/input` | `{mode:"steer"|"queue", text, notify?:boolean}` → 201 `{mid}` |
| `PATCH /api/runs/:id/input/:mid` | `{text}` → 200; 409 if claimed or no longer queued |
| `DELETE /api/runs/:id/input/:mid` | Withdraw → 200; 409 if claimed or no longer queued |
| `POST /api/runs/:id/interrupt` | `{reason?:string, killLongruns:boolean}` → 202; 409 if unavailable/already interrupting |

Input text is trimmed, nonempty, at most 4000 characters. Interrupt reasons have
at most 1000 characters. `notify` defaults to false. Inputs are sorted by `at` and
contain `{mid, mode, text, notify, at, from:"user"|"lead", state, stateAt, error?}`;
delivered user inputs also carry `turn`. `longruns` lists live launcher jobs as
`{n, command, startedAt, log}`. `interrupt` is null or
`{reason, killLongruns, at, state}`.

The dashboard atomically writes `<mid>.json` (temporary file + rename) containing
`{mid, mode, text, notify, at, from:"user"}`. The owner writes `<mid>.ack.json`
containing `{state, at, error?, turn?}`. States are queued, delivered, consumed,
withdrawn, undelivered, failed. Queued means picked up and waiting for turn end;
the HTTP view also displays unacknowledged messages as queued. Delivery claims
`<mid>.json` by renaming it to `<mid>.claimed.json`, then reads its current text.
An async per-message directory mutex also serializes claims, edits and withdrawals
across processes (needed for Windows rename races). Edits temporarily use
`<mid>.editing.json`. Withdrawn messages remain inspectable with a withdrawn ack.
Ack writes are atomic. A failed delivery includes an error. Queued delivery uses
the user-message consumed signal when available, otherwise delivered remains the
receipt. Interrupt files are `interrupt.json` and `interrupt.ack.json`; an exclusive
`interrupt.lock.json` prevents replacement by a second HTTP request.

Steer uses the same serialized redirect path as `task_steer(now:true)`: interrupt
the current turn and start a new turn on its thread, preserving launcher jobs and
their preamble/reminders. Non-launcher commands stop as before. Queue waits for a
completed turn (including partial/needs_decision reports), then starts one input
per new turn, ordered by `at`, before kept-job reminders or host checks. Withdrawn
inputs are skipped; remaining inputs become undelivered on failure, cancellation,
quota/auth termination or interruption. Lead steer calls are appended to
`lead.jsonl` as `{mid, mode:"steer", text, at, from:"lead", state}`.

Final sync/task results include `user input during run:` with each user message's
mode, timestamp, state, turn and approximately 300 characters of text. Notify
inputs additionally wake a waiting sync delegate or task_result once per message:

```
status: user_input (codex is still working; nothing was stopped)
...
next: tell the user what they changed, then task_result(task_id, wait_s) to keep waiting, or task_steer/task_cancel if your plan must change.
```

Interrupt sends turn/interrupt, ends with `user_interrupted`, skips/aborts host
checks, and returns a PAUSE instruction with the reason (or the bilingual missing
reason fallback), resumable session ID and undelivered queue. With killLongruns,
launcher jobs stop and are listed as stopped. Otherwise each job is listed as
`kept running by user choice` with PID, log and exit-file paths; that directory is
excluded from run-end and server-exit reaping. The pending continuation record is
retained. Normal reminder turns and killed_forgotten cleanup remain in force for
runs that finish normally.
