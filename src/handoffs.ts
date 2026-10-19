import { appendFile, mkdir, readdir, readFile, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { atomic, readJson } from "./inbox.ts";
import { config } from "./config.ts";

export interface Handoff {
  runId: string; parentRunId?: string; sessionId?: string; cwd?: string; text?: string;
  notify?: boolean; parentPid?: number; at?: number; state: string;
  endedAt?: number; reply?: string; changes?: string[];
}
const key = (session: string) => encodeURIComponent(session);
export async function appendHandoff(dir: string, session: string, record: Handoff) {
  await mkdir(join(dir, "handoffs"), { recursive: true });
  await appendFile(join(dir, "handoffs", key(session) + ".jsonl"), JSON.stringify(record) + "\n");
}
async function handoffs(dir: string): Promise<Map<string, Handoff[]>> {
  const result = new Map<string, Handoff[]>();
  let files: string[]; try { files = await readdir(join(dir, "handoffs")); } catch { return result; }
  for (const file of files.filter(f => f.endsWith(".jsonl"))) {
    const records = new Map<string, Handoff>();
    for (const line of (await readFile(join(dir, "handoffs", file), "utf8")).split("\n")) {
      try { const e = JSON.parse(line); if (e.runId) records.set(e.runId, { ...records.get(e.runId), ...e }); } catch {}
    }
    result.set(file.slice(0, -6), [...records.values()]);
  }
  return result;
}
export function renderHandoffs(records: Handoff[]) {
  return "user continued this codex session from the dashboard:\n" + records.map(r =>
    `${new Date(r.at ?? r.endedAt ?? Date.now()).toISOString()} run ${r.runId}\nuser: ${r.text}\nstate: ${r.state}\ncodex: ${r.reply ?? "(still running)"}\nchanged files: ${r.changes?.join(", ") || "(unavailable)"}`).join("\n") +
    "\nnext: take the user's changes into account; the session's latest state includes them.";
}
// Async directory mutex coordinates simultaneous tool responses and multiple MCP processes.
export async function consumeHandoffs(session?: string, dir = config.runsDir, notifyOnly = false): Promise<string> {
  const blocks: string[] = [];
  for (const [id, records] of await handoffs(dir)) {
    if (session && id !== key(session)) continue;
    const lock = join(dir, "handoffs", id + ".lock");
    let acquired = false;
    for (let n = 0; n < 200; n++) {
      try { await mkdir(lock); acquired = true; break; } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        await new Promise(r => setTimeout(r, 5));
      }
    }
    if (!acquired) continue;
    try {
      const file = join(dir, "handoffs", id + ".consumed.json");
      const consumed = await readJson<string[]>(file) ?? [];
      const fresh = records.filter(r => !consumed.includes(r.runId) && (!notifyOnly || r.notify && r.parentPid === process.pid));
      if (!fresh.length) continue;
      blocks.push((notifyOnly ? `status: user_continued (another codex run, started by the user from the dashboard, is ${fresh.some(r => r.state === "started") ? "running" : "finished"})\n` : "") + renderHandoffs(fresh));
      await atomic(file, [...consumed, ...fresh.map(r => r.runId)]);
    } finally { await rmdir(lock); }
  }
  return blocks.join("\n\n");
}
export async function hasNotifyHandoffs(dir = config.runsDir) {
  for (const [id, records] of await handoffs(dir)) {
    const consumed = await readJson<string[]>(join(dir, "handoffs", id + ".consumed.json")) ?? [];
    if (records.some(r => r.notify && r.parentPid === process.pid && !consumed.includes(r.runId))) return true;
  }
  return false;
}
