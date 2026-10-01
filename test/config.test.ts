import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { configuredModel } from "../src/config.ts";

test("configuredModel reads only the top-level model key", () => {
  const p = `${import.meta.dir}/config.tmp.toml`;
  writeFileSync(p, 'model_reasoning_effort = "xhigh"\nmodel = "gpt-6.1-sol"\n\n[profiles.x]\nmodel = "gpt-5.5"\n');
  expect(configuredModel(p)).toBe("gpt-6.1-sol");
  writeFileSync(p, '[profiles.x]\nmodel = "gpt-5.5"\n');
  expect(configuredModel(p)).toBeUndefined();
  rmSync(p);
  expect(configuredModel("/nonexistent/config.toml")).toBeUndefined();
});
