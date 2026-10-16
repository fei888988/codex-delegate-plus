import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { listModels, resolveModel, type ModelInfo } from "../src/models.ts";

const all = ["low", "medium", "high", "xhigh", "max", "ultra"];
const noUltra = all.slice(0, 5);
const MODELS: ModelInfo[] = [
  { slug: "gpt-6-astra", efforts: all },
  { slug: "gpt-6-sol", efforts: all },
  { slug: "gpt-6-luna", efforts: noUltra },
  { slug: "gpt-5.6-sol", efforts: all },
  { slug: "gpt-5.6-terra", efforts: all },
  { slug: "gpt-5.6-luna", efforts: noUltra },
  { slug: "gpt-5.5", efforts: ["low", "medium", "high", "xhigh"] },
];

const pick = (q: string) => {
  const r = resolveModel(q, MODELS);
  if (!r.ok) return `ERR:${r.reason}|${r.candidates.join(",")}`;
  return `${r.model}${r.effort ? `#${r.effort}` : ""}${r.known ? "" : " (unknown)"}`;
};

describe("resolveModel", () => {
  test("exact slugs", () => {
    assert.equal(pick("gpt-6-sol"), "gpt-6-sol");
    assert.equal(pick("GPT-5.6-Terra"), "gpt-5.6-terra");
  });
  test("loose names", () => {
    assert.equal(pick("sol 6"), "gpt-6-sol");
    assert.equal(pick("Sol6"), "gpt-6-sol");
    assert.equal(pick("gpt 6 sol"), "gpt-6-sol");
    assert.equal(pick("use sol 6 in codex"), "gpt-6-sol");
    assert.equal(pick("5.6 sol"), "gpt-5.6-sol");
    assert.equal(pick("terra"), "gpt-5.6-terra");
    assert.equal(pick("gpt 5.5"), "gpt-5.5");
  });
  test("without a version the newest family wins", () => {
    assert.equal(pick("sol"), "gpt-6-sol");
    assert.equal(pick("luna"), "gpt-6-luna");
  });
  test("a version never drifts to another family", () => {
    assert.equal(pick("5.6 astra"), "ERR:no codex model matches '5.6 astra'|");
    assert.match(pick("7 sol"), /^ERR:no codex model matches/);
  });
  test("effort suffix", () => {
    assert.equal(pick("sol 6#max"), "gpt-6-sol#max");
    assert.match(pick("gpt-6-luna#ultra"), /^ERR:gpt-6-luna does not support effort 'ultra'/);
  });
  test("ambiguous", () => {
    assert.equal(pick("gpt 6"), "ERR:'gpt 6' is ambiguous|gpt-6-astra,gpt-6-luna,gpt-6-sol");
  });
  test("unknown names pass through", () => {
    assert.equal(pick("gpt-7-nova"), "gpt-7-nova (unknown)");
  });
});

test("listModels skips hidden models and tolerates a missing cache", () => {
  const tmp = join(import.meta.dirname, "models_cache.tmp.json");
  writeFileSync(
    tmp,
    JSON.stringify({
      models: [
        { slug: "gpt-6-sol", visibility: "list", supported_reasoning_levels: [{ effort: "low" }] },
        { slug: "codex-auto-review", visibility: "hide" },
      ],
    }),
  );
  try {
    assert.deepEqual(listModels(tmp), [{ slug: "gpt-6-sol", efforts: ["low"] }]);
    assert.deepEqual(listModels("/nonexistent/models_cache.json"), []);
  } finally {
    rmSync(tmp);
  }
});
