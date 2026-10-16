import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { delegate, formatOutcome, type DelegateInput, type DelegateOutcome } from "./delegate.ts";

export type TaskStatus = "running" | "done" | "error" | "cancelled";

export interface Task {
  id: string;
  input: DelegateInput;
  status: TaskStatus;
  startedAt: number;
  finishedAt?: number;
  outcome?: DelegateOutcome;
  error?: string;
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

export function startTask(input: DelegateInput): Task {
  const controller = new AbortController();
  const task = { id: `task_${randomUUID().slice(0, 8)}`, input, status: "running", startedAt: Date.now(), controller } as Task;
  task.promise = delegate(input, controller.signal).then(
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

export function listTasks(): Task[] {
  return [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export async function waitTask(task: Task, waitSec: number): Promise<void> {
  if (task.status !== "running" || waitSec <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([task.promise, new Promise((r) => (timer = setTimeout(r, waitSec * 1000)))]);
  clearTimeout(timer);
}
