import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// GUI apps like Claude Desktop often don't inherit the shell PATH, so also check common install dirs.
const FALLBACK_DIRS = [
  join(homedir(), ".bun", "bin"),
  join(homedir(), ".local", "bin"),
  join(homedir(), ".npm-global", "bin"),
  join(homedir(), ".cargo", "bin"),
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/usr/bin",
];

export function resolveBin(env = process.env): string {
  if (env.CODEX_BIN) return env.CODEX_BIN;
  const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), ...FALLBACK_DIRS];
  for (const dir of dirs) {
    const candidate = join(dir, "codex");
    if (existsSync(candidate)) return candidate;
  }
  return "codex";
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

export const config = {
  bin: resolveBin(),
  codexHome,
  defaultModel,
  // Used when no model is given and the run is read-only (auto: false): reading, reviews, questions.
  readModel: model(process.env.CODEX_DELEGATE_READ_MODEL, defaultModel),
  // Unset → inherit model_reasoning_effort from ~/.codex/config.toml.
  effort: process.env.CODEX_DELEGATE_EFFORT?.trim() || undefined,
  // Unset → inherit service_tier from config.toml. true = "priority" (Fast), false = "default".
  fast: optionalBool(process.env.CODEX_DELEGATE_FAST),
  sandbox: sandbox(process.env.CODEX_DELEGATE_SANDBOX),
  auto: bool(process.env.CODEX_DELEGATE_AUTO, true),
  timeoutSec: int(process.env.CODEX_DELEGATE_TIMEOUT, 1800),
  maxOutputChars: int(process.env.CODEX_DELEGATE_MAX_OUTPUT, 40000),
  defaultCwd: process.env.CODEX_DELEGATE_CWD || process.cwd(),
};
