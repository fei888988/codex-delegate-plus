import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomic, inboxPath, launcherJobs } from "../src/inbox.ts";

const root = await mkdtemp(join(tmpdir(), "human-input-integration-"));
const runs = join(root, "runs");
process.env.CODEX_BIN = join(import.meta.dirname, "fixtures", "fake-app-server.mjs");
process.env.CODEX_DELEGATE_ENGINE = "app-server";
process.env.CODEX_DELEGATE_RUNS_DIR = runs;
process.env.CODEX_DELEGATE_POLICY = join(root, "policy.json");
process.env.CODEX_DELEGATE_CHECKPOINT_POLL_MS = "200";
const { delegateSync, formatUserInputs, newUserInputs, startTask, steerTask } = await import("../src/tasks.ts");
const { formatOutcome } = await import("../src/delegate.ts");
const { stopLongrun } = await import("../src/longruns.ts");
after(() => rm(root, { recursive: true, force: true }));
async function until(fn: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 400; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.fail("timed out");
}

test("sync delegate wakes on notify once, keeps its task, drains queue before returning final result", async () => {
  const controller = new AbortController();
  const sync = delegateSync({ prompt: "steer-wait", cwd: root, fresh: true, structured: false, timeout_s: 10 }, controller.signal);
  try {
  let dir = "";
  await until(async () => {
    try { const id = (await readdir(runs)).find(n => !["tasks", "pending"].includes(n)); if (id) dir = join(runs, id); return !!id; } catch { return false; }
  });
  await atomic(inboxPath(dir, "queued"), { mid: "queued", mode: "queue", text: "user follow-up", notify: true, at: Date.now(), from: "user" });
  const task = await sync;
  assert.equal(task.status, "running");
  assert.match(formatUserInputs(task), /^status: user_input/);
  assert.equal(newUserInputs(task).length, 0);
  await until(() => !!task.control.live?.turnId);
  const redirected = await steerTask(task, "finish initial turn", true);
  assert.equal(redirected.isError, false, redirected.text);
  await task.promise;
  assert.equal(task.status, "done");
  const input = task.outcome!.result.inputs!.find(m => m.mid === "queued")!;
  assert.ok(input.turn); assert.equal(input.state, "consumed");
  assert.match(formatOutcome(task.outcome!), /user input during run:.*\nqueue .*consumed; turn .*user follow-up/);
  assert.equal(newUserInputs(task).length, 0);
  } finally { controller.abort(); await (await sync).promise; }
});

test("interrupt persists terminal result and resume record, skips checks, and keeps/kills launcher jobs as requested", async () => {
  for (const killLongruns of [false, true]) {
    const task = startTask({ prompt: "longrun-wait", cwd: root, fresh: true, structured: false, timeout_s: 10, checks: [`"${process.execPath}" -e "throw Error('must skip checks')"`] });
    let dir = "";
    await until(async () => {
      if (!task.progress?.id) return false;
      dir = join(runs, task.progress.id);
      return (await launcherJobs(dir)).length > 0;
    });
    try {
      await atomic(inboxPath(dir, "remaining"), { mid: "remaining", mode: "queue", text: "not delivered", notify: false, at: Date.now(), from: "user" });
      await atomic(inboxPath(dir, "interrupt"), { reason: killLongruns ? "wrong data" : "", killLongruns, at: Date.now() });
      await task.promise;
      assert.equal(task.status, "user_interrupted");
      assert.equal(task.outcome!.result.exitKind, "user_interrupted");
      assert.equal(task.outcome!.checks, undefined);
      const text = formatOutcome(task.outcome!);
      assert.match(text, /^status: user_interrupted\nreason: /);
      assert.match(text, killLongruns ? /reason: wrong data/ : /reason: 用户中断，原因不明/);
      assert.match(text, /undelivered remaining: not delivered/);
      assert.match(text, killLongruns ? /stopped: cmd-1/ : /kept running by user choice: cmd-1/);
      assert.equal((await launcherJobs(dir)).length, killLongruns ? 0 : 1);
      assert.ok((await readdir(join(runs, "pending"))).length);
    } finally { stopLongrun(dir, 1, "test cleanup"); }
  }
});
