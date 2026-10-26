import { opendir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { onExit } from "./procs.ts";
import type { RunSummary } from "./run-summary.ts";

export const HEARTBEAT_INTERVAL_MS = 15000;
export const ORPHAN_STALE_MS = Math.max(10 * 60000, 20 * HEARTBEAT_INTERVAL_MS);

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function orphan(meta: RunSummary, now: number): boolean {
  if (meta.state !== "running" || meta.pid === process.pid) return false;
  // A fresh heartbeat always wins, including when a process probe says dead.
  if (typeof meta.heartbeatAt === "number" && now - meta.heartbeatAt <= ORPHAN_STALE_MS) return false;
  return (typeof meta.heartbeatAt === "number" && now - meta.heartbeatAt > ORPHAN_STALE_MS)
    || (Number.isInteger(meta.pid) && meta.pid! > 0 && !alive(meta.pid!));
}

function interrupt(meta: RunSummary): void {
  meta.state = "interrupted";
  meta.phase = "done";
  meta.exitKind = "cancelled";
  meta.interruptedReason = "owning server exited";
  meta.endedAt = meta.heartbeatAt ?? meta.lastEventAt ?? meta.startedAt;
  meta.durationMs = meta.endedAt - meta.startedAt;
  delete meta.inflight;
}

/** Only run directories are visited; pending/tasks/handoffs/inbox are never traversed. */
export async function sweepOrphanedRuns(runsDir: string): Promise<void> {
  let dirs;
  try { dirs = await opendir(runsDir); } catch { return; }
  for await (const entry of dirs) {
    if (!entry.isDirectory() || ["pending", "tasks", "handoffs", "inbox"].includes(entry.name)) continue;
    const path = join(runsDir, entry.name, "meta.json");
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      const original = await readFile(path, "utf8");
      const meta = JSON.parse(original) as RunSummary;
      if (!orphan(meta, Date.now())) continue;
      interrupt(meta);
      await writeFile(tmp, JSON.stringify(meta), { flag: "wx" });
      // Compare the entire snapshot, protecting state, owner and heartbeat changes.
      if (await readFile(path, "utf8") !== original) continue;
      await rename(tmp, path);
    } catch { /* Missing, malformed or concurrently removed records are harmless. */ }
    finally { try { await unlink(tmp); } catch {} }
  }
}

const owned = new Map<string, RunSummary>();
/** Track the same live object the delegate updates, avoiding disk walks on exit. */
export function trackOwnedRun(runDir: string, meta: RunSummary): () => void {
  owned.set(runDir, meta);
  return () => { owned.delete(runDir); };
}

export function interruptOwnedRuns(): void {
  for (const [dir, meta] of owned) {
    if (meta.pid !== process.pid || meta.state !== "running") continue;
    interrupt(meta);
    try { writeFileSync(join(dir, "meta.json"), JSON.stringify(meta)); } catch {}
  }
}
onExit(interruptOwnedRuns);
