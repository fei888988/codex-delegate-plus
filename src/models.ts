import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

export interface ModelInfo {
  slug: string;
  efforts: string[];
}

/**
 * Codex has no `models` subcommand, but the CLI keeps the account's model list in
 * $CODEX_HOME/models_cache.json. Hidden entries (visibility "hide") are internal and skipped.
 */
export function listModels(path = join(config.codexHome, "models_cache.json")): ModelInfo[] {
  let data: any;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const models: any[] = Array.isArray(data?.models) ? data.models : [];
  return models
    .filter((m) => typeof m?.slug === "string" && (m.visibility ?? "list") === "list")
    .map((m) => ({
      slug: m.slug,
      efforts: (m.supported_reasoning_levels ?? []).map((l: any) => l?.effort).filter(Boolean),
    }));
}

// Words people naturally put around a model name ("use sol 6 in codex").
const STOPWORDS = new Set(["use", "using", "with", "from", "in", "on", "via", "the", "a", "model", "codex", "openai", "by"]);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/([a-z])(\d)/g, "$1 $2") // "gpt6" → "gpt 6", "sol6" → "sol 6"
    .replace(/[^a-z0-9.]+/g, " ")
    .split(" ")
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter((t) => t && !STOPWORDS.has(t));
}

const isVersion = (t: string) => /\d/.test(t);

/** First numeric token of a slug, for "newest family first" ordering (gpt-6-sol → 6, gpt-5.6-sol → 5.6). */
function version(slug: string): number {
  return Number.parseFloat(tokenize(slug).find(isVersion) ?? "0") || 0;
}

export type Resolution =
  | { ok: true; model: string; effort?: string; known: boolean }
  | { ok: false; reason: string; candidates: string[] };

/**
 * Resolves a loose model name ("sol 6", "gpt 6 sol", "5.6 terra", "sol") to a Codex model slug.
 * - `#effort` is split off: "sol 6#max" → gpt-6-sol with effort "max" (checked against the model's levels);
 * - every version token must be a whole token of the slug, so "sol 6" never becomes gpt-5.6-sol;
 * - tokens score 3 for an exact token match and 1 for a substring match, doubled for version tokens;
 * - ties prefer the slug with the fewest unmentioned tokens, then the newest version ("sol" → gpt-6-sol);
 *   anything still tied is ambiguous ("gpt 6" → astra/sol/luna);
 * - a slug-shaped name that matches nothing passes through unchanged, so models newer than the cache still work.
 */
export function resolveModel(query: string, models: ModelInfo[]): Resolution {
  const [base = "", effortRaw] = query.trim().split("#", 2);
  const effort = effortRaw?.trim().toLowerCase() || undefined;

  const withEffort = (m: ModelInfo | undefined, slug: string): Resolution => {
    if (effort && m?.efforts.length && !m.efforts.includes(effort)) {
      return { ok: false, reason: `${slug} does not support effort '${effort}' (supported: ${m.efforts.join(", ")})`, candidates: [] };
    }
    return { ok: true, model: slug, effort, known: !!m };
  };

  const exact = models.find((m) => m.slug.toLowerCase() === base.trim().toLowerCase());
  if (exact) return withEffort(exact, exact.slug);

  const tokens = tokenize(base);
  if (!tokens.length) return { ok: false, reason: `empty model name '${query}'`, candidates: [] };

  type Scored = { m: ModelInfo; score: number; extras: number; version: number };
  const scored = models
    .map((m): Scored | undefined => {
      const slugTokens = tokenize(m.slug);
      const set = new Set(slugTokens);
      if (!tokens.filter(isVersion).every((t) => set.has(t))) return undefined;
      let score = 0;
      for (const t of tokens) {
        const hit = set.has(t) ? 3 : m.slug.toLowerCase().includes(t) ? 1 : 0;
        score += isVersion(t) ? hit * 2 : hit;
      }
      // Name words must hit too, so a bare version match ("5.6 astra" vs gpt-5.6-sol) doesn't count.
      if (tokens.some((t) => !isVersion(t)) && !tokens.some((t) => !isVersion(t) && m.slug.toLowerCase().includes(t))) return undefined;
      if (!score) return undefined;
      return { m, score, extras: slugTokens.filter((n) => !tokens.includes(n)).length, version: version(m.slug) };
    })
    .filter((x): x is Scored => !!x)
    .sort((a, b) => b.score - a.score || a.extras - b.extras || b.version - a.version || a.m.slug.localeCompare(b.m.slug));

  const best = scored[0];
  if (!best) {
    // Slug-shaped names ("gpt-7-nova") may be newer than the cache; loose phrases are just misses.
    if (/^[\w.-]+$/.test(base.trim())) return withEffort(undefined, base.trim());
    return { ok: false, reason: `no codex model matches '${query}'`, candidates: [] };
  }
  const tied = scored.filter((s) => s.score === best.score && s.extras === best.extras && s.version === best.version);
  if (tied.length > 1) return { ok: false, reason: `'${query}' is ambiguous`, candidates: tied.map((t) => t.m.slug) };
  return withEffort(best.m, best.m.slug);
}

export function resolveModelOrThrow(query: string): { model: string; effort?: string; known: boolean } {
  const r = resolveModel(query, listModels());
  if (r.ok) return r;
  throw new Error(`${r.reason}.${r.candidates.length ? ` Did you mean one of: ${r.candidates.join(", ")}?` : ""} Use list_models to see all models.`);
}
