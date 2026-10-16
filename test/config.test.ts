import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { allowedEfforts, clampEffort, configuredModel, resolveCodex } from "../src/config.ts";

test("configuredModel reads only the top-level model key", () => {
  const p = join(import.meta.dirname, "config.tmp.toml");
  try {
    writeFileSync(p, 'model_reasoning_effort = "xhigh"\nmodel = "gpt-6.1-sol"\n\n[profiles.x]\nmodel = "gpt-5.5"\n');
    assert.equal(configuredModel(p), "gpt-6.1-sol");
    writeFileSync(p, '[profiles.x]\nmodel = "gpt-5.5"\n');
    assert.equal(configuredModel(p), undefined);
  } finally {
    rmSync(p, { force: true });
  }
  assert.equal(configuredModel("/nonexistent/config.toml"), undefined);
});

test("resolveCodex on Windows runs the npm shim's codex.js through node, not the .cmd", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-npm-"));
  try {
    const js = join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    mkdirSync(join(js, ".."), { recursive: true });
    writeFileSync(js, "");
    writeFileSync(join(dir, "codex.cmd"), "");
    assert.deepEqual(resolveCodex({ Path: `C:\\nope;${dir}` }, "win32"), { cmd: process.execPath, args: [js] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveCodex honours CODEX_BIN and falls back to a native codex.exe", () => {
  assert.deepEqual(resolveCodex({ CODEX_BIN: "C:\\x\\codex.js" }, "win32"), { cmd: process.execPath, args: ["C:\\x\\codex.js"] });
  assert.deepEqual(resolveCodex({ CODEX_BIN: "/opt/codex" }, "linux"), { cmd: "/opt/codex", args: [] });
  const dir = mkdtempSync(join(tmpdir(), "cd-exe-"));
  try {
    writeFileSync(join(dir, "codex.exe"), "");
    assert.deepEqual(resolveCodex({ PATH: dir }, "win32"), { cmd: join(dir, "codex.exe"), args: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("effort range: default low..high, clamped from both sides, configurable", () => {
  const dflt = allowedEfforts(undefined);
  assert.deepEqual(dflt, ["low", "medium", "high"]);
  assert.equal(clampEffort("xhigh", dflt), "high");
  assert.equal(clampEffort("max", dflt), "high");
  assert.equal(clampEffort("minimal", dflt), "low");
  assert.equal(clampEffort("medium", dflt), "medium");
  assert.equal(clampEffort(undefined, dflt), undefined);
  assert.equal(clampEffort("bogus", dflt), "bogus", "unknown names are left for codex to reject");
  assert.deepEqual(allowedEfforts("high, low,xhigh"), ["low", "high", "xhigh"], "ordered cheapest first");
  assert.equal(allowedEfforts(""), undefined);
  assert.equal(allowedEfforts("any"), undefined);
  assert.equal(clampEffort("max", undefined), "max");
});
