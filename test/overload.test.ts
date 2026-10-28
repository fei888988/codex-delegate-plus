import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AppServerTurn } from "../src/appserver.ts";
import { EventCollector, runCodex, type RunOptions } from "../src/codex.ts";
import { config } from "../src/config.ts";
import { delegate, formatOutcome } from "../src/delegate.ts";
import { DEFAULT_POLICY, mergePolicy, validatePolicy } from "../src/policy.ts";
import { atomic, inboxPath, messages } from "../src/inbox.ts";
import { deriveHealth } from "../src/dashboard.ts";

const flush = async () => { for (let i = 0; i < 15; i++) await new Promise<void>(r => setImmediate(r)); };
const until = async (condition: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 10000; i++) { if (await condition()) return; await flush(); }
  assert.fail("condition did not become true");
};
const overloadError = { message: "Selected model is at capacity.", codexErrorInfo: "serverOverloaded" };
function driver(options: Partial<RunOptions> = {}, backoff = [30, 60, 60, 120, 120], max = 30) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough() });
  const requests: any[] = [], updates: any[] = [], events: any[] = [];
  const collector = new EventCollector();
  let done = false;
  const turn = new AppServerTurn(child as unknown as ChildProcessWithoutNullStreams, {
    prompt: "original task", sandbox: "read-only", ...options,
    overload: { backoff_s: backoff, max_total_retries: max, onUpdate: s => updates.push(s) },
  }, { emit(e) { events.push(e); collector.push(JSON.stringify(e)); }, activity() {}, done() { done = true; } });
  turn.threadId = "same-thread"; turn.turnId = "first-turn";
  child.stdin.on("data", data => {
    const m = JSON.parse(data.toString()); requests.push(m);
    queueMicrotask(() => {
      turn.line(JSON.stringify({ id: m.id, result: { turn: { id: `turn-${requests.length}` } } }));
      if (m.params.clientUserMessageId) note("item/completed", { item: { type: "userMessage", clientId: m.params.clientUserMessageId } });
    });
  });
  function note(method: string, params: any) { turn.line(JSON.stringify({ method, params: { threadId: "same-thread", ...params } })); }
  function complete(status = "failed", error: any = overloadError) {
    note("turn/completed", { turn: { id: turn.turnId, status, error: status === "failed" ? error : undefined } });
  }
  function usage(input: number, output: number, lastInput = input, lastOutput = output) {
    note("thread/tokenUsage/updated", { tokenUsage: {
      total: { inputTokens: input, cachedInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0 },
      last: { inputTokens: lastInput, cachedInputTokens: 0, outputTokens: lastOutput, reasoningOutputTokens: 0 },
    } });
  }
  return { turn, requests, updates, events, collector, note, complete, usage, get done() { return done; } };
}

test("overload policy defaults, partial deep merge and validation", () => {
  assert.deepEqual(DEFAULT_POLICY.overload, { backoff_s: [30, 60, 60, 120, 120], max_total_retries: 30 });
  const p = validatePolicy({ overload: { max_total_retries: 8 } }, []);
  assert(p.ok); assert.deepEqual(p.policy.overload, { backoff_s: [30, 60, 60, 120, 120], max_total_retries: 8 });
  const merged = validatePolicy(mergePolicy({ overload: { backoff_s: [10, 20], max_total_retries: 8 } }, { overload: { max_total_retries: 9 } }), []);
  assert(merged.ok); assert.deepEqual(merged.policy.overload, { backoff_s: [10, 20], max_total_retries: 9 });
  for (const overload of [null, [], { backoff_s: [] }, { backoff_s: [3601] }, { backoff_s: [-1] }, { max_total_retries: -1 }])
    assert.equal(validatePolicy({ overload }, []).ok, false);
});

test("overload backoff schedule exhausts five no-progress retries on the same thread", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000000 });
  const d = driver();
  d.note("error", { willRetry: true, error: overloadError });
  assert.equal(d.collector.errors.length, 0);
  for (const [i, seconds] of [30, 60, 60, 120, 120].entries()) {
    d.note("error", { willRetry: false, error: overloadError });
    d.complete();
    const state = d.updates.at(-1);
    assert.equal(state.phase, "overload_wait");
    assert.equal(state.nextRetryAt - Date.now(), seconds * 1000);
    assert.equal(state.consecutive, i + 1);
    assert.equal(d.done, false);
    t.mock.timers.tick(seconds * 1000 - 1); await flush();
    assert.equal(d.requests.length, i);
    t.mock.timers.tick(1); await flush();
    assert.equal(d.requests.length, i + 1);
    assert.equal(d.requests.at(-1).method, "turn/start");
    assert.equal(d.requests.at(-1).params.threadId, "same-thread");
    assert.match(d.requests.at(-1).params.input[0].text, /continue the original task.*do not redo finished steps/);
  }
  d.complete();
  assert.equal(d.done, true);
  assert.equal(d.turn.overloadTotalRetries, 5);
  assert.equal(d.updates.at(-1).totalRetries, 5);
  assert.equal(d.updates.at(-1).consecutive, 6);
  assert.deepEqual(d.turn.errorKinds, ["overloaded"]);
  assert.equal(d.collector.errors.length, 1);
});

test("new completed items and output tokens reset consecutive failures; duplicate usage does not", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000000 });
  const d = driver();
  const retry = async () => { d.complete(); const s = d.updates.at(-1); t.mock.timers.tick(s.nextRetryAt - Date.now()); await flush(); return s; };
  assert.equal((await retry()).consecutive, 1);
  assert.equal((await retry()).consecutive, 2);
  d.note("item/completed", { item: { type: "commandExecution", id: "cmd", status: "completed" } });
  assert.equal((await retry()).consecutive, 0);
  d.note("item/completed", { item: { type: "commandExecution", id: "cmd", status: "completed" } });
  assert.equal((await retry()).consecutive, 1);
  d.usage(100, 5);
  assert.equal((await retry()).consecutive, 0);
  d.usage(100, 5);
  assert.equal((await retry()).consecutive, 1);
  // A half-streamed response that the overload cut off is not in the thread history: not progress.
  d.note("item/agentMessage/delta", { delta: "new output" });
  assert.equal((await retry()).consecutive, 2);
  assert.equal(d.turn.overloadTotalRetries, 7);
  d.complete("completed"); await flush();
  assert.equal(d.done, true);
  assert.equal(d.collector.errors.length, 0);
});

test("total retry cap still applies when every failed turn makes progress", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000000 });
  const d = driver({}, [30, 60], 2);
  for (let i = 0; i < 2; i++) {
    d.note("item/completed", { item: { type: "fileChange", id: `file-${i}`, changes: [] } });
    d.complete(); assert.equal(d.updates.at(-1).nextRetryAt - Date.now(), 30000);
    t.mock.timers.tick(30000); await flush();
  }
  d.note("item/completed", { item: { type: "agentMessage", id: "message", text: "progress" } });
  d.complete();
  assert.equal(d.done, true);
  assert.equal(d.requests.length, 2);
  assert.equal(d.turn.overloadTotalRetries, 2);
});

test("steer and redirect during wait resume immediately with overload preamble and original text", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000000 });
  for (const redirect of [false, true]) {
    const d = driver(); d.complete();
    const r = redirect ? await d.turn.redirect("new instruction") : await d.turn.steer("new instruction");
    assert.equal(d.requests.length, 1);
    assert.match(d.requests[0].params.input[0].text, /model overload[\s\S]*new instruction/);
    assert.equal(r.consumed, true);
    t.mock.timers.tick(120000); await flush();
    assert.equal(d.requests.length, 1);
    d.complete("completed"); await flush();
  }
});

test("failed-turn cumulative usage is retained without counting earlier session tokens or changing exec sums", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000000 });
  const d = driver({}, [30], 1);
  d.usage(721000, 5, 720000, 5);
  d.complete(); t.mock.timers.tick(30000); await flush();
  d.usage(721300, 7, 300, 2);
  d.complete();
  assert.equal(d.done, true);
  assert.equal(d.collector.tokens.input, 720300);
  assert.equal(d.collector.tokens.output, 7);
  const exec = new EventCollector();
  for (const input_tokens of [10, 8]) exec.push(JSON.stringify({ type: "turn.completed", usage: { input_tokens } }));
  assert.equal(exec.tokens.input, 18);
});

test("cancel during overload wait ends immediately and prevents the pending retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000000 });
  const d = driver(); d.complete(); await d.turn.interrupt();
  assert.equal(d.done, true);
  t.mock.timers.tick(120000); await flush();
  assert.equal(d.requests.length, 0);
});

test("inbox steer, queue and interrupt keep working during overload wait", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000000 });
  const dir = mkdtempSync(join(tmpdir(), "overload-inbox-"));
  try {
    const d = driver({ runDir: dir }); d.complete();
    await atomic(inboxPath(dir, "steer"), { mid: "steer", at: 1, from: "user", text: "inbox instruction", mode: "steer", notify: false });
    await d.turn.pollInbox();
    assert.match(d.requests[0].params.input[0].text, /model overload[\s\S]*inbox instruction/);
    await atomic(inboxPath(dir, "queue"), { mid: "queue", at: 2, from: "user", text: "queued instruction", mode: "queue", notify: false });
    d.complete("completed"); await until(() => d.requests.length === 2);
    assert.equal(d.requests[1].params.input[0].text, "queued instruction");
    await until(async () => (await messages(dir)).find(m => m.mid === "queue")?.state === "consumed");
    d.complete();
    await atomic(inboxPath(dir, "interrupt"), { at: 3, reason: "stop now", killLongruns: false });
    await d.turn.pollInbox();
    assert.equal(d.done, true);
    t.mock.timers.tick(120000); await flush();
    assert.equal(d.requests.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("launcher job survives overload and is included in the same kept-command preamble", async t => {
  const dir = mkdtempSync(join(tmpdir(), "overload-longrun-"));
  // A portable Node child stands in for the live launcher monitor recorded by cmd-n.pid.
  const job = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
  await once(job, "spawn");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000000 });
  try {
    writeFileSync(join(dir, "cmd-1.pid"), String(job.pid));
    writeFileSync(join(dir, "cmd-1.json"), JSON.stringify({ program: process.execPath, args: ["training.js"] }));
    writeFileSync(join(dir, "cmd-1.log"), "still running");
    const d = driver({ runDir: dir }); d.complete();
    assert.equal(d.turn.kept[0]?.outcome, "running");
    t.mock.timers.tick(30000); await flush();
    process.kill(job.pid!, 0);
    assert.match(d.requests[0].params.input[0].text, /Still running, NOT stopped: cmd-1[\s\S]*do not start it again/);
    assert.equal(readFileSync(join(dir, "cmd-1.log"), "utf8"), "still running");
    d.complete("failed", { message: "unrelated network failure", codexErrorInfo: "internalServerError" });
    assert.equal(d.done, true);
  } finally {
    job.kill(); await once(job, "exit");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dashboard health treats overload wait as active even past the idle deadline", () => {
  assert.equal(deriveHealth({ id: "test", state: "running", phase: "overload_wait", startedAt: 1, lastEventAt: 1, idleTimeoutSec: 1 }, 1000000), "active");
});

test("real driver persists failed usage, skips checks on exhaustion, and reports recovery without a hint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "overload-run-"));
  const original = { ...config };
  Object.assign(config, {
    codex: { cmd: process.execPath, args: [join(import.meta.dirname, "fixtures", "fake-overload-server.mjs")] },
    engine: "app-server", runsDir: dir, policyFile: join(dir, "policy.json"),
  });
  writeFileSync(config.policyFile, JSON.stringify({ overload: { backoff_s: [0], max_total_retries: 2 } }));
  try {
    const failure = await delegate({ prompt: "forever", cwd: dir, sandbox: "read-only", patrol: false,
      timeout_s: 10, checks: [`"${process.execPath}" -e "process.exit(3)"`] });
    assert.equal(failure.result.exitKind, "api_error");
    assert.equal(failure.result.errorKind, "overloaded");
    assert.equal(failure.result.tokens.input, 2160000);
    assert.equal(failure.result.overloadRetries, 2);
    assert.equal(failure.checks, undefined);
    assert(failure.notes.includes("host checks skipped: codex stopped on overloaded"));
    const meta = JSON.parse(readFileSync(join(failure.runDir!, "meta.json"), "utf8"));
    assert.equal(meta.tokens.input, 2160000);
    assert.equal(meta.overload.totalRetries, 2);
    assert.equal(meta.phase, "done");
    assert.match(formatOutcome(failure), /model overloaded, server auto-resumed 2 times over .* min, no progress since \d\d:\d\d/);
    assert.match(formatOutcome(failure), /do not take over the work yourself/);
    const success = await delegate({ prompt: "recover", cwd: dir, sandbox: "read-only", patrol: false, timeout_s: 10 });
    assert.equal(success.result.exitKind, "completed");
    assert.equal(success.result.errorKind, undefined);
    assert.equal(success.result.tokens.input, 1440000);
    assert.match(formatOutcome(success), /model overload: auto-resumed 1 times/);
    assert.doesNotMatch(formatOutcome(success), /next:/);
    let suspicion = false;
    const waiting = await runCodex({ prompt: "recover", cwd: dir, sandbox: "read-only", engine: "app-server",
      overload: { backoff_s: [1], max_total_retries: 1 }, idleTimeoutMs: 100,
      onProgress: p => { suspicion ||= !!p.suspicion; }, timeoutMs: 5000 });
    assert.equal(waiting.exitKind, "completed");
    assert.equal(suspicion, false);
    const timedOut = await runCodex({ prompt: "forever", cwd: dir, sandbox: "read-only", engine: "app-server",
      overload: { backoff_s: [30], max_total_retries: 30 }, timeoutMs: 500 });
    assert.equal(timedOut.exitKind, "timeout");
    assert.equal(timedOut.tokens.input, 720000);
    const secret = "test-only-overload-secret";
    let lastError = "";
    const redacted = await runCodex({ prompt: "forever", cwd: dir, sandbox: "read-only", engine: "app-server",
      provider: { id: "test", name: "test", apiKey: secret },
      overload: { backoff_s: [0], max_total_retries: 0, onUpdate: s => { lastError = s.lastError ?? ""; } }, timeoutMs: 5000 });
    assert.match(lastError, /\[REDACTED\]/);
    assert(!lastError.includes(secret));
    assert(!redacted.error?.includes(secret));
  } finally {
    Object.assign(config, original);
    rmSync(dir, { recursive: true, force: true });
  }
});
