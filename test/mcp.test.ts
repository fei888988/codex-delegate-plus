import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

// Drives the real server over stdio, the way Claude Code / Claude Desktop does, with a fake codex.
let server: ChildProcessWithoutNullStreams;
let dir: string;
const pending = new Map<number, (msg: any) => void>();
let nextId = 1;
const notifications: string[] = [];

function call(method: string, params: object = {}): Promise<any> {
  const id = nextId++;
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((r) => pending.set(id, r));
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "cd-mcp-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  server = spawn(process.execPath, [join(import.meta.dirname, "..", "src", "index.ts")], {
    cwd: dir,
    env: { ...process.env, CODEX_BIN: join(import.meta.dirname, "fixtures", "fake-codex.mjs"), CODEX_DELEGATE_RUNS_DIR: join(dir, "runs"), CODEX_DELEGATE_POLICY: join(dir, "policy.json") },
  });
  let buf = "";
  server.stdout.setEncoding("utf8").on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id !== undefined && pending.has(msg.id)) pending.get(msg.id)!(msg);
      else if (msg.method) notifications.push(msg.method);
    }
  });
  await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
});

after(async () => {
  const exited = new Promise((r) => server.once("exit", r));
  server.kill();
  await exited; // on Windows the directory can't be removed while the server still has it as cwd
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test("tools are listed and delegate defaults cwd to the server's cwd", async () => {
  const list = await call("tools/list");
  const names = list.result.tools.map((t: any) => t.name);
  for (const n of ["delegate", "delegate_async", "task_result", "task_cancel", "task_inspect", "list_models"]) assert(names.includes(n), n);
  // The lead must pick a cost tier from the policy (defaults: luna-xhigh, low, medium, high).
  const schema = list.result.tools.find((t: any) => t.name === "delegate").inputSchema;
  assert(schema.required.includes("effort"));
  assert.deepEqual(schema.properties.sandbox.enum, ["read-only", "write"]);
  assert.deepEqual(schema.properties.effort.enum, ["luna-xhigh", "low", "medium", "high"]);
  assert.match(list.result.tools.find((t: any) => t.name === "delegate").description, /Cost policy:/);
  const bad = await call("tools/call", { name: "delegate", arguments: { prompt: "x", effort: "xhigh" } });
  assert.equal(bad.result?.isError ?? !!bad.error, true, "xhigh rejected by the schema");
  const r = await call("tools/call", { name: "delegate", arguments: { prompt: "quick", effort: "low" } });
  assert.equal(r.result.isError, false, r.result.content[0].text);
  assert.match(r.result.content[0].text, /codex status: done/);
  assert(existsSync(join(dir, "work.txt")), "ran in the server's cwd");
});

test("saving the policy file updates the tool definitions and notifies the client", async () => {
  const tiers = [{ id: "cheap", model: "gpt-6-luna", effort: "low", use: "small things" }, { id: "big", effort: "high", use: "hard things" }];
  const delegateTool = async () => (await call("tools/list")).result.tools.find((t: any) => t.name === "delegate");
  // The server polls the file every 2s; wait for the tool to change rather than a fixed time.
  const waitFor = async (ids: string[]) => {
    for (let i = 0; i < 80; i++) {
      const tool = await delegateTool();
      if (JSON.stringify(tool.inputSchema.properties.effort.enum) === JSON.stringify(ids)) return tool;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail(`effort enum never became ${ids}`);
  };
  const seen = notifications.length;
  writeFileSync(join(dir, "policy.json"), JSON.stringify({ guidance: "CUSTOM GUIDANCE", tiers }));
  try {
    const tool = await waitFor(["cheap", "big"]);
    assert(notifications.slice(seen).includes("notifications/tools/list_changed"));
    assert.match(tool.inputSchema.properties.effort.description, /- cheap \(gpt-6-luna#low\): small things/);
    assert.match(tool.description, /CUSTOM GUIDANCE$/);
  } finally {
    // Later tests use the default tiers.
    rmSync(join(dir, "policy.json"), { force: true });
    await waitFor(["luna-xhigh", "low", "medium", "high"]);
  }
});

test("cancelling a tool call (the Stop button) kills the codex process", async () => {
  const pidFile = join(dir, "fake.pid");
  rmSync(pidFile, { force: true }); // left over from the previous test
  const id = nextId;
  const done = call("tools/call", { name: "delegate", arguments: { prompt: "delay=60000", cwd: dir, effort: "medium" } });
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 300));
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert(alive(pid));
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "user stop" } })}\n`);
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(pid), false, "codex child still running after cancel");
  // The SDK drops the response for a cancelled request; just make sure the server is still usable.
  void done;
  // The redirect after Stop continues the killed session instead of starting a new one.
  const again = await call("tools/call", { name: "delegate", arguments: { prompt: "after cancel: new direction", cwd: dir, effort: "medium" } });
  assert.equal(again.result.isError, false, again.result.content[0].text);
  assert.match(again.result.content[0].text, /^continued: the interrupted run in this cwd \(session fake-session-1\)/m);
  const argv = JSON.parse(readFileSync(join(dir, "argv.json"), "utf8"));
  assert.deepEqual(argv.slice(1, 3), ["resume", "fake-session-1"]);
  assert.match(readFileSync(join(dir, "prompt.txt"), "utf8"), /The user stopped your previous turn[\s\S]*after cancel: new direction/);
});

// A second server on the same runs dir starts a long delegate; returns it and the fake codex pid.
async function busyServer() {
  const other = spawn(process.execPath, [join(import.meta.dirname, "..", "src", "index.ts")], {
    cwd: dir,
    env: { ...process.env, CODEX_BIN: join(import.meta.dirname, "fixtures", "fake-codex.mjs"), CODEX_DELEGATE_RUNS_DIR: join(dir, "runs"), CODEX_DELEGATE_POLICY: join(dir, "policy.json") },
  });
  const send = (m: object) => other.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t2", version: "1" } } });
  send({ method: "notifications/initialized" });
  rmSync(join(dir, "fake.pid"), { force: true });
  send({ id: 2, method: "tools/call", params: { name: "delegate", arguments: { prompt: "delay=60000 long job", cwd: dir, effort: "medium" } } });
  for (let i = 0; i < 100 && !existsSync(join(dir, "fake.pid")); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 500));
  return { other, codexPid: Number(readFileSync(join(dir, "fake.pid"), "utf8")) };
}

const waitDead = async (pid: number) => {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
};

test("client goes away (stdin closed): server kills codex and exits; the next server continues", async () => {
  const { other, codexPid } = await busyServer();
  const exited = new Promise((r) => other.once("exit", r));
  other.stdin.end();
  await exited;
  assert(await waitDead(codexPid), "codex child outlived its server");
  const r = await call("tools/call", { name: "delegate", arguments: { prompt: "changed my mind", cwd: dir, effort: "medium" } });
  assert.match(r.result.content[0].text, /^continued: the interrupted run/m, r.result.content[0].text);
});

test("server hard-killed (no exit handlers): the next run kills the orphaned codex, then continues", async () => {
  const { other, codexPid } = await busyServer();
  const exited = new Promise((r) => other.once("exit", r));
  other.kill("SIGKILL");
  await exited;
  const r = await call("tools/call", { name: "delegate", arguments: { prompt: "new direction after crash", cwd: dir, effort: "medium" } });
  assert.match(r.result.content[0].text, /^continued: the interrupted run/m, r.result.content[0].text);
  assert(await waitDead(codexPid), "orphaned codex still running");
});

test("killOrphan kills a leftover node/codex process tree", async () => {
  const { killOrphan } = await import("../src/procs.ts");
  const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: process.platform !== "win32", stdio: "ignore" });
  orphan.unref();
  await new Promise((r) => setTimeout(r, 300));
  assert(alive(orphan.pid!));
  killOrphan(orphan.pid!);
  assert(await waitDead(orphan.pid!), "orphan still alive");
});


test("MCP accepts legacy sandbox values without advertising them", async () => {
  for (const sandbox of ["workspace-write", "danger-full-access"]) {
    const r = await call("tools/call", { name: "delegate", arguments: { prompt: "legacy", effort: "low", sandbox } });
    assert.equal(r.result.isError, false, r.result.content[0].text);
    assert.match(r.result.content[0].text, /sandbox: danger-full-access/);
  }
});
