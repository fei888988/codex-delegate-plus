import { spawnSync, type ChildProcess } from "node:child_process";
import { windowsProcessTreeScript } from "./windows-process-tree.ts";

const live = new Set<ChildProcess>();

function killWindowsTree(pid: number) {
  const killed = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
  if (killed.status === 0) return;
  const snapshot = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsProcessTreeScript()],
    { encoding: "utf8", windowsHide: true, timeout: 5000 });
  const rows = (snapshot.stdout ?? "").trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number));
  const ids = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [child, parent] of rows) if (child && parent && ids.has(parent) && !ids.has(child)) { ids.add(child); changed = true; }
  }
  for (const id of [...ids].reverse()) { try { process.kill(id, "SIGKILL"); } catch {} }
}

/** Kills a process we did not spawn ourselves (a command codex left running) and its descendants. */
export function killPidTree(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") return killWindowsTree(pid);
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
}

/** Kills a child and everything it started (codex spawns shells, test runners, dev servers…). */
export function killTree(child: ChildProcess, force = false) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    // taskkill /T walks the tree; without it only the direct child (node codex.js) would die.
    killWindowsTree(child.pid);
    // Node retains a child handle even if enumerating processes is also denied.
    child.kill("SIGKILL");
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
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    if (!/^"(node|codex)\.exe"/im.test(r.stdout ?? "")) {
      const name = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).ProcessName`], { encoding: "utf8", windowsHide: true, timeout: 5000 });
      if (!/^(node|codex)$/i.test(name.stdout?.trim() ?? "")) return;
    }
    killWindowsTree(pid);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}

const exitHooks: (() => void)[] = [];
/** Synchronous cleanup to run when this server exits (installExitCleanup). */
export function onExit(hook: () => void) { exitHooks.push(hook); }

let installed = false;
export function installExitCleanup() {
  if (installed) return;
  installed = true;
  const cleanup = () => {
    for (const hook of exitHooks) { try { hook(); } catch {} }
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
