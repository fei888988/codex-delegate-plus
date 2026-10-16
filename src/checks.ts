import { spawn } from "node:child_process";
import { stop, track } from "./procs.ts";

export interface CheckResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Last non-empty output line (e.g. "Ran 12 tests … OK"): cheap evidence on success. */
  lastLine: string;
  /** Output tail, only kept for failures. */
  tail?: string;
}

const TAIL_CHARS = 2500;

/**
 * Runs one verification command on the host (not in codex's sandbox), through the platform shell
 * (cmd.exe on Windows, /bin/sh elsewhere), so the result doesn't rely on the delegated model's own report.
 */
export function runCheck(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CheckResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    track(child);
    let out = "";
    let timedOut = false;
    const add = (chunk: Buffer) => {
      out = (out + chunk.toString("utf8")).slice(-64 * 1024);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => {
      timedOut = true;
      stop(child);
    }, timeoutMs);
    const onAbort = () => stop(child);
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = (exitCode: number | null, err?: string) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (err) out += `\n${err}`;
      const lines = out.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
      const ok = exitCode === 0 && !timedOut;
      resolve({
        command,
        ok,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        lastLine: (lines.at(-1) ?? "").slice(0, 200),
        tail: ok ? undefined : out.slice(-TAIL_CHARS).trim(),
      });
    };
    child.on("error", (e) => done(null, e.message));
    child.on("close", (code) => done(code));
  });
}

export async function runChecks(commands: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const c of commands) {
    if (signal?.aborted) break;
    results.push(await runCheck(c, cwd, timeoutMs, signal));
  }
  return results;
}
