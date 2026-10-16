import assert from "node:assert/strict";
import { request } from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "cd-dashboard-"));
const runs = join(root, "runs");
mkdirSync(runs);
process.env.CODEX_BIN = join(import.meta.dirname, "fixtures", "fake-codex.mjs");
process.env.CODEX_DELEGATE_RUNS_DIR = runs;
const { delegate } = await import("../src/delegate.ts");
const { createDashboardServer, readRun } = await import("../src/dashboard.ts");
const { WRITE_CONTRACT, READ_CONTRACT } = await import("../src/report.ts");
const { version } = await import("../src/run-summary.ts");
after(() => rmSync(root, { recursive: true, force: true }));

const report = { status: "done", summary: "legacy finished", changes: [], verification: [], risks: [], questions: [] };
function legacy(id: string, events: unknown[], contract = WRITE_CONTRACT) {
  const dir = join(runs, id);
  mkdirSync(dir);
  writeFileSync(join(dir, "prompt.md"), "legacy brief" + contract);
  writeFileSync(join(dir, "last-message.txt"), JSON.stringify(report));
  writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\nmalformed tail");
  return dir;
}

test("delegate persists running and completed metadata, including checks and the original brief", async () => {
  const cwd = join(root, "work");
  mkdirSync(cwd);
  const prompt = "dashboard brief delay=500 " + "x".repeat(2100);
  const promise = delegate({ cwd, prompt, title: "Dashboard test", checks: [`"${process.execPath}" -e "console.log('checked')"`] });
  // execute writes initial metadata synchronously before awaiting the child.
  const { readdirSync } = await import("node:fs");
  const id = readdirSync(runs).find((id) => existsSync(join(runs, id, "meta.json")))!;
  const initial = JSON.parse(readFileSync(join(runs, id, "meta.json"), "utf8"));
  assert.equal(initial.state, "running");
  assert.equal(initial.prompt, prompt.slice(0, 2000));
  const outcome = await promise;
  const meta = JSON.parse(readFileSync(join(outcome.runDir!, "meta.json"), "utf8"));
  assert.equal(meta.state, "ok");
  assert.equal(meta.title, "Dashboard test");
  assert.equal(meta.cwd, cwd);
  assert.equal(meta.resumed, false);
  assert.equal(meta.sessionId, "fake-session-1");
  assert.equal(meta.version, version);
  assert.equal(meta.reportStatus, "done");
  assert.deepEqual(meta.report, outcome.report);
  assert.deepEqual(meta.tokens, { input: 10, cachedInput: 4, output: 2, reasoning: 0 });
  assert.equal(meta.turns, 1);
  assert.equal(meta.toolCalls, 1);
  assert.equal(meta.checks[0].lastLine, "checked");
  assert(!("tail" in meta.checks[0]));
  assert(meta.endedAt >= meta.startedAt);
  assert.equal(meta.durationMs, meta.endedAt - meta.startedAt);
});

test("legacy summaries use UTC stamps, last-turn usage, contract-free briefs and log mtime", async () => {
  const id = "20261016T100256-legacy";
  const dir = legacy(id, [
    { type: "thread.started", thread_id: "old-session" },
    { type: "turn.completed", usage: { input_tokens: 100 } },
    { type: "turn.completed", usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 7, reasoning_output_tokens: 2 } },
  ]);
  const endedAt = Date.UTC(2026, 9, 16, 10, 4);
  utimesSync(join(dir, "events.jsonl"), endedAt / 1000, endedAt / 1000);
  const run = (await readRun(runs, id))!;
  assert.equal(run.startedAt, Date.UTC(2026, 9, 16, 10, 2, 56));
  assert.equal(run.endedAt, endedAt);
  assert.equal(run.state, "ok");
  assert.equal(run.prompt, "legacy brief");
  assert.equal(run.sessionId, "old-session");
  assert.deepEqual(run.tokens, { input: 12, cachedInput: 3, output: 7, reasoning: 2 });
  assert.equal(run.turns, 2);
  assert.equal(run.reportStatus, "done");
  assert.equal(run.summary, report.summary);
  const active = legacy("20261016T100257-active", [], READ_CONTRACT);
  assert.equal((await readRun(runs, "20261016T100257-active"))?.state, "running");
  assert.equal((await readRun(runs, "20261016T100257-active"))?.prompt, "legacy brief");
  const stale = new Date(Date.now() - 180_000);
  utimesSync(join(active, "events.jsonl"), stale, stale);
  assert.equal((await readRun(runs, "20261016T100257-active"))?.state, "error");
  assert.equal(await readRun(runs, "../outside"), undefined);
});

test("interrupted runs record cancellation and continuation, and spawn errors finish metadata", async () => {
  const cwd = join(root, "interrupted-work");
  mkdirSync(cwd);
  const controller = new AbortController();
  const pending = delegate({ cwd, prompt: "delay=5000" }, controller.signal);
  // Wait until the fake process has announced its session before cancelling.
  for (let i = 0; i < 100 && !existsSync(join(cwd, "prompt.txt")); i++) await new Promise((r) => setTimeout(r, 20));
  assert(existsSync(join(cwd, "prompt.txt")));
  await new Promise((r) => setTimeout(r, 50));
  controller.abort();
  const stopped = await pending;
  const stoppedMeta = JSON.parse(readFileSync(join(stopped.runDir!, "meta.json"), "utf8"));
  assert.equal(stoppedMeta.state, "interrupted");
  assert.match(stoppedMeta.error, /cancelled/);
  const next = await delegate({ cwd, prompt: "continue" });
  const nextMeta = JSON.parse(readFileSync(join(next.runDir!, "meta.json"), "utf8"));
  assert.equal(nextMeta.continuedFrom, "fake-session-1");
  assert.equal(nextMeta.resumed, true);
  assert.equal(nextMeta.prompt, "continue");

  const { config } = await import("../src/config.ts");
  const original = config.codex;
  try {
    config.codex = { cmd: join(root, "nonexistent-codex"), args: [] };
    const failed = await delegate({ cwd, prompt: "fail to start" });
    const meta = JSON.parse(readFileSync(join(failed.runDir!, "meta.json"), "utf8"));
    assert.equal(meta.state, "error");
    assert.match(meta.error, /failed to start/);
    assert.equal(typeof meta.endedAt, "number");
  } finally { config.codex = original; }
});

test("metadata write failures do not fail an otherwise successful delegate", async () => {
  const cwd = join(root, "write-failure-work");
  mkdirSync(cwd);
  const promise = delegate({ cwd, prompt: "delay=300", sandbox: "read-only" });
  const { readdirSync } = await import("node:fs");
  const id = readdirSync(runs).find((id) => {
    try { return JSON.parse(readFileSync(join(runs, id, "meta.json"), "utf8")).cwd === cwd; } catch { return false; }
  })!;
  const metaFile = join(runs, id, "meta.json");
  rmSync(metaFile);
  mkdirSync(metaFile);
  assert.equal((await promise).result.ok, true);
});

test("dashboard endpoints are read-only, compact lists, full details, and reject traversal", async () => {
  for (const name of ["pending", "tasks"]) mkdirSync(join(runs, name), { recursive: true });
  writeFileSync(join(runs, "pending", "one.json"), JSON.stringify({ cwd: root, state: "running" }));
  writeFileSync(join(runs, "tasks", "one.json"), JSON.stringify({ id: "task-one", status: "done", text: "large output" }));
  writeFileSync(join(runs, "tasks", "broken.json"), "{");
  const id = "20991016T100256-new";
  mkdirSync(join(runs, id));
  const prompt = "a".repeat(500);
  writeFileSync(join(runs, id, "meta.json"), JSON.stringify({ id, startedAt: Date.UTC(2099, 9, 16), state: "ok", prompt, report }));
  writeFileSync(join(runs, id, "prompt.md"), prompt + WRITE_CONTRACT);
  writeFileSync(join(runs, id, "last-message.txt"), JSON.stringify(report));
  const server = createDashboardServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const get = (path: string, method = "GET") => new Promise<{ status: number; headers: any; body: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: address.port, path, method }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (chunk) => body += chunk);
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
  try {
    const list = await get("/api/runs");
    assert.equal(list.status, 200);
    assert.equal(list.headers["cache-control"], "no-store");
    assert.match(list.headers["content-type"], /application\/json; charset=utf-8/);
    const data = JSON.parse(list.body);
    assert.equal(data.runsDir, runs);
    assert.equal(data.version, version);
    assert.equal(typeof data.generatedAt, "number");
    assert.equal(data.runs[0].id, id);
    assert.equal(data.runs[0].prompt.length, 300);
    assert(data.runs.every((r: object) => !("report" in r)));
    assert.equal(data.pending.length, 1);
    assert.deepEqual(data.tasks, [{ id: "task-one", status: "done" }]);
    const detail = JSON.parse((await get(`/api/runs/${id}`)).body);
    assert.deepEqual(detail.report, report);
    assert.equal(detail.promptFull, prompt + WRITE_CONTRACT);
    assert.equal(detail.lastMessage, JSON.stringify(report));
    assert.equal((await get("/api/runs/unknown")).status, 404);
    for (const path of ["../tasks", "%2e%2e%2ftasks", "%2e%2e%5ctasks", "a/b", "%", "%00"]) {
      assert.equal((await get(`/api/runs/${path}`)).status, 400, path);
    }
    assert.equal((await get("/api/runs", "POST")).status, 405);
    assert.equal((await get("/unknown")).status, 404);
    const home = await get("/");
    const frontend = join(import.meta.dirname, "..", "dashboard", "index.html");
    assert.equal(home.status, existsSync(frontend) ? 200 : 404);
    if (home.status === 200) assert.equal(home.body, readFileSync(frontend, "utf8"));
    else assert.match(home.headers["content-type"], /text\/plain/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  }
});
