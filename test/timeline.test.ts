import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request } from "node:http";
import { parseTimeline, readTimeline } from "../src/timeline.ts";
import { createDashboardServer, deriveHealth, pidAlive, readRun } from "../src/dashboard.ts";
import { config } from "../src/config.ts";
import type { RunSummary } from "../src/run-summary.ts";

const fixture = readFileSync(join(import.meta.dirname, "fixtures", "timeline-rollout.jsonl"), "utf8");
const root = mkdtempSync(join(tmpdir(), "cd-timeline-"));
after(() => rmSync(root, { recursive: true, force: true }));
const now = Date.now();
const active: RunSummary = { id: "20261017T050000-test", state: "running", startedAt: now - 500000,
  lastEventAt: now - 1000, heartbeatAt: now, pid: process.pid, phase: "codex" };

test("rollout parser preserves messages, pairs tools, handles content arrays and durations", () => {
  const all = parseTimeline(fixture, "rollout");
  assert.equal(all.length, 11);
  assert.deepEqual(all.slice(0, 8).map((e) => e.kind), ["system", "system", "user", "reasoning", "command", "tool_output", "tokens", "assistant"]);
  assert.equal(all[2]!.text, "fix the tests");
  assert.equal(all[3]!.text, "inspect first");
  assert.equal(all[5]!.text, "Ran 3 tests\nOK");
  assert.equal(all[5]!.durationMs, 5000);
  assert.equal(all[5]!.callId, "call-1");
  assert.equal(all[8]!.exitCode, 0);
  assert.equal(all[8]!.durationMs, 2500);
  assert.equal(all[9]!.kind, "file_change");
  assert.equal(all[10]!.durationMs, 1000);
  assert(!JSON.stringify(all).includes("LONG DEVELOPER"));
  const incremental = parseTimeline(fixture, "rollout", 5);
  assert.equal(incremental[0]!.seq, 6);
  assert.equal(incremental[0]!.durationMs, 5000, "pairing still sees calls before after");
  assert.equal(incremental[0]!.ts, "2026-10-17T05:00:09.000Z");
});

test("timeline limits, malformed tails, event fallback, and title/text caps", () => {
  const text = "x".repeat(21000) + "\nnext";
  const event = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
  const result = parseTimeline(`${event}\nmalformed\n${event}\n{`, "events");
  assert.deepEqual(result.map((e) => e.seq), [1, 3]);
  assert.equal(result[0]!.ts, null);
  assert.equal(result[0]!.title.length, 200);
  assert(result[0]!.text.length <= 20000);
  const omitted = Number(/…\[truncated (\d+) chars\]$/.exec(result[0]!.text)?.[1]);
  assert.equal(result[0]!.text.slice(0, result[0]!.text.indexOf("…[truncated")).length + omitted, text.length);
  assert.equal(result[0]!.status, "completed");
  assert.equal(parseTimeline(Array(600).fill(event).join("\n"), "events").length, 500);
  const tool = parseTimeline(JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "lookup", arguments: "{}", call_id: "lookup-1" } }), "rollout")[0]!;
  assert.equal(tool.kind, "tool");
  assert.equal(parseTimeline('{"type":"turn.failed","error":{"message":"bad"}}', "events")[0]!.kind, "error");
});

test("rollout discovery honors home, searches the next day, and prefers rollout over events", async () => {
  const runs = join(root, "discovery");
  const home = join(root, "codex-home");
  const run = { ...active, startedAt: Date.UTC(2026, 9, 16, 23), sessionId: "test-session", state: "ok" as const };
  mkdirSync(join(runs, run.id), { recursive: true });
  writeFileSync(join(runs, run.id, "events.jsonl"), '{"type":"thread.started","thread_id":"test-session"}\n');
  const fallback = await readTimeline(runs, run, 0, home);
  assert.equal(fallback.source, "events");
  assert.equal(fallback.done, true);
  const dir = join(home, "sessions", "2026", "10", "17");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "rollout-any-test-session.jsonl"), fixture);
  const timeline = await readTimeline(runs, run, 5, home);
  assert.equal(timeline.runId, run.id);
  assert.equal(timeline.sessionId, "test-session");
  assert.equal(timeline.source, "rollout");
  assert.equal(timeline.nextSeq, 11);
  assert.equal(timeline.entries[0]!.durationMs, 5000);
  const empty = await readTimeline(runs, run, 11, home);
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.nextSeq, 11);
});

test("health derives quiet/stalled/orphaned state, per-command override, checks output, and disabled deadlines", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(-1), false);
  assert.equal(deriveHealth(active, now), "active");
  assert.equal(deriveHealth({ ...active, state: "error", pid: -1 }, now), "ok");
  assert.equal(deriveHealth({ ...active, pid: -1 }, now), "orphaned");
  assert.equal(deriveHealth({ ...active, heartbeatAt: now - 90001 }, now), "orphaned");
  assert.equal(deriveHealth({ ...active, lastEventAt: now - 120000, idleTimeoutSec: 600 }, now), "quiet");
  assert.equal(deriveHealth({ ...active, lastEventAt: now - 600001, idleTimeoutSec: 600 }, now), "stalled");
  const command = { ...active, lastEventAt: now - 700000, commandIdleTimeoutSec: 1200,
    inflight: { type: "command_execution", command: "tests", startedAt: now - 700000 } };
  assert.equal(deriveHealth(command, now), "quiet");
  assert.equal(deriveHealth({ ...command, commandIdleTimeoutSec: 300 }, now), "stalled");
  assert.equal(deriveHealth({ ...command, commandIdleTimeoutSec: 0 }, now), "quiet");
  assert.equal(deriveHealth({ ...active, phase: "checks", lastEventAt: now - 3600000,
    checks: [{ command: "tests", startedAt: now - 200000, state: "running", lastOutputAt: now - 1000 }] }, now), "active");
  assert.equal(deriveHealth({ ...active, phase: "checks", checkIdleTimeoutSec: 300,
    checks: [{ command: "tests", startedAt: now - 300001, state: "running" }] }, now), "stalled");
});

test("readRun health and timeline HTTP endpoints validate after and ids, cap pages, and stay GET-only", async () => {
  const runs = join(root, "http-runs");
  const run = { ...active, sessionId: "no-rollout-session" };
  mkdirSync(join(runs, run.id), { recursive: true });
  writeFileSync(join(runs, run.id, "meta.json"), JSON.stringify(run));
  const event = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "answer" } });
  writeFileSync(join(runs, run.id, "events.jsonl"), Array(502).fill(event).join("\n") + "\n");
  assert.equal((await readRun(runs, run.id))?.health, "active");
  const server = createDashboardServer({ runsDir: runs });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const get = (path: string, method = "GET") => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: address.port, path, method }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(body) }));
    });
    req.on("error", reject); req.end();
  });
  const url = `/api/runs/${run.id}/timeline`;
  try {
    const first = await get(url);
    assert.equal(first.status, 200);
    assert.equal(first.body.entries.length, 500);
    assert.equal(first.body.nextSeq, 500);
    assert.equal(first.body.done, false);
    const next = await get(`${url}?after=500`);
    assert.equal(next.body.entries.length, 2);
    assert.equal(next.body.entries[0].seq, 501);
    assert.equal(next.body.nextSeq, 502);
    for (const suffix of ["-1", "1.1", "NaN", "9007199254740992", "0&after=1", ""]) assert.equal((await get(`${url}?after=${suffix}`)).status, 400);
    assert.equal((await get(url, "POST")).status, 405);
    assert.equal((await get("/api/runs/unknown/timeline")).status, 404);
    assert.equal((await get("/api/runs/%2e%2e%5ctasks/timeline")).status, 400);
    const list = await get("/api/runs");
    assert.equal(list.body.runs[0].phase, "codex");
    assert.equal(list.body.runs[0].health, "active");
    assert.equal(list.body.runs[0].lastEventAt, run.lastEventAt);
  } finally { await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); }
});

test("code-mode exec calls get the shell command as title, outputs their exit code, and rollouts are cut to the run window", async () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 17, 5, 0, s)).toISOString();
  const rows = [
    { timestamp: at(1), type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c1", input: 'let r=await tools.exec_command({cmd:"python -m unittest \\"a b\\"", yield_time_ms: 1})' } },
    { timestamp: at(3), type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c1", output: 'Script completed\n{"exit_code":1,"output":"FAIL"}' } },
    { timestamp: at(50), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "later resumed run" }] } },
  ];
  const [call, out] = parseTimeline(rows.map((r) => JSON.stringify(r)).join("\n"), "rollout");
  assert.equal(call!.title, 'python -m unittest "a b"');
  assert.equal(call!.kind, "command");
  assert.equal(out!.exitCode, 1);
  assert.equal(out!.durationMs, 2000);

  const home = join(root, "window-home"), sid = "window-session";
  mkdirSync(join(home, "sessions", "2026", "10", "17"), { recursive: true });
  writeFileSync(join(home, "sessions", "2026", "10", "17", `rollout-x-${sid}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n"));
  const run: RunSummary = { id: "20261017T050000-win", state: "error", sessionId: sid, startedAt: Date.parse(at(0)), endedAt: Date.parse(at(10)) };
  const t = await readTimeline(root, run, 0, home);
  assert.deepEqual(t.entries.map((e) => e.seq), [1, 2]);
});
