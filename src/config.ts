import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// GUI apps like Claude Desktop often don't inherit the shell PATH, so also check common install dirs.
function fallbackDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const home = homedir();
  if (platform === "win32") {
    return [env.APPDATA ? join(env.APPDATA, "npm") : "", join(home, ".bun", "bin"), join(home, ".cargo", "bin")].filter(Boolean);
  }
  return [
    join(home, ".bun", "bin"),
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".cargo", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
  ];
}

/** How to start codex: `cmd` plus any args that must come before codex's own (e.g. the codex.js entry). */
export interface CodexCommand {
  cmd: string;
  args: string[];
}

/**
 * On Windows `codex` on PATH is an npm `.cmd`/PowerShell shim. Spawning a `.cmd` needs a shell, which
 * re-parses quotes, `%` and newlines in our arguments. Instead run the shim's target, codex.js, with
 * this Node binary: no shell, and codex.js still sets up its env and spawns the native codex.exe.
 */
export function resolveCodex(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): CodexCommand {
  const viaNode = (js: string): CodexCommand => ({ cmd: process.execPath, args: [js] });
  if (env.CODEX_BIN) return /\.[cm]?js$/i.test(env.CODEX_BIN) ? viaNode(env.CODEX_BIN) : { cmd: env.CODEX_BIN, args: [] };
  const path = env.PATH ?? env.Path ?? "";
  const dirs = [...path.split(platform === "win32" ? ";" : delimiter).filter(Boolean), ...fallbackDirs(env, platform)];
  for (const dir of dirs) {
    if (platform === "win32") {
      const js = join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (existsSync(js)) return viaNode(js);
      const exe = join(dir, "codex.exe");
      if (existsSync(exe)) return { cmd: exe, args: [] };
    } else {
      const candidate = join(dir, "codex");
      if (existsSync(candidate)) return { cmd: candidate, args: [] };
    }
  }
  return { cmd: platform === "win32" ? "codex.exe" : "codex", args: [] };
}

/** Unset → fallback; set to "" → undefined (use codex's own config default). */
function model(v: string | undefined, fallback: string | undefined): string | undefined {
  if (v === undefined) return fallback;
  return v.trim() || undefined;
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === "") return dflt;
  return !/^(0|false|no|off)$/i.test(v);
}

function int(v: string | undefined, dflt: number): number {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

export const SANDBOXES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type Sandbox = (typeof SANDBOXES)[number];

function sandbox(v: string | undefined): Sandbox {
  return (SANDBOXES as readonly string[]).includes(v ?? "") ? (v as Sandbox) : "workspace-write";
}

function optionalBool(v: string | undefined): boolean | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  return bool(v, false);
}

const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");

/** Top-level `model = "…"` in config.toml (before the first [table]); only used for display. */
export function configuredModel(path = join(codexHome, "config.toml")): string | undefined {
  try {
    const top = readFileSync(path, "utf8").split(/^\s*\[/m)[0] ?? "";
    return top.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1];
  } catch {
    return undefined;
  }
}

// Unset → no -m flag, so codex uses the model from ~/.codex/config.toml.
const defaultModel = model(process.env.CODEX_DELEGATE_DEFAULT_MODEL, undefined);
// CODEX_DELEGATE_EFFORT applies to every run. Without it, delegated work gets its own defaults rather
// than the (often low) interactive default in config.toml; set either variable to "" to inherit that.
const effortAll = process.env.CODEX_DELEGATE_EFFORT;

/** Reasoning efforts from cheapest to most expensive (not every model supports every level). */
export const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** Comma-separated list; unset → low, medium, high; "" or "any" → no restriction. */
export function allowedEfforts(v: string | undefined): string[] | undefined {
  if (v === undefined) return ["low", "medium", "high"];
  const list = v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length || list.includes("any")) return undefined;
  return EFFORT_ORDER.filter((e) => list.includes(e));
}

/**
 * Fit an effort into the allowed range: above it → the highest allowed level, below it → the lowest.
 * Unknown names are left alone (codex rejects them with a clear message).
 */
export function clampEffort(effort: string | undefined, allowed: string[] | undefined): string | undefined {
  if (!effort || !allowed?.length || allowed.includes(effort)) return effort;
  const rank = EFFORT_ORDER.indexOf(effort);
  if (rank < 0) return effort;
  const ranks = allowed.map((e) => EFFORT_ORDER.indexOf(e));
  return rank > Math.max(...ranks) ? allowed.at(-1) : allowed[0];
}

export const config = {
  codex: resolveCodex(),
  // Levels the lead may choose from; anything else is clamped into this range.
  efforts: allowedEfforts(process.env.CODEX_DELEGATE_EFFORTS),
  codexHome,
  defaultModel,
  // Used when no model is given and the run is read-only (auto: false): reading, reviews, questions.
  readModel: model(process.env.CODEX_DELEGATE_READ_MODEL, defaultModel),
  writeEffort: model(effortAll ?? process.env.CODEX_DELEGATE_WRITE_EFFORT, "high"),
  readEffort: model(effortAll ?? process.env.CODEX_DELEGATE_READ_EFFORT, "medium"),
  // Unset → inherit service_tier from config.toml. true = "priority" (Fast), false = "default".
  fast: optionalBool(process.env.CODEX_DELEGATE_FAST),
  sandbox: sandbox(process.env.CODEX_DELEGATE_SANDBOX),
  auto: bool(process.env.CODEX_DELEGATE_AUTO, true),
  // Ask codex for a JSON report (status/summary/verification/questions) on runs that may edit files.
  structured: bool(process.env.CODEX_DELEGATE_STRUCTURED, true),
  // Append the working agreement (investigate yourself, verify, ask instead of guessing) to every brief.
  contract: bool(process.env.CODEX_DELEGATE_CONTRACT, true),
  timeoutSec: int(process.env.CODEX_DELEGATE_TIMEOUT, 1800),
  checkTimeoutSec: int(process.env.CODEX_DELEGATE_CHECK_TIMEOUT, 600),
  // What goes back into the caller's context. The full event log stays on disk.
  maxOutputChars: int(process.env.CODEX_DELEGATE_MAX_OUTPUT, 6000),
  runsDir: process.env.CODEX_DELEGATE_RUNS_DIR || join(homedir(), ".codex-delegate", "runs"),
  // Cost tiers and guidance prompts, edited from the dashboard (see policy.ts).
  policyFile: process.env.CODEX_DELEGATE_POLICY || join(homedir(), ".codex-delegate", "policy.json"),
  defaultCwd: process.env.CODEX_DELEGATE_CWD || process.cwd(),
};
