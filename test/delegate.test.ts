import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

// config.ts reads the environment at import time, so set it up before loading the modules.
const runs = mkdtempSync(join(tmpdir(), "cd-runs-"));
process.env.CODEX_BIN = join(import.meta.dirname, "fixtures", "fake-codex.mjs");
process.env.CODEX_DELEGATE_RUNS_DIR = runs;
process.env.CODEX_DELEGATE_POLICY = join(runs, "policy.json");
const { delegate, formatOutcome } = await import("../src/delegate.ts");
const { startTask, storedTask, waitTask } = await import("../src/tasks.ts");

let repo: string;
before(() => {
  repo = mkdtempSync(join(tmpdir(), "cd-repo 中文-"));
  const git = (...a: string[]) => spawnSync("git", a, { cwd: repo });
  git("init", "-q");
  writeFileSync(join(repo, "work.txt"), "start\n");
  git("add", ".");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init");
});
after(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(runs, { recursive: true, force: true });
});

test("delegate end to end: stdin brief, JSON report, git changes, host checks, run log", async () => {
  const brief = "目标：改 work.txt\n第二行 with \"quotes\" and %PATH% and & | < >";
  const node = JSON.stringify(process.execPath);
  const o = await delegate({ cwd: repo, prompt: brief, checks: [`${node} -e "console.log('all good')"`, `${node} -e "process.exit(4)"`] });
  const text = formatOutcome(o);
  assert.equal(o.result.ok, true, text);
  assert.equal(o.result.sessionId, "fake-session-1");
  assert.equal(o.report?.status, "done");
  assert.match(text, /codex status: done/);
  assert.match(text, /\.M work\.txt {2}\+1 -0/);
  assert.match(text, /PASS .* \| all good/);
  assert.match(text, /FAIL .*exit 4/);
  assert.doesNotMatch(text, /progress note/, "only the final message is returned");
  // The brief (plus the working agreement) went through stdin, not argv.
  const argv = JSON.parse(readFileSync(join(repo, "argv.json"), "utf8"));
  assert.equal(argv.at(-1), "-");
  assert(!argv.some((a: string) => a.includes("目标")));
  assert.equal(o.effort, "high", "write runs default to high effort");
  const prompt = readFileSync(join(o.runDir!, "prompt.md"), "utf8");
  assert(prompt.startsWith(brief) && prompt.includes("Working agreement"));
  assert(existsSync(join(o.runDir!, "events.jsonl")));
});

test("read-only runs get prose, medium effort and no JSON schema", async () => {
  const o = await delegate({ cwd: repo, prompt: "what is in work.txt?", sandbox: "read-only" });
  assert.equal(o.report, undefined);
  assert.equal(o.effort, "medium");
  assert.match(formatOutcome(o), /--- response ---\nplain answer for: what is in work\.txt\?/);
});

test("a second writer in the same directory is refused; readers are not", async () => {
  const first = delegate({ cwd: repo, prompt: "slow delay=1500" });
  await new Promise((r) => setTimeout(r, 200));
  await assert.rejects(delegate({ cwd: repo, prompt: "second" }), /already editing/);
  const reader = await delegate({ cwd: repo, prompt: "peek", sandbox: "read-only" });
  assert.equal(reader.result.ok, true);
  assert.equal((await first).result.ok, true);
  assert.equal((await delegate({ cwd: repo, prompt: "after" })).result.ok, true, "lock is released");
});

test("async task results survive on disk", async () => {
  const t = startTask({ cwd: repo, prompt: "async", title: "bg" });
  assert.equal(storedTask(t.id)?.status, "interrupted", "a running task on disk reads as interrupted to another server");
  await waitTask(t, 30);
  const s = storedTask(t.id);
  assert.equal(s?.status, "done");
  assert.match(s?.text ?? "", /codex status: done/);
});

const argvOf = () => JSON.parse(readFileSync(join(repo, "argv.json"), "utf8")) as string[];
const promptOf = () => readFileSync(join(repo, "prompt.txt"), "utf8");

test("Stop, then a new direction: the next call continues the interrupted session", async () => {
  const ac = new AbortController();
  const first = delegate({ cwd: repo, prompt: "build CSV export delay=60000" }, ac.signal);
  for (let i = 0; i < 100 && !existsSync(join(repo, "prompt.txt")); i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 300));
  ac.abort();
  // The redirect arrives while the cancelled run is still winding down: it waits, it isn't refused.
  const second = await delegate({ cwd: repo, prompt: "use JSON instead of CSV" });
  assert.equal((await first).result.ok, false);
  assert.equal(second.result.ok, true, formatOutcome(second));
  assert.equal(second.continued?.sessionId, "fake-session-1");
  assert.deepEqual(argvOf().slice(1, 3), ["resume", "fake-session-1"]);
  assert.match(promptOf(), /^Previous attempt diagnosis[\s\S]*\[The user stopped your previous turn[\s\S]*the new message wins[\s\S]*use JSON instead of CSV/);
  assert.match(formatOutcome(second), /^continued: the interrupted run/m);
  // Consumed: the call after that is a normal new session.
  const third = await delegate({ cwd: repo, prompt: "unrelated" });
  assert.equal(third.continued, undefined);
  assert.equal(argvOf()[1], "-s");
});

test("fresh: true drops the interrupted run; explicit other session_id leaves it alone", async () => {
  const ac = new AbortController();
  const first = delegate({ cwd: repo, prompt: "slow delay=60000" }, ac.signal);
  await new Promise((r) => setTimeout(r, 800));
  ac.abort();
  await first;
  const other = await delegate({ cwd: repo, prompt: "follow-up elsewhere", session_id: "other-session" });
  assert.equal(other.continued, undefined);
  const fresh = await delegate({ cwd: repo, prompt: "start over", fresh: true });
  assert.equal(fresh.continued, undefined);
  assert.equal(argvOf()[1], "-s");
  assert.doesNotMatch(promptOf(), /The user stopped/);
  assert.equal((await delegate({ cwd: repo, prompt: "next" })).continued, undefined, "fresh run cleared the record");
});

test("a run whose server was killed (record left 'running', pid gone) is continued too", async () => {
  const { savePending } = await import("../src/pending.ts");
  savePending({ cwd: repo, sessionId: "orphan-session", state: "running", pid: 2 ** 22 + 12345, startedAt: Date.now(), sandbox: "workspace-write", prompt: "old" });
  const o = await delegate({ cwd: repo, prompt: "new direction" });
  assert.equal(o.continued?.sessionId, "orphan-session");
  assert.deepEqual(argvOf().slice(1, 3), ["resume", "orphan-session"]);
});

test("read-only runs neither leave nor consume an interrupted record", async () => {
  const ac = new AbortController();
  const first = delegate({ cwd: repo, prompt: "slow delay=60000" }, ac.signal);
  await new Promise((r) => setTimeout(r, 800));
  ac.abort();
  await first;
  const reader = await delegate({ cwd: repo, prompt: "peek", sandbox: "read-only" });
  assert.equal(reader.continued, undefined);
  const writer = await delegate({ cwd: repo, prompt: "go on" });
  assert.equal(writer.continued?.sessionId, "fake-session-1");
});

test("an effort above the allowed range (e.g. a '#xhigh' suffix) is clamped to high, with a note", async () => {
  const o = await delegate({ cwd: repo, prompt: "hard one", model: "gpt-6.1-sol#xhigh", fresh: true });
  assert.equal(o.effort, "high");
  assert.match(formatOutcome(o), /note: effort 'xhigh' is outside the allowed range \(low, medium, high\); used 'high'/);
  assert(argvOf().includes('model_reasoning_effort="high"'));
});

test("a policy tier sets model and effort, beats a plain effort clamp, and adds the codex guidance", async () => {
  const o = await delegate({ cwd: repo, prompt: "add a flag", effort: "luna-xhigh", fresh: true });
  assert.equal(o.tier, "luna-xhigh");
  assert.equal(o.model, "gpt-6-luna");
  assert.equal(o.effort, "xhigh", "tier efforts are not clamped to low..high");
  assert.deepEqual(argvOf().slice(argvOf().indexOf("-m"), argvOf().indexOf("-m") + 2), ["-m", "gpt-6-luna"]);
  assert(argvOf().includes('model_reasoning_effort="xhigh"'));
  assert.match(formatOutcome(o), /^model: gpt-6-luna#xhigh \(tier luna-xhigh\)/m);
  assert.match(promptOf(), /Working agreement[\s\S]*Cost \(added by the delegating tool\): work economically/);
  // Escalating a follow-up to the next tier moves the session from luna to sol.
  const up = await delegate({ cwd: repo, prompt: "still failing", effort: "high", session_id: o.result.sessionId });
  assert.equal(up.tier, "high");
  assert.equal(up.effort, "high");
  assert.equal(up.model, "gpt-6.1-sol");
});

test("the policy file is read per call: custom tiers, guidance and the model allowlist", async () => {
  const { savePolicy, DEFAULT_POLICY } = await import("../src/policy.ts");
  const file = process.env.CODEX_DELEGATE_POLICY!;
  try {
    savePolicy({ ...DEFAULT_POLICY, codexGuidance: "SPEND LITTLE", models: ["gpt-6-luna"], tiers: [{ id: "cheap", model: "gpt-6-luna", effort: "low", use: "all" }] }, file);
    const o = await delegate({ cwd: repo, prompt: "x", effort: "cheap", fresh: true });
    assert.equal(o.model, "gpt-6-luna");
    assert.equal(o.effort, "low");
    assert.match(promptOf(), /SPEND LITTLE\n\nCommand logs/);
    await assert.rejects(delegate({ cwd: repo, prompt: "x", effort: "cheap", model: "gpt-6.1-sol", fresh: true }), /not allowed by the delegation policy/);
    writeFileSync(file, "{ broken");
    const fallback = await delegate({ cwd: repo, prompt: "x", effort: "luna-xhigh", fresh: true });
    assert.equal(fallback.tier, "luna-xhigh");
    assert.match(formatOutcome(fallback), /note: .*not valid JSON.*using the default policy/);
  } finally {
    rmSync(file, { force: true });
  }
});

test("a needs_decision report leads the result with a status and a next step for the lead", async () => {
  const o = await delegate({ cwd: repo, prompt: "decide something" });
  const report = { status: "needs_decision" as const, summary: "two ways to do it", changes: [], verification: [], risks: [], questions: ["A or B?", "keep the flag?"] };
  const text = formatOutcome({ ...o, report });
  const [first, second] = text.split("\n");
  assert.equal(first, "status: needs_decision (codex finished but the work is not done)");
  assert.match(second!, /^next: decide now: .*resume with session_id.*\(2 questions below\)$/);
  assert.match(text, /QUESTIONS \(need your decision\)/);
  assert.match(formatOutcome(o), /^status: ok/);
});

test("write toggle applies to legacy calls, passes add-dir and private TEMP, then removes tmp", async () => {
  for (const sandboxWrites of [false, true]) {
    writeFileSync(join(runs, "policy.json"), JSON.stringify({ sandboxWrites }));
    for (const sandbox of ["write", "workspace-write", "danger-full-access"] as const) {
      const outcome = await delegate({ cwd: repo, prompt: "toggle", sandbox, add_dirs: ["extra"] });
      assert.equal(outcome.sandbox, sandboxWrites ? "workspace-write" : "danger-full-access");
      const args = argvOf();
      assert(args.includes(outcome.runDir!)); assert(args.includes(join(repo, "extra")));
      const env = JSON.parse(readFileSync(join(repo, "launch-env.json"), "utf8"));
      if (sandboxWrites) {
        assert.equal(env.TEMP, join(outcome.runDir!, "tmp")); assert.equal(env.TMP, env.TEMP);
        assert(!existsSync(env.TEMP));
      }
    }
  }
  rmSync(join(runs, "policy.json"));
});

test("denials lead the result and are carried into resumed prompts; successful logs archive", async () => {
  const first = await delegate({ cwd: repo, prompt: "diagnostic-fixture" });
  assert.match(formatOutcome(first), /^sandbox_denied: 1 denials\n  paths: D:\/outside/);
  const meta = JSON.parse(readFileSync(join(first.runDir!, "meta.json"), "utf8"));
  assert.equal(meta.commands[0].command, "python -m unittest");
  assert.match(meta.cmdLogTails["cmd-1.log"], /working/);
  assert(!existsSync(join(first.runDir!, "cmd-1.log")));
  const next = await delegate({ cwd: repo, prompt: "fix it", session_id: first.result.sessionId });
  const prompt = readFileSync(join(next.runDir!, "prompt.md"), "utf8");
  assert.match(prompt, /^Previous attempt diagnosis\nexit: completed; denied paths: D:\/outside/);
  assert.match(prompt, /Command logs \(added by the server\)/);
});

test("inflight trend sampler persists a ring; inspect is read-only and wake includes logs", async (t) => {
  const { inspectTask, formatSuspicion } = await import("../src/tasks.ts");
  t.mock.timers.enable({ apis: ["setInterval"] });
  let cpu = 100;
  const task = startTask({ cwd: repo, prompt: "diagnostic-fixture delay=10000", stall: { command_s: 120 } }, true,
    async () => ({ cpuTotalMs: cpu += 100, rssBytes: 1048576, ioReadBytes: 100, ioWriteBytes: 200 }));
  try {
    for (let i = 0; i < 100 && !task.progress?.inflight; i++) await new Promise(r => setTimeout(r, 30));
    assert(task.progress?.inflight);
    for (let i = 0; i < 12; i++) { t.mock.timers.tick(60000); await new Promise(r => setTimeout(r, 5)); }
    assert.equal(task.progress!.trend!.length, 10);
    task.progress!.suspicion = { kind: "command", idleMs: 1, suspectedAt: Date.now(), wakes: 1, thresholdSec: 120, command: "python -m unittest", evidence: {} };
    const wake = formatSuspicion(task);
    assert.match(wake, /^sandbox_denied:/); assert.match(wake, /working/); assert.match(wake, /CPU Δ100ms/);
    const observed = task.control.lastObservedAt, seenWake = task.seenWake, suspicion = task.progress!.suspicion;
    const inspection = await inspectTask(task);
    assert.match(inspection, /last events:/); assert.match(inspection, /cmd-1.log/);
    assert.equal(task.control.lastObservedAt, observed); assert.equal(task.seenWake, seenWake);
    assert.equal(task.progress!.suspicion, suspicion);
  } finally { task.controller.abort(); await task.promise; t.mock.timers.reset(); }
  const meta = JSON.parse(readFileSync(join(runs, task.progress!.id, "meta.json"), "utf8"));
  assert.equal(meta.trend.length, 10); assert(existsSync(join(runs, meta.id, "cmd-1.log")), "cancelled logs are kept");
});
