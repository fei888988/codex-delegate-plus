import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config, configuredModel, EFFORT_ORDER } from "./config.ts";
import { listModels, type ModelInfo } from "./models.ts";

/** One rung of the cost ladder the lead picks from: a model (unset = codex's default) at an effort. */
export interface Tier {
  id: string;
  model?: string;
  effort: string;
  /** When to pick this tier; shown to the lead in the tool description. */
  use: string;
}

/** User-editable delegation policy, kept in `config.policyFile` and edited from the dashboard. */
export interface Policy {
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
  guidance:
    "Cost policy: Codex usage is billed per token, and the higher tiers cost several times more. Pick the cheapest tier that will get this task right; quality is not negotiable, so cheap means fewer wasted tokens, not a sloppier result. " +
    "Unsure between two tiers: take the cheaper one, unless the task is in the risky class named by the top tier, where a failed attempt costs more than the difference. " +
    "Escalate on evidence: after a check FAIL or a wrong result, continue the same session_id one tier up. Keep briefs tight and pass only the checks that prove the change. " +
    "Frontend design stays with you: page layout, visual style, CSS, component look and feel, and UI copy are yours to do, not Codex's (its design taste is weak); backend, data plumbing and tests behind a UI can still be delegated." +
    " When Codex can't work: if a delegate call fails for an environment reason (quota or rate limit, auth, network, codex crash, a timeout or abort with no usable result; not the user pressing Stop), retry once only if the error looks transient. If it still fails, don't quietly take the delegated work over yourself. Estimate what is left that you meant to give Codex: if it is small (a few edits you can already see), finish it and say Codex was unavailable; if it is substantial, stop and ask the user, with the error and the remaining work, whether to wait or fix Codex and continue, have you do it yourself (give a rough size), or do something else.",
  codexGuidance:
    "Cost (added by the delegating tool): work economically. Search before opening whole files and read only what you need, prefer a targeted test over re-running the full suite on every step, and stop once the acceptance criteria are met. Never skip the verification needed to be sure the change is correct.",
  tiers: [
    { id: "luna-xhigh", model: "gpt-6-luna", effort: "xhigh", use: "Mechanical, fully specified tasks with no meaningful ambiguity or design decisions: renaming, version bumps, applying a provided patch, straightforward lint fixes, or simple factual lookups. The solution should be directly executable without investigating alternatives." },
    { id: "low", model: "gpt-6.1-sol", effort: "low", use: "Straightforward, well-scoped tasks requiring minor judgment but no novel design: small changes following established patterns, simple bugs with identifiable causes, localized refactoring, or basic tests. Implementation choices should be obvious from existing code or conventions." },
    { id: "medium", model: "gpt-6.1-sol", effort: "medium", use: "Ordinary feature development or bug fixes requiring reasoning across a few related files, where the implementation is not fully specified. Limited autonomous design decisions are allowed for non-critical, low-risk functionality, including choosing between reasonable local approaches and handling routine edge cases." },
    { id: "high", model: "gpt-6.1-sol", effort: "high", use: "Complex or high-risk tasks involving unclear root causes, cross-module architecture or design tradeoffs, concurrency, security, financial correctness, data migration, or many interacting edge cases. Requires deep investigation, careful validation, or substantial independent reasoning. Also includes Level 3 tasks that failed due to insufficient reasoning rather than external or environmental issues." },
  ],
  models: ["gpt-6.1-sol", "gpt-6-luna"],
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
    tiers.push({ id, ...(model ? { model } : {}), effort, use });
  }
  return { ok: true, policy: { guidance, codexGuidance, tiers, models: allowed } };
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
