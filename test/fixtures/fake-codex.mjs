// Stands in for `codex exec --json` in integration tests: reads the brief from stdin, edits a file
// in cwd, prints the JSONL events codex prints and writes the final message to the -o file.
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;

writeFileSync("fake.pid", String(process.pid));
writeFileSync("prompt.txt", prompt);
const out = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
// Like codex: the thread id comes first; `exec resume <id>` keeps the session's id.
out({ type: "thread.started", thread_id: args[1] === "resume" ? args[2] : "fake-session-1" });
const delay = Number(/delay=(\d+)/.exec(prompt)?.[1] ?? 0);
await new Promise((r) => setTimeout(r, delay));

writeFileSync("argv.json", JSON.stringify(args));
appendFileSync("work.txt", "edited\n");
out({ type: "item.completed", item: { type: "file_change", status: "completed", changes: [{ path: `${process.cwd()}/work.txt`, kind: "update" }] } });
out({ type: "item.completed", item: { type: "agent_message", text: "progress note" } });
const final = opt("--output-schema")
  ? JSON.stringify({ status: "done", summary: `got ${prompt.length} chars`, changes: ["work.txt: edited"], verification: [{ command: "true", result: "ok" }], risks: [], questions: [] })
  : `plain answer for: ${prompt.split("\n")[0]}`;
out({ type: "item.completed", item: { type: "agent_message", text: final } });
out({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } });
if (opt("-o")) writeFileSync(opt("-o"), final);
