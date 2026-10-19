import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { atomic, readJson } from "../src/inbox.ts";
import { appendHandoff } from "../src/handoffs.ts";
import type { RunSummary } from "../src/run-summary.ts";

test("MCP delegate/session and stored task tools consume once; parent notifications wake sync and task_result", { timeout: 45000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "continue-mcp-"));
  const runs = join(root, "runs");
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dirname, "..", "src", "index.ts")], cwd: root,
    env: { ...process.env as Record<string, string>, CODEX_BIN: join(import.meta.dirname, "fixtures", "fake-app-server.mjs"), CODEX_DELEGATE_ENGINE: "app-server", CODEX_DELEGATE_RUNS_DIR: runs, CODEX_DELEGATE_POLICY: join(root, "policy.json"), CODEX_DELEGATE_CHECKPOINT_POLL_MS: "50" }, stderr: "pipe" });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  const call = async (name: string, args: object) => {
    const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
    assert.equal(result.isError ?? false, false, JSON.stringify(result));
    return (result.content as { text: string }[]).map(c => c.text).join("\n");
  };
  const event = (id: string, session: string, notify = false, parentPid = -1) => ({ runId: id, sessionId: session, at: Date.now(), text: "human change " + id, state: "ok", reply: "changed it", changes: ["work.txt"], notify, parentPid });
  async function owner() {
    for (let n = 0; n < 500; n++) {
      for (const id of await readdir(runs)) {
        const meta = await readJson<RunSummary>(join(runs, id, "meta.json"));
        if (meta?.state === "running" && meta.turnId) return meta.pid!;
      }
      await new Promise(r => setTimeout(r, 10));
    }
    assert.fail("no active turn");
  }
  try {
    await appendHandoff(runs, "explicit", event("delegate-once", "explicit"));
    const response = await call("delegate", { prompt: "hello", effort: "low", sandbox: "read-only", session_id: "explicit" });
    assert.match(response, /^user continued this codex session from the dashboard:/);
    assert.match(response, /human change delegate-once[\s\S]*changed it[\s\S]*work.txt/);
    assert.doesNotMatch(await call("delegate", { prompt: "hello", effort: "low", sandbox: "read-only", session_id: "explicit" }), /user continued/);
    await atomic(join(runs, "tasks", "stored.json"), { id: "stored", status: "done", startedAt: Date.now(), sessionId: "stored-session", text: "original result" });
    await appendHandoff(runs, "stored-session", event("task-once", "stored-session"));
    assert.match(await call("task_result", { task_id: "stored" }), /^user continued/);
    assert.doesNotMatch(await call("task_result", { task_id: "stored" }), /user continued/);
    await appendHandoff(runs, "stored-session", event("inspect-once", "stored-session"));
    assert.match(await call("task_inspect", { task_id: "stored" }), /^user continued/);

    const sync = call("delegate", { prompt: "quiet-wait", effort: "low", sandbox: "read-only", fresh: true });
    void sync.catch(() => {});
    const pid = await owner();
    await appendHandoff(runs, "notify-sync", event("sync-wake", "notify-sync", true, pid));
    const wake = await sync;
    assert.match(wake, /^status: user_continued .* is finished\)/);
    assert.match(wake, /human change sync-wake/);
    const tasks = await call("task_list", {});
    const taskId = /task_[\w]+/.exec(tasks)![0];
    await call("task_cancel", { task_id: taskId });
    const started = await call("delegate_async", { prompt: "quiet-wait", effort: "low", sandbox: "read-only", fresh: true });
    const second = /task_[\w]+/.exec(started)![0];
    await owner();
    const waiting = call("task_result", { task_id: second, wait_s: 30 });
    await appendHandoff(runs, "notify-task", { ...event("task-wake", "notify-task", true, pid), state: "started" });
    assert.match(await waiting, /^status: user_continued .* is running\)/);
    assert.doesNotMatch(await call("task_list", {}), /user continued/);
    await call("task_cancel", { task_id: second });
    // Idle notifications appear on the next tool response, while non-notify stays untouched.
    await appendHandoff(runs, "quiet", event("quiet", "quiet"));
    await appendHandoff(runs, "idle", event("idle", "idle", true, pid));
    assert.match(await call("task_list", {}), /human change idle/);
    assert.doesNotMatch(await call("task_list", {}), /user continued/);
    const quiet = await readFile(join(runs, "handoffs", "quiet.jsonl"), "utf8");
    assert.match(quiet, /quiet/);
    await assert.rejects(readFile(join(runs, "handoffs", "quiet.consumed.json")));
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
