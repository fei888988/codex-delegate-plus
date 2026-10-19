import type { StallPolicy } from "./watchdog.ts";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config, configuredModel, EFFORT_ORDER } from "./config.ts";
import { listModels, type ModelInfo } from "./models.ts";

/** One rung of the cost ladder the lead picks from: a model (unset = codex's default) at an effort. */
export interface Tier {
  id: string;
  provider?: string;
  model?: string;
  effort: string;
  /** When to pick this tier; shown to the lead in the tool description. */
  use: string;
}

/** User-editable delegation policy, kept in `config.policyFile` and edited from the dashboard. */
export interface Retention {
  cmdLogMaxMB: number;
  failedLogDays: number;
  runDays: number;
  totalMaxMB: number;
}

export interface Policy {
  sandboxWrites: boolean;
  retention: Retention;
  stall?: StallPolicy;
  /** Cost/quality guidance for the lead (Claude), added to the delegate tool description. */
  guidance: string;
  /** Appended to every brief Codex gets. */
  codexGuidance: string;
  /** Cheapest first. */
  tiers: Tier[];
  /** Models the lead may name or tiers may use; empty = any. */
  models: string[];
}

export const DEFAULT_POLICY: Policy = {
  sandboxWrites: false,
  retention: { cmdLogMaxMB: 5, failedLogDays: 3, runDays: 30, totalMaxMB: 1024 },
  stall: { long_commands: [{ match: "unittest discover|pytest|npm (run )?test|node --test", idle_s: 1800 }] },
  "guidance": "Cost policy: Codex usage is billed per token, and the higher tiers cost several times more. Pick the cheapest tier that will get this task right; quality is not negotiable, so cheap means fewer wasted tokens, not a sloppier result. Unsure between two tiers: take the cheaper one, unless the task is in the risky class named by the top tier, where a failed attempt costs more than the difference. Escalate on evidence: after a check FAIL or a wrong result, continue the same session_id one tier up. Keep briefs tight and pass only the checks that prove the change. Read-only reviews and questions: use high when the reviewed code touches live trading, money, concurrency or security; low for other reviews and for questions; medium when a non-risky review must judge cross-module design. Frontend design stays with you: page layout, visual style, CSS, component look and feel, and UI copy are yours to do, not Codex's (its design taste is weak); backend, data plumbing and tests behind a UI can still be delegated. Opinion and direction calls stay with you: when a question asks for judgement (which approach, architecture or direction to take, whether a plan, design or trade-off is right, what to prioritise or recommend), use Codex only to gather objective facts and data (what the code actually does, measurements, test or benchmark results, documented behaviour, counts and comparisons), and ask it for findings, not conclusions. Form the judgement and make the final decision yourself; never adopt Codex's opinion or recommendation as the answer. When Codex can't work: if a delegate call fails for an environment reason (quota or rate limit, auth, network, codex crash, a timeout or abort with no usable result; not the user pressing Stop), retry once only if the error looks transient. If it still fails, don't quietly take the delegated work over yourself. Estimate what is left that you meant to give Codex: if it is small (a few edits you can already see), finish it and say Codex was unavailable; if it is substantial, stop and ask the user, with the error and the remaining work, whether to wait or fix Codex and continue, have you do it yourself (give a rough size), or do something else.\nSandbox selection: Set sandbox on every delegation. Use read-only for investigations, code reviews and questions that need no writes. Use write for anything that edits files or runs builds and tests; the user's panel setting decides how write runs (by default with full access, so network, dependency installs and paths outside cwd work). Full access does not expand authorization: no deployment, live operations, or writes to production or shared data unless the user asked for them; name off-limits paths and systems in the brief. State known requirements in the brief (Python interpreter, dependencies, temp paths). If a result reports sandbox_denied, the panel sandbox is on: fix the path (prefer cwd or the default temp dir), pass add_dirs, or ask the user to turn the sandbox off; never repeat the same blocked attempt. A failure caused only by sandbox restrictions or missing environment dependencies does not justify raising the reasoning tier.",
  "codexGuidance": "Cost (added by the delegating tool): work economically. Search before opening whole files and read only what you need, prefer a targeted test over re-running the full suite on every step, and stop once the acceptance criteria are met. Never skip the verification needed to be sure the change is correct. Keep the diff minimal and targeted: change only what the task needs and never rewrite a whole file or module when a local edit works. In your final report, list every existing behaviour you removed, disabled, narrowed or simplified (deleted branches, narrowed conditions or time windows, dropped arguments, flags or recovery paths), or state that there were none.",
  "tiers": [
    {
      "id": "luna-xhigh",
      "model": "gpt-6-luna",
      "effort": "xhigh",
      "use": "Mechanical, fully specified tasks with no meaningful ambiguity or design decisions: renaming, version bumps, applying a provided patch, straightforward lint fixes, or simple factual lookups. The solution should be directly executable without investigating alternatives."
    },
    {
      "id": "low",
      "model": "gpt-6.1-sol",
      "effort": "low",
      "use": "Default tier for ordinary, non-risky work: features and bug fixes across a few files that follow the project's existing conventions, bugs whose cause can be found by reading or reproducing, moderate refactoring, writing or fixing tests, and routine judgement between obvious local approaches. Use medium only when real design choices are left open, or high when the task is in the risky class."
    },
    {
      "id": "medium",
      "model": "gpt-6.1-sol",
      "effort": "medium",
      "use": "Work that needs genuine design decisions without an existing pattern to follow: new structure spanning several modules, non-obvious tradeoffs, or many routine edge cases that interact, while still outside the risky class named by high. Also a low attempt that failed for lack of reasoning."
    },
    {
      "id": "high",
      "model": "gpt-6.1-sol",
      "effort": "high",
      "use": "Complex or high-risk tasks involving unclear root causes, cross-module architecture or design tradeoffs, concurrency, security, financial correctness, data migration, or many interacting edge cases. Requires deep investigation, careful validation, or substantial independent reasoning. Also a medium attempt that failed for lack of reasoning (not for external or environmental issues)."
    }
  ],
  "models": [
    "gpt-6.1-sol",
    "gpt-6-luna"
  ]
};

const TIER_ID = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const SLUG = /^[\w.-]{1,64}$/;
const MAX_TEXT = 4000;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);

/**
 * Checks a policy (missing keys fall back to the defaults). Each tier's effort must be one the model
 * supports according to codex's model cache; models missing from the cache are let through.
 */
export function validatePolicy(input: unknown, models: ModelInfo[] = listModels()): { ok: true; policy: Policy } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "policy must be a JSON object" };
  const raw = { ...DEFAULT_POLICY, ...(input as Record<string, unknown>) };
  if (typeof raw.sandboxWrites !== "boolean") return { ok: false, error: "sandboxWrites must be boolean" };
  if (!raw.retention || typeof raw.retention !== "object" || Array.isArray(raw.retention)) return { ok: false, error: "invalid retention policy" };
  const retention = { ...DEFAULT_POLICY.retention, ...raw.retention };
  if (Object.values(retention).some(v => typeof v !== "number" || !Number.isFinite(v) || v <= 0)) return { ok: false, error: "retention limits must be positive numbers" };
  const stall = raw.stall as StallPolicy | undefined;
  if (stall !== undefined && (!stall || typeof stall !== "object" || Array.isArray(stall)
    || [stall.silent_s, stall.command_s].some(v => v !== undefined && (!Number.isFinite(v) || v < 0))
    || (stall.long_commands !== undefined && (!Array.isArray(stall.long_commands) || stall.long_commands.some(r => !r || typeof r.match !== "string" || !Number.isFinite(r.idle_s) || r.idle_s < 0)))))
    return { ok: false, error: "invalid stall policy" };
  const guidance = str(raw.guidance);
  const codexGuidance = str(raw.codexGuidance);
  if (guidance === undefined || guidance.length > MAX_TEXT) return { ok: false, error: `guidance must be text of at most ${MAX_TEXT} characters` };
  if (codexGuidance === undefined || codexGuidance.length > MAX_TEXT) return { ok: false, error: `codexGuidance must be text of at most ${MAX_TEXT} characters` };

  if (!Array.isArray(raw.models) || raw.models.length > 32) return { ok: false, error: "models must be a list of at most 32 model slugs" };
  const allowed: string[] = [];
  for (const m of raw.models) {
    const slug = str(m);
    if (!slug || !SLUG.test(slug)) return { ok: false, error: `invalid model slug '${String(m)}'` };
    if (!allowed.includes(slug)) allowed.push(slug);
  }

  if (!Array.isArray(raw.tiers) || !raw.tiers.length || raw.tiers.length > 12) return { ok: false, error: "tiers must be a list of 1 to 12 tiers" };
  const tiers: Tier[] = [];
  for (const t of raw.tiers as any[]) {
    const id = str(t?.id)?.toLowerCase() ?? "";
    if (!TIER_ID.test(id)) return { ok: false, error: `tier id '${id}' must be 1-24 of a-z, 0-9, '-', '_'` };
    if (tiers.some((x) => x.id === id)) return { ok: false, error: `duplicate tier id '${id}'` };
    const provider = t.provider;
    if (provider !== undefined && (typeof provider !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(provider))) return { ok: false, error: `tier provider must be an id or system` };
    const model = str(t.model) || undefined;
    if (model && !SLUG.test(model)) return { ok: false, error: `tier '${id}': invalid model slug '${model}'` };
    const effort = str(t.effort)?.toLowerCase() ?? "";
    if (!EFFORT_ORDER.includes(effort)) return { ok: false, error: `tier '${id}': unknown effort '${effort}' (known: ${EFFORT_ORDER.join(", ")})` };
    const use = str(t.use) ?? "";
    if (!use || use.length > 500) return { ok: false, error: `tier '${id}': 'use' must be 1-500 characters` };
    const effective = model ?? config.defaultModel ?? configuredModel();
    if (model && allowed.length && !allowed.includes(model)) return { ok: false, error: `tier '${id}': model '${model}' is not in the allowed models` };
    const info = models.find((m) => m.slug === effective);
    if (info?.efforts.length && !info.efforts.includes(effort)) {
      return { ok: false, error: `tier '${id}': ${info.slug} does not support effort '${effort}' (supported: ${info.efforts.join(", ")})` };
    }
    tiers.push({ id, ...(provider ? { provider } : {}), ...(model ? { model } : {}), effort, use });
  }
  return { ok: true, policy: { sandboxWrites: raw.sandboxWrites, retention, guidance, codexGuidance, tiers, models: allowed, stall: { ...DEFAULT_POLICY.stall, ...stall } } };
}

/** Missing file → defaults. A broken file also falls back to the defaults, and says why. */
export function loadPolicy(file = config.policyFile): { policy: Policy; error?: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { policy: DEFAULT_POLICY };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { policy: DEFAULT_POLICY, error: `${file} is not valid JSON (${e instanceof Error ? e.message : e}); using the default policy` };
  }
  // The allowlist and efforts were checked when saved; the model cache may have changed since, so
  // don't reject a saved policy over it here.
  const r = validatePolicy(parsed, []);
  return r.ok ? { policy: r.policy } : { policy: DEFAULT_POLICY, error: `${file}: ${r.error}; using the default policy` };
}

export function savePolicy(policy: Policy, file = config.policyFile): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(policy, null, 2)}\n`);
  renameSync(tmp, file);
}

export const findTier = (policy: Policy, id: string | undefined) => (id ? policy.tiers.find((t) => t.id === id.toLowerCase()) : undefined);

/** "gpt-6-luna#max", or "(codex default: gpt-6.1-sol)#low" for a tier without a model. */
export function tierLabel(t: Tier): string {
  const dflt = config.defaultModel ?? configuredModel();
  return `${t.model ?? (dflt ? dflt : "codex default")}#${t.effort}`;
}
