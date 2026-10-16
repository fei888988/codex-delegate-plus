import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface StatusEntry {
  xy: string;
  path: string;
}

/** Parses `git status --porcelain -z`. Paths come out raw (no C-quoting), so non-ASCII names survive. */
export function parsePorcelainZ(out: string): StatusEntry[] {
  const parts = out.split("\0");
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.length < 4) continue;
    const xy = p.slice(0, 2);
    entries.push({ xy, path: p.slice(3) });
    // Renames/copies are followed by the original path as its own NUL-terminated field.
    if (xy[0] === "R" || xy[0] === "C") i++;
  }
  return entries;
}

function git(cwd: string, args: string[]) {
  return spawnSync("git", ["-c", "core.quotepath=off", ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
}

const MAX_HASH_BYTES = 32 * 1024 * 1024;

function fingerprint(file: string): string {
  try {
    const st = statSync(file);
    if (!st.isFile()) return "dir";
    if (st.size > MAX_HASH_BYTES) return `big:${st.size}:${st.mtimeMs}`;
    return createHash("sha1").update(readFileSync(file)).digest("hex");
  } catch {
    return "deleted";
  }
}

/** Dirty paths → content fingerprint. Comparing two snapshots catches edits to already-modified files. */
export type Snapshot = Map<string, { xy: string; hash: string }>;

export function snapshot(cwd: string): Snapshot | undefined {
  const r = git(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (r.status !== 0) return undefined;
  const snap: Snapshot = new Map();
  for (const e of parsePorcelainZ(r.stdout)) snap.set(e.path, { xy: e.xy, hash: fingerprint(join(cwd, e.path)) });
  return snap;
}

export interface Change {
  path: string;
  /** Porcelain status after the run ("  " when the run reverted a previously dirty file). */
  xy: string;
}

export function diffSnapshots(before: Snapshot, after: Snapshot): Change[] {
  const changes: Change[] = [];
  for (const [path, a] of after) {
    const b = before.get(path);
    if (!b || b.hash !== a.hash || b.xy !== a.xy) changes.push({ path, xy: a.xy });
  }
  for (const path of before.keys()) if (!after.has(path)) changes.push({ path, xy: "  " });
  return changes.sort((x, y) => x.path.localeCompare(y.path));
}

export interface FileStat {
  path: string;
  xy: string;
  added?: number;
  removed?: number;
  binary?: boolean;
}

/** Line counts per changed file (tracked: `git diff --numstat HEAD`; untracked: line count of the file). */
export function diffStat(cwd: string, changes: Change[]): FileStat[] {
  const tracked = changes.filter((c) => c.xy !== "??").map((c) => c.path);
  const nums = new Map<string, { added?: number; removed?: number; binary?: boolean }>();
  if (tracked.length) {
    const r = git(cwd, ["diff", "--numstat", "-z", "HEAD", "--", ...tracked]);
    if (r.status === 0) {
      for (const rec of r.stdout.split("\0")) {
        const m = rec.match(/^(-|\d+)\t(-|\d+)\t(.+)$/s);
        if (!m) continue;
        nums.set(m[3]!, m[1] === "-" ? { binary: true } : { added: Number(m[1]), removed: Number(m[2]) });
      }
    }
  }
  return changes.map((c) => {
    if (c.xy === "??") {
      try {
        const buf = readFileSync(join(cwd, c.path));
        if (buf.includes(0)) return { ...c, binary: true };
        const text = buf.toString("utf8");
        return { ...c, added: text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0, removed: 0 };
      } catch {
        return { ...c };
      }
    }
    return { ...c, ...nums.get(c.path) };
  });
}
