// Live probe for `codex app-server`: start a turn, steer it mid-way, interrupt, resume.
// Usage: node bench/appserver_probe.ts [steer|interrupt]
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { config } from "../src/config.ts";

const mode = process.argv[2] ?? "steer";
const cwd = mkdtempSync(join(tmpdir(), "as-probe-"));
const child = spawn(config.codex.cmd, [...config.codex.args, "app-server"], { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
child.stderr.on("data", d => process.stderr.write(`[stderr] ${d}`));
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);

let nextId = 1;
const waiting = new Map<number, (m: any) => void>();
const listeners: ((m: any) => void)[] = [];
createInterface({ input: child.stdout }).on("line", line => {
  let m: any;
  try { m = JSON.parse(line); } catch { return log("non-json", line.slice(0, 200)); }
  if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id); return; }
  if (m.id !== undefined && m.method) { log("SERVER REQUEST", m.method); child.stdin.write(JSON.stringify({ id: m.id, result: { decision: "decline" } }) + "\n"); return; }
  const it = m.params?.item;
  if (!/delta|tokenUsage|rateLimits|mcpServer|skills|reasoning/i.test(m.method ?? ""))
    log("<-", m.method, it ? `${it.type} pid=${it.processId} ${it.command ?? it.text?.slice(0, 120) ?? ""}` : JSON.stringify(m.params ?? {}).slice(0, 200));
  for (const l of listeners) l(m);
});
const rpc = (method: string, params: unknown) => new Promise<any>((res, rej) => {
  const id = nextId++;
  waiting.set(id, m => (m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result)));
  child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
});
const until = (pred: (m: any) => boolean, ms = 300000) => new Promise<any>((res, rej) => {
  const timer = setTimeout(() => rej(new Error("timeout")), ms);
  listeners.push(m => { if (pred(m)) { clearTimeout(timer); res(m); } });
});
const text = (t: string) => [{ type: "text", text: t, text_elements: [] }];

try {
  log("init", JSON.stringify(await rpc("initialize", { clientInfo: { name: "probe", title: null, version: "0" }, capabilities: { experimentalApi: true, requestAttestation: false } })).slice(0, 200));
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  if (mode === "resume") {
    // A session made by `codex exec`, continued through app-server with a structured final message.
    const exec = spawn(config.codex.cmd, [...config.codex.args, "exec", "--json", "--skip-git-repo-check", "-s", "workspace-write", "-m", "gpt-6-luna", "-c", 'model_reasoning_effort="low"', "-C", cwd, "Create seed.txt containing seed, reply OK."], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    exec.stdout.on("data", d => (out += d));
    await new Promise(r => exec.on("close", r));
    const execThread = out.match(/"thread_id":"([^"]+)"/)?.[1];
    log("exec thread", execThread);
    const r = await rpc("thread/resume", { threadId: execThread, cwd, sandbox: "workspace-write", approvalPolicy: "never", excludeTurns: true });
    log("resumed", r.thread.id);
    const schema = { type: "object", properties: { status: { type: "string", enum: ["done"] }, files: { type: "array", items: { type: "string" } } }, required: ["status", "files"], additionalProperties: false };
    await rpc("turn/start", { threadId: execThread, input: text("Create second.txt containing second. Report every file you created in this session."), outputSchema: schema });
    const d = await until(m => m.method === "turn/completed");
    log("final", d.params.turn.status, JSON.stringify(d.params.turn.items.filter((i: any) => i.type === "agentMessage").at(-1)?.text));
    child.stdin.end();
    const exited = await Promise.race([new Promise(r => child.on("exit", c => r(`exited ${c}`))), new Promise(r => setTimeout(() => r("still alive after 5s"), 5000))]);
    log("after stdin end:", exited);
    process.exit(0);
  }
  const th = await rpc("thread/start",{ cwd, sandbox: "workspace-write", approvalPolicy: "never", model: process.env.PROBE_MODEL ?? "gpt-6-luna", config: { model_reasoning_effort: "low" } });
  const threadId = th.thread.id;
  log("thread", threadId, th.model, th.reasoningEffort);
  // Each file needs fresh model-written content, so every step is a separate sampling decision.
  const brief = "Write six short original four-line poems, one per file: a1.txt about rivers, a2.txt about mountains, a3.txt about cities, a4.txt about deserts, a5.txt about forests, a6.txt about oceans. Write each file with its own separate apply_patch edit (one file per edit, never a script or a loop), in order. Then reply DONE.";
  const turn = await rpc("turn/start", { threadId, input: text(brief) });
  const turnId = turn.turn.id;
  log("turn", turnId, turn.turn.status);
  await until(m => m.method === "item/completed" && (m.params.item.type === "fileChange" || m.params.item.type === "commandExecution"));
  if (mode === "steer") {
    const r = await rpc("turn/steer", { threadId, expectedTurnId: turnId, input: text("CHANGE OF PLAN: stop after the file you are on. Instead create STEERED.txt containing the word steered, then reply STEERED-OK.") });
    log("steer ack", JSON.stringify(r));
    const done = await until(m => m.method === "turn/completed");
    log("turn done", done.params.turn.status, JSON.stringify(done.params.turn.error));
  } else {
    await rpc("turn/interrupt", { threadId, turnId });
    const done = await until(m => m.method === "turn/completed");
    log("interrupted", done.params.turn.status);
    const t2 = await rpc("turn/start", { threadId, input: text("New direction: forget the remaining files, create RESUMED.txt containing resumed, reply RESUMED-OK.") });
    log("turn2", t2.turn.id);
    const d2 = await until(m => m.method === "turn/completed");
    log("turn2 done", d2.params.turn.status);
  }
  for (const f of ["a1.txt", "a2.txt", "a3.txt", "a4.txt", "a5.txt", "a6.txt", "STEERED.txt", "RESUMED.txt"]) log(f, existsSync(join(cwd, f)) ? readFileSync(join(cwd, f), "utf8").trim() : "-");
} catch (e) {
  log("FAIL", e);
} finally {
  child.stdin.end();
  child.kill();
}
