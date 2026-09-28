import { expect, test } from "bun:test";
import { parseRollout } from "../src/sessions.ts";

test("parseRollout reads session_meta and skips injected context", () => {
  const head = [
    JSON.stringify({ type: "session_meta", payload: { id: "s1", cwd: "/repo", timestamp: "2026-09-28T00:00:00Z" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "add a login form" }] } }),
  ].join("\n");
  expect(parseRollout(head, "f")).toEqual({ id: "s1", cwd: "/repo", timestamp: "2026-09-28T00:00:00Z", prompt: "add a login form", file: "f" });
  expect(parseRollout('{"type":"other"}', "f")).toBeUndefined();
});
