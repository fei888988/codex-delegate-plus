import { describe, expect, test } from "bun:test";
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
    expect(pick("gpt-6-sol")).toBe("gpt-6-sol");
    expect(pick("GPT-5.6-Terra")).toBe("gpt-5.6-terra");
  });
  test("loose names", () => {
    expect(pick("sol 6")).toBe("gpt-6-sol");
    expect(pick("Sol6")).toBe("gpt-6-sol");
    expect(pick("gpt 6 sol")).toBe("gpt-6-sol");
    expect(pick("use sol 6 in codex")).toBe("gpt-6-sol");
    expect(pick("5.6 sol")).toBe("gpt-5.6-sol");
    expect(pick("terra")).toBe("gpt-5.6-terra");
    expect(pick("gpt 5.5")).toBe("gpt-5.5");
  });
  test("without a version the newest family wins", () => {
    expect(pick("sol")).toBe("gpt-6-sol");
    expect(pick("luna")).toBe("gpt-6-luna");
  });
  test("a version never drifts to another family", () => {
    expect(pick("5.6 astra")).toBe("ERR:no codex model matches '5.6 astra'|");
    expect(pick("7 sol")).toStartWith("ERR:no codex model matches");
  });
  test("effort suffix", () => {
    expect(pick("sol 6#max")).toBe("gpt-6-sol#max");
    expect(pick("gpt-6-luna#ultra")).toStartWith("ERR:gpt-6-luna does not support effort 'ultra'");
  });
  test("ambiguous", () => {
    expect(pick("gpt 6")).toBe("ERR:'gpt 6' is ambiguous|gpt-6-astra,gpt-6-luna,gpt-6-sol");
  });
  test("unknown names pass through", () => {
    expect(pick("gpt-7-nova")).toBe("gpt-7-nova (unknown)");
  });
});

test("listModels skips hidden models and tolerates a missing cache", () => {
  const tmp = `${import.meta.dir}/models_cache.tmp.json`;
  Bun.write(tmp, JSON.stringify({ models: [
    { slug: "gpt-6-sol", visibility: "list", supported_reasoning_levels: [{ effort: "low" }] },
    { slug: "codex-auto-review", visibility: "hide" },
  ] }));
  return Bun.sleep(10).then(async () => {
    expect(listModels(tmp)).toEqual([{ slug: "gpt-6-sol", efforts: ["low"] }]);
    expect(listModels("/nonexistent/models_cache.json")).toEqual([]);
    await Bun.file(tmp).delete();
  });
});
