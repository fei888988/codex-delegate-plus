import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Exercise the actual browser conversation builder without starting a server or Codex.
const html = readFileSync(new URL("../dashboard/index.html", import.meta.url), "utf8");
const start = html.indexOf("const BOILER =");
const end = html.indexOf("const IST =", start);
assert(start >= 0 && end > start);
const createBuilder = new Function("view", html.slice(start, end) + "\nreturn buildConvo;");
const humanPrefix = "This message comes from the human user directly through the dashboard, not from the lead.";
const user = (seq: number, text: string) => ({ seq, kind: "user", text, ts: "2026-10-20T15:29:01.000Z" });

test("later lead messages stay attributed to the lead instead of becoming false human continuations", () => {
  const build = createBuilder({ run: {}, inputs: [] });
  const items = build([user(1, "initial brief"), user(2, "continue with the agreed requirements"), user(3, "check the report")]);
  assert.deepEqual(items.map((i: any) => [i.type, i.e.text, i.later]), [
    ["task", "initial brief", false],
    ["task", "continue with the agreed requirements", true],
    ["task", "check the report", true],
  ]);
});

test("later dashboard inputs match the real text and are displayed once with their receipt", () => {
  const input = { mid: "human-1", mode: "steer", text: "use the daily ST history", from: "user", state: "consumed" };
  const build = createBuilder({ run: {}, inputs: [input] });
  const items = build([user(1, "initial brief"), user(2, "User input: use the daily ST history")]);
  assert.equal(items.length, 2);
  assert.equal(items[1].type, "human");
  assert.equal(items[1].inp, input);
  assert.equal(items[1].pending, undefined);
});

test("dashboard continuation unwraps only the first brief and preserves later lead messages", () => {
  const build = createBuilder({ run: { origin: "dashboard" }, inputs: [] });
  const items = build([
    user(1, "# AGENTS.md instructions\ncontext"),
    user(2, humanPrefix + "\n\ncontinue my analysis\n\nReply directly to the human user as requested."),
    user(3, "lead follow-up"),
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0].type, "human");
  assert.equal(items[0].inp.text, "continue my analysis");
  assert.equal(items[1].type, "task");
  assert.equal(items[1].e.text, "lead follow-up");
});

test("a genuine user message containing the literal false is preserved", () => {
  const input = { mid: "human-false", mode: "queue", text: "false", from: "user", state: "consumed" };
  const build = createBuilder({ run: {}, inputs: [input] });
  const items = build([user(1, "initial brief"), user(2, "false")]);
  assert.equal(items.length, 2);
  assert.equal(items[1].inp, input);
  assert.equal(items[1].inp.text, "false");
});
