import { delegate } from "./delegate.ts";
import { appendHandoff } from "./handoffs.ts";
import { atomic, finishInputs, readJson } from "./inbox.ts";
import { reapLongruns } from "./longruns.ts";
import { killOrphan, onExit } from "./procs.ts";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RunSummary } from "./run-summary.ts";

export async function continuationAvailability(run: RunSummary, runsDir: string) {
  if (run.state === "running") return { reason: "running" as const };
  if (!run.sessionId) return { reason: "no_session" as const };
  for (const name of await readdir(runsDir)) {
    const other = await readJson<RunSummary>(join(runsDir, name, "meta.json"));
    if (other?.state === "running" && other.sessionId === run.sessionId && other.heartbeatAt && Date.now() - other.heartbeatAt <= 90000)
      return { reason: "session_busy" as const, runId: other.id };
  }
  try { if (!run.cwd || !(await stat(run.cwd)).isDirectory()) return { reason: "cwd_missing" as const }; }
  catch { return { reason: "cwd_missing" as const }; }
  return {};
}

/** A hard OS kill has no exit callbacks; recover its owned runs before the service listens again. */
export async function recoverDashboardContinuations(runsDir: string) {
  let names: string[]; try { names = await readdir(runsDir); } catch { return; }
  for (const name of names) {
    const dir = join(runsDir, name);
    const meta = await readJson<RunSummary>(join(dir, "meta.json"));
    if (meta?.origin !== "dashboard" || meta.state !== "running" || !meta.pid) continue;
    try { process.kill(meta.pid, 0); continue; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") continue;
    }
    if (meta.codexPid) killOrphan(meta.codexPid);
    reapLongruns(dir, "dashboard exited");
    meta.state = "interrupted"; meta.phase = "done"; meta.exitKind = "cancelled";
    meta.inflight = undefined; meta.endedAt = Date.now(); meta.durationMs = meta.endedAt - meta.startedAt;
    meta.inputs = await finishInputs(dir);
    await atomic(join(dir, "meta.json"), meta);
    let reply = ""; try { reply = await readFile(join(dir, "last-message.txt"), "utf8"); } catch {}
    if (meta.sessionId) await appendHandoff(runsDir, meta.sessionId, { runId: meta.id, state: meta.state, endedAt: meta.endedAt, reply: reply.slice(0, 1500), changes: meta.changes?.map(c => c.path) });
  }
}

export function dashboardContinuations(runsDir: string, providersFile?: string) {
  const active = new Map<string, { controller: AbortController; promise: Promise<unknown>; meta?: RunSummary }>();
  let closing = false;
  // Exit is synchronous: persist terminal metadata before process cleanup kills Codex.
  onExit(() => {
    for (const item of active.values()) {
      item.controller.abort();
      if (!item.meta) continue;
      const meta = item.meta.state === "running"
        ? { ...item.meta, state: "interrupted", phase: "done", exitKind: "cancelled", inflight: undefined, endedAt: Date.now() }
        : item.meta;
      const dir = join(runsDir, meta.id);
      try { writeFileSync(join(dir, "meta.json"), JSON.stringify(meta)); } catch {}
      reapLongruns(dir, "dashboard exited");
      let reply = ""; try { reply = readFileSync(join(dir, "last-message.txt"), "utf8").slice(0, 1500); } catch {}
      try { appendFileSync(join(runsDir, "handoffs", encodeURIComponent(meta.sessionId!) + ".jsonl"), JSON.stringify({ runId: meta.id, state: meta.state, endedAt: meta.endedAt, reply, changes: meta.changes?.map(c => c.path) }) + "\n"); } catch {}
    }
  });
  return {
    async start(parent: RunSummary, text: string, notify: boolean) {
      if (closing) throw Error("Dashboard is shutting down");
      const session = parent.sessionId!;
      if (active.has(session)) return { reason: "session_busy", runId: active.get(session)!.meta?.id };
      // Reserve before any await: simultaneous HTTP requests cannot resume the same session.
      const controller = new AbortController();
      const item = { controller, promise: Promise.resolve() as Promise<unknown>, meta: undefined as RunSummary | undefined };
      active.set(session, item);
      let ready!: (id: string) => void, failed!: (e: unknown) => void;
      const started = new Promise<string>((resolve, reject) => { ready = resolve; failed = reject; });
      item.promise = delegate({
        prompt: "This message comes from the human user directly through the dashboard, not from the lead.\n\n" + text,
        session_id: session, cwd: parent.cwd, provider: parent.provider ?? "system",
        model: parent.model, effort: parent.effort, fast: parent.fast,
        sandbox: parent.sandbox === "read-only" ? "read-only" : "write",
        structured: false, fresh: true, title: text.replace(/\s+/g, " ").slice(0, 80),
      }, controller.signal, meta => {
        item.meta = meta;
        if (meta.id) ready(meta.id);
      }, undefined, { origin: "dashboard", parentRunId: parent.id, original: parent, runsDir, text, notify, providersFile })
        .catch(failed).finally(() => { active.delete(session); });
      return { runId: await started };
    },
    async shutdown() {
      closing = true;
      for (const item of active.values()) item.controller.abort();
      await Promise.allSettled([...active.values()].map(item => item.promise));
    },
  };
}
