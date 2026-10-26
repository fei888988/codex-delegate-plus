import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { ORPHAN_STALE_MS, sweepOrphanedRuns } from "../src/run-lifecycle.ts";

 test("async startup sweep respects ownership, heartbeat, terminal states and concurrent writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "run-lifecycle-"));
  const now = Date.now(), old = now - ORPHAN_STALE_MS - 60000;
  const dead = spawnSync(process.execPath, ["-e", "" ]).pid;
  const live = spawnSync(process.execPath, ["-e", "console.log(process.ppid)"]);
  assert.equal(Number(live.stdout.toString().trim()), process.pid);
  const child = (await import("node:child_process")).spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  const put = (id: string, fields = {}) => {
    mkdirSync(join(root, id));
    writeFileSync(join(root, id, "meta.json"), JSON.stringify({ id, state: "running", pid: dead, heartbeatAt: old, startedAt: old - 1000, ...fields }));
  };
  const get = (id: string) => JSON.parse(readFileSync(join(root, id, "meta.json"), "utf8"));
  try {
    put("dead"); put("fresh-dead", { heartbeatAt: now });
    put("live-fresh", { pid: child.pid, heartbeatAt: now });
    put("live-stale", { pid: child.pid }); put("own", { pid: process.pid });
    for (const state of ["ok", "error", "interrupted", "user_interrupted", "needs_decision", "partial", "blocked", "cancelled"]) put(state, { state });
    put("race");
    for (const id of ["pending", "handoffs", "inbox", "tasks"]) put(id);
    const read = fs.readFile;
    let raceReads = 0, reads = 0;
    fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
      reads++;
      if (String(args[0]) === join(root, "race", "meta.json") && ++raceReads === 2) {
        writeFileSync(String(args[0]), JSON.stringify({ ...get("race"), heartbeatAt: now }));
      }
      return read(...args);
    }) as typeof fs.readFile;
    syncBuiltinESMExports();
    try {
      const sweep = sweepOrphanedRuns(root);
      assert.equal(reads, 0, "directory enumeration yields before reading records");
      await sweep;
    } finally { fs.readFile = read; syncBuiltinESMExports(); }
    for (const id of ["dead", "live-stale"]) {
      const meta = get(id);
      assert.equal(meta.state, "interrupted"); assert.equal(meta.phase, "done");
      assert.equal(meta.exitKind, "cancelled"); assert.equal(meta.endedAt, old);
      assert.equal(meta.interruptedReason, "owning server exited");
    }
    for (const id of ["fresh-dead", "live-fresh", "own", "race", "pending", "handoffs", "inbox", "tasks"]) assert.equal(get(id).state, "running", id);
    for (const state of ["ok", "error", "interrupted", "user_interrupted", "needs_decision", "partial", "blocked", "cancelled"]) assert.equal(get(state).state, state);
    assert.equal(get("race").heartbeatAt, now);
    assert.equal(child.exitCode, null, "sweep never stops live jobs");
  } finally { child.kill(); rmSync(root, { recursive: true, force: true }); }
});

test("exit hook writes only owned, still tracked running runs", () => {
  const root = mkdtempSync(join(tmpdir(), "run-exit-"));
  try {
    const moduleUrl = new URL("../src/run-lifecycle.ts", import.meta.url).href;
    const procsUrl = new URL("../src/procs.ts", import.meta.url).href;
    const script = `import {trackOwnedRun} from ${JSON.stringify(moduleUrl)};
      import {installExitCleanup} from ${JSON.stringify(procsUrl)};
      import {mkdirSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';
      installExitCleanup(false);
      for (const id of ['running','finished','untracked','other']) {
        const dir=join(${JSON.stringify(root)},id); mkdirSync(dir);
        const meta={id,state:id==='finished'?'ok':'running',pid:id==='other'?1:process.pid,startedAt:1,heartbeatAt:123};
        writeFileSync(join(dir,'meta.json'),JSON.stringify(meta));
        const untrack=trackOwnedRun(dir,meta); if(id==='untracked')untrack();
      }`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const get = (id: string) => JSON.parse(readFileSync(join(root,id,"meta.json"),"utf8"));
    assert.equal(get("running").state,"interrupted"); assert.equal(get("running").endedAt,123);
    assert.equal(get("finished").state,"ok"); assert.equal(get("untracked").state,"running"); assert.equal(get("other").state,"running");
  } finally { rmSync(root,{recursive:true,force:true}); }
});
