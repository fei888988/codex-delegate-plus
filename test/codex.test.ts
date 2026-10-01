import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildArgs, errorMessage, EventCollector } from "../src/codex.ts";

const fixture = (name: string) => {
  const c = new EventCollector();
  for (const line of readFileSync(join(import.meta.dir, "fixtures", name), "utf8").split("\n")) c.push(line);
  return c;
};

describe("buildArgs", () => {
  test("new run", () => {
    expect(buildArgs({ prompt: "-do it", model: "gpt-6-sol", effort: "high", cwd: "/p", sandbox: "workspace-write", images: ["/p/a.png"] })).toEqual([
      "exec", "-s", "workspace-write", "-C", "/p", "--json", "--skip-git-repo-check",
      "-c", 'approval_policy="never"', "-m", "gpt-6-sol", "-c", 'model_reasoning_effort="high"',
      "-i", "/p/a.png", "--", "-do it",
    ]);
  });
  test("resume passes the sandbox as config and omits -C", () => {
    expect(buildArgs({ prompt: "more", sessionId: "abc", cwd: "/p", sandbox: "read-only" })).toEqual([
      "exec", "resume", "abc", "-c", 'sandbox_mode="read-only"', "--json", "--skip-git-repo-check",
      "-c", 'approval_policy="never"', "--", "more",
    ]);
  });
  test("fast maps to codex service tiers", () => {
    const tier = (fast?: boolean) => buildArgs({ prompt: "x", sandbox: "workspace-write", fast }).find((a) => a.startsWith("service_tier"));
    expect(tier(true)).toBe('service_tier="priority"');
    expect(tier(false)).toBe('service_tier="default"');
    expect(tier(undefined)).toBeUndefined();
  });
  test("fork", () => {
    expect(buildArgs({ prompt: "x", sessionId: "abc", fork: true, sandbox: "danger-full-access" }).slice(0, 5)).toEqual([
      "exec", "fork", "abc", "-c", 'sandbox_mode="danger-full-access"',
    ]);
  });
});

describe("EventCollector", () => {
  test("simple run", () => {
    const c = fixture("simple.jsonl");
    expect(c.sessionId).toBe("01a0e86c-a542-72b1-a005-1083b75d890f");
    expect(c.text).toBe("Created `hello.txt`; `cat hello.txt` printed `hi`.");
    expect(c.toolCalls).toHaveLength(1);
    expect(c.toolCalls[0]).toMatchObject({ tool: "shell", status: "completed", exitCode: 0 });
    expect(c.tokens).toEqual({ input: 45183, cachedInput: 22272, output: 61, reasoning: 0 });
    expect(c.turns).toBe(1);
    expect(c.errors).toEqual([]);
  });
  test("file changes and multiple messages", () => {
    const c = fixture("tools.jsonl");
    expect(c.fileChanges).toEqual([
      { path: "/repo/hello.txt", kind: "update" },
      { path: "/repo/notes.md", kind: "add" },
    ]);
    expect(c.toolCalls.map((t) => t.tool)).toEqual(["apply_patch"]);
    expect(c.text).toContain("\n\nUpdated `hello.txt`");
  });
  test("errors are unwrapped and deduplicated; item errors are warnings", () => {
    const c = fixture("error.jsonl");
    expect(c.errors).toEqual(["The 'no-such-model-xyz' model is not supported when using Codex with a ChatGPT account."]);
    expect(c.warnings[0]).toContain("Model metadata for `no-such-model-xyz` not found");
    expect(c.turns).toBe(0);
  });
  test("warnings don't fail a completed run", () => {
    const c = fixture("warning.jsonl");
    expect(c.errors).toEqual([]);
    expect(c.warnings[0]).toContain("service tier `bogus` is not advertised");
    expect(c.text).toBe("ok");
  });
  test("non-JSON output is kept as fallback text", () => {
    const c = new EventCollector();
    c.push("plain line");
    expect(c.text).toBe("plain line");
  });
});

test("errorMessage leaves plain strings alone", () => {
  expect(errorMessage("boom")).toBe("boom");
  expect(errorMessage('{"error":{"message":"inner"}}')).toBe("inner");
});
