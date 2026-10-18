import { appendFileSync, copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { killPidTree, onExit } from "./procs.ts";

/**
 * Server side of longrun.mjs. Long commands started through the launcher survive an interrupted
 * Codex turn; this module finds them, reports their state, and makes sure none outlives its run.
 */

export const LAUNCHER = "longrun.mjs";

/** Dev runs load src/longrun.mjs, the bundle has it next to dist/index.js. */
export function installLauncher(runDir: string): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = [join(here, LAUNCHER), join(here, "..", "src", LAUNCHER)].find((f) => existsSync(f));
  if (!src) return undefined;
  const dest = join(runDir, LAUNCHER);
  try { copyFileSync(src, dest); return dest; } catch { return undefined; }
}

export type LongrunState = { state: "running"; pid: number } | { state: "exited"; code: number } | { state: "stopped" } | { state: "gone" } | { state: "unknown" };

export interface KeptCommand {
  n: number;
  command: string;
  log: string;
  keptAt: number;
  /** running → still the lead's/codex's responsibility; the others are final. */
  outcome: "running" | "exited" | "stopped" | "gone" | "killed_cancel" | "killed_forgotten";
  exitCode?: number;
}

const int = (f: string) => { try { const v = Number.parseInt(readFileSync(f, "utf8"), 10); return Number.isFinite(v) ? v : undefined; } catch { return undefined; } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };

export function longrunState(runDir: string, n: number): LongrunState {
  const code = int(join(runDir, `cmd-${n}.exit`));
  if (code !== undefined) return existsSync(join(runDir, `cmd-${n}.stopping`)) ? { state: "stopped" } : { state: "exited", code };
  const pid = int(join(runDir, `cmd-${n}.pid`));
  if (pid === undefined) return { state: "unknown" };
  return alive(pid) ? { state: "running", pid } : { state: "gone" };
}

/** Kill a launcher command (its monitor and everything under it) and record it as stopped. */
export function stopLongrun(runDir: string, n: number, why: string): boolean {
  const s = longrunState(runDir, n);
  if (s.state !== "running") return false;
  try { writeFileSync(join(runDir, `cmd-${n}.stopping`), why); } catch {}
  killPidTree(s.pid);
  try { appendFileSync(join(runDir, `cmd-${n}.log`), `\nEXIT=stopped (${why})\n`); writeFileSync(join(runDir, `cmd-${n}.exit`), "137"); } catch {}
  return true;
}

/** The command a launcher job runs, from its cmd-<n>.json. */
export function longrunCommand(runDir: string, n: number): string {
  try {
    const { program, args } = JSON.parse(readFileSync(join(runDir, `cmd-${n}.json`), "utf8"));
    const a: string[] = args ?? [];
    // A shell-string job runs a generated script; show the script's command line instead.
    const script = a.find((x) => /cmd-\d+\.(ps1|sh)$/.test(x));
    if (script) return readFileSync(script, "utf8").split(/\r?\n/)[0] ?? program;
    return [program, ...a].join(" ");
  } catch { return `cmd-${n}`; }
}

export function refresh(runDir: string, k: KeptCommand): KeptCommand {
  if (k.outcome !== "running") return k;
  const s = longrunState(runDir, k.n);
  if (s.state === "exited") return { ...k, outcome: "exited", exitCode: s.code };
  if (s.state === "stopped") return { ...k, outcome: "stopped" };
  if (s.state === "gone") return { ...k, outcome: "gone" };
  return k;
}

/** Launcher commands in `runDir` that are still running. */
export function runningLongruns(runDir: string): number[] {
  let names: string[] = [];
  try { names = readdirSync(runDir); } catch {}
  return names.map((f) => Number(/^cmd-(\d+)\.pid$/.exec(f)?.[1])).filter((n) => Number.isInteger(n) && longrunState(runDir, n).state === "running");
}

/** End of a run: nothing it started may keep running unattended. Returns what had to be killed. */
export function reapLongruns(runDir: string, why: string): number[] {
  const killed = runningLongruns(runDir).filter((n) => stopLongrun(runDir, n, why));
  active.delete(runDir);
  return killed;
}

// Run directories whose launcher commands must die with this server, even if it exits abruptly.
const active = new Set<string>();
export function trackRunDir(runDir: string) { active.add(runDir); }
onExit(() => { for (const dir of [...active]) reapLongruns(dir, "server exited"); });

export function keptPreamble(runDir: string, kept: KeptCommand[], killed: string[]): string {
  const launcher = join(runDir, LAUNCHER);
  const lines = ["[codex-delegate] The lead interrupted your previous step to give you a new instruction (below)."];
  for (const k of kept) {
    lines.push(`- Still running, NOT stopped: cmd-${k.n} \`${k.command.replace(/\s+/g, " ").slice(0, 200)}\` (log ${k.log}). It is the same job you started; do not start it again.`);
  }
  for (const c of killed) lines.push(`- Stopped (it was not started through ${LAUNCHER}, so it could not be kept): \`${c.replace(/\s+/g, " ").slice(0, 200)}\`; check what it left behind.`);
  if (kept.length) lines.push(
    "The still-running command(s) are your responsibility. Read the instruction first, then for each one decide explicitly:",
    `  - keep it and look at its progress: node "${launcher}" "${runDir}" status <n>   (alive/exit code + log tail)`,
    `  - wait for it to finish: node "${launcher}" "${runDir}" wait <n>   (blocks, streams new output, exits with its code; one blocking call is fine under your long-script rules)`,
    `  - stop it: node "${launcher}" "${runDir}" stop <n>`,
    "Do not start it again while it runs. Do not end your turn while it is still running unless you stopped it; the final report must say what became of it (finished with exit code / stopped and why).",
  );
  lines.push("", "Instruction from the lead:");
  return `${lines.join("\n")}\n`;
}

export function keptReminder(runDir: string, kept: KeptCommand[]): string {
  const launcher = join(runDir, LAUNCHER);
  return [
    "[codex-delegate] You ended your turn, but these commands you are responsible for are still running:",
    ...kept.map((k) => `- cmd-${k.n} \`${k.command.replace(/\s+/g, " ").slice(0, 200)}\` (log ${k.log})`),
    `Deal with each now: wait for it (node "${launcher}" "${runDir}" wait <n>) or stop it (… stop <n>) if it is no longer needed. Then give your final report again, saying what became of each. If you end the turn with them still running, the server will stop them and report them as forgotten.`,
  ].join("\n");
}
