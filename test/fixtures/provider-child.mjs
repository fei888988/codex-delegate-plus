// Dependency-free child process for testing both engine launch paths and credential redaction.
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const key = process.env.CODEX_DELEGATE_PROVIDER_KEY;
if (!key || args.some(arg => arg.includes(key))) process.exit(2);
writeFileSync("provider-launch.json", JSON.stringify({ args, hasKey: !!key }));
const out = value => process.stdout.write(JSON.stringify(value) + "\n");
if (args[0] === "app-server") {
  for await (const line of createInterface({ input: process.stdin })) {
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    if (msg.method === "initialize") out({ id: msg.id, result: {} });
    else if (msg.method === "thread/start") {
      if (msg.params.modelProvider !== "cdp_relay") process.exit(3);
      out({ id: msg.id, result: { thread: { id: "provider-thread" } } });
    } else if (msg.method === "turn/start") {
      out({ id: msg.id, result: { turn: { id: "t" } } });
      out({ method: "item/completed", params: { item: { type: "agentMessage", text: key } } });
      out({ method: "turn/completed", params: { turn: { id: "t", status: "completed" } } });
    }
  }
} else {
  for await (const chunk of process.stdin) { /* consume prompt */ }
  out({ type: "thread.started", thread_id: "provider-thread" });
  const line = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: key } }) + "\n";
  // Split the key across chunks: the log must redact the assembled line.
  const split = line.indexOf(key) + 6;
  process.stdout.write(line.slice(0, split));
  await new Promise(resolve => setTimeout(resolve, 10));
  process.stdout.write(line.slice(split));
  process.stderr.write(key);
  const outputIndex = args.indexOf("-o");
  if (outputIndex >= 0) writeFileSync(args[outputIndex + 1], key);
  out({ type: "turn.completed", usage: {} });
}
