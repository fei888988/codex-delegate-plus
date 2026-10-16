import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRollout } from "../src/sessions.ts";

test("parseRollout reads session_meta and skips injected context", () => {
  const head = [
    JSON.stringify({ type: "session_meta", payload: { id: "s1", cwd: "/repo", timestamp: "2026-09-28T00:00:00Z" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "add a login form" }] } }),
  ].join("\n");
  assert.deepEqual(parseRollout(head, "f"), { id: "s1", cwd: "/repo", timestamp: "2026-09-28T00:00:00Z", prompt: "add a login form", file: "f" });
  assert.equal(parseRollout('{"type":"other"}', "f"), undefined);
});
