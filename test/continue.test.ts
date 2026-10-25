import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { atomic, launcherJobs, readJson } from "../src/inbox.ts";
import type { RunSummary } from "../src/run-summary.ts";

const root = await mkdtemp(join(tmpdir(), "continue-"));
const runs = join(root, "runs");
await mkdir(runs);
process.env.CODEX_BIN = join(import.meta.dirname, "fixtures", "fake-app-server.mjs");
process.env.CODEX_DELEGATE_ENGINE = "exec"; // continuation must override this
process.env.CODEX_DELEGATE_RUNS_DIR = runs;
process.env.CODEX_DELEGATE_POLICY = join(root, "policy.json");
process.env.CODEX_DELEGATE_CHECKPOINT_POLL_MS = "50";
const { createDashboardServer } = await import("../src/dashboard.ts");
const { appendHandoff, consumeHandoffs, hasNotifyHandoffs } = await import("../src/handoffs.ts");
const { startTask, waitTask } = await import("../src/tasks.ts");
const providersFile = join(root, "providers.json");
await atomic(providersFile, { defaultProvider: null, providers: [{ id: "relay", name: "test relay", baseUrl: "https://example.test/v1", apiKey: "fake-key" }] });
const server = createDashboardServer({ runsDir: runs, providersFile });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
after(async () => { await server.shutdownContinuations(); server.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
async function parent(id: string, extra: Partial<RunSummary> = {}) {
  const meta: RunSummary = { id, state: "ok", startedAt: Date.now(), cwd: root, sessionId: id, provider: "system", sandbox: "workspace-write", tier: "old-tier", effort: "high", model: "gpt-6-sol", fast: false, pid: process.pid, ...extra };
  await atomic(join(runs, id, "meta.json"), meta);
  return meta;
}
async function post(id: string, value: any = { text: "hello" }, headers: Record<string, string> = {}) {
  const r = await fetch(base + `/api/runs/${id}/continue`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
  return { status: r.status, body: await r.json() as any };
}
async function until(fn: () => Promise<any>) {
  for (const deadline = Date.now() + 20000; Date.now() < deadline;) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 10)); }
  assert.fail("timed out");
}
test("continue validates guards, text, notify and all conflict reasons; inputs predicts availability", async () => {
  await parent("guards");
  for (const headers of [{ origin: "http://evil.test" }, { "content-type": "text/plain" }] as Record<string, string>[]) assert.equal((await post("guards", {}, headers)).status, 403);
  assert.equal(await new Promise(resolve => {
    const req = request(base + "/api/runs/guards/continue", { method: "POST", headers: { host: "evil.test", "content-type": "application/json" } }, res => { res.resume(); resolve(res.statusCode); });
    req.end("{}");
  }), 403);
  for (const value of [null, {}, { text: " " }, { text: "x".repeat(4001) }, { text: "ok", notify: 1 }]) assert.equal((await post("guards", value)).status, 400);
  for (const [id, meta, reason] of [
    ["running", { state: "running" }, "running"],
    ["nosession", { sessionId: undefined }, "no_session"],
    ["missingcwd", { cwd: join(root, "gone") }, "cwd_missing"],
  ] as const) {
    await parent(id, meta);
    assert.equal((await post(id)).body.reason, reason);
    const inputs = await (await fetch(base + `/api/runs/${id}/inputs`)).json() as any;
    assert.equal(inputs.canContinue, false); assert.equal(inputs.continueReason, reason);
  }
  await parent("busy-parent");
  await parent("busy", { state: "running", sessionId: "busy-parent", heartbeatAt: Date.now() });
  assert.deepEqual((await post("busy-parent")).body, { error: "Cannot continue run", reason: "session_busy", runId: "busy" });
  const inputs = await (await fetch(base + "/api/runs/busy-parent/inputs")).json() as any;
  assert.equal(inputs.busyRunId, "busy");
  await parent("busy", { state: "running", sessionId: "busy-parent", heartbeatAt: Date.now() - 91000 });
});
test("all terminal states continue in-process using only original settings, no checks/pending/tasks; handoff has both events", async () => {
  for (const state of ["ok", "needs_decision", "partial", "blocked", "error", "cancelled", "user_interrupted", "interrupted"] as const) {
    const id = "terminal-" + state;
    await parent(id, { state });
    const response = await post(id, { text: "  human says hello  ", cwd: join(root, "bad"), session_id: "wrong", checks: ["bad"], tier: "high" });
    assert.equal(response.status, 201, JSON.stringify(response));
    const runId = response.body.runId;
    const meta = await until(async () => { const m = await readJson<RunSummary>(join(runs, runId, "meta.json")); return m?.state !== "running" && m; });
    assert.equal(meta.state, "ok"); assert.equal(meta.origin, "dashboard"); assert.equal(meta.parentRunId, id);
    for (const [key, value] of Object.entries({ resumed: true, sessionId: id, cwd: root, provider: "system", tier: "old-tier", effort: "high", model: "gpt-6-sol", fast: false, sandbox: "workspace-write", engine: "app-server" })) assert.equal(meta[key], value, key);
    assert.equal(meta.checks, undefined);
    assert.match(await readFile(join(runs, runId, "prompt.md"), "utf8"), /human user directly through the dashboard, not from the lead/);
    assert.equal(meta.title, "human says hello");
    const events = await until(async () => { const e = (await readFile(join(runs, "handoffs", id + ".jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l)); return e.length === 2 && e; });
    assert.equal(events.length, 2); assert.equal(events[0].state, "started"); assert.equal(events[0].text, "human says hello"); assert.equal(events[1].state, "ok"); assert.ok(events[1].reply);
    const detail = await (await fetch(base + "/api/runs/" + runId)).json() as any;
    assert.equal(detail.origin, "dashboard"); assert.equal(detail.parentRunId, id);
  }
  assert.ok(!(await readdir(runs)).includes("pending")); assert.ok(!(await readdir(runs)).includes("tasks"));
});
test("the human can switch model, effort and sandbox; a matching pick is recorded as its tier; bad picks are rejected", async () => {
  await atomic(join(root, "policy.json"), { ...(await import("../src/policy.ts")).DEFAULT_POLICY });
  await parent("pick-parent");
  for (const bad of [{ model: "bad model!" }, { model: "gpt-9-unlisted" }, { effort: "turbo" }, { sandbox: "write" }]) assert.equal((await post("pick-parent", { text: "x", ...bad })).status, 400, JSON.stringify(bad));
  const response = await post("pick-parent", { text: "switch", model: "gpt-6-luna", effort: "xhigh", sandbox: "read-only" });
  assert.equal(response.status, 201, JSON.stringify(response));
  const meta = await until(async () => { const m = await readJson<RunSummary>(join(runs, response.body.runId, "meta.json")); return m?.state !== "running" && m; });
  for (const [key, value] of Object.entries({ model: "gpt-6-luna", effort: "xhigh", tier: "light", sandbox: "read-only", sessionId: "pick-parent" })) assert.equal(meta[key], value, key);
  await parent("pick-custom");
  const custom = await post("pick-custom", { text: "custom", effort: "low" });
  assert.equal(custom.status, 201, JSON.stringify(custom));
  const m2 = await until(async () => { const m = await readJson<RunSummary>(join(runs, custom.body.runId, "meta.json")); return m?.state !== "running" && m; });
  assert.equal(m2.model, "gpt-6-sol"); assert.equal(m2.effort, "low"); assert.equal(m2.tier, undefined); assert.equal(m2.sandbox, "workspace-write");
  await rm(join(root, "policy.json"), { force: true });
});
test("provider and full-access sandbox inherit; pending record stays intact and cannot silently resume a human-driven session", async () => {
  const { savePending } = await import("../src/pending.ts");
  const { delegate } = await import("../src/delegate.ts");
  const { config } = await import("../src/config.ts");
  savePending({ cwd: root, state: "interrupted", sessionId: "pending-parent", pid: process.pid, startedAt: Date.now(), sandbox: "workspace-write", prompt: "lead work" });
  const file = join(runs, "pending", (await readdir(join(runs, "pending")))[0]!);
  const before = await readFile(file, "utf8");
  await parent("pending-parent", { provider: "relay", sandbox: "danger-full-access", effort: "xhigh" });
  const response = await post("pending-parent");
  assert.equal(response.status, 201);
  const meta = await until(async () => { const m = await readJson<RunSummary>(join(runs, response.body.runId, "meta.json")); return m?.state === "ok" && m; });
  assert.equal(meta.provider, "relay"); assert.equal(meta.sandbox, "danger-full-access");
  assert.equal(meta.effort, "xhigh"); assert.doesNotMatch(meta.notes.join("\n"), /outside the allowed range/);
  assert.equal(await readFile(file, "utf8"), before);
  const previous = config.engine; config.engine = "app-server";
  try {
    const next = await delegate({ prompt: "lead next", cwd: root, provider: "system" });
    assert.equal(next.resumed, false);
  } finally { config.engine = previous; }
});
test("restart recovery finalizes hard-killed dashboard runs without touching lead runs", async () => {
  const { recoverDashboardContinuations } = await import("../src/continuations.ts");
  await parent("dead-dashboard", { origin: "dashboard", state: "running", pid: 2147483647 });
  await parent("dead-lead", { state: "running", pid: 2147483647 });
  await recoverDashboardContinuations(runs);
  assert.equal((await readJson<RunSummary>(join(runs, "dead-dashboard", "meta.json")))?.state, "interrupted");
  assert.equal((await readJson<RunSummary>(join(runs, "dead-lead", "meta.json")))?.state, "running");
  assert.match(await readFile(join(runs, "handoffs", "dead-dashboard.jsonl"), "utf8"), /interrupted/);
});
test("dashboard-owned run polls queue and interrupt unchanged, reserves sessions, shutdown ends interrupted", async () => {
  await parent("live", { sandbox: "read-only" });
  const { body } = await post("live", { text: "longrun-wait" });
  const dir = join(runs, body.runId);
  await until(async () => (await readFile(join(root, "requests.jsonl"), "utf8")).includes("turn/start"));
  assert.equal((await post("live")).body.reason, "session_busy");
  const queue = await fetch(base + `/api/runs/${body.runId}/input`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "queue", text: "queued hello" }) });
  assert.equal(queue.status, 201);
  const interrupted = await fetch(base + `/api/runs/${body.runId}/interrupt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "stop now", killLongruns: true }) });
  assert.equal(interrupted.status, 202);
  const meta = await until(async () => { const m = await readJson<RunSummary>(join(dir, "meta.json")); return m?.state === "user_interrupted" && m; });
  assert.equal(meta.inputs[0].state, "undelivered");
  await parent("steered", { sandbox: "read-only" });
  const steered = await post("steered", { text: "quiet-wait" });
  const steerDir = join(runs, steered.body.runId);
  await until(async () => { const requests = (await readFile(join(root, "requests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)); return requests.some(r => r.method === "turn/start" && r.params?.threadId === "steered"); });
  const steer = await fetch(base + `/api/runs/${steered.body.runId}/input`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "steer", text: "finish this turn obey" }) });
  assert.equal(steer.status, 201);
  const finished = await until(async () => {
    const m = await readJson<RunSummary>(join(steerDir, "meta.json"));
    if (m && m.state !== "running") assert.equal(m.state, "ok", JSON.stringify(m));
    return m?.state === "ok" && m;
  });
  assert.equal(finished.inputs[0].state, "consumed");
  await parent("shutdown", { sandbox: "read-only" });
  const started = await post("shutdown", { text: "longrun-wait" });
  await until(async () => (await readJson<RunSummary>(join(runs, started.body.runId, "meta.json")))?.inflight);
  await until(async () => (await launcherJobs(join(runs, started.body.runId))).length);
  await server.shutdownContinuations();
  assert.equal((await launcherJobs(join(runs, started.body.runId))).length, 0);
  assert.equal((await readJson<RunSummary>(join(runs, started.body.runId, "meta.json")))?.state, "interrupted");
});
test("handoffs consume exactly once concurrently and notify wakes only the parent-owning process", async () => {
  const rec = { runId: "handoff-one", sessionId: "handoff", text: "change", at: Date.now(), state: "started", notify: true, parentPid: process.pid };
  await appendHandoff(runs, "handoff", { ...rec, parentPid: -1 });
  assert.equal(await hasNotifyHandoffs(), false);
  await appendHandoff(runs, "handoff", rec);
  assert.equal(await hasNotifyHandoffs(), true);
  const responses = await Promise.all([consumeHandoffs("handoff"), consumeHandoffs("handoff")]);
  assert.equal(responses.filter(Boolean).length, 1);
  assert.match(responses.find(Boolean)!, /user continued this codex session from the dashboard:/);
  assert.equal(await hasNotifyHandoffs(), false);
  // A separate read-only mock exec task waits; a parent-owned notification wakes it early.
  const { config } = await import("../src/config.ts");
  config.engine = "app-server";
  const task = startTask({ prompt: "quiet-wait", cwd: root, sandbox: "read-only" });
  const wait = waitTask(task, 10);
  await appendHandoff(runs, "wake", { ...rec, sessionId: "wake", runId: "wake" });
  await wait;
  assert.equal(task.status, "running");
  assert.match(await consumeHandoffs(undefined, runs, true), /status: user_continued/);
  task.controller.abort(); await task.promise;
});


test("SIGINT, SIGTERM and exit finalize dashboard metadata, end handoff and reap launcher jobs", { timeout: 30000 }, async () => {
  for (const signal of ["SIGINT", "SIGTERM", "exit"]) {
    const host = spawn(process.execPath, [join(import.meta.dirname, "fixtures", "dashboard-host.mjs")], { env: process.env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = ""; host.stderr!.on("data", b => { stderr += b; });
    const [port] = await once(host, "message");
    const exited = once(host, "exit");
    try {
      const id = "exit-" + signal;
      await parent(id, { sandbox: "read-only" });
      const response = await fetch(`http://127.0.0.1:${port}/api/runs/${id}/continue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "longrun-wait" }) });
      assert.equal(response.status, 201, stderr);
      const { runId } = await response.json() as { runId: string };
      const dir = join(runs, runId);
      await until(async () => (await launcherJobs(dir)).length);
      host.send(signal);
      await exited;
      assert.equal((await readJson<RunSummary>(join(dir, "meta.json")))?.state, "interrupted");
      assert.equal((await launcherJobs(dir)).length, 0);
      const records = (await readFile(join(runs, "handoffs", id + ".jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(records.at(-1).state, "interrupted");
    } finally {
      if (host.exitCode === null && host.signalCode === null) { host.kill(); await exited; }
    }
  }
});
