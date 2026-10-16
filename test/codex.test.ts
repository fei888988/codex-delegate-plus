import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { buildArgs, errorMessage, EventCollector } from "../src/codex.ts";

const fixture = (name: string) => {
  const c = new EventCollector();
  for (const line of readFileSync(join(import.meta.dirname, "fixtures", name), "utf8").split("\n")) c.push(line);
  return c;
};

describe("buildArgs", () => {
  test("new run reads the prompt from stdin", () => {
    assert.deepEqual(
      buildArgs({ prompt: "-do it", model: "gpt-6-sol", effort: "high", cwd: "/p", sandbox: "workspace-write", images: ["/p/a.png"] }),
      ["exec", "-s", "workspace-write", "-C", "/p", "--json", "--skip-git-repo-check", "-c", 'approval_policy="never"', "-m", "gpt-6-sol", "-c", 'model_reasoning_effort="high"', "-i", "/p/a.png", "--", "-"],
    );
  });
  test("the prompt never appears in argv", () => {
    assert(!buildArgs({ prompt: "secret brief", sandbox: "read-only" }).includes("secret brief"));
  });
  test("resume passes the sandbox as config and omits -C", () => {
    assert.deepEqual(buildArgs({ prompt: "more", sessionId: "abc", cwd: "/p", sandbox: "read-only" }), [
      "exec", "resume", "abc", "-c", 'sandbox_mode="read-only"', "--json", "--skip-git-repo-check", "-c", 'approval_policy="never"', "--", "-",
    ]);
  });
  test("last-message and output schema files", () => {
    const a = buildArgs({ prompt: "x", sandbox: "workspace-write", lastMessageFile: "/r/last.txt", outputSchemaFile: "/r/s.json" });
    assert.deepEqual(a.slice(a.indexOf("-o"), a.indexOf("-o") + 4), ["-o", "/r/last.txt", "--output-schema", "/r/s.json"]);
  });
  test("fast maps to codex service tiers", () => {
    const tier = (fast?: boolean) => buildArgs({ prompt: "x", sandbox: "workspace-write", fast }).find((a) => a.startsWith("service_tier"));
    assert.equal(tier(true), 'service_tier="priority"');
    assert.equal(tier(false), 'service_tier="default"');
    assert.equal(tier(undefined), undefined);
  });
  test("fork", () => {
    assert.deepEqual(buildArgs({ prompt: "x", sessionId: "abc", fork: true, sandbox: "danger-full-access" }).slice(0, 5), [
      "exec", "fork", "abc", "-c", 'sandbox_mode="danger-full-access"',
    ]);
  });
});

describe("EventCollector", () => {
  test("simple run", () => {
    const c = fixture("simple.jsonl");
    assert.equal(c.sessionId, "01a0e86c-a542-72b1-a005-1083b75d890f");
    assert.equal(c.text, "Created `hello.txt`; `cat hello.txt` printed `hi`.");
    assert.equal(c.toolCalls.length, 1);
    assert.equal(c.toolCalls[0]!.tool, "shell");
    assert.equal(c.toolCalls[0]!.exitCode, 0);
    assert.deepEqual(c.tokens, { input: 45183, cachedInput: 22272, output: 61, reasoning: 0 });
    assert.equal(c.turns, 1);
    assert.deepEqual(c.errors, []);
  });
  test("file changes and multiple messages; finalText is only the last message", () => {
    const c = fixture("tools.jsonl");
    assert.deepEqual(c.fileChanges, [
      { path: "/repo/hello.txt", kind: "update" },
      { path: "/repo/notes.md", kind: "add" },
    ]);
    assert.deepEqual(c.toolCalls.map((t) => t.tool), ["apply_patch"]);
    assert(c.text.includes("\n\nUpdated `hello.txt`"));
    assert(c.finalText.startsWith("Updated `hello.txt`"));
  });
  test("errors are unwrapped and deduplicated; item errors are warnings", () => {
    const c = fixture("error.jsonl");
    assert.deepEqual(c.errors, ["The 'no-such-model-xyz' model is not supported when using Codex with a ChatGPT account."]);
    assert(c.warnings[0]!.includes("Model metadata for `no-such-model-xyz` not found"));
    assert.equal(c.turns, 0);
  });
  test("warnings don't fail a completed run", () => {
    const c = fixture("warning.jsonl");
    assert.deepEqual(c.errors, []);
    assert(c.warnings[0]!.includes("service tier `bogus` is not advertised"));
    assert.equal(c.text, "ok");
  });
  test("non-JSON output is kept as fallback text", () => {
    const c = new EventCollector();
    c.push("plain line");
    assert.equal(c.text, "plain line");
    assert.equal(c.finalText, "plain line");
  });
});

test("errorMessage leaves plain strings alone", () => {
  assert.equal(errorMessage("boom"), "boom");
  assert.equal(errorMessage('{"error":{"message":"inner"}}'), "inner");
});
