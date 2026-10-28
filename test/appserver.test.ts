import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

// config.ts reads the environment at import time, so set it up before loading the modules.
const runs = mkdtempSync(join(tmpdir(), "cd-as-runs-"));
process.env.CODEX_BIN = join(import.meta.dirname, "fixtures", "fake-app-server.mjs");
process.env.CODEX_DELEGATE_ENGINE = "app-server";
process.env.CODEX_DELEGATE_RUNS_DIR = runs;
process.env.CODEX_DELEGATE_POLICY = join(runs, "policy.json");
process.env.CODEX_DELEGATE_CHECKPOINT_POLL_MS = "200";
const { delegate, formatOutcome } = await import("../src/delegate.ts");
const { appendDeferredCheckpoints, delegateSync, formatCheckpoints, newCheckpoints, startTask, steerTask, waitTask } = await import("../src/tasks.ts");
const { execItem, kindFromInfo, threadConfig } = await import("../src/appserver.ts");

let repo: string;
before(() => {
  repo = mkdtempSync(join(tmpdir(), "cd-as-repo-"));
  const git = (...a: string[]) => spawnSync("git", a, { cwd: repo });
  git("init", "-q");
  writeFileSync(join(repo, "work.txt"), "start\n");
  writeFileSync(join(repo, ".gitignore"), "fake.pid\ncommand.pid\nrequests.jsonl\n");
  git("add", ".");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
});
after(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(runs, { recursive: true, force: true });
});
/** Until the fake's long command is in flight (the turn has started and is busy). */
async function commandRunning(task: { progress?: { inflight?: { command?: string } } }) {
  for (let i = 0; i < 200 && task.progress?.inflight?.command !== "sleep 100"; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(task.progress?.inflight?.command, "sleep 100");
}
const requests = () => readFileSync(join(repo, "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("app-server run: thread/start + turn/start, JSON report, tokens of this turn only, exec-style event log", async () => {
  const o = await delegate({ prompt: "do the thing", cwd: repo, effort: "high", fresh: true });
  assert.equal(o.result.exitKind, "completed");
  assert.equal(o.result.sessionId, "fake-thread-1");
  assert.equal(o.report?.summary, "fake done");
  assert.deepEqual(o.result.tokens, { input: 10, cachedInput: 4, output: 2, reasoning: 0 });
  assert.deepEqual(o.changes?.map((c) => c.path), ["work.txt"]);
  const [init, initialized, start, turn] = requests();
  assert.equal(init.method, "initialize");
  assert.equal(initialized.method, "initialized");
  assert.equal(start.method, "thread/start");
  assert.equal(start.params.approvalPolicy, "never");
  assert.equal(start.params.config.model_reasoning_effort, "high");
  assert.equal(turn.params.effort, "high");
  assert.equal(turn.params.outputSchema.type, "object");
  const events = readFileSync(join(o.runDir!, "events.jsonl"), "utf8");
  assert.match(events, /"type":"thread.started","thread_id":"fake-thread-1"/);
  assert.match(events, /"type":"file_change"/);
  assert.equal(readFileSync(join(o.runDir!, "last-message.txt"), "utf8"), JSON.stringify({ status: "done", summary: "fake done", changes: ["work.txt"], verification: [], risks: [], questions: [] }));
  assert.match(formatOutcome(o), /note: codex usage window 91% used/);
  assert.equal(JSON.parse(readFileSync(join(o.runDir!, "meta.json"), "utf8")).engine, "app-server");
});

test("session_id resumes through thread/resume", async () => {
  rmSync(join(repo, "requests.jsonl"), { force: true });
  const o = await delegate({ prompt: "follow up", cwd: repo, session_id: "older-thread", fresh: true });
  assert.equal(o.result.sessionId, "older-thread");
  const resume = requests().find((r) => r.method === "thread/resume");
  assert.equal(resume.params.threadId, "older-thread");
});

test("task_steer reaches the running turn and the result reports it was read", async () => {
  const task = startTask({ prompt: "steer-wait please", cwd: repo, fresh: true, structured: false });
  await commandRunning(task);
  const r = await steerTask(task, "also add a README");
  assert.equal(r.isError, false);
  assert.match(r.text, /codex has read the message/);
  await waitTask(task, 10);
  assert.equal(task.status, "done");
  const steer = requests().find((q) => q.method === "turn/steer");
  assert.equal(steer.params.expectedTurnId, "fake-turn-1");
  assert.equal(steer.params.input[0].text, "also add a README");
  const text = formatOutcome(task.outcome!);
  assert.match(text, /steered: 1 message\(s\) sent into the turn, all read by codex/);
  assert.match(text, /steered: also add a README/);
  const after = await steerTask(task, "too late");
  assert.equal(after.isError, true);
  assert.match(after.text, /delegate\(session_id="fake-thread-1"\)/);
});

test("checkpoints: sync delegate returns early with the stage report while codex keeps working, then steer and collect", async () => {
  const task = await delegateSync({ prompt: "steer-wait long job", cwd: repo, fresh: true, structured: false, checkpoints: true });
  assert.equal(task.status, "running");
  assert.equal(newCheckpoints(task).length, 1);
  const wake = formatCheckpoints(task);
  assert.match(wake, /^status: checkpoint \(codex is still working; nothing was stopped\)\nnext: /);
  assert.match(wake, /# Found the real cause in parser\.ts/);
  assert.match(wake, /task_steer\(task_id, prompt\)/);
  assert.equal(newCheckpoints(task).length, 0, "shown once");
  assert.match(readFileSync(join(task.outcome?.runDir ?? join(runs, task.progress!.id), "prompt.md"), "utf8"), /checkpoint-<n>\.md/);
  const r = await steerTask(task, "on course, also cover the edge case");
  assert.equal(r.isError, false);
  await waitTask(task, 10);
  assert.equal(task.status, "done");
  assert.match(formatOutcome(task.outcome!), /checkpoints \(stage reports in the run log\): 1\. Found the real cause in parser\.ts/);
});

test("steer now: true interrupts the running step and continues the same thread with a new turn", async () => {
  rmSync(join(repo, "requests.jsonl"), { force: true });
  const task = startTask({ prompt: "steer-wait please", cwd: repo, fresh: true, structured: false });
  await commandRunning(task);
  const r = await steerTask(task, "drop that, write NOTES.md instead", true);
  assert.equal(r.isError, false, r.text);
  // Not started through the launcher: its output can't be recovered, so it is stopped and said so.
  assert.match(r.text, /^redirected .*\nstopped: sleep 100 \(it was not started through the launcher/);
  await waitTask(task, 10);
  assert.equal(task.status, "done");
  assert.equal(task.outcome?.result.exitKind, "completed");
  assert.match(task.outcome!.result.text, /redirected: drop that, write NOTES\.md instead/);
  assert.deepEqual(requests().filter((q) => q.method.startsWith("turn/")).map((q) => q.method), ["turn/start", "turn/interrupt", "turn/start"]);
  assert.match(formatOutcome(task.outcome!), /all read by codex/);
  // The interrupted command was killed by the server, not left running.
  const pid = Number(readFileSync(join(repo, "command.pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), "the interrupted command must be dead");
});

/** Start a task whose fake codex runs a never-ending command through the launcher; wait until it is up. */
async function until(ok: () => boolean, what: string, ms = 20000) {
  for (const end = Date.now() + ms; !ok(); ) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
async function longrunTask() {
  rmSync(join(repo, "redirect-brief.txt"), { force: true });
  const task = startTask({ prompt: "longrun-wait please", cwd: repo, fresh: true, structured: false });
  await until(() => !!task.progress?.inflight?.command?.includes("longrun.mjs"), "the launcher command");
  const runDir = join(runs, task.progress!.id);
  await until(() => existsSync(join(runDir, "cmd-1.pid")), "cmd-1.pid");
  const pid = Number(readFileSync(join(runDir, "cmd-1.pid"), "utf8"));
  return { task, runDir, pid };
}
/** The fake writes the redirected brief right after answering turn/start. */
async function redirectBrief() {
  await until(() => existsSync(join(repo, "redirect-brief.txt")), "the redirected brief");
  return readFileSync(join(repo, "redirect-brief.txt"), "utf8");
}
const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("steer now keeps a launcher command running; codex is told it owns it and the result says what became of it", async () => {
  const { task, runDir, pid } = await longrunTask();
  const r = await steerTask(task, "obey: check the log before deciding", true);
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /kept running: cmd-1 .*Codex was told it must wait for it or stop it before finishing/);
  const brief = await redirectBrief();
  assert.match(brief, /Still running, NOT stopped: cmd-1/);
  assert.match(brief, /longrun\.mjs" ".+" wait <n>/);
  assert.match(brief, /Instruction from the lead:\nobey: check the log before deciding$/);
  await waitTask(task, 15);
  assert.equal(task.status, "done");
  // The redirected turn ended with cmd-1 still running → reminder turn → the fake stops it.
  assert.match(readFileSync(join(task.outcome!.runDir!, "events.jsonl"), "utf8"), /"type":"turn.reminded"/);
  assert.match(formatOutcome(task.outcome!), /background commands kept across a redirect:\n  cmd-1: stopped by codex/);
  assert.equal(isAlive(pid), false);
  assert.match(readFileSync(join(runDir, "cmd-1.log"), "utf8"), /tick[\s\S]*EXIT=stopped/, "the log the result points to is kept");
});

test("a kept command codex keeps ignoring is stopped by the server and reported as forgotten", async () => {
  const { task, runDir, pid } = await longrunTask();
  await steerTask(task, "ignore it", true);
  // Survived the interrupt and still writing its log.
  assert.equal(isAlive(pid), true);
  const size = readFileSync(join(runDir, "cmd-1.log"), "utf8").length;
  await new Promise((r) => setTimeout(r, 600));
  assert(readFileSync(join(runDir, "cmd-1.log"), "utf8").length > size, "still logging after the interrupt");
  await waitTask(task, 15);
  assert.equal(task.status, "done");
  const events = readFileSync(join(task.outcome!.runDir!, "events.jsonl"), "utf8");
  assert.equal(events.match(/"type":"turn.reminded"/g)?.length, 2);
  assert.match(formatOutcome(task.outcome!), /cmd-1: STOPPED BY THE SERVER: codex ended without dealing with it/);
  assert.equal(isAlive(pid), false);
});

test("steer now + kill stops the launcher command at once", async () => {
  const { task, runDir, pid } = await longrunTask();
  const r = await steerTask(task, "obey: it is writing bad data", true, undefined, true);
  assert.match(r.text, /\nstopped: .*node(\.exe)? -e setInterval/);
  assert.doesNotMatch(r.text, /kept running/);
  for (let i = 0; i < 40 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(isAlive(pid), false);
  assert.match(readFileSync(join(runDir, "cmd-1.log"), "utf8"), /EXIT=stopped/);
  await waitTask(task, 15);
  assert.equal(task.outcome?.result.kept, undefined);
});

test("cancel interrupts the turn instead of killing codex outright", async () => {
  const task = startTask({ prompt: "steer-wait please", cwd: repo, fresh: true, structured: false });
  await commandRunning(task);
  task.controller.abort();
  await waitTask(task, 10);
  assert.equal(task.status, "cancelled");
  assert.equal(task.outcome?.result.exitKind, "cancelled");
  assert(requests().some((q) => q.method === "turn/interrupt"));
});

test("quota: structured error kind, no host checks, STOP instruction with the reset time", async () => {
  const started = Date.now();
  const o = await delegate({ prompt: "quota please", cwd: repo, fresh: true, checks: ["node -e \"setTimeout(()=>{},20000)\""] });
  assert(Date.now() - started < 10000, "checks must not run after a quota stop");
  assert.equal(o.result.exitKind, "api_error");
  assert.equal(o.result.errorKind, "quota");
  assert.equal(o.checks, undefined);
  const text = formatOutcome(o);
  assert.match(text, /^status: error \(api_error\/quota\)\nnext: codex is out of quota until 10:57 PM\. STOP now/);
  assert.match(text, /note: host checks skipped: codex stopped on quota/);
});

test("translation helpers", () => {
  assert.equal(kindFromInfo("usageLimitExceeded"), "quota");
  assert.equal(kindFromInfo("serverOverloaded"), "overloaded");
  assert.equal(kindFromInfo("internalServerError"), "network");
  assert.equal(kindFromInfo({ responseStreamDisconnected: { httpStatusCode: 502 } }), "network");
  assert.equal(kindFromInfo("other"), undefined);
  assert.deepEqual(execItem({ type: "commandExecution", id: "c", command: "ls", aggregatedOutput: "x", exitCode: 0, status: "completed" }),
    { id: "c", type: "command_execution", command: "ls", aggregated_output: "x", exit_code: 0, status: "completed" });
  assert.deepEqual(threadConfig({ prompt: "", sandbox: "workspace-write", addDirs: ["D:/r"], effort: "low" }),
    { model_reasoning_effort: "low", "sandbox_workspace_write.writable_roots": ["D:/r"] });
  assert.deepEqual(threadConfig({ prompt: "", sandbox: "danger-full-access", addDirs: ["D:/r"] }), {});
});

test("no checkpoints stay asleep, accompany the next result once, and remain in final outcome", async () => {
  const task = startTask({ prompt: "steer-wait checkpoint-no", cwd: repo, fresh: true, structured: false, checkpoints: true, patrol: false });
  try {
    await commandRunning(task);
    let woke = false;
    const waiting = waitTask(task, 10).then(() => { woke = true; });
    for (let i = 0; i < 100 && !task.progress?.checkpoints?.length; i++) await new Promise(r => setTimeout(r, 25));
    assert.equal(task.progress?.checkpoints?.[0]?.needsLead, false);
    assert.equal(woke, false);
    assert.equal(newCheckpoints(task).length, 0);
    task.progress!.patrols = [{ at: Date.now(), verdict: "uncertain", reason: "warning", evidence: ["warning"] }];
    for (const notify of task.listeners) notify();
    await waiting;
    const text = appendDeferredCheckpoints(task, "status: patrol_alert");
    assert.match(text, /1\. Found the real cause in parser\.ts .*checkpoint-1\.md/);
    assert.doesNotMatch(text, /Found: x/);
    assert.equal(appendDeferredCheckpoints(task, "next result"), "next result");
    await steerTask(task, "finish"); await task.promise;
    assert.match(formatOutcome(task.outcome!), /checkpoint-1\.md/);
  } finally { task.controller.abort(); await task.promise; }
});

test("missing checkpoint declaration wakes sync delegate", async () => {
  const task = await delegateSync({ prompt: "steer-wait checkpoint-missing", cwd: repo, fresh: true, structured: false, checkpoints: true, patrol: false });
  try { assert.equal(task.status, "running"); assert.equal(newCheckpoints(task)[0]?.needsLead, true); }
  finally { task.controller.abort(); await task.promise; }
});

test("deferred checkpoints attach on the final result path", async () => {
  const task = await delegateSync({ prompt: "checkpoint-no", cwd: repo, fresh: true, structured: false, checkpoints: true, patrol: false });
  assert.equal(task.status, "done");
  const text = appendDeferredCheckpoints(task, formatOutcome(task.outcome!));
  assert.match(text, /progress checkpoints:/);
  assert.doesNotMatch(appendDeferredCheckpoints(task, "again"), /progress checkpoints:/);
});

test("checkpoint declaration parsing is case insensitive, bilingual and fails loud", async () => {
  const { parseNeedsLead } = await import("../src/checkpoints.ts");
  assert.equal(parseNeedsLead("Needs lead:yes"), true);
  assert.equal(parseNeedsLead("NEEDS LEAD: NO"), false);
  assert.equal(parseNeedsLead("需要调用方决定：是"), true);
  assert.equal(parseNeedsLead("需要调用方决定：否"), false);
  assert.equal(parseNeedsLead("progress only"), true);
  assert.equal(parseNeedsLead("Needs lead: maybe"), true);
});
