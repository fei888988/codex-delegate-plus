import { readFile, writeFile, appendFile, rename, mkdir, readdir, stat, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface InputMessage { mid: string; mode: "steer" | "queue"; text: string; notify: boolean; at: number; from: "user" | "lead"; state?: string; stateAt?: number; error?: string; turn?: string }
export interface UserInterrupt { reason: string; killLongruns: boolean; at: number; state?: string }
export async function readJson<T>(file: string): Promise<T | undefined> { try { return JSON.parse(await readFile(file, "utf8")); } catch { return undefined; } }
export async function atomic(file: string, value: unknown) {
  await mkdir(join(file, ".."), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
}
export const inboxPath = (dir: string, mid: string) => join(dir, "inbox", `${mid}.json`);
async function locked<T>(dir: string, mid: string, fn: () => Promise<T>): Promise<T> {
  const lock = inboxPath(dir, `${mid}.lock`);
  await mkdir(join(dir, "inbox"), { recursive: true });
  for (let tries = 0; ; tries++) {
    try { await mkdir(lock); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || tries >= 200) throw e;
      await new Promise(r => setTimeout(r, 5));
    }
  }
  try { return await fn(); } finally { await rmdir(lock); }
}
export async function ack(dir: string, mid: string, state: string, error?: string, turn?: string) { await atomic(inboxPath(dir, `${mid}.ack`), { state, at: Date.now(), ...(error ? { error } : {}), ...(turn ? { turn } : {}) }); }
export async function messages(dir: string): Promise<InputMessage[]> {
  let names: string[]; try { names = await readdir(join(dir, "inbox")); } catch { return []; }
  const result: InputMessage[] = [];
  for (const name of names.filter(n => /^[\w-]+(?:\.claimed|\.editing)?\.json$/.test(n) && !n.startsWith("interrupt."))) {
    const m = await readJson<InputMessage>(join(dir, "inbox", name));
    if (!m?.mid || m.from !== "user") continue;
    const a = await readJson<{ state: string; at: number; error?: string; turn?: string }>(inboxPath(dir, `${m.mid}.ack`));
    result.push({ ...m, state: a?.state ?? "queued", stateAt: a?.at ?? m.at, error: a?.error, turn: a?.turn });
  }
  try { for (const line of (await readFile(join(dir, "inbox", "lead.jsonl"), "utf8")).split("\n")) { try { const m = JSON.parse(line); result.push({ ...m, notify: false, stateAt: m.at }); } catch {} } } catch {}
  return result.sort((a, b) => a.at - b.at || a.mid.localeCompare(b.mid));
}
/** Rename is the shared exclusion primitive: edit/withdraw and delivery cannot both own a file. */
export async function claim(dir: string, mid: string): Promise<InputMessage | undefined> {
  return locked(dir, mid, async () => {
    const a = await readJson<{ state: string }>(inboxPath(dir, `${mid}.ack`));
    if (a && a.state !== "queued") return undefined;
    try { await rename(inboxPath(dir, mid), inboxPath(dir, `${mid}.claimed`)); } catch { return undefined; }
    return readJson<InputMessage>(inboxPath(dir, `${mid}.claimed`));
  });
}
export async function markQueued(dir: string, mid: string) {
  await locked(dir, mid, async () => {
    if (await readJson(inboxPath(dir, mid)) && !await readJson(inboxPath(dir, `${mid}.ack`))) await ack(dir, mid, "queued");
  });
}
export async function editInput(dir: string, mid: string, text?: string): Promise<boolean> {
  return locked(dir, mid, async () => {
  const file = inboxPath(dir, mid), lock = inboxPath(dir, `${mid}.editing`);
  try { await rename(file, lock); } catch { return false; }
  try {
    const a = await readJson<{ state: string }>(inboxPath(dir, `${mid}.ack`));
    if (a && a.state !== "queued") return false;
    const m = await readJson<InputMessage>(lock);
    if (!m || m.mid !== mid || m.from !== "user") return false;
    if (text === undefined) { await ack(dir, mid, "withdrawn"); await rename(lock, inboxPath(dir, `${mid}.claimed`)); }
    else { await atomic(lock, { ...m, text }); await rename(lock, file); }
    return true;
  } finally { try { await rename(lock, file); } catch {} }
  });
}
export async function leadInput(dir: string, text: string, state: string) {
  await mkdir(join(dir, "inbox"), { recursive: true });
  await appendFile(join(dir, "inbox", "lead.jsonl"), JSON.stringify({ mid: randomUUID(), mode: "steer", text, at: Date.now(), from: "lead", state }) + "\n");
}
export async function finishInputs(dir: string) {
  for (const m of await messages(dir)) if (m.from === "user" && m.state === "queued" && await claim(dir, m.mid)) await ack(dir, m.mid, "undelivered");
  return messages(dir);
}
export function availability(run: { state: string; engine?: string; heartbeatAt?: number }) {
  return run.state !== "running" ? "not_running" : run.engine !== "app-server" ? "exec_engine" : !run.heartbeatAt || Date.now() - run.heartbeatAt > 90000 ? "stale_heartbeat" : undefined;
}
export async function launcherJobs(dir: string) {
  let names: string[]; try { names = await readdir(dir); } catch { return []; }
  const jobs = [];
  for (const name of names) {
    const match = /^cmd-(\d+)\.pid$/.exec(name); if (!match) continue;
    const n = Number(match[1]);
    try { await stat(join(dir, `cmd-${n}.exit`)); continue; } catch {}
    const pid = Number(await readFile(join(dir, name), "utf8"));
    try { process.kill(pid, 0); } catch { continue; }
    const m = await readJson<{ program: string; args?: string[]; startedAt: number }>(join(dir, `cmd-${n}.json`));
    jobs.push({ n, pid, command: [m?.program, ...(m?.args ?? [])].filter(Boolean).join(" "), startedAt: m?.startedAt, log: join(dir, `cmd-${n}.log`) });
  }
  return jobs;
}
export function renderInputs(inputs: InputMessage[]) {
  const users = inputs.filter(m => m.from === "user");
  return users.length ? "user input during run:\n" + users.map(m => `${m.mode} ${new Date(m.at).toISOString()} ${m.state}; turn ${m.turn ?? "(none)"}: ${m.text.slice(0, 300)}`).join("\n") : "";
}
export function interruptText(i: UserInterrupt, session: string | undefined, inputs: InputMessage[], jobs: { n: number; pid: number; log: string }[], dir: string) {
  return [`status: user_interrupted`, `reason: ${i.reason || "用户中断，原因不明 (the user interrupted without giving a reason)"}`,
    `next: PAUSE this work. Do not resume, retry or re-delegate on your own; tell the user it was interrupted and wait for their instruction. session_id ${session ?? "(none)"} can continue it later.`,
    ...inputs.filter(m => m.state === "undelivered").map(m => `undelivered ${m.mid}: ${m.text}`),
    ...jobs.map(j => i.killLongruns ? `stopped: cmd-${j.n} pid ${j.pid} log ${j.log}` : `kept running by user choice: cmd-${j.n} pid ${j.pid} log ${j.log} exit-file ${join(dir, `cmd-${j.n}.exit`)}; ask the user before stopping it.`)].join("\n");
}
