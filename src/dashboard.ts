import { readFile, readdir, stat, lstat } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";
import type { PendingRun } from "./pending.ts";
import type { StoredTask } from "./tasks.ts";
import { parseReport, READ_CONTRACT, WRITE_CONTRACT } from "./report.ts";
import { version, type RunSummary } from "./run-summary.ts";

const indexFile = fileURLToPath(new URL("../dashboard/index.html", import.meta.url));
const validId = /^[\w-]+$/;

async function text(file: string): Promise<string> {
  try { return await readFile(file, "utf8"); } catch { return ""; }
}

async function object<T>(file: string): Promise<T | undefined> {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch { return undefined; }
}

async function entries(dir: string) {
  try { return await readdir(dir, { withFileTypes: true }); } catch { return []; }
}

/** Legacy logs may end in an incomplete JSON line or contain a stderr tail. */
export async function readRun(runsDir: string, id: string): Promise<RunSummary | undefined> {
  if (!validId.test(id) || id === "pending" || id === "tasks") return undefined;
  const dir = join(runsDir, id);
  try { if (!(await lstat(dir)).isDirectory()) return undefined; } catch { return undefined; }
  const meta = await object<RunSummary>(join(dir, "meta.json"));
  if (meta && meta.id === id && typeof meta.startedAt === "number" && ["running", "ok", "error", "interrupted"].includes(meta.state)) {
    // A server that exits mid-run never writes the final state; once the log has been quiet for
    // longer than the run timeout, nothing is coming back.
    if (meta.state === "running") {
      let last = meta.startedAt;
      try { last = Math.max(last, (await stat(join(dir, "events.jsonl"))).mtimeMs); } catch {}
      if (Date.now() - last > (config.timeoutSec + 120) * 1000) meta.state = "interrupted";
    }
    return meta;
  }

  const stamp = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:-|$)/.exec(id);
  if (!stamp) return undefined;
  const startedAt = Date.UTC(+stamp[1]!, +stamp[2]! - 1, +stamp[3]!, +stamp[4]!, +stamp[5]!, +stamp[6]!);
  const [events, prompt, lastMessage] = await Promise.all([
    text(join(dir, "events.jsonl")), text(join(dir, "prompt.md")), text(join(dir, "last-message.txt")),
  ]);
  let endedAt: number | undefined;
  try { endedAt = (await stat(join(dir, "events.jsonl"))).mtimeMs; } catch {}
  const report = parseReport(lastMessage);
  const contractAt = [WRITE_CONTRACT, READ_CONTRACT].map((c) => prompt.indexOf(c)).filter((i) => i >= 0);
  const run: RunSummary = {
    id, startedAt, endedAt, state: "error",
    prompt: prompt.slice(0, contractAt.length ? Math.min(...contractAt) : undefined).slice(0, 2000),
    report, reportStatus: report?.status, summary: report?.summary, turns: 0,
  };
  for (const line of events.split(/\r?\n/)) {
    try {
      const e = JSON.parse(line);
      if (e.type === "thread.started") run.sessionId = e.thread_id;
      if (e.type === "turn.completed") {
        run.turns!++;
        const u = e.usage ?? {};
        run.tokens = { input: u.input_tokens ?? 0, cachedInput: u.cached_input_tokens ?? 0,
          output: u.output_tokens ?? 0, reasoning: u.reasoning_output_tokens ?? 0 };
      }
    } catch {}
  }
  run.state = run.turns ? "ok" : endedAt !== undefined && Date.now() - endedAt < 120_000 ? "running" : "error";
  if (endedAt !== undefined) run.durationMs = Math.max(0, endedAt - startedAt);
  return run;
}

async function records<T>(dir: string): Promise<T[]> {
  const files = (await entries(dir)).filter((e) => e.isFile() && e.name.endsWith(".json"));
  const values = await Promise.all(files.map((e) => object<T>(join(dir, e.name))));
  return values.filter((v): v is Awaited<T> => v !== undefined);
}

export function createDashboardServer(options: { runsDir?: string } = {}) {
  const runsDir = options.runsDir ?? config.runsDir;
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(value));
    };
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      json(405, { error: "Method not allowed" });
      return;
    }
    try {
      // Inspect the raw path: URL normalization would erase traversal segments before validation.
      const path = (req.url ?? "/").split("?")[0]!;
      if (path === "/") {
        try {
          const html = await readFile(indexFile);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        } catch {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Dashboard frontend not found");
        }
      } else if (path === "/api/runs") {
        const dirs = (await entries(runsDir)).filter((e) => e.isDirectory() && e.name !== "pending" && e.name !== "tasks");
        const [all, pending, tasks] = await Promise.all([
          Promise.all(dirs.map((e) => readRun(runsDir, e.name))),
          records<PendingRun>(join(runsDir, "pending")), records<StoredTask>(join(runsDir, "tasks")),
        ]);
        const runs = all.filter((r): r is RunSummary => !!r).sort((a, b) => b.startedAt - a.startedAt)
          .map(({ report, ...run }) => ({ ...run, prompt: run.prompt?.slice(0, 300) }));
        json(200, { generatedAt: Date.now(), runsDir, version, runs, pending, tasks: tasks.map(({ text, ...task }) => task) });
      } else if (path.startsWith("/api/runs/")) {
        let id: string;
        try { id = decodeURIComponent(path.slice("/api/runs/".length)); } catch { json(400, { error: "Invalid run id" }); return; }
        if (!validId.test(id)) { json(400, { error: "Invalid run id" }); return; }
        const run = await readRun(runsDir, id);
        if (!run) { json(404, { error: "Run not found" }); return; }
        const [promptFull, lastMessage] = await Promise.all([
          text(join(runsDir, id, "prompt.md")), text(join(runsDir, id, "last-message.txt")),
        ]);
        json(200, { ...run, promptFull, lastMessage });
      } else json(404, { error: "Not found" });
    } catch { json(500, { error: "Unable to read dashboard data" }); }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const value = process.env.CODEX_DELEGATE_DASHBOARD_PORT ?? "4318";
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid CODEX_DELEGATE_DASHBOARD_PORT");
  const server = createDashboardServer();
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address !== "string") console.log(`Dashboard: http://127.0.0.1:${address.port}`);
  });
}
