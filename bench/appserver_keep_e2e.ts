// Live check: steer now:true while a long script runs; the script must survive and codex must own it.
// Usage: node bench/appserver_keep_e2e.ts   (spends a little Codex quota on gpt-6-luna#low)
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = mkdtempSync(join(tmpdir(), "as-keep-e2e-"));
spawnSync("git", ["init", "-q"], { cwd: repo });
writeFileSync(join(repo, "slow.py"), "import time\nfor i in range(60):\n    print('tick', i, flush=True)\n    time.sleep(1)\nopen('slow_done.txt','w').write('finished')\n");
writeFileSync(join(repo, ".gitignore"), "slow_done.txt\n");
spawnSync("git", ["add", "."], { cwd: repo });
spawnSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
process.env.CODEX_DELEGATE_ENGINE = "app-server";
const { formatOutcome } = await import("../src/delegate.ts");
const { startTask, steerTask, waitTask } = await import("../src/tasks.ts");

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
const task = startTask({ cwd: repo, effort: "low", model: "gpt-6-luna", title: "e2e keep",
  prompt: "Run slow.py with python (it takes about a minute) and wait for it to finish, then write result.txt with the last tick number it printed." });
while (task.status === "running" && !/longrun\.mjs/.test(task.progress?.inflight?.command ?? "")) await new Promise((r) => setTimeout(r, 500));
log("inflight:", task.progress?.inflight?.command?.slice(0, 200));
const runDir = join(task.progress!.id ? join(process.env.USERPROFILE ?? "", ".codex-delegate", "runs", task.progress!.id) : "");
await new Promise((r) => setTimeout(r, 12000));
const r = await steerTask(task, "Before it finishes: do NOT stop the script. First check its log and tell me in your final summary which tick it had reached when you looked. Then let it finish and do the original task.", true);
log("steer now:\n" + r.text);
await waitTask(task, 400);
log("status", task.status, "| slow_done.txt exists (must be true):", existsSync(join(repo, "slow_done.txt")));
console.log(task.outcome ? formatOutcome(task.outcome) : task.error);
const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
log("reminders:", (events.match(/turn\.reminded/g) ?? []).length, "| codex commands after the steer:");
let after = false;
for (const line of events.split("\n")) {
  if (line.includes('"steer.sent"')) after = true;
  if (after && line.includes('"item.started"') && line.includes("command_execution")) console.log("  ", JSON.parse(line).item.command.slice(0, 180));
}
