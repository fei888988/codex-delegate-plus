import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, utimesSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { diffSnapshots, diffStat, parsePorcelainZ, snapshot } from "../src/git.ts";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cd-git-"));
  const r = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return dir;
}

test("snapshot detects new, modified, deleted and reverted files", async () => {
  const dir = repo();
  try {
    for (const name of ["modified", "deleted", "reverted"]) writeFileSync(join(dir, name), "original\n");
    const git = (...args: string[]) => {
      const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    };
    git("add", ".");
    git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "initial");
    writeFileSync(join(dir, "reverted"), "dirty\n");
    const before = (await snapshot(dir))!;
    writeFileSync(join(dir, "new"), "new\n");
    writeFileSync(join(dir, "modified"), "modified\n");
    unlinkSync(join(dir, "deleted"));
    git("restore", "reverted");
    const after = (await snapshot(dir))!;
    assert.equal(after.get("deleted")?.hash, "deleted");
    assert.deepEqual(diffSnapshots(before, after), [
      { path: "deleted", xy: " D" },
      { path: "modified", xy: " M" },
      { path: "new", xy: "??" },
      { path: "reverted", xy: "  " },
    ]);
    assert.deepEqual(diffSnapshots(after, after), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot uses size and mtime for same-size already-dirty edits", async () => {
  const dir = repo();
  try {
    const file = join(dir, "dirty");
    writeFileSync(file, "one");
    utimesSync(file, 1000000000, 1000000000);
    const before = (await snapshot(dir))!;
    writeFileSync(file, "two");
    utimesSync(file, 1000000001, 1000000001);
    const after = (await snapshot(dir))!;
    assert.deepEqual(diffSnapshots(before, after), [{ path: "dirty", xy: "??" }]);
    // Rewriting identical content also counts when mtime changes.
    writeFileSync(file, "two");
    utimesSync(file, 1000000002, 1000000002);
    assert.deepEqual(diffSnapshots(after, (await snapshot(dir))!), [{ path: "dirty", xy: "??" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("diffStat skips large untracked counts and preserves text and binary counting", async () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, "large"), "");
    truncateSync(join(dir, "large"), 32 * 1024 * 1024 + 1);
    writeFileSync(join(dir, "text"), "one\ntwo");
    writeFileSync(join(dir, "binary"), Buffer.from([1, 0, 2]));
    writeFileSync(join(dir, "empty"), "");
    const changes = ["large", "text", "binary", "empty", "missing"].map(path => ({ path, xy: "??" }));
    assert.deepEqual(await diffStat(dir, changes), [
      { path: "large", xy: "??" },
      { path: "text", xy: "??", added: 2, removed: 0 },
      { path: "binary", xy: "??", binary: true },
      { path: "empty", xy: "??", added: 0, removed: 0 },
      { path: "missing", xy: "??" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot allows interval ticks while many untracked files are pending", { timeout: 5000 }, async () => {
  const dir = repo();
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    for (let i = 0; i < 512; i++) writeFileSync(join(dir, `file-${i}`), "data");
    let ticks = 0;
    timer = setInterval(() => ticks++, 1);
    const result = await snapshot(dir);
    assert.equal(result?.size, 512);
    assert.ok(ticks > 0, "the event loop must tick before snapshot resolves");
  } finally {
    clearInterval(timer);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parsePorcelainZ handles renames, spaces and non-ASCII paths", () => {
  const out = " M src/a.ts\0R  new name.ts\0old name.ts\0?? 文档/说明.md\0";
  assert.deepEqual(parsePorcelainZ(out), [
    { xy: " M", path: "src/a.ts" },
    { xy: "R ", path: "new name.ts" },
    { xy: "??", path: "文档/说明.md" },
  ]);
});

test("snapshots catch edits to files that were already dirty", async () => {
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
    const before = (await snapshot(dir))!;

    writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n"); // still " M", new content
    writeFileSync(join(dir, "新文件.txt"), "x\ny\n");
    const after = (await snapshot(dir))!;
    const changes = diffSnapshots(before, after);
    assert.deepEqual(changes.map((c) => c.path).sort(), ["a.txt", "新文件.txt"]);

    const stats = await diffStat(dir, changes);
    assert.deepEqual(stats.find((s) => s.path === "a.txt"), { path: "a.txt", xy: " M", added: 2, removed: 0 });
    assert.deepEqual(stats.find((s) => s.path === "新文件.txt"), { path: "新文件.txt", xy: "??", added: 2, removed: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot is undefined outside a git repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cd-nogit-"));
  try {
    assert.equal(await snapshot(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
