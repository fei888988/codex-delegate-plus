import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";
import type { RunOptions, RunResult, Suspicion } from "../src/codex.ts";
import type { RunSummary } from "../src/run-summary.ts";

const dir = await mkdtemp(join(tmpdir(), "patrol-test-"));
Object.assign(process.env, { CODEX_BIN: join(import.meta.dirname, "fixtures/fake-patrol-codex.mjs"),
  CODEX_DELEGATE_ENGINE: "exec", CODEX_DELEGATE_RUNS_DIR: dir,
  CODEX_DELEGATE_POLICY: join(dir, "policy.json"), CODEX_DELEGATE_PROVIDERS: join(dir, "providers.json"),
  CODEX_HOME: dir, CODEX_DELEGATE_TEST_FAST_PATROL: "1", PATH: "", Path: "" });
const { PatrolMonitor, parseVerdict, evidenceDigest, patrolConfig } = await import("../src/patrol.ts");
const { startTask, delegateSync, waitTask, formatPatrolAlerts, newPatrolAlerts, wakeSuspicion } = await import("../src/tasks.ts");
const { formatOutcome } = await import("../src/delegate.ts");
const { loadPending } = await import("../src/pending.ts");
after(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const suspicion = (wakes: number): Suspicion => ({ suspectedAt: Date.now() + wakes, wakes, kind: "command", idleMs: 1000, thresholdSec: 1, evidence: {}, command: "silent-test-command" });
const verdict = (v = "healthy") => JSON.stringify({ verdict: v, reason: "test reason", evidence: ["test command idle 5s"] });
const result = (text = verdict(), patch: Partial<RunResult> = {}) => ({ ok: true, text, exitKind: "completed", exitCode: 0, ...patch }) as RunResult;
function setup(runner: (o: RunOptions) => Promise<RunResult>) {
  const meta: RunSummary = { id: "unit", startedAt: Date.now(), state: "running", phase: "codex", cwd: dir,
    patrol: { tier: "light", every_s: .02, timeout_s: 1 }, patrols: [] };
  const task = { status: "running", startedAt: meta.startedAt, progress: meta, input: { prompt: "test" }, control: { lastObservedAt: Date.now() },
    controller: new AbortController(), listeners: new Set<() => void>(), promise: new Promise<void>(() => {}) } as import("../src/tasks.ts").Task;
  let rearmed = 0;
  task.control.rearm = () => { rearmed++; meta.suspicion = undefined; };
  const monitor = new PatrolMonitor(meta, undefined, () => { for (const f of task.listeners) f(); },
    () => task.control.rearm?.(), runner, async () => "test digest");
  return { meta, task, monitor, rearmed: () => rearmed };
}

test("strict final JSON verdict requires concrete non-healthy evidence", () => {
  assert.equal(parseVerdict(`prose\n\`\`\`json\n${verdict()}\n\`\`\``).verdict, "healthy");
  for (const text of ["", "bad", verdict("unknown"), '{"verdict":"uncertain","reason":"?","evidence":[]}', verdict() + " trailing text"]) {
    assert.throws(() => parseVerdict(text));
  }
});

test("healthy patrol never wakes a waiting lead; read-only fresh runner options", async () => {
  const s = setup(async o => {
    assert.equal(o.sandbox, "read-only"); assert.equal(o.sessionId, undefined);
    assert.equal(o.runDir, undefined); assert.equal(o.stallControl, undefined);
    assert.equal(o.effort, "xhigh"); assert.equal(o.model, "gpt-6-luna");
    assert.match(o.prompt, /Check: \(1\) progressing/);
    return result();
  });
  let woke = false;
  const wait = waitTask(s.task, .15).then(() => { woke = true; });
  await s.monitor.check();
  assert.equal(woke, false); assert.equal(newPatrolAlerts(s.task).length, 0);
  await wait; await s.monitor.stop();
});

test("non-healthy wakes once with patrol_alert and next actions", async () => {
  const s = setup(async () => result(verdict("stalled")));
  const wait = waitTask(s.task, 10);
  await s.monitor.check(); await wait;
  const text = formatPatrolAlerts(s.task);
  assert.match(text, /status: patrol_alert/); assert.match(text, /stalled/);
  assert.match(text, /test command idle/); assert.match(text, /next:.*task_result.*task_steer.*task_cancel/);
  assert.equal(newPatrolAlerts(s.task).length, 0); await s.monitor.stop();
});

test("an uncollected patrol failure remains visible after worker completion", async () => {
  const s = setup(async () => result("bad JSON"));
  await s.monitor.check();
  s.task.status = "done";
  assert.equal(newPatrolAlerts(s.task).length, 1);
  const text = formatPatrolAlerts(s.task);
  assert.match(text, /patrol_failed \(raised during the run; codex has finished, final result below\)/);
  assert.match(text, /invalid_verdict/); assert.doesNotMatch(text, /next:/);
  assert.equal(newPatrolAlerts(s.task).length, 0);
  await s.monitor.stop();
});

test("worker quota/auth STOP retains first-collection priority over a queued patrol alert", async () => {
  for (const errorKind of ["quota", "auth"] as const) {
    const s = setup(async () => result("bad JSON"));
    await s.monitor.check(); s.task.status = "error";
    s.task.outcome = { result: result("", { errorKind, ok: false }) } as import("../src/delegate.ts").DelegateOutcome;
    assert.equal(newPatrolAlerts(s.task).length, 0);
    s.task.shownStop = true;
    assert.equal(newPatrolAlerts(s.task).length, 1);
    assert.match(formatPatrolAlerts(s.task), /patrol_failed/);
    await s.monitor.stop();
  }
});

for (const failure of ["timeout", "bad JSON", "quota", "auth", "crash", "nonzero"]) {
  test(`patrol failure ${failure} wakes with patrol_failed`, async () => {
    const s = setup(async o => {
      if (failure === "timeout") return new Promise((_, reject) => o.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      if (failure === "bad JSON") return result("garbage");
      if (failure === "crash") throw new Error("runner crashed");
      if (failure === "nonzero") return result(verdict(), { exitCode: 2 });
      return result("", { ok: false, exitCode: 1, exitKind: "api_error", errorKind: failure as "quota" | "auth", error: failure });
    });
    if (s.meta.patrol) s.meta.patrol.timeout_s = .02;
    const wait = waitTask(s.task, 10);
    await s.monitor.check(); await wait;
    const text = formatPatrolAlerts(s.task);
    assert.match(text, /status: patrol_failed/);
    assert.match(text, failure === "bad JSON" ? /invalid_verdict/ : failure === "nonzero" ? /exit 2/ : new RegExp(failure));
    assert.equal(s.meta.patrols!.length, 1); await s.monitor.stop();
  });
}

test("triage healthy suppresses suspicion wake and rearms; third suspicion always wakes", async () => {
  const s = setup(async () => result());
  s.meta.suspicion = suspicion(1);
  let woke = false;
  const wait = waitTask(s.task, .2).then(() => { woke = true; });
  s.monitor.observe(s.meta.suspicion);
  await s.monitor.check();
  assert.equal(s.rearmed(), 1); assert.equal(woke, false);
  assert.equal(s.task.seenWake, undefined);
  s.meta.suspicion = suspicion(3);
  assert(wakeSuspicion(s.task));
  for (const notify of s.task.listeners) notify();
  await wait;
  assert.equal(s.task.seenWake, s.meta.suspicion.suspectedAt);
  await s.monitor.stop();
});

test("failed triage includes suspicion evidence and acknowledges wake", async () => {
  const s = setup(async () => result("bad"));
  s.meta.suspicion = suspicion(1);
  s.monitor.observe(s.meta.suspicion);
  await s.monitor.check();
  const text = formatPatrolAlerts(s.task);
  assert.match(text, /patrol_failed/); assert.match(text, /suspected_stall/);
  assert.match(text, /silent-test-command/);
  assert.equal(s.task.seenWake, s.meta.suspicion.suspectedAt);
  // Acknowledged failure permits the existing next-wait rearm semantics.
  await waitTask(s.task, .01); assert.equal(s.rearmed(), 1);
  await s.monitor.stop();
});

test("a suspicion during periodic patrol queues fresh triage without overlap", async () => {
  let release!: () => void, calls = 0;
  const s = setup(async () => {
    if (++calls === 1) await new Promise<void>(r => { release = r; });
    return result();
  });
  const first = s.monitor.check();
  await sleep(5);
  s.meta.suspicion = suspicion(1); s.monitor.observe(s.meta.suspicion);
  assert.equal(calls, 1);
  release(); await first; await s.monitor.check();
  assert.equal(calls, 2); assert.equal(s.rearmed(), 1);
  await s.monitor.stop();
});

test("single in-flight patrol and stop cancels it and all future schedules", async () => {
  let calls = 0, aborted = false;
  const s = setup(async o => {
    calls++;
    return new Promise((_, reject) => o.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }, { once: true }));
  });
  s.monitor.start();
  await sleep(50);
  await s.monitor.stop();
  assert.equal(calls, 1); assert(aborted);
  await sleep(50); assert.equal(calls, 1); assert.equal(s.meta.patrols!.length, 0);
});

test("patrol:false retains direct suspicion / seenWake / rearm behaviour", async () => {
  const s = setup(async () => { throw new Error("must not run"); });
  s.meta.patrol = false; s.meta.suspicion = suspicion(1);
  await waitTask(s.task, 10);
  assert.equal(s.task.seenWake, s.meta.suspicion.suspectedAt); assert.equal(s.rearmed(), 0);
  await waitTask(s.task, .01); assert.equal(s.rearmed(), 1);
  s.monitor.start(); await s.monitor.check(); await s.monitor.stop();
});

test("real worker lifecycle: queued alerts, persisted config/history, pending stays worker-only", async () => {
  const task = startTask({ cwd: dir, prompt: "worker delay=1500", patrol: { every_s: .1, watch: "off_course" } }, true, async () => ({}));
  try {
    for (let i = 0; i < 100 && !newPatrolAlerts(task).length; i++) await sleep(20);
    assert(newPatrolAlerts(task).length > 0);
    // loadPending intentionally hides records belonging to a live server; inspect the raw record.
    const pendingFiles = await readdir(join(dir, "pending"));
    assert.equal(pendingFiles.length, 1);
    const pending = JSON.parse(await readFile(join(dir, "pending", pendingFiles[0]!), "utf8"));
    assert.equal(pending?.sessionId, "worker-session");
    assert.equal(pending?.runDir, join(dir, task.progress!.id));
    const before = Date.now(); await waitTask(task, 86400);
    assert(Date.now() - before < 1000);
    assert.match(formatPatrolAlerts(task), /patrol_alert/);
    const meta = JSON.parse(await readFile(join(dir, task.progress!.id, "meta.json"), "utf8"));
    assert.equal(meta.patrol.watch, "off_course"); assert(meta.patrols.length > 0);
    assert(!(await readdir(dir)).some(n => n.includes("patrol-session")));
  } finally { task.controller.abort(); await task.promise; }
  assert.equal(loadPending(dir)?.sessionId, "worker-session");
  const runFiles = await readdir(join(dir, task.progress!.id));
  assert(!runFiles.includes("handoffs")); assert(!runFiles.includes("inbox"));
  assert.match(formatOutcome(task.outcome!), /patrol: \d+ checks, \d+ alerts/);
});

test("sync delegate wakes on patrol alert while worker keeps running", async () => {
  const task = await delegateSync({ cwd: dir, sandbox: "read-only", prompt: "worker delay=2000", patrol: { every_s: .05, watch: "off_course" } });
  try {
    assert.equal(task.status, "running"); assert.equal(task.control.background, true);
    assert.match(formatPatrolAlerts(task), /patrol_alert/);
  } finally { task.controller.abort(); await task.promise; }
});

test("real watchdog healthy triages double windows; third same-command suspicion wakes", async () => {
  const task = startTask({ cwd: dir, prompt: "worker delay=3000", sandbox: "read-only", stall: { command_s: .05 },
    patrol: { every_s: 600, watch: "healthy" } }, true, async () => ({ cpuDeltaMs: 1 }));
  try {
    await waitTask(task, 10);
    assert.equal(task.status, "running"); assert.equal(task.progress?.suspicion?.wakes, 3);
    assert.equal(task.progress?.suspicion?.thresholdSec, .2);
    assert.equal(task.progress?.patrols?.length, 2);
    assert(task.progress!.patrols!.every(p => p.verdict === "healthy"));
    assert.equal(newPatrolAlerts(task).length, 0);
  } finally { task.controller.abort(); await task.promise; }
});

test("digest contains bounded brief, focus, evidence, events, command log, checkpoints and history", async () => {
  const evidenceDir = join(dir, "digest");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(evidenceDir);
  await writeFile(join(evidenceDir, "events.jsonl"), Array.from({ length: 25 }, (_, i) => JSON.stringify({ event: i })).join("\n"));
  await writeFile(join(evidenceDir, "cmd-7.log"), "command output tail");
  const meta: RunSummary = { id: "digest", startedAt: Date.now() - 4000, state: "running", phase: "codex", cwd: dir,
    prompt: "x".repeat(10000), patrol: { every_s: 600, timeout_s: 300, tier: "light", watch: "silent command expected" },
    inflight: { type: "command_execution", command: "node longrun.mjs /run run 7 -- test", startedAt: Date.now() - 3000 },
    lastEventAt: Date.now() - 2000, lastEvidence: { cpuDeltaMs: 10, ioWriteBytes: 20, at: Date.now() - 700000, command: "old command" },
    checkpoints: [{ n: 1, at: 1, title: "findings", needsLead: true }], patrols: [{ at: 1, verdict: "healthy", reason: "previous", evidence: [] }] };
  const digest = JSON.parse(await evidenceDigest(meta, evidenceDir, new AbortController().signal));
  assert.equal(digest.prompt.length, 8000); assert.equal(digest.watch, "silent command expected");
  assert.equal(digest.events.length, 20); assert.equal(digest.commandLog.tail, "command output tail");
  assert.equal(digest.watchdog.stale, true); assert(digest.watchdog.age_s >= 700); assert.equal(digest.watchdog.command, "old command");
  assert.equal(digest.watchdog.cpuDeltaMs, 10); assert.equal(digest.checkpoints.length, 1);
  assert.equal(digest.priorAlerts[0].reason, "previous"); assert.match(digest.gitDiffStat, /unavailable/);
  assert(digest.elapsed_s >= 4); assert(digest.idle_s >= 2);
  meta.lastEvidence = { at: Date.now() - 4000, command: "previous command" };
  assert.equal(JSON.parse(await evidenceDigest(meta, evidenceDir, new AbortController().signal)).watchdog.stale, true);
  meta.lastEvidence = { at: Date.now(), command: meta.inflight!.command };
  assert.equal(JSON.parse(await evidenceDigest(meta, evidenceDir, new AbortController().signal)).watchdog.stale, false);
  delete process.env.CODEX_DELEGATE_TEST_FAST_PATROL;
  try { assert.equal((patrolConfig({ every_s: .01 }) as { every_s: number }).every_s, 600); }
  finally { process.env.CODEX_DELEGATE_TEST_FAST_PATROL = "1"; }
});

test("worker completion stops periodic patrol and default config is ON", async () => {
  const task = startTask({ cwd: dir, prompt: "worker delay=500", sandbox: "read-only", patrol: { every_s: .05, watch: "healthy" } }, true, async () => ({}));
  await waitTask(task, 10); assert.equal(task.status, "done");
  const count = task.progress!.patrols?.length ?? 0; assert(count > 0);
  await sleep(150); assert.equal(task.progress!.patrols?.length, count);
  assert.match(formatOutcome(task.outcome!), new RegExp(`patrol: ${count} checks, 0 alerts`));
  const defaults = startTask({ cwd: dir, prompt: "worker delay=1", sandbox: "read-only" });
  await defaults.promise;
  assert(defaults.progress!.patrol); assert.equal(defaults.progress!.patrol.every_s, 1800);
  assert.doesNotMatch(formatOutcome(defaults.outcome!), /patrol:/);
});

test("patrol requires positive warning signs for uncertain", async () => {
  const { PATROL_CHECKLIST } = await import("../src/patrol.ts");
  assert.match(PATROL_CHECKLIST, /Uncertain means there are signs the worker may be stuck or off-course/);
  assert.match(PATROL_CHECKLIST, /positive warning sign/);
  assert.match(PATROL_CHECKLIST, /stale: true are not evidence/);
  assert.doesNotMatch(PATROL_CHECKLIST, /In doubt use uncertain|missing evidence is itself/);
});

for (const freshness of [false, true, undefined, "invalid"]) {
  test(`non-healthy freshness ${freshness}: wake or defer once`, async () => {
    const s = setup(async () => result(JSON.stringify({ verdict: "stalled", reason: "same problem", evidence: ["worker command"], new: freshness })));
    let woke = false;
    const wait = waitTask(s.task, .08).then(() => { woke = true; });
    await s.monitor.check();
    assert.equal(newPatrolAlerts(s.task).length, freshness === false ? 0 : 1);
    if (freshness === false) {
      assert.equal(woke, false);
      assert.equal(s.meta.patrols![0]!.repeat, true);
      const { appendDeferredCheckpoints } = await import("../src/tasks.ts");
      assert.match(appendDeferredCheckpoints(s.task, "result"), /patrol repeat: stalled.*same problem/);
      assert.equal(appendDeferredCheckpoints(s.task, "result"), "result");
      const outcome = { result: result("", { warnings: [], tokens: { input: 0, cachedInput: 0, output: 0, reasoning: 0 } }), notes: [], changes: [], checks: [], patrols: s.meta.patrols } as unknown as import("../src/delegate.ts").DelegateOutcome;
      assert.match(formatOutcome(outcome), /patrol: 1 checks, 0 alerts, 1 repeats/);
    } else {
      await wait;
      formatPatrolAlerts(s.task);
    }
    assert.equal(s.meta.patrols![0]!.reported_to_lead, true);
    const digest = JSON.parse(await evidenceDigest(s.meta, undefined, new AbortController().signal));
    assert.equal(digest.priorAlerts[0].reported_to_lead, true);
    assert.equal(digest.priorPatrols, undefined);
    await wait; await s.monitor.stop();
  });
}

test("checklist treats prior alerts as context, never worker evidence", async () => {
  const { PATROL_CHECKLIST } = await import("../src/patrol.ts");
  assert.match(PATROL_CHECKLIST, /Prior patrol records.*context, NOT evidence/);
  assert.match(PATROL_CHECKLIST, /NEW worker evidence/);
});

test("effective worker timeout defaults and precedence are recorded", async () => {
  const { config } = await import("../src/config.ts");
  const previousEnv = process.env.CODEX_DELEGATE_TIMEOUT;
  const previousTimeout = config.timeoutSec;
  delete process.env.CODEX_DELEGATE_TIMEOUT;
  config.timeoutSec = 1800;
  try {
    for (const [input, seconds, source] of [
      [{}, 14400, "patrol.timeout_default_s"],
      [{ patrol: false }, 1800, "config.timeoutSec"],
      [{ timeout_s: 123 }, 123, "timeout_s"],
    ] as const) {
      const task = startTask({ cwd: dir, prompt: "worker delay=1", sandbox: "read-only", ...input });
      await task.promise;
      assert.equal(task.progress!.timeoutSec, seconds);
      assert.equal(task.progress!.timeoutSource, source);
    }
    process.env.CODEX_DELEGATE_TIMEOUT = "246"; config.timeoutSec = 246;
    for (const explicit of [undefined, 123]) {
      const task = startTask({ cwd: dir, prompt: "worker delay=1", sandbox: "read-only", timeout_s: explicit });
      await task.promise;
      assert.equal(task.progress!.timeoutSec, explicit ?? 246);
      assert.equal(task.progress!.timeoutSource, explicit ? "timeout_s" : "CODEX_DELEGATE_TIMEOUT");
    }
  } finally {
    config.timeoutSec = previousTimeout;
    if (previousEnv === undefined) delete process.env.CODEX_DELEGATE_TIMEOUT;
    else process.env.CODEX_DELEGATE_TIMEOUT = previousEnv;
  }
});

test("patrol default timeout policy validates and merges independently of patrol-run timeout", async () => {
  const { validatePolicy, mergePolicy, DEFAULT_POLICY } = await import("../src/policy.ts");
  for (const timeout_default_s of [0, -1, 1.5, "14400", null]) {
    assert.equal(validatePolicy({ patrol: { timeout_default_s } }, []).ok, false);
  }
  const validated = validatePolicy(mergePolicy(DEFAULT_POLICY, { patrol: { timeout_default_s: 7200 } }), []);
  assert(validated.ok);
  assert.equal(validated.policy.patrol!.timeout_default_s, 7200);
  assert.equal(validated.policy.patrol!.timeout_s, 300);
});

test("repeat triage rearms watchdog without waking, preserving escalation", async () => {
  const s = setup(async () => result(JSON.stringify({ verdict: "stalled", reason: "already reported", evidence: ["same worker command"], new: false })));
  s.meta.suspicion = suspicion(1);
  s.monitor.observe(s.meta.suspicion); await s.monitor.check();
  assert.equal(newPatrolAlerts(s.task).length, 0);
  assert.equal(s.rearmed(), 1);
  s.meta.suspicion = suspicion(3); assert(wakeSuspicion(s.task));
  await s.monitor.stop();
});

test("uncertain never wakes; off_course wakes only on the second in a row; notes ride along", async () => {
  const { appendDeferredCheckpoints } = await import("../src/tasks.ts");
  const verdicts: [string, boolean?][] = [["uncertain"], ["off_course", false], ["healthy"], ["off_course"], ["off_course", false], ["off_course", false]];
  let i = 0;
  const s = setup(async () => {
    const [v, fresh] = verdicts[i++]!;
    return result(JSON.stringify({ verdict: v, reason: `r${i}`, evidence: ["worker command"], ...(fresh === undefined ? {} : { new: fresh }) }));
  });
  s.meta.suspicion = suspicion(1);
  s.monitor.observe(s.meta.suspicion); await s.monitor.check();
  assert.equal(s.meta.patrols![0]!.held, true); assert.equal(newPatrolAlerts(s.task).length, 0);
  assert.equal(s.rearmed(), 1, "a held verdict rearms the watchdog like a healthy one");
  await s.monitor.check();
  assert.equal(s.meta.patrols![1]!.held, true, "off_course after uncertain is a first off_course");
  await s.monitor.check(); await s.monitor.check();
  assert.equal(s.meta.patrols![3]!.held, true, "healthy in between resets the streak");
  assert.equal(newPatrolAlerts(s.task).length, 0);
  let woke = false;
  const wait = waitTask(s.task, 10).then(() => { woke = true; });
  await s.monitor.check(); await wait;
  assert.equal(woke, true);
  assert.equal(s.meta.patrols![4]!.confirmed, true, "second in a row confirms even when marked not new");
  assert.match(formatPatrolAlerts(s.task), /status: patrol_alert[\s\S]*off_course/);
  await s.monitor.check();
  assert.equal(s.meta.patrols![5]!.repeat, true, "a restatement after the alert does not wake again");
  assert.equal(newPatrolAlerts(s.task).length, 0);
  const notes = appendDeferredCheckpoints(s.task, "result");
  assert.match(notes, /patrol note: uncertain — r1/); assert.match(notes, /patrol note: off_course — r4/);
  assert.match(notes, /patrol repeat: off_course — r6/);
  const outcome = { result: result("", { warnings: [], tokens: { input: 0, cachedInput: 0, output: 0, reasoning: 0 } }), notes: [], changes: [], checks: [], patrols: s.meta.patrols } as unknown as import("../src/delegate.ts").DelegateOutcome;
  assert.match(formatOutcome(outcome), /patrol: 6 checks, 1 alerts, 1 repeats, 3 notes/);
  await s.monitor.stop();
});

test("a patrol failure still wakes and does not break an off_course streak", async () => {
  const runs = [() => result(verdict("off_course")), () => result("bad JSON"), () => result(verdict("off_course"))];
  let i = 0;
  const s = setup(async () => runs[i++]!());
  await s.monitor.check(); assert.equal(newPatrolAlerts(s.task).length, 0);
  await s.monitor.check(); assert.equal(newPatrolAlerts(s.task).length, 1); formatPatrolAlerts(s.task);
  await s.monitor.check();
  assert.equal(s.meta.patrols![2]!.confirmed, true); assert.equal(newPatrolAlerts(s.task).length, 1);
  await s.monitor.stop();
});
