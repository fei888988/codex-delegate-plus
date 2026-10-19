import type { CommandTiming, Denials, TrendPoint } from "./observability.ts";
import type { StallPolicy } from "./watchdog.ts";
import type { Suspicion } from "./codex.ts";
import type { CheckResult } from "./checks.ts";
import type { RunResult } from "./codex.ts";
import type { Sandbox } from "./config.ts";
import type { FileStat } from "./git.ts";
import type { Report } from "./report.ts";
import pkg from "../package.json" with { type: "json" };

export const version = pkg.version;

export interface RunSummary {
  inputs?: import("./inbox.ts").InputMessage[];
  provider?: string;
  commands?: CommandTiming[];
  denials?: Denials;
  trend?: TrendPoint[];
  cmdLogTails?: Record<string, string>;
  lastEvidence?: import("./watchdog.ts").CpuEvidence;
  lastInflight?: { command?: string; startedAt: number };
  id: string;
  startedAt: number;
  endedAt?: number;
  state: "running" | "ok" | "error" | "interrupted" | "user_interrupted";
  phase?: "codex" | "checks" | "done";
  engine?: import("./config.ts").Engine;
  /** App-server: the active turn, and lead messages steered into it. */
  turnId?: string;
  steers?: { at: number; text: string; consumedAt?: number; redirect?: boolean }[];
  /** Long commands kept running across a redirect and their outcome. */
  kept?: import("./longruns.ts").KeptCommand[];
  /** Stage reports codex wrote (checkpoint-<n>.md in the run directory). */
  checkpoints?: { n: number; at: number; title: string }[];
  pid?: number;
  codexPid?: number;
  lastEventAt?: number;
  inflight?: { type: string; command?: string; startedAt: number };
  heartbeatAt?: number;
  exitKind?: RunResult["exitKind"];
  errorKind?: RunResult["errorKind"];
  stall?: RunResult["stall"];
  checksStartedAt?: number;
  suspicion?: Suspicion;
  stallWindowSince?: number;
  effectiveThresholdSec?: number;
  matchedRule?: string;
  stallPolicy?: StallPolicy;
  idleTimeoutSec?: number;
  commandIdleTimeoutSec?: number;
  checkIdleTimeoutSec?: number;
  health?: "ok" | "active" | "quiet" | "stalled" | "orphaned";
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
  checks?: (Partial<Omit<CheckResult, "tail">> & { command: string; startedAt: number; lastOutputAt?: number; state?: "running" | "done" })[];
  notes?: string[];
  error?: string;
  toolCalls?: number;
  version?: string;
}
