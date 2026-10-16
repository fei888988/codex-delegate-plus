import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { diffSnapshots, diffStat, parsePorcelainZ, snapshot } from "../src/git.ts";

test("parsePorcelainZ handles renames, spaces and non-ASCII paths", () => {
  const out = " M src/a.ts\0R  new name.ts\0old name.ts\0?? 文档/说明.md\0";
  assert.deepEqual(parsePorcelainZ(out), [
    { xy: " M", path: "src/a.ts" },
    { xy: "R ", path: "new name.ts" },
    { xy: "??", path: "文档/说明.md" },
  ]);
});

test("snapshots catch edits to files that were already dirty", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-git-"));
  const git = (...a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "one\n");
    writeFileSync(join(dir, "b.txt"), "b\n");
    git("add", ".");
    git("commit", "-qm", "init");
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n"); // dirty before the run
    const before = snapshot(dir)!;

    writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n"); // still " M", new content
    writeFileSync(join(dir, "新文件.txt"), "x\ny\n");
    const after = snapshot(dir)!;
    const changes = diffSnapshots(before, after);
    assert.deepEqual(changes.map((c) => c.path).sort(), ["a.txt", "新文件.txt"]);

    const stats = diffStat(dir, changes);
    assert.deepEqual(stats.find((s) => s.path === "a.txt"), { path: "a.txt", xy: " M", added: 2, removed: 0 });
    assert.deepEqual(stats.find((s) => s.path === "新文件.txt"), { path: "新文件.txt", xy: "??", added: 2, removed: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot is undefined outside a git repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-nogit-"));
  try {
    assert.equal(snapshot(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
