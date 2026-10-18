import { extractDenials, type Denials, type CommandTiming } from "./observability.ts";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { APP_SERVER_ARGS, AppServerTurn, type LiveTurn, type RateLimits, type SteerRecord } from "./appserver.ts";
import { config, type Sandbox } from "./config.ts";
import type { KeptCommand } from "./longruns.ts";
import { stop, track } from "./procs.ts";
import { softWatchdog, commandThreshold, type StallPolicy, type CpuEvidence, type EvidenceSampler } from "./watchdog.ts";

export interface InflightItem { id: string; type: string; command?: string; startedAt: number }
export interface Suspicion extends Stall { suspectedAt: number; wakes: number; thresholdSec: number; matchedRule?: string; evidence: CpuEvidence }
/** `live` is set while an app-server turn runs, so task_steer / task_cancel can reach it. */
export interface StallControl { evidenceSampler?: EvidenceSampler; rearm?: (seconds?: number) => void; background?: boolean; lastObservedAt: number; waiting?: number; live?: LiveTurn }
export interface CodexProgress { commands?: CommandTiming[]; denials?: Denials; stallWindowSince?: number; suspicion?: Suspicion; effectiveThresholdSec?: number; matchedRule?: string; codexPid?: number; lastEventAt: number; inflight?: InflightItem; turnId?: string; steers?: SteerRecord[]; kept?: KeptCommand[] }
export interface Stall { kind: "silent" | "command"; idleMs: number; command?: string; commandStartedAt?: number }
export type ExitKind = "completed" | "timeout" | "stalled" | "cancelled" | "crashed" | "api_error";
export type ErrorKind = "quota" | "rate_limit" | "auth" | "network" | "context" | "other";

export function classifyError(text: string): ErrorKind {
  if (/quota|usage limit|insufficient_quota|credits|billing|exceeded.*usage/i.test(text)) return "quota";
  if (/rate.?limit|429|too many requests/i.test(text)) return "rate_limit";
  if (/auth|401|403|api.?key|unauthorized|forbidden|log.?in/i.test(text)) return "auth";
  if (/network|connect|ECONN|ENOTFOUND|fetch failed|socket|stream disconnect|timed? ?out|\b50[234]\b/i.test(text)) return "network";
  if (/context|token limit|too many tokens|maximum.*tokens/i.test(text)) return "context";
  return "other";
}

export interface RunOptions {
  addDirs?: string[];
  env?: NodeJS.ProcessEnv;
  prompt: string;
  model?: string;
  effort?: string;
  fast?: boolean;
  cwd?: string;
  images?: string[];
  sessionId?: string;
  fork?: boolean;
  sandbox: Sandbox;
  timeoutMs?: number;
  /** Overrides both the silent and command idle windows; zero disables. */
  idleTimeoutMs?: number;
  onProgress?: (info: CodexProgress) => void;
  /** Injectable evidence sampler for deterministic watchdog tests. */
  evidenceSampler?: EvidenceSampler;
  stall?: StallPolicy;
  stallControl?: StallControl;
  signal?: AbortSignal;
  /** `-o`: codex writes only its final message here. */
  lastMessageFile?: string;
  /** `--output-schema`: JSON Schema the final message must follow. */
  outputSchemaFile?: string;
  /** Raw `--json` event stream, kept for later inspection instead of being returned. */
  logFile?: string;
  /** The run directory (command logs, longrun.mjs); app-server keeps launcher commands across a redirect. */
  runDir?: string;
  /** Called once, as soon as codex reports the session (thread) id. */
  onSession?: (id: string) => void;
  /** Called with the codex process id right after it starts. */
  onSpawn?: (pid: number) => void;
}

export interface ToolCall {
  tool: string;
  status: string;
  title?: string;
  exitCode?: number | null;
}

export interface FileChange {
  path: string;
  kind: string;
}

export interface RunResult {
  denials?: Denials;
  commands?: CommandTiming[];
  ok: boolean;
  sessionId?: string;
  /** Final message (from `-o` when available, else the last agent message). */
  text: string;
  logFile?: string;
  toolCalls: ToolCall[];
  fileChanges: FileChange[];
  tokens: { input: number; cachedInput: number; output: number; reasoning: number };
  turns: number;
  warnings: string[];
  error?: string;
  exitCode: number | null;
  timedOut: boolean;
  stalled: boolean;
  stall?: Stall;
  exitKind: ExitKind;
  errorKind?: ErrorKind;
  durationMs: number;
  /** App-server only: lead messages sent into the running turn. */
  steers?: SteerRecord[];
  /** App-server only: the account's latest usage window. */
  rateLimits?: RateLimits;
  /** App-server only: long commands kept running across a redirect, and what became of them. */
  kept?: KeptCommand[];
}

const toml = (v: string) => JSON.stringify(v);

export function buildArgs(o: RunOptions): string[] {
  const args = ["exec"];
  if (o.sessionId) {
    // `resume`/`fork` take no -s/-C: the sandbox goes through -c and cwd comes from the spawn cwd.
    args.push(o.fork ? "fork" : "resume", o.sessionId, "-c", `sandbox_mode=${toml(o.sandbox)}`);
  } else {
    args.push("-s", o.sandbox);
    if (o.cwd) args.push("-C", o.cwd);
  }
  args.push("--json", "--skip-git-repo-check", "-c", `approval_policy=${toml("never")}`);
  if (o.model) args.push("-m", o.model);
  if (o.effort) args.push("-c", `model_reasoning_effort=${toml(o.effort)}`);
  // "priority" is the Fast tier; "default" is the normal one ("flex" is rejected by the API).
  if (o.fast !== undefined) args.push("-c", `service_tier=${toml(o.fast ? "priority" : "default")}`);
  if (o.lastMessageFile) args.push("-o", o.lastMessageFile);
  if (o.outputSchemaFile) args.push("--output-schema", o.outputSchemaFile);
  // `exec resume` rejects --add-dir; the same writable roots go through config there.
  if (o.sessionId && o.addDirs?.length) args.push("-c", `sandbox_workspace_write.writable_roots=[${o.addDirs.map(toml).join(",")}]`);
  else for (const dir of o.addDirs ?? []) args.push("--add-dir", dir);
  for (const img of o.images ?? []) args.push("-i", img);
  // The prompt goes through stdin ("-"): no argv length limit (Windows caps a command line at ~32K)
  // and the brief doesn't show up in process listings. "--" ends -i's list of files.
  args.push("--", "-");
  return args;
}

/** Codex wraps API errors as a JSON string inside `message`; pull out the readable part. */
export function errorMessage(msg: unknown): string {
  if (typeof msg !== "string") return JSON.stringify(msg);
  try {
    const inner = JSON.parse(msg);
    const m = inner?.error?.message ?? inner?.message;
    if (typeof m === "string") return m;
  } catch {}
  return msg;
}

/** Folds `codex exec --json` event lines into a result. Unknown events are ignored. */
export class EventCollector {
  sessionId?: string;
  texts: string[] = [];
  toolCalls: ToolCall[] = [];
  fileChanges: FileChange[] = [];
  tokens = { input: 0, cachedInput: 0, output: 0, reasoning: 0 };
  turns = 0;
  warnings: string[] = [];
  errors: string[] = [];
  raw: string[] = [];
  lastEventAt = Date.now();
  commands: CommandTiming[] = [];
  denialOutputs = new Map<string, Denials>();
  get denials(): Denials {
    const values = [...this.denialOutputs.values()];
    return { count: values.reduce((n, d) => n + d.count, 0), paths: [...new Set(values.flatMap(d => d.paths))] };
  }
  inflight = new Map<string, InflightItem>();

  push(line: string) {
    this.lastEventAt = Date.now();
    const trimmed = line.trim();
    if (!trimmed) return;
    let e: any;
    try {
      e = JSON.parse(trimmed);
    } catch {
      this.raw.push(trimmed);
      return;
    }
    if (e.item?.type === "command_execution" && typeof e.item.aggregated_output === "string") {
      this.denialOutputs.set(e.item.id ?? `command-${this.commands.length}`, extractDenials(e.item.aggregated_output));
    }
    switch (e.type) {
      case "item.started":
        if (e.item?.id) this.inflight.set(e.item.id, { id: e.item.id, type: e.item.type,
          command: e.item.command, startedAt: this.lastEventAt });
        break;
      case "thread.started":
        this.sessionId ??= e.thread_id;
        break;
      case "item.completed": {
        const started = this.inflight.get(e.item?.id);
        if (started?.type === "command_execution" && started.command) this.commands.push({ command: started.command, durationMs: this.lastEventAt - started.startedAt });
        this.inflight.delete(e.item?.id);
        this.item(e.item ?? {});
        break;
      }
      case "turn.completed": {
        this.turns++;
        const u = e.usage ?? {};
        this.tokens.input += u.input_tokens ?? 0;
        this.tokens.cachedInput += u.cached_input_tokens ?? 0;
        this.tokens.output += u.output_tokens ?? 0;
        this.tokens.reasoning += u.reasoning_output_tokens ?? 0;
        break;
      }
      case "turn.failed":
        this.error(e.error?.message ?? e.error);
        break;
      case "turn.redirected":
        // The interrupted turn's commands never complete; they must not hold the stall window.
        this.inflight.clear();
        break;
      case "error":
        this.error(e.message);
        break;
    }
  }

  private item(it: any) {
    switch (it.type) {
      case "agent_message":
        if (typeof it.text === "string") this.texts.push(it.text);
        break;
      case "command_execution":
        this.toolCalls.push({ tool: "shell", status: it.status, title: it.command, exitCode: it.exit_code });
        break;
      case "file_change":
        this.toolCalls.push({ tool: "apply_patch", status: it.status });
        for (const c of it.changes ?? []) this.fileChanges.push({ path: c.path, kind: c.kind });
        break;
      case "mcp_tool_call":
        this.toolCalls.push({ tool: `mcp:${it.server}/${it.tool}`, status: it.status });
        break;
      case "web_search":
        this.toolCalls.push({ tool: "web_search", status: it.status ?? "completed", title: it.query });
        break;
      case "error":
        // Non-fatal notices (e.g. unknown model metadata); fatal ones arrive as `error`/`turn.failed` events.
        // Config-lint notices repeat on every run and say nothing about the task; they stay in the log.
        if (typeof it.message === "string" && !this.warnings.includes(it.message) && !/unrecognized configuration settings/i.test(it.message)) {
          this.warnings.push(it.message);
        }
        break;
    }
  }

  private error(msg: unknown) {
    const m = errorMessage(msg);
    // `error` is usually followed by a `turn.failed` carrying the same message.
    if (!this.errors.includes(m)) this.errors.push(m);
  }

  /** All agent messages, falling back to non-JSON stdout. */
  get text(): string {
    return this.texts.join("\n\n").trim() || this.raw.join("\n").trim();
  }

  /** The last agent message: the answer, without the progress notes before it. */
  get finalText(): string {
    return this.texts.at(-1)?.trim() || this.raw.join("\n").trim();
  }
}

function readFinal(file: string | undefined): string | undefined {
  if (!file || !existsSync(file)) return undefined;
  try {
    return readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function runCodex(o: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const collector = new EventCollector();
  const appServer = config.engine === "app-server";
  return new Promise((resolve) => {
    const child = spawn(config.codex.cmd, [...config.codex.args, ...(appServer ? APP_SERVER_ARGS : buildArgs(o))], {
      cwd: o.cwd,
      env: { ...process.env, ...o.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Own process group on POSIX so the whole tree can be signalled (see procs.ts).
      detached: process.platform !== "win32",
    });
    track(child);
    if (child.pid !== undefined) {
      try {
        o.onSpawn?.(child.pid);
      } catch {}
    }
    child.stdin.on("error", () => {});
    const log = o.logFile ? createWriteStream(o.logFile) : undefined;
    log?.on("error", () => {});
    // exec: the brief is read from stdin; closing it is also what tells codex the prompt is complete.
    // app-server: stdin carries JSON-RPC; the turn's events are translated into exec event lines.
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const turn = appServer ? new AppServerTurn(child, o, {
      emit: (event) => { const line = JSON.stringify(event); log?.write(`${line}\n`); collector.push(line); alive(); },
      activity: () => { collector.lastEventAt = Date.now(); alive(); },
      // Codex is done with the turn: let the server exit, and make sure it does.
      done: () => { child.stdin.end(); exitTimer ??= setTimeout(() => stop(child), 5000); exitTimer.unref?.(); },
    }) : undefined;
    if (!turn) child.stdin.end(o.prompt);
    if (turn && o.stallControl) o.stallControl.live = turn;
    let buf = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let stall: Stall | undefined;
    let suspicion: Suspicion | undefined;
    let wakes = 0;
    let threshold: number | undefined;
    let windowSince: number | undefined;
    const control = o.stallControl;
    const progress = () => {
      try { o.onProgress?.({ commands: [...collector.commands], denials: collector.denials, codexPid: child.pid, lastEventAt: collector.lastEventAt,
        inflight: [...collector.inflight.values()].find(it => it.type === "command_execution") ?? collector.inflight.values().next().value,
        suspicion, stallWindowSince: idleWindow().since, effectiveThresholdSec: idleWindow().timeoutMs / 1000, matchedRule: selectedRule(),
        turnId: turn?.turnId, steers: turn?.steers.length ? [...turn.steers] : undefined, kept: turn?.kept.length ? turn.kept : undefined }); } catch {}
    };
    // New output resets the stall window.
    const alive = () => { suspicion = undefined; wakes = 0; threshold = undefined; windowSince = undefined; watchdog.touch(); progress(); announce(); };
    let announced = false;
    const announce = () => {
      if (announced || !collector.sessionId) return;
      announced = true;
      try {
        o.onSession?.(collector.sessionId);
      } catch {}
    };

    const kill = () => {
      watchdog.dispose();
      if (timer) clearTimeout(timer);
      stop(child);
    };
    // A Stop interrupts the turn first, so codex records it cleanly and the session resumes well.
    const cancel = () => {
      if (!turn || turn.finished || !turn.turnId) return kill();
      watchdog.dispose();
      void turn.interrupt();
      exitTimer ??= setTimeout(kill, 5000);
    };
    const command = () => [...collector.inflight.values()].find(it => it.type === "command_execution");
    const selection = () => commandThreshold(command()?.command ?? "", o.stall?.command_s ?? (o.idleTimeoutMs === undefined ? config.commandIdleTimeoutSec : o.idleTimeoutMs / 1000), o.stall?.long_commands);
    const selectedRule = () => command() ? selection().matchedRule : undefined;
    const idleWindow = () => ({ key: command()?.id ?? "silent", since: windowSince ?? collector.lastEventAt,
      timeoutMs: (threshold ?? (command() ? selection().seconds : o.stall?.silent_s ?? (o.idleTimeoutMs === undefined ? config.idleTimeoutSec : o.idleTimeoutMs / 1000))) * 1000 });
    const watchdog = softWatchdog(child.pid, idleWindow, evidence => {
      const it = command();
      suspicion = { kind: it ? "command" : "silent", command: it?.command, commandStartedAt: it?.startedAt,
        idleMs: Date.now() - collector.lastEventAt, suspectedAt: Date.now(), wakes: ++wakes,
        thresholdSec: idleWindow().timeoutMs / 1000, matchedRule: selectedRule(), evidence };
      progress();
    }, o.evidenceSampler);
    if (control) control.rearm = seconds => {
      threshold = seconds ?? (suspicion ? suspicion.thresholdSec * 2 : idleWindow().timeoutMs / 1000);
      windowSince = Date.now();
      suspicion = undefined;
      watchdog.touch();
      progress();
    };
    const hardIdle = config.hardIdleTimeoutSec * 1000;
    const orphanTimer = hardIdle > 0 ? setInterval(() => {
      if (suspicion && control?.background && !control.waiting
        && Date.now() - Math.max(collector.lastEventAt, control.lastObservedAt) >= hardIdle) {
        stall = suspicion;
        kill();
      }
    }, Math.max(10, Math.min(1000, hardIdle))) : undefined;
    orphanTimer?.unref();
    progress();
    const timer = o.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, o.timeoutMs)
      : undefined;
    o.signal?.addEventListener("abort", cancel, { once: true });
    if (o.signal?.aborted) kill();

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (!turn) log?.write(chunk);
      buf += chunk;
      let i: number;
      let sawLine = false;
      while ((i = buf.indexOf("\n")) >= 0) {
        sawLine = true;
        const line = buf.slice(0, i);
        if (turn) turn.line(line);
        else collector.push(line);
        buf = buf.slice(i + 1);
      }
      if (sawLine && !turn) alive();
    });
    if (turn && !o.signal?.aborted) void turn.run();
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });

    const stderrTail = () => stderr.split("\n")
      .filter((l) => l.trim() && !l.startsWith("Reading additional input") && !/unrecognized configuration|is ignored\.$/.test(l))
      .slice(-5).join("\n");
    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearInterval(orphanTimer);
      clearTimeout(exitTimer);
      if (control) control.rearm = undefined;
      watchdog.dispose();
      o.signal?.removeEventListener("abort", cancel);
      if (timer) clearTimeout(timer);
      if (buf) turn ? turn.line(buf) : collector.push(buf);
      // The turn object stays readable on `live` (steers, finished) until the task is collected.
      if (turn) turn.finished = true;
      progress();
      announce();
      if (stderr.trim()) log?.write(`\n# stderr (tail)\n${stderr}\n`);
      log?.end();
      const errors = [...collector.errors];
      if (spawnError) errors.push(spawnError);
      if (timedOut) errors.push(`timed out after ${Math.round((o.timeoutMs ?? 0) / 1000)}s`);
      else if (o.signal?.aborted) errors.push("cancelled");
      if (stall) errors.push(`stalled: no codex output for ${Math.round(stall.idleMs / 60000)}m${stall.command ? ` while running: ${stall.command.slice(0, 200)}` : " (model silent)"}`);
      // app-server: after turn.completed the exit code is ours (stdin closed or the fallback stop).
      if (exitCode && !errors.length && !(turn && collector.turns)) errors.push(stderrTail() || `exit code ${exitCode}`);
      const exitKind: ExitKind = timedOut ? "timeout" : stall ? "stalled" : o.signal?.aborted ? "cancelled"
        : spawnError ? "crashed" : collector.errors.length ? "api_error"
        : (exitCode !== 0 && !turn) || !collector.turns ? "crashed" : "completed";
      if (exitKind === "crashed" && !errors.length) errors.push(stderrTail() || "codex exited without turn.completed");
      const error = errors.join("; ") || undefined;
      resolve({
        denials: collector.denials, commands: collector.commands,
        ok: exitKind === "completed",
        exitKind,
        // Structured codexErrorInfo beats matching the message text.
        errorKind: error ? turn?.errorKinds[0] ?? classifyError(error) : undefined,
        steers: turn?.steers.length ? turn.steers : undefined,
        rateLimits: turn?.rateLimits,
        kept: turn?.kept.length ? turn.kept : undefined,
        stalled: !!stall,
        stall,
        sessionId: collector.sessionId,
        text: readFinal(o.lastMessageFile) ?? collector.finalText,
        logFile: o.logFile,
        toolCalls: collector.toolCalls,
        fileChanges: collector.fileChanges,
        tokens: collector.tokens,
        turns: collector.turns,
        warnings: collector.warnings,
        error,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
      });
    };
    child.on("error", (err) => finish(null, `failed to start '${[config.codex.cmd, ...config.codex.args].join(" ")}': ${err.message}`));
    child.on("close", (code) => finish(code));
  });
}
