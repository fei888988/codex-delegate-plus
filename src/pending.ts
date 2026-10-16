import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, type Sandbox } from "./config.ts";
import { killOrphan } from "./procs.ts";

/**
 * One record per working directory for the editing run that is in flight or was cut off.
 * When the user presses Stop, the MCP client drops the tool result, so the lead never learns
 * the session id. The record lets the next delegate call in that directory resume the same
 * Codex session (its context and partial edits intact) with the new direction instead of
 * starting over.
 */
export interface PendingRun {
  cwd: string;
  sessionId?: string;
  /** "running" while a server is driving it; "interrupted" once stopped, cancelled or orphaned. */
  state: "running" | "interrupted";
  /** The server process driving the run, and the codex process it started. */
  pid: number;
  codexPid?: number;
  startedAt: number;
  endedAt?: number;
  model?: string;
  effort?: string;
  sandbox: Sandbox;
  title?: string;
  /** Start of the brief that was interrupted, for the lead's reference. */
  prompt: string;
  /** Files the interrupted run had touched (relative paths). */
  changed?: string[];
  runDir?: string;
}

/** Interrupted runs older than this are ignored (a new task, not a redirect). */
const MAX_AGE_MS = 24 * 3600 * 1000;

const dir = () => join(config.runsDir, "pending");
const fileFor = (cwd: string) => join(dir(), `${createHash("sha1").update(cwd.toLowerCase()).digest("hex").slice(0, 16)}.json`);

function alive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function savePending(rec: PendingRun) {
  try {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(fileFor(rec.cwd), JSON.stringify(rec, null, 2));
  } catch {}
}

/** Remove the record for `cwd`; with `owner`, only if it is still that run's (another server may have taken over). */
export function clearPending(cwd: string, owner?: Pick<PendingRun, "pid" | "startedAt">) {
  const f = fileFor(cwd);
  try {
    if (owner) {
      if (!existsSync(f)) return;
      const cur = JSON.parse(readFileSync(f, "utf8")) as PendingRun;
      if (cur.pid !== owner.pid || cur.startedAt !== owner.startedAt) return;
    }
    rmSync(f, { force: true });
  } catch {}
}

/**
 * The interrupted run for `cwd` that can be continued, if any. A record still marked "running"
 * whose server process is gone (the client killed it) counts as interrupted; one whose server is
 * alive belongs to a run in progress and is left alone.
 */
export function loadPending(cwd: string): PendingRun | undefined {
  const f = fileFor(cwd);
  if (!existsSync(f)) return undefined;
  let rec: PendingRun;
  try {
    rec = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
  if (rec.cwd.toLowerCase() !== cwd.toLowerCase()) return undefined;
  if (rec.state === "running") {
    // Past the run timeout the owner must be gone, even if its pid was reused by another process.
    const stale = Date.now() - rec.startedAt > (config.timeoutSec + 300) * 1000;
    if (!stale && (rec.pid === process.pid || alive(rec.pid))) return undefined;
    // Its server is gone; make sure its codex isn't still editing before another run takes over.
    if (rec.codexPid) killOrphan(rec.codexPid);
    rec.state = "interrupted";
  }
  if (!rec.sessionId || Date.now() - (rec.endedAt ?? rec.startedAt) > MAX_AGE_MS) {
    clearPending(cwd);
    return undefined;
  }
  return rec;
}

/** Preamble for the resumed turn: what happened, and that the new message wins. */
export function continuationPreamble(rec: PendingRun): string {
  const files = rec.changed?.length ? ` Files you had touched: ${rec.changed.slice(0, 30).join(", ")}${rec.changed.length > 30 ? ", …" : ""}.` : "";
  return [
    "[The user stopped your previous turn before it finished and has updated the instructions.",
    `Your edits so far are still in the working tree.${files}`,
    "If the new message below changes the earlier task, the new message wins: keep what still fits, rework or remove what it rules out, then finish.",
    "If it is a different task, leave the earlier edits as they are unless it says otherwise.]",
    "",
  ].join(" ").trimEnd() + "\n\n";
}
