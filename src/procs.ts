import { spawnSync, type ChildProcess } from "node:child_process";

const live = new Set<ChildProcess>();

/** Kills a child and everything it started (codex spawns shells, test runners, dev servers…). */
export function killTree(child: ChildProcess, force = false) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    // taskkill /T walks the tree; without it only the direct child (node codex.js) would die.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  // Children are spawned detached, so -pid addresses the whole process group.
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
}

/** Track a child so it is killed if this server exits (e.g. the MCP client goes away). */
export function track(child: ChildProcess) {
  live.add(child);
  child.once("close", () => live.delete(child));
}

/** Graceful stop, then force after `graceMs`. */
export function stop(child: ChildProcess, graceMs = 3000) {
  killTree(child);
  if (process.platform !== "win32") setTimeout(() => killTree(child, true), graceMs).unref();
}

/**
 * Kill a codex process tree left behind by a server that was killed outright (no exit handlers ran).
 * On Windows the pid is only killed if it is still a node/codex process, in case it was reused.
 */
export function killOrphan(pid: number) {
  if (process.platform === "win32") {
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
    if (!/^"(node|codex)\.exe"/im.test(r.stdout ?? "")) return;
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}

let installed = false;
export function installExitCleanup() {
  if (installed) return;
  installed = true;
  const cleanup = () => {
    for (const c of live) killTree(c, true);
  };
  process.once("exit", cleanup);
  // An MCP client that goes away closes our stdin; without this the server (and codex) would keep running.
  process.stdin.once("end", () => process.exit(0));
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      cleanup();
      process.exit(128);
    });
  }
}
