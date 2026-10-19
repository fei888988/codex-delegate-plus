import { closeSync, openSync, readSync, readdirSync, readFileSync, lstatSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Sandbox } from "./config.ts";
import type { Retention } from "./policy.ts";
import type { RunSummary } from "./run-summary.ts";
import type { CpuEvidence } from "./watchdog.ts";

export interface Denials { count: number; paths: string[] }
export interface CommandTiming { command: string; durationMs: number }
export interface TrendPoint extends CpuEvidence { at: number; logBytes: number; command?: string; commandStartedAt?: number }

export function effectiveSandbox(sandbox: Sandbox | "write" | undefined, auto: boolean, sandboxWrites: boolean): Sandbox {
  return (sandbox ?? (auto ? "write" : "read-only")) === "read-only" ? "read-only" : sandboxWrites ? "workspace-write" : "danger-full-access";
}

export function extractDenials(output: string): Denials {
  const paths = new Set<string>();
  let count = 0;
  for (const line of output.split(/\r?\n/)) {
    if (!/PermissionError|WinError\s*5\b|Access is denied|拒绝访问|\bEACCES\b|\bEPERM\b/i.test(line)) continue;
    count++;
    for (const m of line.matchAll(/(?:["'])([A-Za-z]:[\\/][^"'\r\n]*|\/[^"'\r\n]+|\\\\[^"'\r\n]+)["']|([A-Za-z]:[\\/][^\s,"'<>]*)/g)) {
      paths.add((m[1] ?? m[2]!).replace(/\\/g, "/"));
    }
  }
  return { count, paths: [...paths] };
}

export function denialBlock(denials?: Denials): string {
  return denials?.count ? `sandbox_denied: ${denials.count} denials\n  paths: ${denials.paths.join(", ") || "(not reported)"}\n  next: the target is outside the writable area; fix the code/test to use the default temp dir or cwd, or resume with add_dirs / ask the user to turn off the panel sandbox.` : "";
}

function entries(dir: string) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}
export function readMeta(dir: string): RunSummary | undefined {
  try { return JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")); } catch { return undefined; }
}
export function tailFile(file: string, bytes: number): string {
  let fd: number | undefined;
  try {
    const size = lstatSync(file).size;
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(Math.min(size, bytes));
    readSync(fd, buffer, 0, buffer.length, Math.max(0, size - bytes));
    return buffer.toString("utf8");
  } catch { return ""; } finally { if (fd !== undefined) closeSync(fd); }
}
export function commandLogs(dir: string) {
  return entries(dir).filter(e => e.isFile() && /^cmd-.*\.log$/.test(e.name)).flatMap(e => {
    const file = join(dir, e.name);
    try { const stat = lstatSync(file); return [{ file, name: e.name, bytes: stat.size, mtime: stat.mtimeMs }]; }
    catch { return []; }
  }).sort((a, b) => b.mtime - a.mtime);
}
export function logReport(dir: string, maxBytes = 1500): string {
  const log = commandLogs(dir)[0];
  if (!log) {
    const saved = Object.entries(readMeta(dir)?.cmdLogTails ?? {}).at(-1);
    return saved ? `cmd log: ${saved[0]} (archived tail)\n${saved[1].slice(-maxBytes).split(/\r?\n/).slice(-15).join("\n")}` : "cmd log: (none)";
  }
  return log ? `cmd log: ${log.name} (${log.bytes} bytes)\n${tailFile(log.file, maxBytes).split(/\r?\n/).slice(-15).join("\n")}` : "cmd log: (none)";
}
export function trimCommandLogs(dir: string, maxMB: number) {
  for (const log of commandLogs(dir)) if (log.bytes > maxMB * 1024 * 1024) writeFileSync(log.file, tailFile(log.file, Math.floor(maxMB * 1024 * 1024)));
}
/** `keep`: logs the result points the lead to (commands kept across a redirect) are not removed. */
export function finishCommandLogs(dir: string, success: boolean, keep: string[] = []): Record<string, string> | undefined {
  if (!success) return undefined;
  const tails: Record<string, string> = {};
  for (const log of commandLogs(dir)) { tails[log.name] = tailFile(log.file, 2048); if (!keep.includes(log.name)) rmSync(log.file); }
  return tails;
}

export function commandClass(command: string): string {
  const tokens = command.trim().replace(/^cd\s+.+?\s*(?:&&|;)\s*/i, "").replace(/^(?:(?:[\w]+=[^\s]+|&|call|exec)\s+)+/i, "").match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
  const first = (tokens[0] ?? "").replace(/["']/g, "").replace(/\\/g, "/").split("/").at(-1)!.replace(/\.(exe|cmd)$/i, "").toLowerCase();
  if (/^(?:bash|sh|cmd|powershell|pwsh)$/.test(first)) {
    const flag = tokens.findIndex(t => /^(?:-[a-z]*c|\/c|-command)$/i.test(t));
    if (flag >= 0 && tokens[flag + 1]) return commandClass(tokens.slice(flag + 1).join(" ").replace(/^["']|["']$/g, ""));
  }
  if (/^python(?:\d+(?:\.\d+)?)?$/.test(first) && tokens[1] === "-m") return `python -m ${tokens[2] ?? ""}`.trim();
  if (/^(npm|pnpm|yarn)$/.test(first)) return [first, ...tokens.slice(1, tokens[1] === "run" ? 3 : 2)].join(" ");
  return first;
}
export function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0;
}
export function baseline(runsDir: string, command: string, exclude?: string): string {
  const cls = commandClass(command);
  const values: number[] = [];
  for (const e of entries(runsDir)) {
    if (!e.isDirectory() || e.name === exclude) continue;
    const meta = readMeta(join(runsDir, e.name));
    for (const c of [...(meta?.commands ?? []), ...(meta?.checks ?? [])]) {
      if (c.durationMs !== undefined && commandClass(c.command) === cls) values.push(c.durationMs / 1000);
    }
  }
  return values.length >= 3 ? `baseline: ${cls} p50 ${percentile(values, .5).toFixed(0)}s p90 ${percentile(values, .9).toFixed(0)}s (n=${values.length})` : "";
}
export function evidenceDelta(current: CpuEvidence, previous?: CpuEvidence): string {
  const delta = (key: "cpuTotalMs" | "ioReadBytes" | "ioWriteBytes") => current[key] === undefined || previous?.[key] === undefined ? "?" : Math.max(0, current[key]! - previous[key]!).toFixed(0);
  return `CPU Δ${delta("cpuTotalMs")}ms; RSS ${((current.rssBytes ?? 0) / 1048576).toFixed(0)}MB; IO ΔR${delta("ioReadBytes")}/W${delta("ioWriteBytes")}B`;
}
export function trendReport(points: TrendPoint[] = []): string {
  if (!points.length) return "trend: awaiting samples";
  const rows = points.slice(-4).map((p, i, all) => {
    const prev = all[i - 1] ?? points[points.indexOf(p) - 1];
    const same = prev?.commandStartedAt === p.commandStartedAt;
    return `${prev ? Math.round((p.at - prev.at) / 1000) : "?"}s: ${evidenceDelta(p, same ? prev : undefined)}, log Δ${same ? Math.max(0, p.logBytes - (prev?.logBytes ?? p.logBytes)) : "?"}B`;
  });
  return `trend: ${rows.join(" | ")}\nhint: CPU >0 and log growing -> likely working.\nhint: CPU ≈0, no IO or log growth across repeated intervals -> likely hung; unavailable counters are inconclusive.`;
}
export function diagnosisPrefix(meta?: RunSummary): string {
  if (!meta || (meta.state === "ok" && meta.exitKind === "completed" && !meta.denials?.count)) return "";
  const paths = (meta.denials?.paths.join(", ") || "none").slice(0, 120);
  const command = (meta.lastInflight?.command ?? meta.stall?.command ?? meta.inflight?.command ?? meta.commands?.at(-1)?.command ?? "unknown").replace(/\s+/g, " ").slice(0, 160);
  const evidence = meta.lastEvidence ?? meta.trend?.at(-1) ?? meta.suspicion?.evidence;
  const summary = evidence ? `CPU ${evidence.cpuDeltaMs ?? "?"}ms/${evidence.sampleMs ?? "?"}ms, RSS ${((evidence.rssBytes ?? 0) / 1048576).toFixed(0)}MB; ${evidence.error ?? ""}` : "unavailable";
  return `Previous attempt diagnosis\nexit: ${meta.exitKind ?? meta.state}; denied paths: ${paths}; last command: ${command}; evidence: ${summary.slice(0, 140)}\n\n`;
}
export function previousDiagnosis(runsDir: string, sessionId?: string): string {
  if (!sessionId) return "";
  const metas = entries(runsDir).filter(e => e.isDirectory()).map(e => readMeta(join(runsDir, e.name)))
    .filter((m): m is RunSummary => !!m && m.sessionId === sessionId && (m.state !== "running" || (!!m.pid && !alive(m.pid) && !alive(m.codexPid))))
    .map(m => m.state === "running" ? { ...m, state: "interrupted" as const, exitKind: "crashed" as const } : m)
    .sort((a, b) => b.startedAt - a.startedAt);
  return diagnosisPrefix(metas[0]);
}

function alive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
function dirBytes(dir: string): number {
  return entries(dir).reduce((sum, e) => sum + (e.isDirectory() ? dirBytes(join(dir, e.name)) : e.isFile() ? lstatSync(join(dir, e.name)).size : 0), 0);
}
/** Protect live owners/children across servers, and ambiguous legacy running records. */
export function cleanupRuns(runsDir: string, retention: Retention, active = new Set<string>(), now = Date.now()) {
  const runs = entries(runsDir).filter(e => e.isDirectory() && e.name !== "pending" && e.name !== "tasks" && e.name !== "handoffs").map(e => {
    const dir = join(runsDir, e.name), meta = readMeta(dir);
    return { dir, meta, age: now - (meta?.endedAt ?? meta?.startedAt ?? lstatSync(dir).mtimeMs), bytes: dirBytes(dir), protected: active.has(e.name) || (meta?.state === "running" && (alive(meta.pid) || alive(meta.codexPid) || (meta.heartbeatAt !== undefined ? now - meta.heartbeatAt < 90000 : meta.pid === undefined && meta.codexPid === undefined))) };
  }).sort((a, b) => b.age - a.age);
  let total = dirBytes(runsDir);
  for (const r of runs) {
    if (r.protected) continue;
    if (r.age > retention.runDays * 86400000 || total > retention.totalMaxMB * 1048576) { rmSync(r.dir, { recursive: true, force: true }); total -= r.bytes; continue; }
    if (r.age > retention.failedLogDays * 86400000) for (const log of commandLogs(r.dir)) rmSync(log.file);
  }
}
export function recentFiles(cwd: string, now = Date.now()): string[] {
  const files: { name: string; at: number }[] = [];
  let visited = 0;
  const walk = (dir: string) => {
    for (const e of entries(dir)) {
      if (++visited > 20000) return;
      if (e.name === ".git" || e.name === "node_modules") continue;
      const file = join(dir, e.name);
      if (e.isDirectory()) walk(file);
      else if (e.isFile()) {
        try {
          const at = lstatSync(file).mtimeMs;
          if (now - at <= 1800000) files.push({ name: relative(cwd, file), at });
        } catch {}
      }
    }
  };
  walk(cwd);
  return files.sort((a, b) => b.at - a.at).slice(0, 10).map(f => f.name);
}
