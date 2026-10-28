import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DEFAULT_POLICY, findTier, loadPolicy, savePolicy, validatePolicy } from "../src/policy.ts";

const dir = mkdtempSync(join(tmpdir(), "cd-policy-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const models = [
  { slug: "gpt-6.1-sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-6-luna", efforts: ["low", "medium", "high", "xhigh", "max"] },
];
const tiers = (...t: object[]) => ({ ...DEFAULT_POLICY, tiers: t });
const err = (p: unknown) => {
  const r = validatePolicy(p, models);
  return r.ok ? "ok" : r.error;
};

test("the default policy matches the saved policy template", () => {
  assert.equal(err(DEFAULT_POLICY), "ok");
  assert.deepEqual(DEFAULT_POLICY.tiers.map((t) => t.id), ["light", "scout", "routine", "ops", "low", "medium", "high", "deep"]);
  assert.deepEqual(findTier(DEFAULT_POLICY, "LIGHT"), { id: "light", model: "gpt-6-luna", effort: "xhigh", use: DEFAULT_POLICY.tiers[0]!.use });
  assert.equal(findTier(DEFAULT_POLICY, "xhigh"), undefined);
});

test("validation: missing keys fall back to defaults, bad tiers are rejected with a reason", () => {
  const r = validatePolicy({ guidance: "  be cheap  " }, models);
  assert(r.ok);
  assert.equal(r.policy.guidance, "be cheap");
  assert.deepEqual(r.policy.tiers, DEFAULT_POLICY.tiers);
  assert.match(err(tiers({ id: "x", model: "gpt-6-luna", effort: "ultra", use: "u" })), /gpt-6-luna does not support effort 'ultra'/);
  assert.match(err(tiers({ id: "a", effort: "low", use: "u" }, { id: "A", effort: "high", use: "u" })), /duplicate tier id 'a'/);
  assert.match(err(tiers({ id: "a", effort: "turbo", use: "u" })), /unknown effort 'turbo'/);
  assert.match(err(tiers({ id: "a b", effort: "low", use: "u" })), /tier id/);
  assert.match(err(tiers({ id: "a", effort: "low", use: "" })), /'use'/);
  assert.match(err(tiers()), /1 to 12 tiers/);
  assert.match(err({ ...DEFAULT_POLICY, models: ["gpt-6.1-sol"] }), /tier 'light': model 'gpt-6-luna' is not in the allowed models/);
  assert.equal(err({ ...DEFAULT_POLICY, models: ["gpt-6.1-sol", "gpt-6-luna", "gpt-6.1-terra", "gpt-6-luna"] }), "ok");
  assert.equal(err({ ...tiers({ id: "new", model: "gpt-7-nova", effort: "high", use: "u" }), models: [] }), "ok", "models newer than the cache pass");
  assert.match(err([]), /JSON object/);
});

test("save/load round trip; a broken file falls back to the defaults with a reason", () => {
  const file = join(dir, "sub", "policy.json");
  assert.deepEqual(loadPolicy(file), { policy: DEFAULT_POLICY }, "missing file → defaults, no error");
  const r = validatePolicy({ guidance: "g", tiers: [{ id: "only", effort: "medium", use: "everything" }] }, models);
  assert(r.ok);
  savePolicy(r.policy, file);
  assert.deepEqual(loadPolicy(file).policy, r.policy);
  writeFileSync(file, "{ nope");
  const broken = loadPolicy(file);
  assert.equal(broken.policy, DEFAULT_POLICY);
  assert.match(broken.error!, /not valid JSON/);
});

test("patrol policy defaults, validation, custom tiers and unknown user fields survive", () => {
  const file = join(dir, "patrol-policy.json");
  const r = validatePolicy({ patrol: { tier: "low", every_s: 1200 }, customUserKey: { keep: true } }, models);
  assert(r.ok); assert.equal(r.policy.patrol!.timeout_s, 300);
  savePolicy(r.policy, file);
  assert.deepEqual((loadPolicy(file).policy as any).customUserKey, { keep: true });
  assert.equal(loadPolicy(file).policy.patrol!.tier, "low");
  assert.match(err({ patrol: { every_s: 599 } }), /invalid patrol/);
  assert.match(err({ patrol: { timeout_s: 0 } }), /invalid patrol/);
  assert.match(err({ patrol: { tier: "missing" } }), /unknown patrol tier/);
});
