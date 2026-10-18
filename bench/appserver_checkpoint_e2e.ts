// Live check: a checkpointed sync delegate wakes the lead, then steer now:true kills a long script.
// Usage: node bench/appserver_checkpoint_e2e.ts   (spends a little Codex quota on gpt-6-luna#low)
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = mkdtempSync(join(tmpdir(), "as-cp-e2e-"));
spawnSync("git", ["init", "-q"], { cwd: repo });
writeFileSync(join(repo, "slow.py"), "import time\nfor i in range(120):\n    print('tick', i, flush=True)\n    time.sleep(1)\nopen('slow_done.txt','w').write('finished')\n");
spawnSync("git", ["add", "."], { cwd: repo });
spawnSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
process.env.CODEX_DELEGATE_ENGINE = "app-server";
const { formatOutcome } = await import("../src/delegate.ts");
const { delegateSync, formatCheckpoints, newCheckpoints, steerTask, waitTask } = await import("../src/tasks.ts");

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
const task = await delegateSync({ cwd: repo, effort: "low", model: "gpt-6-luna", title: "e2e checkpoint", checkpoints: true,
  prompt: "Two phases. Phase 1: read slow.py and decide how to run it (it takes about two minutes). Phase 2: run it with python and wait for it to finish, then write result.txt with the last tick number." });
log("delegate returned:", task.status);
if (newCheckpoints(task).length) console.log(formatCheckpoints(task));
// The script itself, not a command that merely mentions it (e.g. writing the checkpoint).
const runsSlow = (c = "") => /python[^|;]*slow\.py/i.test(c) && !/Set-Content|checkpoint/i.test(c);
while (task.status === "running" && !runsSlow(task.progress?.inflight?.command)) await new Promise((r) => setTimeout(r, 500));
log("slow.py running:", task.progress?.inflight?.command?.slice(0, 120));
await new Promise((r) => setTimeout(r, 8000));
// Deliberately silent about the script: the server, not codex, must stop it.
const r = await steerTask(task, "Change of plan: write result.txt containing exactly: skipped. Then finish immediately; run nothing else.", true);
log("steer now:", r.text);
await waitTask(task, 300);
log("status", task.status);
console.log(task.outcome ? formatOutcome(task.outcome) : task.error);
// slow.py needs ~120s; had it survived the interrupt it would write slow_done.txt.
await new Promise((r) => setTimeout(r, 130000));
log("slow_done.txt exists after 130s (must be false):", existsSync(join(repo, "slow_done.txt")));
process.exit(0);
