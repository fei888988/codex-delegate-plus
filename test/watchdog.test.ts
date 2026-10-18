import { deriveHealth } from "../src/dashboard.ts";
import { loadPolicy, validatePolicy } from "../src/policy.ts";
import { loadPending } from "../src/pending.ts";
import { commandThreshold } from "../src/watchdog.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { classifyError, runCodex, type CodexProgress } from "../src/codex.ts";
import { runCheck } from "../src/checks.ts";
import { delegate, formatOutcome } from "../src/delegate.ts";
import { delegateSync, formatSuspicion, getTask, listTasks, waitTask, startTask, runningProgress } from "../src/tasks.ts";

const root = mkdtempSync(join(tmpdir(), "cd-watchdog-"));
const original = { ...config };
const fixture = join(import.meta.dirname, "fixtures", "watchdog-codex.mjs");
config.runsDir = join(root, "runs");
config.policyFile = join(root, "policy.json");
after(() => { Object.assign(config, original); rmSync(root, { recursive: true, force: true }); });
config.engine = "exec";
function mode(value: string) { config.codex = { cmd: process.execPath, args: [fixture, value] }; }
function run(extra: Partial<Parameters<typeof runCodex>[0]> = {}) {
  return runCodex({ prompt: "x", sandbox: "read-only", idleTimeoutMs: 1500, timeoutMs: 8000, evidenceSampler: async () => ({ cpuDeltaMs: 42, descendantCount: 2 }), ...extra });
}

test("command rules are case insensitive, first match wins, invalid regex is ignored", () => {
  assert.deepEqual(commandThreshold("NPM TEST", 600, [{ match: "[", idle_s: 1 }, { match: "npm (run )?test", idle_s: 1800 }, { match: "npm", idle_s: 5 }]), { seconds: 1800, matchedRule: "npm (run )?test" });
  assert.equal(commandThreshold("build", 600, [{ match: "[", idle_s: 1 }]).seconds, 600);
  assert.equal(commandThreshold("pytest", 0, [{ match: "pytest", idle_s: 1800 }]).seconds, 0);
});

test("suspicions never kill and sampler failure still wakes", async () => {
  for (const fails of [false, true]) {
    mode("delayed");
    const progress: CodexProgress[] = [];
    const result = await run({ stall: { silent_s: 2, command_s: 0.1 }, onProgress: p => progress.push(p),
      evidenceSampler: async () => { if (fails) throw Error("unavailable"); return { cpuDeltaMs: 42 }; } });
    assert.equal(result.exitKind, "completed");
    assert.equal(result.stalled, false);
    const s = progress.find(p => p.suspicion)?.suspicion;
    assert.equal(s?.command, "python -m unittest hung");
    assert.equal(s?.wakes, 1);
    assert(s!.idleMs >= 100);
    assert.equal(s?.evidence.cpuDeltaMs, fails ? undefined : 42);
    assert(progress.at(-1)?.suspicion === undefined);
  }
});

test("silent and non-command items wake without CPU extensions", async () => {
  for (const value of ["silent", "tool"]) {
    mode(value);
    let samples = 0;
    let kind: string | undefined;
    const result = await run({ idleTimeoutMs: 400, timeoutMs: 1100, evidenceSampler: async () => { samples++; return { cpuDeltaMs: 5000 }; },
      onProgress: p => { if (p.suspicion) kind = p.suspicion.kind; } });
    assert.equal(result.exitKind, "timeout");
    assert.equal(kind, "silent");
    assert.equal(samples, 1);
  }
});

test("fresh stdout resets suspicion and the backoff", async () => {
  mode("reset");
  const control = { lastObservedAt: Date.now() };
  const wakes: number[] = [];
  const result = await run({ idleTimeoutMs: 100, stallControl: control, onProgress: p => {
    if (p.suspicion && wakes.length < 2) wakes.push(p.suspicion.wakes);
  } });
  assert.equal(result.exitKind, "completed");
  assert.deepEqual(wakes, [1, 1]);
});

test("sync hands off the same task and returns its full outcome after completion", async () => {
  mode("delayed");
  const command = `"${process.execPath}" -e "console.log('checked')"`;
  const task = await delegateSync({ cwd: root, prompt: "x", sandbox: "read-only", stall: { command_s: 0.1 }, checks: [command] }, undefined, async () => ({ cpuDeltaMs: 100 }));
  assert.equal(task.status, "running");
  assert.equal(getTask(task.id), task);
  assert(listTasks().includes(task));
  assert.match(formatSuspicion(task), /^status: suspected_stall \(still running, not killed\)\nnext: judge from the evidence;/);
  assert.match(formatSuspicion(task), /session_id: watchdog-session/);
  await waitTask(task, 5, 5);
  assert.equal(task.status, "done");
  assert(task.outcome?.checks?.[0]?.ok);
  assert.match(formatOutcome(task.outcome!), /host checks.*\n  PASS/s);
  assert(task.outcome?.changes !== undefined || task.outcome?.result.toolCalls.length);
});

test("task_result wakes early, backoffs only on waiting, and accepts explicit next window", async () => {
  mode("command");
  const task = startTask({ cwd: root, prompt: "x", sandbox: "read-only", stall: { command_s: 0.1 } }, true, async () => ({}));
  try {
    const started = Date.now();
    await waitTask(task, 5);
    assert(Date.now() - started < 3000);
    assert.equal(task.progress?.suspicion?.wakes, 1);
    const first = task.progress!.suspicion!.suspectedAt;
    await new Promise(r => setTimeout(r, 150));
    await waitTask(task, 0);
    assert.equal(task.progress?.suspicion?.suspectedAt, first);
    await waitTask(task, 5);
    assert.equal(task.progress?.suspicion?.wakes, 2);
    assert.equal(task.progress?.suspicion?.thresholdSec, 0.2);
    await waitTask(task, 5, 0.05);
    assert.equal(task.progress?.suspicion?.wakes, 3);
    assert.equal(task.progress?.suspicion?.thresholdSec, 0.05);
    await waitTask(task, 0, 0);
    assert.equal(task.progress?.suspicion, undefined);
    await waitTask(task, 0.15);
    assert.equal(task.progress?.suspicion, undefined);
  } finally { task.controller.abort(); await task.promise; }
});

test("hard idle kills only unobserved suspected background tasks", async () => {
  mode("command");
  const old = config.hardIdleTimeoutSec;
  config.hardIdleTimeoutSec = 0.25;
  const task = startTask({ cwd: root, prompt: "x", sandbox: "read-only", stall: { command_s: 0.05 } }, true, async () => ({}));
  try {
    await waitTask(task, 5);
    await new Promise(r => setTimeout(r, 150));
    listTasks();
    await new Promise(r => setTimeout(r, 150));
    assert.equal(task.status, "running");
    await task.promise;
    assert.equal(task.outcome?.result.exitKind, "stalled");
    assert.match(formatOutcome(task.outcome!), /next: codex hung/);
  } finally { task.controller.abort(); await task.promise; config.hardIdleTimeoutSec = old; }
});


test("policy defaults survive partial overrides and call rules precede policy rules", () => {
  const validated = validatePolicy({ stall: { command_s: 123 } }, []);
  assert(validated.ok);
  assert.equal(validated.policy.stall?.command_s, 123);
  assert.equal(commandThreshold("NODE --TEST", 123, validated.policy.stall?.long_commands).seconds, 1800);
  assert.equal(commandThreshold("NODE --TEST", 123, [{ match: "node", idle_s: 9 }, ...validated.policy.stall!.long_commands!]).seconds, 9);
  assert(validatePolicy({ stall: { long_commands: [{ match: "[", idle_s: 3 }] } }, []).ok);
  assert(!validatePolicy({ stall: { command_s: -1 } }, []).ok);
});

test("dashboard uses matched command windows and re-arm timestamps", () => {
  const now = Date.now();
  const run = { id: "test", startedAt: now - 900000, state: "running" as const,
    lastEventAt: now - 800000, commandIdleTimeoutSec: 600,
    inflight: { type: "command_execution", startedAt: now - 900000, command: "pytest" },
    stallPolicy: loadPolicy().policy.stall };
  assert.equal(deriveHealth(run, now), "quiet");
  assert.equal(deriveHealth({ ...run, effectiveThresholdSec: 30, stallWindowSince: now - 1000 }, now), "active");
});

test("cancelling a converted editing run keeps Stop redirect pending semantics", async () => {
  mode("command");
  const cwd = join(root, "pending-work");
  mkdirSync(cwd);
  const task = await delegateSync({ cwd, prompt: "x", stall: { silent_s: 3, command_s: 0.1 } }, undefined, async () => ({}));
  task.controller.abort();
  await task.promise;
  assert.equal(loadPending(cwd)?.sessionId, "watchdog-session");
  assert.equal(loadPending(cwd)?.state, "interrupted");
});

test("zero idle override disables detection; hard timeout still works", async () => {
  mode("command");
  const result = await run({ idleTimeoutMs: 0, timeoutMs: 500 });
  assert.equal(result.exitKind, "timeout");
  assert.equal(result.timedOut, true);
  assert.equal(result.stalled, false);
});

test("exit classification requires turn.completed and distinguishes API errors and cancellation", async () => {
  for (const [value, kind] of [["empty", "crashed"], ["crash", "crashed"], ["failed", "api_error"], ["complete", "completed"]] as const) {
    mode(value);
    const result = await run();
    assert.equal(result.exitKind, kind);
    assert.equal(result.ok, kind === "completed");
    if (value === "empty") assert.match(result.error!, /without turn.completed/);
    if (value === "failed") assert.equal(result.errorKind, "network");
  }
  mode("silent");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  const result = await run({ signal: controller.signal });
  clearTimeout(timer);
  assert.equal(result.exitKind, "cancelled");
  config.codex = { cmd: join(root, "missing.exe"), args: [] };
  assert.equal((await run()).exitKind, "crashed");
});

test("error text classification", () => {
  for (const [text, kind] of [["usage limit reached", "quota"], ["429 too many requests", "rate_limit"], ["invalid API key", "auth"],
    ["ECONNRESET", "network"], ["context window exceeded", "context"], ["mystery", "other"]]) assert.equal(classifyError(text!), kind);
});

test("host checks stop on idle output, record startedAt, and can disable idle detection", async () => {
  const command = `"${process.execPath}" -e "setInterval(()=>{},1000)"`;
  const result = await runCheck(command, root, 5000, undefined, { idleTimeoutMs: 300, cpuSampler: async () => false });
  assert.equal(result.stalled, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert(result.startedAt > 0);
  const timeout = await runCheck(command, root, 300, undefined, { idleTimeoutMs: 0 });
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.stalled, false);
});

test("delegate metadata and in-memory tasks expose codex/checks/done phases", async () => {
  mode("complete");
  const cwd = join(root, "work");
  mkdirSync(cwd);
  const phases = new Set<string>();
  const command = `"${process.execPath}" -e "console.log('checked')"`;
  const outcome = await delegate({ cwd, prompt: "x", sandbox: "read-only", checks: [command, command] }, undefined, (p) => {
    phases.add(p.phase!);
    if (p.phase === "checks") assert(p.checksStartedAt);
  });
  assert.deepEqual([...phases], ["codex", "checks", "done"]);
  const meta = JSON.parse(readFileSync(join(outcome.runDir!, "meta.json"), "utf8"));
  assert.equal(meta.pid, process.pid);
  assert(meta.codexPid && meta.heartbeatAt && meta.lastEventAt);
  assert.equal(meta.exitKind, "completed");
  assert.equal(meta.checks.length, 2);
  assert(meta.checks.every((c: any) => c.startedAt && c.state === "done" && c.lastOutputAt));
  mode("command");
  const task = startTask({ cwd, prompt: "x", sandbox: "read-only", idle_timeout_s: 0 });
  try {
    for (let i = 0; i < 50 && !task.progress?.inflight; i++) await new Promise((r) => setTimeout(r, 20));
    assert.match(runningProgress(task), /phase: codex; last codex event: .*m ago\ninflight: python -m unittest hung/);
    const active = JSON.parse(readFileSync(join(config.runsDir, task.progress!.id, "meta.json"), "utf8"));
    assert.equal(active.phase, "codex");
  } finally { task.controller.abort(); await task.promise; }
  const stalled = { ...outcome, result: { ...outcome.result, ok: false, exitKind: "stalled" as const,
    stalled: true, stall: { kind: "command" as const, command: "python -m unittest", idleMs: 1000 } } };
  assert.match(formatOutcome(stalled), /^status: error \(stalled\)\nnext: codex hung on python -m unittest; the session keeps context:/);
  for (const errorKind of ["quota", "auth", "network", "rate_limit"] as const) {
    const text = formatOutcome({ ...outcome, result: { ...outcome.result, ok: false, exitKind: "api_error", errorKind } });
    assert.match(text, new RegExp(`^status: error \\(api_error/${errorKind}\\)\\nnext: `));
    assert(text.includes({ quota: "codex is out of quota", auth: "codex is not logged in" }[errorKind as string] ?? "transient: retry once with the same session_id"));
    if (errorKind === "quota" || errorKind === "auth") assert.match(text, /STOP/);
  }
  const quota = formatOutcome({ ...outcome, result: { ...outcome.result, ok: false, exitKind: "api_error", errorKind: "quota",
    error: "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at 10:57 PM." } });
  assert.match(quota, /out of quota until 10:57 PM\. STOP now: do not continue the delegated work yourself, do not sleep or poll/);
});
