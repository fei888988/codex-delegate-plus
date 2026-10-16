import assert from "node:assert/strict";
import { test } from "node:test";
import { runCheck } from "../src/checks.ts";
import { parseReport, renderReport } from "../src/report.ts";

test("parseReport accepts plain and fenced JSON and rejects prose", () => {
  const r = { status: "needs_decision", summary: "s", changes: ["a.ts: x"], verification: [{ command: "npm test", result: "12 passed" }], risks: [], questions: ["A or B?"] };
  assert.deepEqual(parseReport(JSON.stringify(r)), r);
  assert.deepEqual(parseReport("```json\n" + JSON.stringify(r) + "\n```"), r);
  assert.equal(parseReport("I changed a few files."), undefined);
  const text = renderReport(r as any);
  assert.match(text, /codex status: needs_decision/);
  assert.match(text, /QUESTIONS \(need your decision\):\n {2}- A or B\?/);
  assert.doesNotMatch(text, /risks/);
});

test("runCheck reports pass with the last line and failure with the tail", async () => {
  const node = JSON.stringify(process.execPath);
  const pass = await runCheck(`${node} -e "console.log('noise');console.log('Ran 3 tests OK')"`, process.cwd(), 30000);
  assert.equal(pass.ok, true);
  assert.equal(pass.lastLine, "Ran 3 tests OK");
  assert.equal(pass.tail, undefined);
  const fail = await runCheck(`${node} -e "console.error('AssertionError: 1 != 2');process.exit(3)"`, process.cwd(), 30000);
  assert.equal(fail.ok, false);
  assert.equal(fail.exitCode, 3);
  assert.match(fail.tail ?? "", /AssertionError/);
});

test("runCheck kills a command that runs past its timeout", async () => {
  const node = JSON.stringify(process.execPath);
  const r = await runCheck(`${node} -e "setTimeout(()=>{},60000)"`, process.cwd(), 500);
  assert.equal(r.timedOut, true);
  assert.equal(r.ok, false);
  assert(r.durationMs < 15000);
});
