import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { atomic, ack, claim, editInput, finishInputs, inboxPath, interruptText, messages, readJson, type InputMessage } from "../src/inbox.ts";
import { AppServerTurn } from "../src/appserver.ts";
import type { RunOptions } from "../src/codex.ts";
import { createDashboardServer } from "../src/dashboard.ts";
import { formatUserInputs, newUserInputs, waitTask, type Task } from "../src/tasks.ts";
import { trackRunDir, reapTrackedLongruns } from "../src/longruns.ts";

async function temporary(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "human-input-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const message = (mid: string, at = 1, text = mid): InputMessage => ({ mid, at, text, from: "user", mode: "queue", notify: false });
async function until(fn: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 200; n++) { if (await fn()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail("condition did not become true");
}
function driver(dir: string) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough() });
  const requests: any[] = [];
  let done = false;
  const turn = new AppServerTurn(child as unknown as ChildProcessWithoutNullStreams, { runDir: dir } as RunOptions, { emit() {}, activity() {}, done() { done = true; } });
  turn.threadId = "thread"; turn.turnId = "initial";
  child.stdin.on("data", data => {
    const m = JSON.parse(data.toString()); requests.push(m);
    queueMicrotask(() => {
      turn.line(JSON.stringify({ id: m.id, result: { turn: { id: `turn-${requests.length}` } } }));
      if (m.method === "turn/interrupt") complete("interrupted");
    });
  });
  function complete(status = "completed") { turn.line(JSON.stringify({ method: "turn/completed", params: { turn: { id: turn.turnId, status } } })); }
  return { turn, requests, complete, get done() { return done; } };
}

test("delivery claim excludes edit/withdraw; edit changes delivery text; withdrawal is durable", async () => temporary(async dir => {
  await atomic(inboxPath(dir, "one"), message("one"));
  assert.equal(await editInput(dir, "one", "edited"), true);
  assert.equal((await claim(dir, "one"))?.text, "edited");
  assert.equal(await editInput(dir, "one", "late"), false);
  assert.equal(await editInput(dir, "one"), false);
  await atomic(inboxPath(dir, "two"), message("two"));
  assert.equal(await editInput(dir, "two"), true);
  assert.equal(await claim(dir, "two"), undefined);
  assert.equal((await messages(dir)).find(m => m.mid === "two")?.state, "withdrawn");
  for (let n = 0; n < 20; n++) {
    const mid = `race-${n}`; await atomic(inboxPath(dir, mid), message(mid));
    const [claimed, edited] = await Promise.all([claim(dir, mid), editInput(dir, mid, "new")]);
    if (edited) { assert.equal(claimed?.text ?? (await claim(dir, mid))?.text, "new"); }
    else assert.equal(claimed?.text, mid);
  }
  for (let n = 0; n < 10; n++) {
    const mid = `withdraw-race-${n}`; await atomic(inboxPath(dir, mid), message(mid));
    const [claimed, withdrawn] = await Promise.all([claim(dir, mid), editInput(dir, mid)]);
    assert.equal(!!claimed, !withdrawn);
  }
}));

test("queue uses at order, one new turn per input, skips withdrawn, marks remainder undelivered on failure", async () => temporary(async dir => {
  for (const m of [message("later", 20), message("first", 10), message("withdraw", 5)]) await atomic(inboxPath(dir, m.mid), m);
  await editInput(dir, "withdraw");
  const d = driver(dir);
  d.complete(); await until(() => d.requests.length === 1);
  assert.equal(d.requests[0].params.input[0].text, "first");
  assert.equal(d.done, false);
  await editInput(dir, "later", "delivery-time text");
  d.complete(); await until(() => d.requests.length === 2);
  assert.equal(d.requests[1].params.input[0].text, "delivery-time text");
  assert.equal(d.done, false);
  await atomic(inboxPath(dir, "remaining"), message("remaining", 30));
  d.complete("failed"); assert.equal(d.done, true);
  const final = await finishInputs(dir);
  assert.equal(final.find(m => m.mid === "remaining")?.state, "undelivered");
  assert.equal(final.find(m => m.mid === "first")?.turn, "turn-1");
}));

test("user steer reuses redirect and interrupt ends immediately", async () => temporary(async dir => {
  await atomic(inboxPath(dir, "steer"), { ...message("steer"), mode: "steer" });
  const d = driver(dir);
  await d.turn.pollInbox();
  assert.deepEqual(d.requests.map(r => r.method), ["turn/interrupt", "turn/start"]);
  assert.equal((await messages(dir))[0]!.state, "delivered");
  await atomic(inboxPath(dir, "interrupt"), { reason: "stop here", killLongruns: false, at: 1 });
  await d.turn.pollInbox();
  assert.equal(d.done, true);
  assert.equal(d.turn.userInterrupt?.reason, "stop here");
  assert.equal((await readJson<{ state: string }>(inboxPath(dir, "interrupt.ack")))?.state, "delivered");
}));

test("concurrent redirects are serialized on the same thread", async () => temporary(async dir => {
  const d = driver(dir);
  await Promise.all([d.turn.redirect("lead direction"), d.turn.redirect("user direction")]);
  assert.deepEqual(d.requests.map(r => r.method), ["turn/interrupt", "turn/start", "turn/interrupt", "turn/start"]);
  assert.equal(d.requests[3].params.threadId, "thread");
}));

test("interrupt report includes pause, reason fallback, undelivered and explicit stop/keep job outcomes", () => {
  const inputs = [{ ...message("q"), state: "undelivered" }];
  const jobs = [{ n: 2, pid: 123, log: "/run/cmd-2.log" }];
  const kept = interruptText({ reason: "", killLongruns: false, at: 1 }, "session", inputs, jobs, "/run");
  assert.match(kept, /^status: user_interrupted\nreason: 用户中断，原因不明/);
  assert.match(kept, /PAUSE this work.*session_id session can continue/);
  assert.match(kept, /undelivered q: q/);
  assert.match(kept, /kept running by user choice: cmd-2 pid 123.*exit-file.*ask the user before stopping it/);
  const stopped = interruptText({ reason: "wrong data", killLongruns: true, at: 1 }, "session", [], jobs, "/run");
  assert.match(stopped, /^status: user_interrupted\nreason: wrong data/);
  assert.match(stopped, /stopped: cmd-2/); assert.doesNotMatch(stopped, /kept running/);
});

test("interrupt kills launcher jobs only on request; kept jobs are excluded from server-exit reaping", async () => {
  for (const killLongruns of [false, true]) await temporary(async dir => {
    const job = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
    await once(job, "spawn");
    const exited = once(job, "exit");
    try {
      await writeFile(join(dir, "cmd-1.pid"), String(job.pid));
      await atomic(join(dir, "cmd-1.json"), { program: process.execPath, args: ["job"], startedAt: 1 });
      trackRunDir(dir);
      await atomic(inboxPath(dir, "interrupt"), { reason: "test", killLongruns, at: 1 });
      const d = driver(dir); await d.turn.pollInbox();
      assert.equal(d.done, true);
      assert.equal(d.turn.interruptedJobs?.[0]?.pid, job.pid);
      reapTrackedLongruns();
      if (killLongruns) {
        await exited;
        assert.equal(await readJson(join(dir, "cmd-1.exit")), 137);
      } else {
        assert.doesNotThrow(() => process.kill(job.pid!, 0));
        assert.equal(await readJson(join(dir, "cmd-1.exit")), undefined);
      }
    } finally { job.kill(); await exited; }
  });
});

test("notify wakes waiting result once; silent input does not wake", async () => {
  const task = { status: "running", control: { lastObservedAt: 0 }, controller: new AbortController(), listeners: new Set<() => void>(), progress: { inputs: [message("silent")] }, promise: new Promise<void>(() => {}) } as Task;
  assert.equal(newUserInputs(task).length, 0);
  const waiting = waitTask(task, 1);
  task.progress!.inputs!.push({ ...message("notify"), notify: true });
  for (const notify of task.listeners) notify();
  await waiting;
  assert.match(formatUserInputs(task), /^status: user_input/);
  assert.equal(newUserInputs(task).length, 0);
  task.progress!.inputs![1]!.state = "consumed";
  assert.equal(newUserInputs(task).length, 0);
});

test("HTTP input contract guards mutations and rejects unavailable runs", async () => temporary(async dir => {
  const runDir = join(dir, "run");
  const meta = { id: "run", state: "running", engine: "app-server", startedAt: 1, heartbeatAt: Date.now() };
  await atomic(join(runDir, "meta.json"), meta);
  const server = createDashboardServer({ runsDir: dir });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address() as { port: number }; const base = `http://127.0.0.1:${address.port}`;
  async function request(path: string, method = "GET", value?: unknown, origin = base) {
    return fetch(base + "/api/runs/run/" + path, { method, headers: { "Content-Type": "application/json", Origin: origin }, body: value === undefined ? undefined : JSON.stringify(value) });
  }
  try {
    for (const [path, method] of [["input", "POST"], ["input/x", "PATCH"], ["input/x", "DELETE"], ["interrupt", "POST"]] as const) assert.equal((await request(path, method, {}, "http://evil.test")).status, 403);
    assert.equal((await fetch(base + "/api/runs/run/input", { method: "POST", headers: { "Content-Type": "text/plain", Origin: base }, body: "{}" })).status, 403);
    const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(base + "/api/runs/run/input", { method: "POST", headers: { Host: "evil.test", "Content-Type": "application/json" } }, res => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end("{}");
    });
    assert.equal(badHostStatus, 403);
    const created = await request("input", "POST", { mode: "queue", text: " hello " }); assert.equal(created.status, 201);
    const { mid } = await created.json() as { mid: string };
    assert.equal((await request(`input/${mid}`, "PATCH", { text: "edited" })).status, 200);
    await claim(runDir, mid);
    assert.equal((await request(`input/${mid}`, "DELETE")).status, 409);
    const list = await (await request("inputs")).json() as { available: boolean; inputs: InputMessage[] };
    assert.equal(list.available, true); assert.equal(list.inputs[0]!.text, "edited");
    assert.equal((await request("interrupt", "POST", { killLongruns: false })).status, 202);
    assert.equal((await request("interrupt", "POST", { killLongruns: false })).status, 409);
    for (const [patch, reason] of [[{ state: "ok" }, "not_running"], [{ engine: "exec" }, "exec_engine"], [{ heartbeatAt: 1 }, "stale_heartbeat"]] as const) {
      await atomic(join(runDir, "meta.json"), { ...meta, ...patch });
      const response = await request("input", "POST", { mode: "steer", text: "x" });
      assert.equal(response.status, 409); assert.equal((await response.json() as { reason: string }).reason, reason);
    }
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
}));
