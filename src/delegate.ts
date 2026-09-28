import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { config, type Sandbox } from "./config.ts";
import { runCodex, type RunResult } from "./codex.ts";
import { resolveModelOrThrow } from "./models.ts";

export interface DelegateInput {
  prompt: string;
  model?: string;
  effort?: string;
  cwd?: string;
  images?: string[];
  session_id?: string;
  fork?: boolean;
  sandbox?: Sandbox;
  auto?: boolean;
  title?: string;
  timeout_s?: number;
}

export interface DelegateOutcome {
  model?: string;
  effort?: string;
  sandbox: Sandbox;
  resumed: boolean;
  cwd: string;
  notes: string[];
  result: RunResult;
  changedFiles?: string[];
}

function gitStatus(cwd: string): Set<string> | undefined {
  const r = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return undefined;
  return new Set(r.stdout.split("\n").filter(Boolean));
}

export async function delegate(input: DelegateInput, signal?: AbortSignal): Promise<DelegateOutcome> {
  const cwd = resolve(config.defaultCwd, input.cwd ?? ".");
  if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  const auto = input.auto ?? config.auto;
  const sandbox: Sandbox = input.sandbox ?? (auto ? config.sandbox : "read-only");
  const notes: string[] = [];

  // A follow-up keeps the session's model unless one is asked for explicitly.
  const query = input.model ?? (input.session_id ? undefined : auto ? config.defaultModel : config.readModel);
  let model: string | undefined;
  let effort = input.effort ?? config.effort;
  if (query) {
    const r = resolveModelOrThrow(query);
    model = r.model;
    if (r.effort && !input.effort) effort = r.effort;
    if (!r.known) notes.push(`'${r.model}' is not in codex's model cache; passed through as-is`);
  }
  const images = input.images?.map((f) => (isAbsolute(f) ? f : resolve(cwd, f)));

  const before = gitStatus(cwd);
  const result = await runCodex({
    prompt: input.prompt,
    model,
    effort,
    cwd,
    images,
    sessionId: input.session_id,
    fork: input.fork,
    sandbox,
    timeoutMs: (input.timeout_s ?? config.timeoutSec) * 1000,
    signal,
  });
  const after = before && gitStatus(cwd);
  const changedFiles = after ? [...after].filter((l) => !before!.has(l)) : undefined;
  return { model, effort, sandbox, resumed: !!input.session_id, cwd, notes, result, changedFiles };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n…[truncated ${s.length - max} chars — continue the session to ask for the rest]`;
}

export function formatOutcome(o: DelegateOutcome): string {
  const r = o.result;
  const lines = [
    `status: ${r.ok ? "ok" : "error"}`,
    `model: ${o.model ?? (o.resumed ? "(same as session)" : "(codex default)")}${o.effort ? `, effort: ${o.effort}` : ""}, sandbox: ${o.sandbox}`,
    `session_id: ${r.sessionId ?? "(none)"}`,
    `cwd: ${o.cwd}`,
    `duration: ${(r.durationMs / 1000).toFixed(1)}s, turns: ${r.turns}, tokens in/cached/out: ${r.tokens.input}/${r.tokens.cachedInput}/${r.tokens.output}`,
  ];
  for (const n of [...o.notes, ...r.warnings]) lines.push(`note: ${n}`);
  if (r.error) lines.push(`error: ${r.error}`);
  if (r.toolCalls.length) {
    const counts = new Map<string, number>();
    for (const t of r.toolCalls) counts.set(t.tool, (counts.get(t.tool) ?? 0) + 1);
    lines.push(`tools used: ${[...counts].map(([k, v]) => `${k}×${v}`).join(", ")}`);
  }
  if (r.fileChanges.length) {
    const seen = new Map<string, string>();
    for (const c of r.fileChanges) seen.set(relative(o.cwd, c.path) || c.path, c.kind);
    lines.push(`files edited by codex:\n${[...seen].map(([p, k]) => `  ${k.padEnd(6)} ${p}`).join("\n")}`);
  }
  if (o.changedFiles) {
    lines.push(o.changedFiles.length ? `git changes:\n${o.changedFiles.map((f) => `  ${f}`).join("\n")}` : "git changes: none");
  }
  lines.push("", "--- response ---", truncate(r.text || "(no text output)", config.maxOutputChars));
  return lines.join("\n");
}
