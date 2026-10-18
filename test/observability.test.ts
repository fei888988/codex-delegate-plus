import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { baseline, cleanupRuns, commandClass, diagnosisPrefix, effectiveSandbox, extractDenials, finishCommandLogs, logReport, percentile, previousDiagnosis, recentFiles, trimCommandLogs, trendReport } from "../src/observability.ts";
import { DEFAULT_POLICY, validatePolicy } from "../src/policy.ts";
import { EventCollector, buildArgs } from "../src/codex.ts";
import type { RunSummary } from "../src/run-summary.ts";

const root = mkdtempSync(join(tmpdir(), "cd-observability-"));
after(() => rmSync(root, { recursive: true, force: true }));
const area = (name: string) => { const dir = join(root, name); mkdirSync(dir); return dir; };
const record = (dir: string, id: string, meta: Partial<RunSummary>) => {
  const path = join(dir, id); mkdirSync(path);
  writeFileSync(join(path, "meta.json"), JSON.stringify({ id, startedAt: Date.now(), state: "ok", ...meta }));
  return path;
};

test("sandbox mapping: write and legacy choices follow the toggle, explicit sandbox wins over auto", () => {
  for (const choice of ["write", "workspace-write", "danger-full-access", undefined] as const) {
    assert.equal(effectiveSandbox(choice, true, false), "danger-full-access");
    assert.equal(effectiveSandbox(choice, true, true), "workspace-write");
  }
  assert.equal(effectiveSandbox(undefined, false, true), "read-only");
  assert.equal(effectiveSandbox("write", false, false), "danger-full-access");
  assert.equal(effectiveSandbox("read-only", true, true), "read-only");
  assert.deepEqual(buildArgs({ prompt: "x", sandbox: "workspace-write", addDirs: ["D:/run", "D:/other"] }).slice(-6), ["--add-dir", "D:/run", "--add-dir", "D:/other", "--", "-"]);
});

test("old policies default sandbox off, retention merges and rejects invalid values", () => {
  const old = validatePolicy({ retention: { cmdLogMaxMB: 2 } }, []);
  assert(old.ok);
  assert.equal(old.policy.sandboxWrites, false);
  assert.deepEqual(old.policy.retention, { ...DEFAULT_POLICY.retention, cmdLogMaxMB: 2 });
  for (const invalid of [{ sandboxWrites: "yes" }, { retention: [] }, { retention: { runDays: 0 } }, { retention: { totalMaxMB: -1 } }, { retention: { cmdLogMaxMB: "5" } }]) assert.equal(validatePolicy(invalid, []).ok, false);
});

test("denials group paths across Windows, Unix and Chinese output, without counting normal output", () => {
  const output = "PermissionError: [WinError 5] Access is denied: 'D:\\'\nEACCES: permission denied, open '/tmp/a'\n拒绝访问 D:/\nEPERM: 'D:/space dir/file'\nall good";
  assert.deepEqual(extractDenials(output), { count: 4, paths: ["D:/", "/tmp/a", "D:/space dir/file"] });
  const collector = new EventCollector();
  const event = (type: string) => JSON.stringify({ type, item: { id: "1", type: "command_execution", command: "pytest", aggregated_output: output } });
  collector.push(event("item.started")); collector.push(event("item.updated")); collector.push(event("item.completed"));
  assert.equal(collector.denials.count, 4, "cumulative output updates are not counted twice");
  assert.equal(collector.commands[0]?.command, "pytest");
  assert(collector.commands[0]!.durationMs >= 0);
});

test("baseline uses command classes and nearest-rank percentiles, with at least three samples", () => {
  assert.equal(commandClass('"C:/Python/python.exe" -m unittest discover'), "python -m unittest");
  assert.equal(commandClass("npm run test -- --all"), "npm run test");
  assert.equal(commandClass("CI=1 pytest -q"), "pytest");
  assert.equal(percentile([900, 10, 30, 20], .5), 20);
  assert.equal(percentile([900, 10, 30, 20], .9), 900);
  const dir = area("baseline");
  for (const [i, durationMs] of [10000, 20000, 90000].entries()) record(dir, `run-${i}`, { commands: [{ command: "pytest -q", durationMs }] });
  assert.equal(baseline(dir, "pytest test/a.py"), "baseline: pytest p50 20s p90 90s (n=3)");
  assert.equal(baseline(dir, "pytest", "run-0"), "");
  assert.equal(baseline(dir, "npm test"), "");
});

test("resume diagnosis is bounded, includes last command/evidence and chooses latest attempt", () => {
  const dir = area("diagnosis");
  const meta: RunSummary = { id: "bad", startedAt: 1000, sessionId: "session", state: "error", exitKind: "stalled", denials: { count: 1, paths: ["D:/"] }, lastInflight: { command: "pytest", startedAt: 1000 }, lastEvidence: { cpuTotalMs: 0 } };
  record(dir, "bad", meta);
  const prefix = previousDiagnosis(dir, "session");
  assert(prefix.startsWith("Previous attempt diagnosis\n"));
  assert.match(prefix, /stalled.*D:\/.*pytest.*CPU/s);
  assert(prefix.length < 600);
  assert(diagnosisPrefix({ ...meta, lastInflight: { command: "x".repeat(1000), startedAt: 0 } }).length < 600);
  record(dir, "good", { startedAt: 2000, sessionId: "session", state: "ok", exitKind: "completed" });
  assert.equal(previousDiagnosis(dir, "session"), "");
  record(dir, "killed", { startedAt: 3000, sessionId: "killed-session", state: "running", pid: 1073741824, lastInflight: { command: "pytest", startedAt: 3000 } });
  assert.match(previousDiagnosis(dir, "killed-session"), /exit: crashed.*pytest/);
  assert(diagnosisPrefix({ ...meta, state: "ok", exitKind: "completed" }).length > 0, "denials carry over even after completion");
});

test("command logs truncate to a tail, success archives 2KB and deletes, failures keep files", () => {
  const dir = area("logs"), file = join(dir, "cmd-1.log");
  writeFileSync(file, "old\n".repeat(1000) + "new\n".repeat(30));
  trimCommandLogs(dir, 2048 / 1048576);
  assert.equal(readFileSync(file).length, 2048);
  assert.match(logReport(dir), /cmd-1.log \(2048 bytes\)/);
  assert(Buffer.byteLength(logReport(dir)) < 1700);
  assert.equal(finishCommandLogs(dir, false), undefined); assert(existsSync(file));
  assert.equal(Buffer.byteLength(finishCommandLogs(dir, true)!["cmd-1.log"]!), 2048);
  assert(!existsSync(file));
});

test("cleanup expires failed logs and old runs, enforces oldest-first cap, protects running tasks", () => {
  const dir = area("cleanup"), now = Date.now(), day = 86400000;
  const live = record(dir, "live", { state: "running", pid: process.pid, startedAt: now - 60 * day });
  const dead = record(dir, "dead", { state: "running", pid: 1073741824, heartbeatAt: 1, startedAt: now - 60 * day });
  const running = record(dir, "running", { state: "running", startedAt: now - 60 * day });
  const active = record(dir, "active", { state: "ok", startedAt: now - 50 * day });
  const expired = record(dir, "expired", { startedAt: now - 31 * day });
  const failed = record(dir, "failed", { state: "error", endedAt: now - 4 * day });
  const fresh = record(dir, "fresh", { state: "error", endedAt: now - day });
  for (const path of [running, failed, fresh]) writeFileSync(join(path, "cmd-1.log"), "output");
  cleanupRuns(dir, DEFAULT_POLICY.retention, new Set(["active"]), now);
  assert(existsSync(live)); assert(!existsSync(dead));
  assert(existsSync(running)); assert(existsSync(active)); assert(!existsSync(expired));
  assert(!existsSync(join(failed, "cmd-1.log"))); assert(existsSync(join(fresh, "cmd-1.log")));
  cleanupRuns(dir, { ...DEFAULT_POLICY.retention, totalMaxMB: .000001 }, new Set(["active"]), now);
  assert(!existsSync(failed)); assert(!existsSync(fresh)); assert(existsSync(running)); assert(existsSync(active));
});

test("inspection helpers skip excluded directories and trend reports interval deltas", () => {
  const dir = area("files");
  for (const name of [".git", "node_modules", "src"]) { mkdirSync(join(dir, name)); writeFileSync(join(dir, name, "file"), "x"); }
  writeFileSync(join(dir, "old"), "x"); utimesSync(join(dir, "old"), new Date(0), new Date(0));
  assert.deepEqual(recentFiles(dir), [join("src", "file")]);
  const trend = trendReport([{ at: 0, commandStartedAt: 1, logBytes: 0, cpuTotalMs: 100, rssBytes: 1048576 }, { at: 60000, commandStartedAt: 1, logBytes: 10, cpuTotalMs: 200, rssBytes: 2097152 }]);
  assert.match(trend, /60s: CPU Δ100ms; RSS 2MB/); assert.match(trend, /log Δ10B/);
});
