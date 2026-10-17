import type { CheckResult } from "./checks.ts";
import type { RunResult } from "./codex.ts";
import type { Sandbox } from "./config.ts";
import type { FileStat } from "./git.ts";
import type { Report } from "./report.ts";
import pkg from "../package.json" with { type: "json" };

export const version = pkg.version;

export interface RunSummary {
  id: string;
  startedAt: number;
  endedAt?: number;
  state: "running" | "ok" | "error" | "interrupted";
  title?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  /** Policy tier the model/effort came from. */
  tier?: string;
  fast?: boolean;
  sandbox?: Sandbox;
  resumed?: boolean;
  sessionId?: string;
  continuedFrom?: string;
  prompt?: string;
  durationMs?: number;
  tokens?: RunResult["tokens"];
  turns?: number;
  reportStatus?: Report["status"];
  summary?: string;
  report?: Report;
  changes?: FileStat[];
  checks?: Omit<CheckResult, "tail">[];
  notes?: string[];
  error?: string;
  toolCalls?: number;
  version?: string;
}
