import { providerName } from "./providers.ts";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ErrorKind, RunOptions } from "./codex.ts";
import { join } from "node:path";
import { keptPreamble, keptReminder, longrunCommand, refresh, runningLongruns, stopLongrun, type KeptCommand } from "./longruns.ts";
import { killPidTree } from "./procs.ts";

/** Reminder turns codex gets for still-running kept commands before the server stops them. */
const MAX_REMINDERS = 2;

/**
 * `codex app-server` speaks JSON-RPC over stdio. One process runs one turn of one thread; while the
 * turn is active the lead can steer it (turn/steer) or stop it (turn/interrupt). Notifications are
 * translated into the `codex exec --json` event lines the rest of the server already reads, so the
 * collector, events.jsonl, the dashboard and task_inspect stay the same for both engines.
 */

export interface SteerRecord { at: number; text: string; clientId: string; consumedAt?: number; redirect?: boolean }
export interface RateLimits { usedPercent?: number; resetsAt?: number; windowMins?: number; secondaryUsedPercent?: number; secondaryResetsAt?: number }

/** Live handle on the running turn, exposed to task_steer / task_cancel. */
export interface LiveTurn {
  threadId?: string;
  turnId?: string;
  /** Codex reported turn/completed; the run may still be in host checks. */
  finished: boolean;
  steers: SteerRecord[];
  /** Resolves true once codex has taken the input into the turn, false if not within `waitMs`. */
  steer(text: string, waitMs?: number): Promise<{ consumed: boolean; record: SteerRecord }>;
  /**
   * Interrupt codex's current step and continue the thread with `text`. Long commands started through
   * longrun.mjs keep running (codex is told it must deal with them) unless `kill`; others are stopped.
   */
  redirect(text: string, opts?: { kill?: boolean; waitMs?: number }): Promise<{ consumed: boolean; record: SteerRecord; kept: KeptCommand[]; killed: string[] }>;
  /** Commands kept running across a redirect, with their current state. */
  readonly kept: KeptCommand[];
  interrupt(): Promise<void>;
}

export const APP_SERVER_ARGS = ["app-server", "-c", `approval_policy="never"`];

/** `-c`-style overrides; dotted keys merge into the user's tables instead of replacing them. */
export function threadConfig(o: RunOptions): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  if (o.effort) c.model_reasoning_effort = o.effort;
  if (o.sandbox === "workspace-write" && o.addDirs?.length) c["sandbox_workspace_write.writable_roots"] = o.addDirs;
  return c;
}

export function threadParams(o: RunOptions) {
  return {
    ...(o.provider ? { modelProvider: providerName(o.provider) } : {}),
    cwd: o.cwd ?? null,
    sandbox: o.sandbox,
    approvalPolicy: "never",
    ...(o.model ? { model: o.model } : {}),
    ...(o.fast !== undefined ? { serviceTier: o.fast ? "priority" : "default" } : {}),
    config: threadConfig(o),
  };
}

/** Maps `codexErrorInfo` (structured) onto our error kinds; undefined leaves it to the text classifier. */
export function kindFromInfo(info: unknown): ErrorKind | undefined {
  const key = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined;
  if (!key) return undefined;
  if (/usageLimit|sessionBudget/i.test(key)) return "quota";
  if (/rateLimit/i.test(key)) return "rate_limit";
  if (/unauthorized/i.test(key)) return "auth";
  if (/contextWindow/i.test(key)) return "context";
  if (/serverOverloaded|internalServerError|ConnectionFailed|StreamDisconnected|TooManyFailedAttempts/i.test(key)) return "network";
  return undefined;
}

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** One app-server item → the `codex exec --json` item shape. */
export function execItem(it: any): any {
  switch (it?.type) {
    case "commandExecution":
      return { id: it.id, type: "command_execution", command: it.command, aggregated_output: it.aggregatedOutput ?? undefined,
        exit_code: it.exitCode, status: it.status };
    case "fileChange":
      return { id: it.id, type: "file_change", status: it.status, changes: (it.changes ?? []).map((c: any) => ({ path: c.path, kind: c.kind?.type ?? c.kind })) };
    case "agentMessage":
      return { id: it.id, type: "agent_message", text: it.text };
    case "mcpToolCall":
      return { id: it.id, type: "mcp_tool_call", server: it.server, tool: it.tool, status: it.status };
    case "webSearch":
      return { id: it.id, type: "web_search", query: it.query, status: "completed" };
    default:
      return { id: it?.id, type: snake(String(it?.type ?? "unknown")) };
  }
}

// High-volume streams we never read; the server skips sending them.
const OPT_OUT = ["item/agentMessage/delta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded",
  "item/plan/delta", "item/fileChange/outputDelta", "item/fileChange/patchUpdated", "turn/diff/updated", "turn/moderationMetadata",
  "rawResponseItem/completed", "rawResponse/completed", "thread/readState/changed"];

export interface DriverHooks {
  /** A translated exec-style event line. */
  emit(event: object): void;
  /** Any sign of life (including command output and sub-agent work) that is not worth an event line. */
  activity(): void;
  /** The turn is over (completed, failed or interrupted) or the session could not start. */
  done(): void;
}

export class AppServerTurn implements LiveTurn {
  threadId?: string;
  turnId?: string;
  finished = false;
  steers: SteerRecord[] = [];
  rateLimits?: RateLimits;
  errorKinds: ErrorKind[] = [];
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private closed = false;
  private lastText?: string;
  private usageBase?: any;
  private usage = { input: 0, cached: 0, output: 0, reasoning: 0 };
  private lastActivity = 0;
  private waiters = new Map<string, () => void>();
  private outputSchema?: unknown;
  /** Command item id → OS pid of its shell and the command line, while the command runs. */
  private running = new Map<string, { pid: number; command: string }>();
  private redirecting?: { kill: boolean; go: (kept: KeptCommand[], killed: string[]) => void };
  private keptCommands: KeptCommand[] = [];
  private reminders = 0;
  private child: ChildProcessWithoutNullStreams;
  private o: RunOptions;
  private hooks: DriverHooks;

  constructor(child: ChildProcessWithoutNullStreams, o: RunOptions, hooks: DriverHooks) {
    this.child = child;
    this.o = o;
    this.hooks = hooks;
    child.stdin.on("error", () => {});
    child.on("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("codex app-server exited"));
      this.pending.clear();
    });
  }

  private send(msg: object) {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private rpc(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error("codex app-server exited"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  private ping() {
    const now = Date.now();
    if (now - this.lastActivity < 1000) return;
    this.lastActivity = now;
    this.hooks.activity();
  }

  /** Feed one stdout line from the app-server. */
  line(raw: string) {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.id !== undefined && !m.method) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p?.reject(new Error(m.error.message ?? JSON.stringify(m.error)));
      else p?.resolve(m.result);
      return;
    }
    // approval_policy=never means codex should not ask; refuse anything that slips through.
    if (m.id !== undefined) return this.send({ id: m.id, error: { code: -32601, message: `codex-delegate cannot answer ${m.method}` } });
    this.notify(m.method, m.params ?? {});
  }

  private notify(method: string, p: any) {
    if (method === "account/rateLimits/updated") {
      const r = p.rateLimits ?? {};
      this.rateLimits = { usedPercent: r.primary?.usedPercent, resetsAt: r.primary?.resetsAt ?? undefined, windowMins: r.primary?.windowDurationMins ?? undefined,
        secondaryUsedPercent: r.secondary?.usedPercent, secondaryResetsAt: r.secondary?.resetsAt ?? undefined };
      return;
    }
    // Sub-agent threads keep the run alive but are not part of its report.
    if (p.threadId && this.threadId && p.threadId !== this.threadId) return this.ping();
    switch (method) {
      case "item/started":
        if (p.item?.type === "commandExecution" && Number(p.item.processId) > 0) this.running.set(p.item.id, { pid: Number(p.item.processId), command: String(p.item.command ?? "") });
        if (p.item?.type !== "userMessage") this.hooks.emit({ type: "item.started", item: execItem(p.item) });
        else this.ping();
        return;
      case "item/completed": {
        const it = p.item ?? {};
        this.running.delete(it.id);
        if (it.type === "userMessage") return this.consumed(it.clientId);
        if (it.type === "agentMessage" && typeof it.text === "string") this.lastText = it.text;
        this.hooks.emit({ type: "item.completed", item: execItem(it) });
        return;
      }
      case "item/commandExecution/outputDelta":
      case "command/exec/outputDelta":
      case "item/mcpToolCall/progress":
        return this.ping();
      case "thread/tokenUsage/updated":
        this.tokens(p.tokenUsage);
        return this.ping();
      case "turn/started":
        this.turnId ??= p.turn?.id;
        return this.ping();
      case "turn/completed":
        if (!this.turnId || p.turn?.id === this.turnId) this.complete(p.turn ?? {});
        return;
      case "error":
        // Retries (reconnects) are progress, not failures; the final failure arrives on turn/completed.
        if (p.willRetry) return this.ping();
        this.fail(p.error);
        return;
      case "warning":
      case "configWarning":
        if (typeof p.message === "string" || typeof p.summary === "string") this.hooks.emit({ type: "item.completed", item: { type: "error", message: p.message ?? p.summary } });
        return;
      default:
        this.ping();
    }
  }

  private tokens(u: any) {
    const t = u?.total, l = u?.last;
    if (!t) return;
    // The thread total includes earlier turns of a resumed session; count from just before this turn.
    this.usageBase ??= {
      inputTokens: t.inputTokens - (l?.inputTokens ?? 0), cachedInputTokens: t.cachedInputTokens - (l?.cachedInputTokens ?? 0),
      outputTokens: t.outputTokens - (l?.outputTokens ?? 0), reasoningOutputTokens: t.reasoningOutputTokens - (l?.reasoningOutputTokens ?? 0),
    };
    const b = this.usageBase;
    this.usage = { input: t.inputTokens - b.inputTokens, cached: t.cachedInputTokens - b.cachedInputTokens,
      output: t.outputTokens - b.outputTokens, reasoning: t.reasoningOutputTokens - b.reasoningOutputTokens };
  }

  private fail(error: any) {
    const kind = kindFromInfo(error?.codexErrorInfo);
    if (kind) this.errorKinds.push(kind);
    this.hooks.emit({ type: "error", message: error?.message ?? "codex turn failed" });
  }

  private complete(turn: any) {
    if (this.finished) return;
    const runDir = this.o.runDir;
    if (turn.status === "interrupted") {
      const redirect = this.redirecting;
      this.redirecting = undefined;
      const running = [...this.running.values()];
      this.running.clear();
      // Interrupting a turn does not stop the commands it started (seen live on Windows), and their
      // shells can no longer report back. Launcher commands (longrun.mjs) live on in their own process,
      // so a redirect keeps them, unless the lead asked to kill; everything else is stopped.
      const kept: KeptCommand[] = [];
      const killed: string[] = [];
      // Ground truth is the run directory (cmd-<n>.pid of live monitors), not the shell command text,
      // whose quoting varies (`node \"…longrun.mjs\"` inside powershell -Command …).
      const tracked = new Set(this.keptCommands.filter((k) => k.outcome === "running").map((k) => k.n));
      const live = runDir ? runningLongruns(runDir).filter((n) => !tracked.has(n)) : [];
      for (const r of running) {
        killPidTree(r.pid); // the shell / launcher; a launcher command's own process is not under it
        // Launcher shells are accounted for below by their cmd-<n>; anything else is gone for good.
        if (!/longrun\.mjs/i.test(r.command)) killed.push(r.command);
      }
      for (const n of live) {
        if (redirect && !redirect.kill) kept.push({ n, command: longrunCommand(runDir!, n), log: join(runDir!, `cmd-${n}.log`), keptAt: Date.now(), outcome: "running" });
        else if (stopLongrun(runDir!, n, redirect ? "lead redirected with kill" : "task cancelled")) killed.push(longrunCommand(runDir!, n));
      }
      if (redirect) {
        this.keptCommands.push(...kept);
        this.hooks.emit({ type: "turn.redirected", turn_id: turn.id, kept: kept.map((k) => k.n), killed });
        return redirect.go(kept, killed);
      }
      // A cancel: nothing the task started stays behind.
      if (runDir) this.keptCommands = this.keptCommands.map((k) => refresh(runDir, k)).map((k) =>
        k.outcome === "running" && stopLongrun(runDir, k.n, "task cancelled") ? { ...k, outcome: "killed_cancel" as const } : k);
    }
    if (turn.status === "completed" && runDir) {
      // Codex may not end its work while a command it was told to look after is still running.
      this.keptCommands = this.keptCommands.map((k) => refresh(runDir, k));
      const open = this.keptCommands.filter((k) => k.outcome === "running");
      if (open.length && this.reminders < MAX_REMINDERS) {
        this.reminders++;
        this.hooks.emit({ type: "turn.reminded", kept: open.map((k) => k.n) });
        this.startTurn([{ type: "text", text: keptReminder(runDir, open), text_elements: [] }]).catch((e) => this.failRun(e));
        return;
      }
      // Still running after the reminders: stop it, and say loudly that it was forgotten.
      this.keptCommands = this.keptCommands.map((k) =>
        k.outcome === "running" && stopLongrun(runDir, k.n, "codex ended the run without dealing with it") ? { ...k, outcome: "killed_forgotten" as const } : k);
    }
    this.finished = true;
    const text = turn.items?.filter((i: any) => i.type === "agentMessage").at(-1)?.text ?? this.lastText;
    if (this.o.lastMessageFile && typeof text === "string") { try { writeFileSync(this.o.lastMessageFile, text); } catch {} }
    if (turn.status === "completed") {
      this.hooks.emit({ type: "turn.completed", usage: { input_tokens: this.usage.input, cached_input_tokens: this.usage.cached,
        output_tokens: this.usage.output, reasoning_output_tokens: this.usage.reasoning } });
    } else if (turn.status === "failed") {
      const kind = kindFromInfo(turn.error?.codexErrorInfo);
      if (kind) this.errorKinds.push(kind);
      this.hooks.emit({ type: "turn.failed", error: { message: turn.error?.message ?? "codex turn failed" } });
    }
    // "interrupted" adds nothing: the caller asked for it and reports it as cancelled.
    for (const wake of this.waiters.values()) wake();
    this.hooks.done();
  }

  private consumed(clientId: string | null) {
    const rec = this.steers.find((s) => s.clientId === clientId) ?? (clientId ? undefined : this.steers.find((s) => !s.consumedAt));
    if (!rec || rec.consumedAt) return this.ping();
    rec.consumedAt = Date.now();
    this.hooks.emit({ type: "steer.consumed", client_id: rec.clientId });
    this.waiters.get(rec.clientId)?.();
  }

  /** Start (or resume / fork) the thread and the turn. Failures end the run through a turn.failed event. */
  async run() {
    const o = this.o;
    try {
      await this.rpc("initialize", { clientInfo: { name: "codex-delegate", title: null, version: "1" },
        capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: OPT_OUT } });
      this.send({ method: "initialized" });
      const params = threadParams(o);
      const res = o.sessionId
        ? await this.rpc(o.fork ? "thread/fork" : "thread/resume", { threadId: o.sessionId, ...params, excludeTurns: true })
        : await this.rpc("thread/start", params);
      this.threadId = res.thread?.id;
      this.hooks.emit({ type: "thread.started", thread_id: this.threadId });
      if (o.outputSchemaFile) this.outputSchema = JSON.parse(readFileSync(o.outputSchemaFile, "utf8"));
      const input: any[] = [{ type: "text", text: o.prompt, text_elements: [] }];
      for (const path of o.images ?? []) input.push({ type: "localImage", path });
      await this.startTurn(input);
    } catch (e) {
      this.failRun(e);
    }
  }

  private async startTurn(input: any[], clientUserMessageId?: string) {
    const turn = await this.rpc("turn/start", { threadId: this.threadId, input, ...(clientUserMessageId ? { clientUserMessageId } : {}),
      ...(this.o.effort ? { effort: this.o.effort } : {}), ...(this.outputSchema ? { outputSchema: this.outputSchema } : {}) });
    this.turnId = turn.turn?.id ?? this.turnId;
    this.hooks.emit({ type: "turn.started", turn_id: this.turnId });
  }

  /**
   * Stop what codex is doing right now (including a long command) and continue the same thread with
   * `text` as a new turn. The run stays one run: same task, same final report.
   */
  async redirect(text: string, opts: { kill?: boolean; waitMs?: number } = {}) {
    if (!this.threadId || !this.turnId) throw new Error("codex has not started its turn yet; try again in a few seconds");
    if (this.finished) throw new Error("codex already finished this turn");
    const record: SteerRecord = { at: Date.now(), text: text.slice(0, 500), clientId: `redirect-${randomUUID().slice(0, 8)}`, redirect: true };
    this.steers.push(record);
    let outcome = { kept: [] as KeptCommand[], killed: [] as string[] };
    const stopped = new Promise<boolean>((resolve) => {
      this.redirecting = { kill: !!opts.kill, go: (kept, killed) => { outcome = { kept, killed }; resolve(true); } };
      setTimeout(() => resolve(false), opts.waitMs ?? 20000).unref?.();
    });
    this.hooks.emit({ type: "steer.sent", client_id: record.clientId, text: record.text, redirect: true });
    try {
      await this.rpc("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
    } catch (e) {
      this.redirecting = undefined;
      throw e;
    }
    if (!(await stopped)) {
      this.redirecting = undefined;
      throw new Error("codex did not stop the current turn in time; try task_cancel");
    }
    const preamble = this.o.runDir && (outcome.kept.length || outcome.killed.length) ? keptPreamble(this.o.runDir, outcome.kept, outcome.killed) : "";
    try {
      await this.startTurn([{ type: "text", text: preamble + text, text_elements: [] }], record.clientId);
    } catch (e) {
      this.failRun(e);
      throw e;
    }
    return { consumed: true, record, ...outcome };
  }

  /** Commands kept running across a redirect, with their current state. */
  get kept(): KeptCommand[] {
    const runDir = this.o.runDir;
    return runDir ? (this.keptCommands = this.keptCommands.map((k) => refresh(runDir, k))) : this.keptCommands;
  }

  private failRun(e: unknown) {
    if (this.finished) return;
    this.finished = true;
    this.hooks.emit({ type: "turn.failed", error: { message: e instanceof Error ? e.message : String(e) } });
    this.hooks.done();
  }

  async steer(text: string, waitMs = 15000) {
    if (!this.threadId || !this.turnId) throw new Error("codex has not started its turn yet; try again in a few seconds");
    if (this.finished) throw new Error("codex already finished this turn");
    const record: SteerRecord = { at: Date.now(), text: text.slice(0, 500), clientId: `steer-${randomUUID().slice(0, 8)}` };
    // Registered before the request: the userMessage echo can arrive before the RPC reply.
    this.steers.push(record);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const seen = new Promise<boolean>((resolve) => {
      this.waiters.set(record.clientId, () => resolve(true));
      timer = setTimeout(() => resolve(false), waitMs);
    });
    try {
      await this.rpc("turn/steer", { threadId: this.threadId, expectedTurnId: this.turnId, clientUserMessageId: record.clientId,
        input: [{ type: "text", text, text_elements: [] }] });
    } catch (e) {
      this.steers.splice(this.steers.indexOf(record), 1);
      clearTimeout(timer);
      this.waiters.delete(record.clientId);
      throw e;
    }
    this.hooks.emit({ type: "steer.sent", client_id: record.clientId, text: record.text });
    const consumed = record.consumedAt !== undefined || (await seen);
    clearTimeout(timer);
    this.waiters.delete(record.clientId);
    return { consumed: consumed && record.consumedAt !== undefined, record };
  }

  async interrupt() {
    // A cancel wins over a redirect in progress: the interrupted turn ends the run.
    this.redirecting = undefined;
    if (this.finished || !this.threadId || !this.turnId) return;
    try { await this.rpc("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }); } catch {}
  }
}
