import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "./config.ts";

export interface SessionInfo {
  id: string;
  cwd: string;
  timestamp: string;
  prompt?: string;
  file: string;
}

// Rollouts can be many MB; session_meta and the first prompt sit near the top.
const HEAD_BYTES = 512 * 1024;

function readHead(file: string): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** First user message that isn't injected context (AGENTS.md, <environment_context>, …). */
function firstPrompt(lines: string[]): string | undefined {
  for (const line of lines) {
    if (!line.includes('"role":"user"')) continue;
    try {
      const p = JSON.parse(line).payload;
      if (p?.type !== "message" || p.role !== "user") continue;
      const text = (p.content ?? []).map((c: any) => c?.text ?? "").join(" ").trim();
      if (text && !text.startsWith("#") && !text.startsWith("<")) return text;
    } catch {}
  }
  return undefined;
}

export function parseRollout(head: string, file: string): SessionInfo | undefined {
  const lines = head.split("\n");
  try {
    const first = JSON.parse(lines[0] ?? "");
    if (first.type !== "session_meta") return undefined;
    const p = first.payload ?? {};
    return { id: p.id, cwd: p.cwd, timestamp: p.timestamp, prompt: firstPrompt(lines.slice(1)), file };
  } catch {
    return undefined;
  }
}

/** Rollout files, newest first (dirs are YYYY/MM/DD, names start with an ISO timestamp). */
function* rollouts(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort().reverse();
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (e.startsWith("rollout-") && e.endsWith(".jsonl")) yield p;
    else if (statSync(p).isDirectory()) yield* rollouts(p);
  }
}

export function listSessions(cwd: string, limit: number, root = join(config.codexHome, "sessions")): SessionInfo[] {
  const want = resolve(cwd);
  const out: SessionInfo[] = [];
  for (const file of rollouts(root)) {
    const s = parseRollout(readHead(file), file);
    if (s && resolve(s.cwd ?? "") === want) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}
