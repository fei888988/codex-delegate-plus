import { spawn } from "node:child_process";
import { stop, track } from "./procs.ts";
import { config } from "./config.ts";
import { idleWatchdog, type CpuSampler } from "./watchdog.ts";

export interface CheckResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stalled: boolean;
  startedAt: number;
  durationMs: number;
  /** Last non-empty output line (e.g. "Ran 12 tests … OK"): cheap evidence on success. */
  lastLine: string;
  /** Output tail, only kept for failures. */
  tail?: string;
}

const TAIL_CHARS = 2500;

export interface CheckProgress { command: string; startedAt: number; lastOutputAt?: number; result?: CheckResult }
export interface CheckOptions {
  idleTimeoutMs?: number;
  cpuSampler?: CpuSampler;
  onProgress?: (info: CheckProgress) => void;
}

/**
 * Runs one verification command on the host (not in codex's sandbox), through the platform shell
 * (cmd.exe on Windows, /bin/sh elsewhere), so the result doesn't rely on the delegated model's own report.
 */
export function runCheck(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal, options: CheckOptions = {}): Promise<CheckResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    track(child);
    let out = "";
    let timedOut = false;
    let stalled = false;
    let settled = false;
    let lastOutputAt: number | undefined;
    const progress = (result?: CheckResult) => {
      try { options.onProgress?.({ command, startedAt: started, lastOutputAt, result }); } catch {}
    };
    progress();
    const watchdog = idleWatchdog(child.pid, () => ({ key: "check", since: lastOutputAt ?? started,
      timeoutMs: options.idleTimeoutMs ?? config.checkIdleTimeoutSec * 1000 }), () => {
      timedOut = stalled = true;
      stop(child);
    }, options.cpuSampler);
    const add = (chunk: Buffer) => {
      out = (out + chunk.toString("utf8")).slice(-64 * 1024);
      lastOutputAt = Date.now();
      watchdog.touch();
      progress();
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => {
      watchdog.dispose();
      timedOut = true;
      stop(child);
    }, timeoutMs);
    const onAbort = () => { watchdog.dispose(); clearTimeout(timer); stop(child); };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const done = (exitCode: number | null, err?: string) => {
      if (settled) return;
      settled = true;
      watchdog.dispose();
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (err) out += `\n${err}`;
      const lines = out.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
      const ok = exitCode === 0 && !timedOut && !signal?.aborted && !err;
      const result: CheckResult = {
        command,
        ok,
        exitCode,
        timedOut,
        stalled,
        startedAt: started,
        durationMs: Date.now() - started,
        lastLine: (lines.at(-1) ?? "").slice(0, 200),
        tail: ok ? undefined : out.slice(-TAIL_CHARS).trim(),
      };
      progress(result);
      resolve(result);
    };
    child.on("error", (e) => done(null, e.message));
    child.on("close", (code) => done(code));
  });
}

export async function runChecks(commands: string[], cwd: string, timeoutMs: number, signal?: AbortSignal, options: CheckOptions = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const c of commands) {
    if (signal?.aborted) break;
    results.push(await runCheck(c, cwd, timeoutMs, signal, options));
  }
  return results;
}
