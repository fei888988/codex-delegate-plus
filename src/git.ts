import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
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

function git(cwd: string, args: string[]): Promise<{ status: number | null; stdout: string } | undefined> {
  return new Promise((resolve) => {
    try {
      const child = spawn("git", ["-c", "core.quotepath=off", ...args], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.on("error", () => resolve(undefined));
      child.on("close", (status) => resolve({ status, stdout: Buffer.concat(chunks).toString("utf8") }));
    } catch {
      resolve(undefined);
    }
  });
}

const MAX_COUNT_BYTES = 32 * 1024 * 1024;

async function fingerprint(file: string): Promise<string> {
  try {
    const st = await stat(file);
    if (!st.isFile()) return "dir";
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "deleted";
  }
}

/** Dirty paths to metadata fingerprints. Comparing snapshots catches edits to already-modified files. */
export type Snapshot = Map<string, { xy: string; hash: string }>;

export async function snapshot(cwd: string): Promise<Snapshot | undefined> {
  const r = await git(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (r?.status !== 0) return undefined;
  const snap: Snapshot = new Map();
  const entries = parsePorcelainZ(r.stdout);
  const fingerprints: string[] = new Array(entries.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(64, entries.length) }, async () => {
    while (next < entries.length) {
      const i = next++;
      fingerprints[i] = await fingerprint(join(cwd, entries[i]!.path));
    }
  }));
  for (const [i, e] of entries.entries()) snap.set(e.path, { xy: e.xy, hash: fingerprints[i]! });
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
export async function diffStat(cwd: string, changes: Change[]): Promise<FileStat[]> {
  const tracked = changes.filter((c) => c.xy !== "??").map((c) => c.path);
  const nums = new Map<string, { added?: number; removed?: number; binary?: boolean }>();
  if (tracked.length) {
    const r = await git(cwd, ["diff", "--numstat", "-z", "HEAD", "--", ...tracked]);
    if (r?.status === 0) {
      for (const rec of r.stdout.split("\0")) {
        const m = rec.match(/^(-|\d+)\t(-|\d+)\t(.+)$/s);
        if (!m) continue;
        nums.set(m[3]!, m[1] === "-" ? { binary: true } : { added: Number(m[1]), removed: Number(m[2]) });
      }
    }
  }
  const stats: FileStat[] = [];
  for (const c of changes) {
    stats.push(await fileStat(c));
  }
  return stats;

  async function fileStat(c: Change): Promise<FileStat> {
    if (c.xy === "??") {
      try {
        const file = join(cwd, c.path);
        if ((await stat(file)).size > MAX_COUNT_BYTES) return { ...c };
        const buf = await readFile(file);
        if (buf.includes(0)) return { ...c, binary: true };
        const text = buf.toString("utf8");
        return { ...c, added: text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0, removed: 0 };
      } catch {
        return { ...c };
      }
    }
    return { ...c, ...nums.get(c.path) };
  }
}
