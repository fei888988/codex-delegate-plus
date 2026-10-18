import type { EvidenceSampler } from "./watchdog.ts";
import type { StallControl } from "./codex.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { delegate, formatOutcome, type DelegateInput, type DelegateOutcome } from "./delegate.ts";
import type { RunSummary } from "./run-summary.ts";

export type TaskStatus = "running" | "done" | "error" | "cancelled";

export interface Task {
  id: string;
  control: StallControl;
  listeners: Set<() => void>;
  seenWake?: number;
  input: DelegateInput;
  status: TaskStatus;
  startedAt: number;
  finishedAt?: number;
  outcome?: DelegateOutcome;
  error?: string;
  progress?: RunSummary;
  promise: Promise<void>;
  controller: AbortController;
}

const MAX_FINISHED = 100;
const tasks = new Map<string, Task>();

/** Finished results are also written to disk, so task_result still works after a server restart. */
export interface StoredTask {
  id: string;
  status: TaskStatus | "interrupted";
  startedAt: number;
  finishedAt?: number;
  title?: string;
  text?: string;
}

const tasksDir = () => join(config.runsDir, "tasks");
const taskFile = (id: string) => join(tasksDir(), `${id.replace(/[^\w-]/g, "")}.json`);

function store(t: Task) {
  try {
    mkdirSync(tasksDir(), { recursive: true });
    const text = t.outcome ? formatOutcome(t.outcome) : t.error && `error: ${t.error}`;
    const rec: StoredTask = { id: t.id, status: t.status, startedAt: t.startedAt, finishedAt: t.finishedAt, title: t.input.title, text };
    writeFileSync(taskFile(t.id), JSON.stringify(rec));
  } catch {}
}

export function storedTask(id: string): StoredTask | undefined {
  const f = taskFile(id);
  if (!existsSync(f)) return undefined;
  try {
    const rec = JSON.parse(readFileSync(f, "utf8")) as StoredTask;
    // Still "running" on disk but unknown to this process: the server that ran it has exited.
    if (rec.status === "running") rec.status = "interrupted";
    return rec;
  } catch {
    return undefined;
  }
}

function prune() {
  const finished = [...tasks.values()].filter((t) => t.status !== "running").sort((a, b) => a.startedAt - b.startedAt);
  for (const t of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) tasks.delete(t.id);
}

export function startTask(input: DelegateInput, background = true, evidenceSampler?: EvidenceSampler): Task {
  const controller = new AbortController();
  const task = { id: `task_${randomUUID().slice(0, 8)}`, input, status: "running", startedAt: Date.now(), controller, control: { evidenceSampler, background, lastObservedAt: Date.now() }, listeners: new Set() } as Task;
  task.promise = delegate(input, controller.signal, (info) => { task.progress = info; for (const notify of task.listeners) notify(); }, task.control).then(
    (outcome) => {
      task.outcome = outcome;
      task.status = controller.signal.aborted ? "cancelled" : outcome.result.ok ? "done" : "error";
    },
    (err: unknown) => {
      task.error = err instanceof Error ? err.message : String(err);
      task.status = "error";
    },
  ).finally(() => {
    task.finishedAt = Date.now();
    store(task);
    prune();
  });
  tasks.set(task.id, task);
  store(task);
  return task;
}

export function getTask(id: string): Task | undefined {
  return tasks.get(id);
}

export function runningProgress(task: Task): string {
  if (task.progress?.suspicion) return formatSuspicion(task);
  const p = task.progress;
  const minutes = ((Date.now() - (p?.lastEventAt ?? task.startedAt)) / 60000).toFixed(1);
  const command = p?.inflight?.command ?? p?.checks?.find((c) => c.state === "running")?.command;
  return `phase: ${p?.phase ?? "codex"}; last codex event: ${minutes}m ago${command ? `\ninflight: ${command.replace(/\s+/g, " ").slice(0, 200)}` : ""}`;
}

export function listTasks(): Task[] {
  for (const task of tasks.values()) task.control.lastObservedAt = Date.now();
  return [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function formatSuspicion(task: Task): string {
  const p = task.progress!;
  const s = p.suspicion!;
  return [
    "status: suspected_stall (still running, not killed)",
    "next: judge from the evidence; if it looks healthy call task_result(task_id, wait_s, stall_after_s?) to keep waiting; if hung call task_cancel then resume with session_id and tell codex which command hung",
    `task_id: ${task.id}`, `session_id: ${p.sessionId ?? "(none)"}`, `run id: ${p.id}`,
    `elapsed: ${((Date.now() - task.startedAt) / 1000).toFixed(0)}s`,
    `inflight: ${s.command?.replace(/\s+/g, " ").slice(0, 300) ?? "(model silent)"}; idle: ${((Date.now() - (p.lastEventAt ?? task.startedAt)) / 1000).toFixed(0)}s`,
    `threshold: ${s.thresholdSec}s; wakes: ${s.wakes}${s.matchedRule ? `; rule: ${s.matchedRule}` : ""}`,
    `evidence: ${JSON.stringify(s.evidence)}`,
  ].join("\n");
}

export async function waitTask(task: Task, waitSec: number, stallAfterSec?: number): Promise<void> {
  task.control.lastObservedAt = Date.now();
  if (task.status !== "running") return;
  const suspicion = task.controller.signal.aborted ? undefined : task.progress?.suspicion;
  // Deliver an unseen wake once before allowing a later wait to re-arm it.
  if (suspicion && task.seenWake !== suspicion.suspectedAt && stallAfterSec === undefined) {
    task.seenWake = suspicion.suspectedAt;
    return;
  }
  if (stallAfterSec !== undefined || (suspicion && waitSec > 0)) task.control.rearm?.(stallAfterSec);
  if (waitSec <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let notify!: () => void;
  const wake = new Promise<void>(resolve => {
    notify = () => { if (!task.controller.signal.aborted && task.progress?.suspicion) resolve(); };
    task.listeners.add(notify);
  });
  task.control.waiting = (task.control.waiting ?? 0) + 1;
  try {
    await Promise.race([task.promise, wake, new Promise<void>(r => { timer = setTimeout(r, waitSec * 1000); })]);
    if (task.progress?.suspicion) task.seenWake = task.progress.suspicion.suspectedAt;
  } finally {
    task.control.waiting--;
    task.control.lastObservedAt = Date.now();
    task.listeners.delete(notify);
    clearTimeout(timer);
  }
}

/** Sync tool handoff keeps the original delegate promise, including checks and reporting. */
export async function delegateSync(input: DelegateInput, signal?: AbortSignal, evidenceSampler?: EvidenceSampler): Promise<Task> {
  const task = startTask(input, false, evidenceSampler);
  const abort = () => task.controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    await waitTask(task, 2147483);
    if (task.status === "running") task.control.background = true;
    return task;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
