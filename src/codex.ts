import { spawn } from "node:child_process";
import { config, type Sandbox } from "./config.ts";

export interface RunOptions {
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
  signal?: AbortSignal;
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
  ok: boolean;
  sessionId?: string;
  text: string;
  toolCalls: ToolCall[];
  fileChanges: FileChange[];
  tokens: { input: number; cachedInput: number; output: number; reasoning: number };
  turns: number;
  warnings: string[];
  error?: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
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
  for (const img of o.images ?? []) args.push("-i", img);
  // "--" so prompts starting with "-" are not parsed as flags
  args.push("--", o.prompt);
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

  push(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let e: any;
    try {
      e = JSON.parse(trimmed);
    } catch {
      this.raw.push(trimmed);
      return;
    }
    switch (e.type) {
      case "thread.started":
        this.sessionId ??= e.thread_id;
        break;
      case "item.completed":
        this.item(e.item ?? {});
        break;
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
        if (typeof it.message === "string") this.warnings.push(it.message);
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
}

export function runCodex(o: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const collector = new EventCollector();
  return new Promise((resolve) => {
    const child = spawn(config.bin, buildArgs(o), {
      cwd: o.cwd,
      env: process.env,
      // stdin must be closed, or codex waits on it ("Reading additional input from stdin...").
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const kill = () => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 3000).unref();
      }
    };
    const timer = o.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, o.timeoutMs)
      : undefined;
    o.signal?.addEventListener("abort", kill, { once: true });

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        collector.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });

    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      collector.push(buf);
      const errors = [...collector.errors];
      if (spawnError) errors.push(spawnError);
      if (timedOut) errors.push(`timed out after ${Math.round((o.timeoutMs ?? 0) / 1000)}s`);
      else if (o.signal?.aborted) errors.push("cancelled");
      if (exitCode && !errors.length) {
        const tail = stderr
          .split("\n")
          .filter((l) => l.trim() && !l.startsWith("Reading additional input"))
          .slice(-5)
          .join("\n");
        errors.push(tail || `exit code ${exitCode}`);
      }
      resolve({
        ok: exitCode === 0 && !errors.length,
        sessionId: collector.sessionId,
        text: collector.text,
        toolCalls: collector.toolCalls,
        fileChanges: collector.fileChanges,
        tokens: collector.tokens,
        turns: collector.turns,
        warnings: collector.warnings,
        error: errors.join("; ") || undefined,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
      });
    };
    child.on("error", (err) => finish(null, `failed to start '${config.bin}': ${err.message}`));
    child.on("close", (code) => finish(code));
  });
}
