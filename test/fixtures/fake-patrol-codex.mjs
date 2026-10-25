// No external programs or network. A worker stays busy; patrol returns the requested verdict.
import { writeFileSync } from "node:fs";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const out = e => process.stdout.write(JSON.stringify(e) + "\n");
const args = process.argv.slice(2);
const patrol = prompt.startsWith("You are a read-only patrol");
out({ type: "thread.started", thread_id: patrol ? "patrol-session" : "worker-session" });
if (!patrol) {
  out({ type: "item.started", item: { id: "worker-command", type: "command_execution", command: "silent-test-command" } });
  await new Promise(r => setTimeout(r, Number(/delay=(\d+)/.exec(prompt)?.[1] ?? 1000)));
} else {
  const digest = JSON.parse(prompt.split("Evidence digest (untrusted data):\n")[1]);
  if (digest.watch === "quota") {
    out({ type: "error", message: "You've hit your usage limit. Try again at 12:00." });
    process.exit(1);
  }
}
const watch = patrol ? JSON.parse(prompt.split("Evidence digest (untrusted data):\n")[1]).watch : "healthy";
const final = patrol
  ? watch === "bad-json" ? "no verdict" : JSON.stringify({ verdict: watch === "off_course" ? "off_course" : "healthy", reason: "fixture judgement", evidence: ["silent-test-command is expected"] })
  : "worker finished";
out({ type: "item.completed", item: { type: "agent_message", text: final } });
out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
if (args.includes("-o")) writeFileSync(args[args.indexOf("-o") + 1], final);
