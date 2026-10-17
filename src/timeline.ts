import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { config } from "./config.ts";
import type { RunSummary } from "./run-summary.ts";

export interface TimelineEntry {
  seq: number;
  ts: string | null;
  kind: "user" | "assistant" | "reasoning" | "command" | "tool" | "tool_output" | "file_change" | "tokens" | "error" | "system";
  title: string;
  text: string;
  status?: string;
  exitCode?: number | null;
  durationMs?: number;
  callId?: string;
}
export interface Timeline {
  runId: string;
  sessionId: string | null;
  source: "rollout" | "events";
  entries: TimelineEntry[];
  nextSeq: number;
  done: boolean;
}

function fullText(value: any): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((c) => typeof c === "string" ? c : c?.text ?? c?.content ?? JSON.stringify(c)).join("\n");
  return value == null ? "" : JSON.stringify(value, null, 2);
}

function cappedText(text: string): string {
  if (text.length <= 20000) return text;
  let keep = 20000;
  for (;;) {
    const marker = `…[truncated ${text.length - keep} chars]`;
    if (keep + marker.length <= 20000) return text.slice(0, keep) + marker;
    keep = 20000 - marker.length;
  }
}

export class TimelineParser {
  private calls = new Map<string, number>();
  parse(line: string, seq: number, source: Timeline["source"]): TimelineEntry | undefined {
    let e: any;
    try { e = JSON.parse(line); } catch { return undefined; }
    if (!e || typeof e !== "object") return undefined;
    const ts = source === "rollout" && typeof e.timestamp === "string" ? e.timestamp : null;
    let p = source === "rollout" ? e.payload ?? {} : e.item ?? e;
    const type = p.type ?? e.type;
    let kind: TimelineEntry["kind"] = "system";
    let title: string = type ?? "event";
    let text = "";
    let command: string | undefined;
    if (type === "message") {
      if (p.role === "developer" || p.role === "system") text = title = `${p.role} instructions`;
      else { kind = p.role === "user" ? "user" : "assistant"; text = fullText(p.content); title = text; }
    } else if (type === "user_message" || type === "agent_message" || type === "agent_reasoning" || type === "reasoning") {
      kind = type === "user_message" ? "user" : type === "agent_message" ? "assistant" : "reasoning";
      text = fullText(p.text ?? p.message ?? p.summary ?? p.content);
      title = text || kind;
    } else if (type === "function_call" || type === "custom_tool_call") {
      kind = /(?:exec|shell|command)/i.test(p.name ?? "") ? "command" : /apply_patch/.test(p.name ?? "") ? "file_change" : "tool";
      text = fullText(p.arguments ?? p.input);
      try { const a = JSON.parse(text); command = fullText(a.cmd ?? a.command); } catch {}
      // Code-mode `exec` calls wrap the shell command in JS: tools.exec_command({cmd:"..."}).
      const m = command ? undefined : /\bcmd\s*:\s*("(?:[^"\\]|\\.)*")/.exec(text);
      if (m) try { command = JSON.parse(m[1]!); } catch {}
      title = command || p.name || "tool";
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      kind = "tool_output"; text = fullText(p.output); title = text || "tool output";
      const code = /"exit_code"\s*:\s*(-?\d+|null)/.exec(text);
      if (code) p = { ...p, exit_code: code[1] === "null" ? null : Number(code[1]) };
    } else if (type === "command_execution" || type === "exec_command_begin" || type === "exec_command_end") {
      kind = "command"; title = fullText(p.command) || type;
      text = [fullText(p.command), fullText(p.aggregated_output ?? p.output ?? p.stdout)].filter(Boolean).join("\n");
    } else if (type === "file_change" || type === "patch_apply_end" || type === "patch_apply_begin") {
      kind = "file_change"; text = fullText(p.changes ?? p); title = "file changes";
    } else if (type === "mcp_tool_call" || type === "web_search") {
      kind = "tool"; title = type === "mcp_tool_call" ? `${p.server ?? "mcp"}/${p.tool ?? "tool"}` : "web search";
      text = fullText(p.arguments ?? p.query ?? p.result ?? p);
    } else if (type === "token_count" || e.type === "token_usage_record" || e.type === "turn.completed") {
      kind = "tokens"; title = "token usage"; text = fullText(p.info?.total_token_usage ?? p.thread_token_usage ?? p.usage ?? p);
    } else if (type === "error" || e.type === "turn.failed") {
      kind = "error"; text = fullText(p.message ?? p.error ?? p); title = text;
    } else {
      // Preserve prompt/context markers without echoing megabytes of injected instructions.
      title = e.type === "response_item" || e.type === "event_msg" ? type : e.type;
      text = title ?? "system event";
    }
    const entry: TimelineEntry = { seq, ts, kind, title: (title ?? kind).replace(/\s+/g, " ").slice(0, 200),
      text: cappedText(text) };
    if (typeof p.status === "string") entry.status = p.status;
    else if (source === "events" && /^item\./.test(e.type)) entry.status = e.type.slice(5);
    if (typeof p.exit_code === "number" || p.exit_code === null) entry.exitCode = p.exit_code;
    if (typeof p.duration_ms === "number") entry.durationMs = p.duration_ms;
    else if (p.duration && typeof p.duration.secs === "number") entry.durationMs = p.duration.secs * 1000 + (p.duration.nanos ?? 0) / 1e6;
    const callId = p.call_id ?? (source === "events" ? p.id : undefined);
    if (typeof callId === "string") {
      entry.callId = callId;
      const time = ts ? Date.parse(ts) : NaN;
      if (type === "function_call" || type === "custom_tool_call" || type === "exec_command_begin" || e.type === "item.started") {
        if (Number.isFinite(time)) this.calls.set(callId, time);
      } else if (kind === "tool_output" || type === "exec_command_end" || e.type === "item.completed") {
        const start = this.calls.get(callId);
        if (start !== undefined && Number.isFinite(time)) entry.durationMs = Math.max(0, time - start);
        this.calls.delete(callId);
      }
    }
    return entry;
  }
}

/** Sequence numbers are physical line numbers, stable across incremental requests and malformed tails. */
export function parseTimeline(content: string, source: Timeline["source"], after = 0): TimelineEntry[] {
  const parser = new TimelineParser();
  const entries: TimelineEntry[] = [];
  for (const [i, line] of content.split(/\r?\n/).entries()) {
    const entry = parser.parse(line, i + 1, source);
    if (entry && entry.seq > after) entries.push(entry);
    if (entries.length === 500) break;
  }
  return entries;
}

const paths = new Map<string, string>();
async function rolloutPath(run: RunSummary, home: string): Promise<string | undefined> {
  if (!run.sessionId || !/^[\w-]+$/.test(run.sessionId)) return undefined;
  const key = `${home}:${run.id}:${run.sessionId}`;
  if (paths.has(key)) return paths.get(key);
  for (const offset of [0, 86400000]) {
    const date = new Date(run.startedAt + offset).toISOString().slice(0, 10).split("-");
    const dir = join(home, "sessions", ...date);
    try {
      const file = (await readdir(dir)).find((name) => name.startsWith("rollout-") && name.endsWith(`-${run.sessionId}.jsonl`));
      if (file) {
        const path = join(dir, file);
        if (paths.size >= 1000) paths.delete(paths.keys().next().value!);
        paths.set(key, path);
        return path;
      }
    } catch {}
  }
  return undefined;
}

export async function readTimeline(runsDir: string, run: RunSummary, after = 0, home = config.codexHome): Promise<Timeline> {
  const rollout = await rolloutPath(run, home);
  const source = rollout ? "rollout" : "events";
  const parser = new TimelineParser();
  const entries: TimelineEntry[] = [];
  const stream = createReadStream(rollout ?? join(runsDir, run.id, "events.jsonl"), { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let seq = 0;
  // A session's rollout also holds the turns of earlier and later runs that resumed it; keep this run's window.
  const from = run.startedAt - 5000, to = run.state === "running" || !run.endedAt ? Infinity : run.endedAt + 5000;
  const inWindow = (e: TimelineEntry) => source !== "rollout" || !e.ts || ((t) => !(t < from || t > to))(Date.parse(e.ts));
  try {
    for await (const line of lines) {
      const entry = parser.parse(line, ++seq, source);
      if (entry && entry.seq > after && inWindow(entry)) entries.push(entry);
      if (entries.length === 500) break;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally { lines.close(); stream.destroy(); }
  return { runId: run.id, sessionId: run.sessionId ?? null, source, entries,
    nextSeq: entries.at(-1)?.seq ?? after, done: run.state !== "running" };
}
