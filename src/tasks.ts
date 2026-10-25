import { hasNotifyHandoffs } from "./handoffs.ts";
import { leadInput, renderInputs } from "./inbox.ts";
import { baseline, denialBlock, evidenceDelta, logReport, recentFiles, tailFile, trendReport } from "./observability.ts";
import { sampleTreeEvidence } from "./watchdog.ts";
import type { EvidenceSampler } from "./watchdog.ts";
import type { StallControl } from "./codex.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { renderCheckpoint } from "./checkpoints.ts";
import { delegate, formatOutcome, type DelegateInput, type DelegateOutcome } from "./delegate.ts";
import type { RunSummary } from "./run-summary.ts";

export type TaskStatus = "running" | "done" | "error" | "cancelled" | "user_interrupted";

export interface Task {
  id: string;
  control: StallControl;
  listeners: Set<() => void>;
  seenWake?: number;
  /** Checkpoint numbers the lead has been shown. */
  shownCheckpoints?: Set<number>;
  shownUserInputs?: number;
  shownPatrols?: Set<number>;
  shownStop?: boolean;
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
  /** Codex thread, saved as soon as it is known so an interrupted task can still be resumed. */
  sessionId?: string;
}

const tasksDir = () => join(config.runsDir, "tasks");
const taskFile = (id: string) => join(tasksDir(), `${id.replace(/[^\w-]/g, "")}.json`);

function store(t: Task) {
  try {
    mkdirSync(tasksDir(), { recursive: true });
    const text = t.outcome ? formatOutcome(t.outcome) : t.error && `error: ${t.error}`;
    const rec: StoredTask = { id: t.id, status: t.status, startedAt: t.startedAt, finishedAt: t.finishedAt, title: t.input.title, text,
      sessionId: t.outcome?.result.sessionId ?? t.progress?.sessionId };
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
  task.promise = delegate(input, controller.signal, (info) => {
    const first = info.sessionId && !task.progress?.sessionId;
    task.progress = info;
    if (first) store(task);
    for (const notify of task.listeners) notify();
  }, task.control).then(
    (outcome) => {
      task.outcome = outcome;
      task.status = outcome.result.userInterrupt ? "user_interrupted" : controller.signal.aborted ? "cancelled" : outcome.result.ok ? "done" : "error";
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
  if (wakeSuspicion(task)) return formatSuspicion(task);
  const p = task.progress;
  const minutes = ((Date.now() - (p?.lastEventAt ?? task.startedAt)) / 60000).toFixed(1);
  const command = p?.inflight?.command ?? p?.checks?.find((c) => c.state === "running")?.command;
  const kept = p?.kept?.filter((k) => k.outcome === "running").map((k) => `\nkept running: cmd-${k.n} ${k.command.replace(/\s+/g, " ").slice(0, 120)}`).join("") ?? "";
  return `phase: ${p?.phase ?? "codex"}; last codex event: ${minutes}m ago${command ? `\ninflight: ${command.replace(/\s+/g, " ").slice(0, 200)}` : ""}${kept}`;
}

export function wakeSuspicion(task: Task): boolean {
  const p = task.progress;
  return !!p?.suspicion && (!p.patrol || p.suspicion.wakes >= 3);
}

export function newPatrolAlerts(task: Task) {
  // A completed worker's quota/auth STOP must retain priority over auxiliary alerts.
  if (!task.shownStop && (task.outcome?.result.errorKind === "quota" || task.outcome?.result.errorKind === "auth")) return [];
  return (task.progress?.patrols ?? []).flatMap((p, i) =>
    (p.error || p.verdict !== "healthy") && !task.shownPatrols?.has(i) ? [{ record: p, index: i }] : []);
}

export function formatPatrolAlerts(task: Task): string {
  const alerts = newPatrolAlerts(task);
  const running = task.status === "running";
  task.shownPatrols ??= new Set();
  return alerts.map(({ record: p, index }) => {
    task.shownPatrols!.add(index);
    const suspicion = p.suspicionAt && task.progress?.suspicion?.suspectedAt === p.suspicionAt;
    if (suspicion) task.seenWake = p.suspicionAt;
    return [
      `status: ${p.error ? "patrol_failed" : "patrol_alert"} (${running ? "codex is still running; nothing stopped" : "raised during the run; codex has finished, final result below"})`,
      `task_id: ${task.id}`,
      p.error ? `error: ${p.error.kind}: ${p.error.message}` : `verdict: ${p.verdict}\nreason: ${p.reason}\nevidence: ${JSON.stringify(p.evidence)}${p.suggestion ? `\nsuggestion: ${p.suggestion}` : ""}`,
      suspicion ? formatSuspicion(task) : "",
      running ? "next: task_result(task_id, wait_s=86400) to keep waiting; task_steer to redirect; task_cancel to stop."
        : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

export function listTasks(): Task[] {
  for (const task of tasks.values()) task.control.lastObservedAt = Date.now();
  return [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function formatSuspicion(task: Task): string {
  const p = task.progress!;
  const s = p.suspicion!;
  return [
    denialBlock(p.denials),
    "status: suspected_stall (still running, not killed)",
    "next: judge from the evidence; if it looks healthy call task_result(task_id, wait_s, stall_after_s?) to keep waiting; if hung call task_cancel then resume with session_id and tell codex which command hung",
    `task_id: ${task.id}`, `session_id: ${p.sessionId ?? "(none)"}`, `run id: ${p.id}`,
    `elapsed: ${((Date.now() - task.startedAt) / 1000).toFixed(0)}s`,
    `inflight: ${s.command?.replace(/\s+/g, " ").slice(0, 300) ?? "(model silent)"}; idle: ${((Date.now() - (p.lastEventAt ?? task.startedAt)) / 1000).toFixed(0)}s`,
    `threshold: ${s.thresholdSec}s; wakes: ${s.wakes}${s.matchedRule ? `; rule: ${s.matchedRule}` : ""}`,
    `evidence: ${JSON.stringify(s.evidence)}`,
    logReport(join(config.runsDir, p.id)),
    trendReport(p.trend),
    s.command ? baseline(config.runsDir, s.command, p.id) : "",
  ].filter(Boolean).join("\n");
}

/** Unseen checkpoints requiring a lead decision (legacy missing flags fail loud). */
export function newCheckpoints(task: Task) {
  return (task.progress?.checkpoints ?? []).filter(c => c.needsLead !== false && !task.shownCheckpoints?.has(c.n));
}

/** The checkpoint wake: what codex reported, and what the lead can do while it keeps working. Marks them shown. */
export function formatCheckpoints(task: Task): string {
  const fresh = newCheckpoints(task);
  task.shownCheckpoints ??= new Set();
  for (const c of fresh) task.shownCheckpoints.add(c.n);
  const p = task.progress!;
  const dir = join(config.runsDir, p.id);
  const steer = task.control.live
    ? "direction should change → task_steer(task_id, prompt) (now: true makes codex read it at once; a long command it started keeps running unless you also pass kill: true)"
    : "direction should change → task_cancel, then delegate(session_id) with the new direction (this engine cannot steer)";
  return [
    "status: checkpoint (codex is still working; nothing was stopped)",
    `next: read the stage report. On course → task_result(task_id, wait_s) to keep waiting; ${steer}; badly off → task_cancel. Don't re-investigate what the report already states.`,
    `task_id: ${task.id}`, `session_id: ${p.sessionId ?? "(none)"}`, `elapsed: ${((Date.now() - task.startedAt) / 1000).toFixed(0)}s`,
    ...fresh.map((c) => {
      try { return renderCheckpoint({ ...c, file: join(dir, `checkpoint-${c.n}.md`), text: readFileSync(join(dir, `checkpoint-${c.n}.md`), "utf8").trim() }); }
      catch { return `--- checkpoint ${c.n}: ${c.title} (file unreadable) ---`; }
    }),
  ].join("\n");
}

export async function waitTask(task: Task, waitSec: number, stallAfterSec?: number): Promise<void> {
  task.control.lastObservedAt = Date.now();
  if (task.status !== "running") return;
  // A stage report the lead hasn't seen comes back before any waiting.
  if (newCheckpoints(task).length || newUserInputs(task).length || newPatrolAlerts(task).length || await hasNotifyHandoffs()) return;
  const suspicion = task.controller.signal.aborted ? undefined : task.progress?.suspicion;
  // Deliver an unseen wake once before allowing a later wait to re-arm it.
  if (suspicion && wakeSuspicion(task) && task.seenWake !== suspicion.suspectedAt && stallAfterSec === undefined) {
    task.seenWake = suspicion.suspectedAt;
    return;
  }
  if (stallAfterSec !== undefined || (suspicion && waitSec > 0 && (!task.progress?.patrol || task.seenWake === suspicion.suspectedAt))) task.control.rearm?.(stallAfterSec);
  if (waitSec <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let notify!: () => void;
  const wake = new Promise<void>(resolve => {
    notify = () => { if (!task.controller.signal.aborted && (wakeSuspicion(task) || newPatrolAlerts(task).length || newCheckpoints(task).length || newUserInputs(task).length)) resolve(); };
    task.listeners.add(notify);
    notify();
  });
  let polling = false;
  const handoffTimer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try { if (await hasNotifyHandoffs()) notifyHandoff(); } catch {} finally { polling = false; }
  }, config.checkpointPollMs);
  let notifyHandoff!: () => void;
  const handoffWake = new Promise<void>(r => { notifyHandoff = r; });
  task.control.waiting = (task.control.waiting ?? 0) + 1;
  try {
    await Promise.race([task.promise, wake, handoffWake, new Promise<void>(r => { timer = setTimeout(r, waitSec * 1000); })]);
    if (task.progress?.suspicion && wakeSuspicion(task)) task.seenWake = task.progress.suspicion.suspectedAt;
  } finally {
    task.control.waiting--;
    task.control.lastObservedAt = Date.now();
    task.listeners.delete(notify);
    clearTimeout(timer);
    clearInterval(handoffTimer);
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

/**
 * Add the lead's message to the running Codex turn. Codex reads it at its next step (after the
 * command in flight, if any); edits it already made stay. Text, never throws.
 */
export async function steerTask(task: Task, prompt: string, now = false, waitMs?: number, kill = false): Promise<{ text: string; isError: boolean }> {
  const session = task.progress?.sessionId ?? task.outcome?.result.sessionId;
  if (task.status !== "running") {
    return { isError: true, text: `${task.id} already ${task.status}; codex is no longer running. Send the new direction with delegate(session_id="${session ?? "?"}") instead.` };
  }
  const live = task.control.live;
  if (!live) return { isError: true, text: `${task.id} runs on the exec engine, which cannot be steered; task_cancel it, then delegate again in the same cwd with the new direction (the interrupted session continues).` };
  if (live.finished) return { isError: true, text: `codex has finished ${task.id}'s turn and the server is running host checks; collect it with task_result, then send the new direction with delegate(session_id="${session ?? "?"}").` };
  try {
    const inflight = task.progress?.inflight?.command?.replace(/\s+/g, " ").slice(0, 160);
    if (now) {
      const r = await live.redirect(prompt, { kill, waitMs });
      if (task.progress) await leadInput(join(config.runsDir, task.progress.id), prompt, "delivered").catch(() => {});
      const lines = [`redirected ${task.id}: codex stopped thinking about its current step and continues the same session with your message. Edits made before stay.`];
      for (const k of r.kept) lines.push(`kept running: cmd-${k.n} ${k.command.replace(/\s+/g, " ").slice(0, 160)} (log ${k.log}). Codex was told it must wait for it or stop it before finishing; you can watch it with task_inspect. If you decide it must stop, task_steer again saying so (or now: true, kill: true).`);
      for (const c of r.killed) lines.push(`stopped: ${c.replace(/\s+/g, " ").slice(0, 160)}${kill ? "" : " (it was not started through the launcher, so it could not be kept)"}`);
      lines.push("Collect with task_result.");
      return { isError: false, text: lines.join("\n") };
    }
    const { consumed } = await live.steer(prompt, waitMs);
    if (task.progress) await leadInput(join(config.runsDir, task.progress.id), prompt, consumed ? "consumed" : "delivered").catch(() => {});
    return { isError: false, text: consumed
      ? `steered ${task.id}: codex has read the message and continues with it. Edits made before it stay; collect with task_result.`
      : `steered ${task.id}: accepted, codex will read it at its next step${inflight ? ` (busy running: ${inflight}; to have codex read it now while that keeps running, steer again with now: true)` : ""}. Collect with task_result; the result says whether codex read it.` };
  } catch (e) {
    if (task.progress) await leadInput(join(config.runsDir, task.progress.id), prompt, "failed").catch(() => {});
    return { isError: true, text: `steer failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Inspection never acknowledges a wake, re-arms a window or changes task state. */
export async function inspectTask(task: Task): Promise<string> {
  const p = task.progress;
  if (!p) return `task_id: ${task.id}; ${task.status}; evidence unavailable`;
  const dir = join(config.runsDir, p.id);
  const sample = task.status === "running" && p.codexPid
    ? await sampleTreeEvidence(p.codexPid, new AbortController().signal) : undefined;
  const events = tailFile(join(dir, "events.jsonl"), 16000).trim().split(/\r?\n/).slice(-5).map(line => {
    try { const e = JSON.parse(line); return `${e.type}: ${e.item?.command ?? e.item?.text ?? e.item?.type ?? e.message ?? ""}`.slice(0, 120); }
    catch { return line.slice(0, 120); }
  });
  return [denialBlock(p.denials), `task_id: ${task.id}; ${task.status}; sandbox: ${p.sandbox}`,
    `inflight: ${(p.inflight?.command ?? "none").slice(0, 180)}`,
    `evidence: ${sample ? evidenceDelta(sample, p.trend?.at(-1) ?? p.suspicion?.evidence) + `; busiest: ${sample.busiest?.name ?? "?"}; ${sample.error ?? ""}` : "process exited"}`,
    logReport(dir, 650), `last events:\n${events.join("\n")}`,
    `recent files (30m, top 10; scan capped at 20000 entries): ${(p.cwd ? recentFiles(p.cwd) : []).join(", ").slice(0, 600)}`].filter(Boolean).join("\n");
}

export function newUserInputs(task: Task) {
  return (task.progress?.inputs ?? []).filter(m => m.from === "user" && m.notify).slice(task.shownUserInputs ?? 0);
}
export function formatUserInputs(task: Task) {
  const fresh = newUserInputs(task);
  task.shownUserInputs = (task.progress?.inputs ?? []).filter(m => m.from === "user" && m.notify).length;
  return ["status: user_input (codex is still working; nothing was stopped)", `task_id: ${task.id}`, renderInputs(fresh), "next: tell the user what they changed, then task_result(task_id, wait_s) to keep waiting, or task_steer/task_cancel if your plan must change."].join("\n");
}

/** Attach deferred reports once to any result without waking a waiter. */
export function appendDeferredCheckpoints(task: Task, text: string): string {
  const fresh = (task.progress?.checkpoints ?? []).filter(c => c.needsLead === false && !task.shownCheckpoints?.has(c.n));
  if (!fresh.length) return text;
  task.shownCheckpoints ??= new Set();
  for (const c of fresh) task.shownCheckpoints.add(c.n);
  return text + "\n\nprogress checkpoints:\n" + fresh.map(c => `${c.n}. ${c.title} (${join(config.runsDir, task.progress!.id, `checkpoint-${c.n}.md`)})`).join("\n");
}
