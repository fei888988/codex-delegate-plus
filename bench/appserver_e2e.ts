// Live check of the app-server engine through the real task path: start, steer, collect.
// Usage: node bench/appserver_e2e.ts   (spends a little Codex quota on gpt-6-luna#low)
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = mkdtempSync(join(tmpdir(), "as-e2e-"));
spawnSync("git", ["init", "-q"], { cwd: repo });
writeFileSync(join(repo, ".keep"), "");
spawnSync("git", ["add", "."], { cwd: repo });
spawnSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
process.env.CODEX_DELEGATE_ENGINE = "app-server";
const { formatOutcome } = await import("../src/delegate.ts");
const { startTask, steerTask, waitTask } = await import("../src/tasks.ts");

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
const task = startTask({ cwd: repo, effort: "low", model: "gpt-6-luna", title: "e2e steer",
  prompt: "Write six short original four-line poems, one per file: a1.txt rivers, a2.txt mountains, a3.txt cities, a4.txt deserts, a5.txt forests, a6.txt oceans. One apply_patch edit per file, in order, never a script." });
while (!existsSync(join(repo, "a1.txt")) && task.status === "running") await new Promise((r) => setTimeout(r, 200));
log("a1 written; steering");
const r = await steerTask(task, "Change of plan: stop writing poems now. Create NOTE.txt containing exactly: steered via task_steer. Then finish.");
log("steer:", r.text);
await waitTask(task, 300);
log("status", task.status);
console.log(task.outcome ? formatOutcome(task.outcome) : task.error);
log("files:", ["a1.txt", "a2.txt", "a3.txt", "a4.txt", "a5.txt", "a6.txt", "NOTE.txt"].filter((f) => existsSync(join(repo, f))).join(" "));
