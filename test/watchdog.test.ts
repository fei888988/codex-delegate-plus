import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { classifyError, runCodex, type CodexProgress } from "../src/codex.ts";
import { runCheck } from "../src/checks.ts";
import { delegate, formatOutcome } from "../src/delegate.ts";
import { startTask, runningProgress } from "../src/tasks.ts";

const root = mkdtempSync(join(tmpdir(), "cd-watchdog-"));
const original = { ...config };
const fixture = join(import.meta.dirname, "fixtures", "watchdog-codex.mjs");
config.runsDir = join(root, "runs");
config.policyFile = join(root, "policy.json");
after(() => { Object.assign(config, original); rmSync(root, { recursive: true, force: true }); });
function mode(value: string) { config.codex = { cmd: process.execPath, args: [fixture, value] }; }
function run(extra: Partial<Parameters<typeof runCodex>[0]> = {}) {
  return runCodex({ prompt: "x", sandbox: "read-only", idleTimeoutMs: 1500, timeoutMs: 8000, cpuSampler: async () => false, ...extra });
}

test("command stall records the command, timestamp, and live inflight item", async () => {
  mode("command");
  const progress: CodexProgress[] = [];
  const result = await run({ onProgress: (p) => progress.push(p) });
  assert.equal(result.exitKind, "stalled");
  assert.equal(result.stalled, true);
  assert.equal(result.stall?.kind, "command");
  assert.equal(result.stall?.command, "python -m unittest hung");
  assert(result.stall!.commandStartedAt! > 0);
  assert(result.stall!.idleMs >= 1500);
  assert.match(result.error!, /stalled: no codex output.*python -m unittest/);
  assert(progress.some((p) => p.inflight?.id === "cmd-1" && p.codexPid && p.lastEventAt));
});

test("silent stall and CPU sampling failures are best effort", async () => {
  mode("silent");
  const result = await run({ cpuSampler: async () => { throw new Error("unavailable"); } });
  assert.equal(result.stall?.kind, "silent");
  assert.equal(result.ok, false);
});

test("a non-command in-flight item still uses the silent idle window", async () => {
  mode("tool");
  const result = await run();
  assert.equal(result.exitKind, "stalled");
  assert.equal(result.stall?.kind, "silent");
});

test("CPU activity extends once, bounded even when both samples are busy", async () => {
  mode("command");
  let samples = 0;
  const result = await run({ cpuSampler: async () => { samples++; return true; } });
  assert.equal(samples, 2);
  assert.equal(result.exitKind, "stalled");
  assert(result.stall!.idleMs >= 3000);
});

test("fresh stdout prevents idle confirmation", async () => {
  mode("output");
  const result = await run({ cpuSampler: async () => { throw new Error("should not need CPU samples"); } });
  assert.equal(result.exitKind, "completed");
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
    assert(text.includes(errorKind === "quota" || errorKind === "auth" ? "environment problem: tell the user, don't take over" : "transient: retry once with the same session_id"));
  }
});
