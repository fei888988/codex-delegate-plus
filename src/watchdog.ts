import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { windowsProcessTreeScript } from "./windows-process-tree.ts";

export type CpuSampler = (pid: number, signal: AbortSignal) => Promise<boolean>;

function capture(cmd: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 4000, maxBuffer: 8 * 1024 * 1024, signal },
      (err, stdout) => resolve(err ? "" : stdout));
  });
}

/** Cumulative CPU milliseconds, including descendants. No wmic dependency. */
async function cpuTree(pid: number, signal: AbortSignal): Promise<Map<number, number>> {
  const rows: { pid: number; parent: number; cpu: number }[] = [];
  if (process.platform === "win32") {
    const out = await capture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsProcessTreeScript(pid)], signal);
    for (const line of out.trim().split(/\r?\n/)) {
      const [id, parent, cpu] = line.trim().split(/\s+/).map(Number);
      if (id !== undefined && parent !== undefined && Number.isFinite(cpu)) rows.push({ pid: id, parent, cpu: cpu! });
    }
  } else {
    const out = await capture("ps", ["-A", "-o", "pid=,ppid=,time="], signal);
    for (const line of out.trim().split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*$/.exec(line);
      if (m) rows.push({ pid: +m[1]!, parent: +m[2]!, cpu: ((+m[3]! || 0) * 86400 + (+m[4]! || 0) * 3600 + +m[5]! * 60 + +m[6]!) * 1000 });
    }
  }
  const tree = new Map<number, number>();
  const ids = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of rows) if (ids.has(r.parent) && !ids.has(r.pid)) { ids.add(r.pid); changed = true; }
  }
  for (const r of rows) if (ids.has(r.pid)) tree.set(r.pid, r.cpu);
  return tree;
}

/** Best effort: a failed sample cannot disable the idle deadline. */
export const sampleTreeCpu: CpuSampler = async (pid, signal) => {
  try {
    const before = await cpuTree(pid, signal);
    await delay(5000, undefined, { signal });
    const after = await cpuTree(pid, signal);
    return [...after].some(([id, cpu]) => cpu - (before.get(id) ?? 0) > 20);
  } catch { return false; }
};

export interface IdleWindow { key: string; since: number; timeoutMs: number }

/** Output resets the window. CPU activity buys at most one additional idle window. */
export function idleWatchdog(pid: number | undefined, window: () => IdleWindow | undefined,
  stalled: () => void, sample: CpuSampler = sampleTreeCpu) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let disposed = false;
  let extended = false;
  let sampling: AbortController | undefined;
  const arm = (extra?: number) => {
    clearTimeout(timer);
    const w = window();
    if (disposed || !w || w.timeoutMs <= 0) return;
    timer = setTimeout(async () => {
      const version = generation;
      const controller = sampling = new AbortController();
      let busy = false;
      try { if (pid !== undefined) busy = await sample(pid, controller.signal); } catch {}
      if (disposed || version !== generation) return;
      const current = window();
      if (!current || current.key !== w.key) { arm(); return; }
      if (busy && !extended) { extended = true; arm(current.timeoutMs); }
      else stalled();
    }, extra ?? Math.max(1, w.since + w.timeoutMs - Date.now()));
    timer.unref();
  };
  arm();
  return {
    touch() { generation++; extended = false; sampling?.abort(); arm(); },
    dispose() { disposed = true; generation++; sampling?.abort(); clearTimeout(timer); },
  };
}

export interface StallPolicy {
  silent_s?: number;
  command_s?: number;
  long_commands?: { match: string; idle_s: number }[];
}
export function commandThreshold(command: string, fallback: number, rules: StallPolicy["long_commands"] = []) {
  if (fallback === 0) return { seconds: 0, matchedRule: undefined };
  for (const rule of rules) {
    try { if (new RegExp(rule.match, "i").test(command)) return { seconds: rule.idle_s, matchedRule: rule.match }; } catch {}
  }
  return { seconds: fallback, matchedRule: undefined };
}
export interface CpuEvidence {
  cpuDeltaMs?: number;
  sampleMs?: number;
  descendantCount?: number;
  busiest?: { pid: number; name: string; cpuMs: number; rssBytes: number };
  error?: string;
}
export type EvidenceSampler = (pid: number, signal: AbortSignal) => Promise<CpuEvidence>;
export const sampleTreeEvidence: EvidenceSampler = async (pid, signal) => {
  try {
    const started = Date.now();
    const before = await cpuTree(pid, signal);
    await delay(500, undefined, { signal });
    const after = await cpuTree(pid, signal);
    if (!after.size) return { error: "process sample unavailable" };
    const details = process.platform === "win32"
      ? await capture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsProcessTreeScript(pid)], signal)
      : await capture("ps", ["-A", "-o", "pid=,ppid=,rss=,comm="], signal);
    let busiest: CpuEvidence["busiest"];
    let delta = 0;
    for (const [id, cpu] of after) {
      const d = Math.max(0, cpu - (before.get(id) ?? cpu));
      delta += d;
      if (id === pid || (busiest && d <= busiest.cpuMs)) continue;
      const line = details.split(/\r?\n/).find(l => Number(l.trim().split(/\s+/)[0]) === id);
      const fields = line?.trim().split(/\s+/) ?? [];
      busiest = { pid: id, cpuMs: d, name: fields.slice(process.platform === "win32" ? 4 : 3).join(" "),
        rssBytes: Number(fields[process.platform === "win32" ? 3 : 2] ?? 0) * (process.platform === "win32" ? 1 : 1024) };
    }
    return { cpuDeltaMs: delta, sampleMs: Date.now() - started, descendantCount: Math.max(0, after.size - 1), busiest };
  } catch { return { error: "process sample unavailable" }; }
};

/** One notification per armed window. Only the lead re-arms a suspected window. */
export function softWatchdog(pid: number | undefined, window: () => IdleWindow | undefined,
  suspected: (evidence: CpuEvidence) => void, sample: EvidenceSampler = sampleTreeEvidence) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sampling: AbortController | undefined;
  let generation = 0;
  let disposed = false;
  const touch = () => {
    generation++;
    sampling?.abort();
    clearTimeout(timer);
    const w = window();
    if (disposed || !w || w.timeoutMs <= 0) return;
    const version = generation;
    timer = setTimeout(async () => {
      const controller = sampling = new AbortController();
      let evidence: CpuEvidence = { error: "process sample unavailable" };
      try { if (pid !== undefined) evidence = await sample(pid, controller.signal); } catch {}
      if (!disposed && version === generation && window()?.key === w.key) suspected(evidence);
    }, Math.max(1, w.since + w.timeoutMs - Date.now()));
    timer.unref();
  };
  touch();
  return { touch, dispose() { disposed = true; generation++; sampling?.abort(); clearTimeout(timer); } };
}
