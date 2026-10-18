// Stands in for `codex app-server` (JSON-RPC over stdio) in tests. The brief selects a scenario:
//   "quota"      the turn fails with usageLimitExceeded
//   "steer-wait" the turn keeps running until a turn/steer or turn/interrupt arrives
//   otherwise    edit work.txt, answer and complete
// Every request is appended to requests.jsonl in cwd.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const note = (method, params) => send({ method, params });
const log = (m) => appendFileSync("requests.jsonl", `${JSON.stringify(m)}\n`);
writeFileSync("fake.pid", String(process.pid));
let threadId = "fake-thread-1";
let turnId;
let waiting = false;
let redirected = false;
let obedient = false;
let launcher = {};

const item = (it) => { note("item/started", { threadId, turnId, item: it }); note("item/completed", { threadId, turnId, item: it }); };
function complete(status, error = null, text) {
  if (text) item({ type: "agentMessage", id: "m-final", text });
  note("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: {
    total: { totalTokens: 112, inputTokens: 110, cachedInputTokens: 54, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
    last: { totalTokens: 12, inputTokens: 10, cachedInputTokens: 4, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 } } });
  note("turn/completed", { threadId, turn: { id: turnId, items: text ? [{ type: "agentMessage", id: "m-final", text }] : [], status, error } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  log(m);
  const p = m.params ?? {};
  switch (m.method) {
    case "initialize": return send({ id: m.id, result: { userAgent: "fake/0" } });
    case "thread/start": case "thread/resume": case "thread/fork":
      if (m.method !== "thread/start") threadId = p.threadId;
      return send({ id: m.id, result: { thread: { id: threadId }, model: p.model ?? "fake" } });
    case "turn/start": {
      turnId = redirected ? "fake-turn-2" : "fake-turn-1";
      send({ id: m.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      note("turn/started", { threadId, turn: { id: turnId } });
      note("account/rateLimits/updated", { rateLimits: { primary: { usedPercent: 91, windowDurationMins: 300, resetsAt: 1792335420 } } });
      const brief = p.input?.[0]?.text ?? "";
      if (brief.includes("quota")) {
        const error = { message: "You've hit your usage limit. Try again at 10:57 PM.", codexErrorInfo: "usageLimitExceeded" };
        note("error", { threadId, turnId, willRetry: false, error });
        return complete("failed", error);
      }
      if (brief.startsWith("[codex-delegate] You ended your turn")) {
        // Reminder about a kept command: an obedient codex stops it, a careless one ignores it again.
        if (obedient) spawnSync(process.execPath, [launcher.path, launcher.runDir, "stop", "1"], { stdio: "ignore" });
        return complete("completed", null, obedient ? "stopped cmd-1" : "done (ignored the reminder)");
      }
      if (redirected) {
        // The turn that follows a redirect: echo the lead's message and finish (leaving kept commands alone).
        item({ type: "userMessage", id: "u3", clientId: p.clientUserMessageId, content: p.input });
        writeFileSync("redirect-brief.txt", brief);
        obedient = brief.includes("obey");
        return complete("completed", null, `redirected: ${brief.split("Instruction from the lead:\n").at(-1)}`);
      }
      const lr = /node "([^"]+longrun\.mjs)" "([^"]+)" run <n>/.exec(brief);
      if (lr) launcher = { path: lr[1], runDir: lr[2] };
      if (brief.includes("longrun-wait")) {
        // Like codex following the contract: the long command goes through the launcher.
        waiting = true;
        const cmd = spawn(process.execPath, [launcher.path, launcher.runDir, "run", "1", "--", process.execPath, "-e", "setInterval(()=>console.log('tick'),200)"], { stdio: "ignore" });
        // As codex really reports it on Windows: escaped quotes inside powershell -Command.
        const command = `"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "node \\"${launcher.path}\\" \\"${launcher.runDir}\\" run 1 -- node -e tick"`;
        return note("item/started", { threadId, turnId, item: { type: "commandExecution", id: "c1", command, status: "inProgress", processId: String(cmd.pid) } });
      }
      const checkpointDir = /checkpoint-<n>\.md/.test(brief) && /write a short stage report to (.+?)checkpoint-<n>\.md/.exec(brief)?.[1];
      if (checkpointDir) writeFileSync(`${checkpointDir}checkpoint-1.md`, "# Found the real cause in parser.ts\nFound: x\nPlan next: y\nOpen choice / risk: none\n");
      if (brief.includes("steer-wait")) {
        waiting = true;
        // A real long command, like codex's shell: an interrupt leaves it running unless someone kills it.
        const cmd = spawn(process.execPath, ["-e", "setTimeout(()=>{},100000)"], { detached: true, stdio: "ignore" });
        cmd.unref();
        writeFileSync("command.pid", String(cmd.pid));
        return note("item/started", { threadId, turnId, item: { type: "commandExecution", id: "c1", command: "sleep 100", status: "inProgress", processId: String(cmd.pid) } });
      }
      appendFileSync("work.txt", "edited\n");
      item({ type: "fileChange", id: "f1", status: "completed", changes: [{ path: `${process.cwd()}/work.txt`, kind: { type: "update", move_path: null }, diff: "" }] });
      const final = p.outputSchema ? JSON.stringify({ status: "done", summary: "fake done", changes: ["work.txt"], verification: [], risks: [], questions: [] }) : "plain fake answer";
      return complete("completed", null, final);
    }
    case "turn/steer": {
      if (p.expectedTurnId !== turnId || !waiting) return send({ id: m.id, error: { code: -32600, message: "no active turn" } });
      send({ id: m.id, result: { turnId } });
      // The command "finishes" normally here, so the fixture ends it itself.
      try { process.kill(Number(readFileSync("command.pid", "utf8"))); } catch {}
      note("item/completed", { threadId, turnId, item: { type: "commandExecution", id: "c1", command: "sleep 100", status: "completed", exitCode: 0, aggregatedOutput: "" } });
      item({ type: "userMessage", id: "u2", clientId: p.clientUserMessageId, content: p.input });
      waiting = false;
      return complete("completed", null, `steered: ${p.input?.[0]?.text}`);
    }
    case "turn/interrupt":
      send({ id: m.id, result: {} });
      waiting = false;
      redirected = true;
      return complete("interrupted");
    default:
      if (m.id !== undefined) send({ id: m.id, result: {} });
  }
});
