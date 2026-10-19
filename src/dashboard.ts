import { commandThreshold } from "./watchdog.ts";
import { readFile, readdir, stat, lstat } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config, configuredModel, EFFORT_ORDER } from "./config.ts";
import { listModels } from "./models.ts";
import { providersFile as defaultProvidersFile, loadProviders, saveProviders, validateProviders, maskedProviders, readCcswitch, importCcswitch, testProvider, syncTokens, removeProviderAuth, providerHome } from "./providers.ts";
import { DEFAULT_POLICY, loadPolicy, savePolicy, validatePolicy } from "./policy.ts";
import type { PendingRun } from "./pending.ts";
import type { StoredTask } from "./tasks.ts";
import { parseReport, READ_CONTRACT, WRITE_CONTRACT } from "./report.ts";
import { version, type RunSummary } from "./run-summary.ts";
import { readTimeline } from "./timeline.ts";

const indexFile = fileURLToPath(new URL("../dashboard/index.html", import.meta.url));
const validId = /^[\w-]+$/;

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

export function deriveHealth(run: RunSummary, now = Date.now(), alive = pidAlive): NonNullable<RunSummary["health"]> {
  if (run.state !== "running") return "ok";
  if ((run.pid !== undefined && !alive(run.pid)) || (run.heartbeatAt !== undefined && now - run.heartbeatAt > 90000)) return "orphaned";
  const check = run.phase === "checks" ? run.checks?.find((c) => c.state === "running") : undefined;
  const last = check ? check.lastOutputAt ?? check.startedAt : run.stallWindowSince ?? run.lastEventAt ?? run.startedAt;
  const age = now - last;
  const limit = check ? run.checkIdleTimeoutSec ?? config.checkIdleTimeoutSec
    : run.effectiveThresholdSec ?? (run.inflight?.type === "command_execution" ? commandThreshold(run.inflight.command ?? "", run.commandIdleTimeoutSec ?? config.commandIdleTimeoutSec, run.stallPolicy?.long_commands).seconds
    : run.idleTimeoutSec ?? config.idleTimeoutSec);
  if (!check && run.suspicion) return "stalled";
  if (limit > 0 && age > limit * 1000) return "stalled";
  if (age < 120000) return "active";
  return "quiet";
}

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
    if (meta.state === "running" && meta.pid === undefined && meta.heartbeatAt === undefined && meta.lastEventAt === undefined) {
      let last = meta.startedAt;
      try { last = Math.max(last, (await stat(join(dir, "events.jsonl"))).mtimeMs); } catch {}
      if (Date.now() - last > (config.timeoutSec + 120) * 1000) meta.state = "interrupted";
      meta.lastEventAt = last;
    }
    meta.health = deriveHealth(meta);
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
  run.lastEventAt = endedAt;
  run.health = deriveHealth(run);
  return run;
}

async function records<T>(dir: string): Promise<T[]> {
  const files = (await entries(dir)).filter((e) => e.isFile() && e.name.endsWith(".json"));
  const values = await Promise.all(files.map((e) => object<T>(join(dir, e.name))));
  return values.filter((v): v is Awaited<T> => v !== undefined);
}

const MAX_BODY = 64 * 1024;

async function body(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Writes are only accepted from the dashboard page itself: a loopback Host (blocks DNS rebinding),
 * a matching Origin when the browser sends one, and a JSON content type, which a cross-site form or
 * no-cors fetch can't send without a preflight that this server never answers.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) return false;
  return /^application\/json\b/i.test(req.headers["content-type"] ?? "");
}

export function createDashboardServer(options: { runsDir?: string; policyFile?: string; providersFile?: string; ccswitchFile?: string; homesRoot?: string; codexHome?: string } = {}) {
  const runsDir = options.runsDir ?? config.runsDir;
  const policyFile = options.policyFile ?? config.policyFile;
  const providersFile = options.providersFile ?? defaultProvidersFile;
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(value));
    };
    // Inspect the raw path: URL normalization would erase traversal segments before validation.
    const path = (req.url ?? "/").split("?")[0]!;
    const allow = path === "/api/policy" || path === "/api/providers" ? "GET, PUT" : path === "/api/providers/ccswitch/import" || /^\/api\/providers\/[^/]+\/(test|sync)$/.test(path) ? "POST" : "GET";
    if (!allow.split(", ").includes(req.method ?? "")) {
      res.setHeader("Allow", allow);
      json(405, { error: "Method not allowed" });
      return;
    }
    try {
      if (path === "/api/providers" || path.startsWith("/api/providers/")) {
        if (req.method !== "GET" && !sameOrigin(req)) { json(403, { error: "Forbidden" }); return; }
        try {
          if (path === "/api/providers") {
            if (req.method === "PUT") {
              const previous = loadProviders(providersFile);
              const doc = validateProviders(JSON.parse(await body(req)), previous);
              // The isolated home is keyed by id, so renaming a ChatGPT account would orphan its tokens.
              for (const p of doc.providers) if (p.source && previous.providers.some(old => old.auth === "chatgpt" && old.source?.id === p.source!.id && old.id !== p.id)) throw Error("ChatGPT account id cannot be changed");
              saveProviders(doc, providersFile);
              for (const p of previous.providers) if (!doc.providers.some(next => next.id === p.id && next.auth === "chatgpt")) removeProviderAuth(p, options);
            }
            json(200, maskedProviders(loadProviders(providersFile), options));
          } else if (path === "/api/providers/ccswitch") {
            json(200, maskedProviders({ defaultProvider: null, providers: readCcswitch(options.ccswitchFile) }));
          } else if (path === "/api/providers/ccswitch/import") {
            const input = JSON.parse(await body(req));
            if (!Array.isArray(input?.ids) || input.ids.some((id: unknown) => typeof id !== "string")) throw Error("ids must be a string array");
            const doc = importCcswitch(loadProviders(providersFile), readCcswitch(options.ccswitchFile), input.ids, options);
            saveProviders(doc, providersFile);
            json(200, maskedProviders(doc, options));
          } else if (/^\/api\/providers\/[^/]+\/(test|sync)$/.test(path)) {
            const id = decodeURIComponent(path.split("/")[3]!);
            const provider = loadProviders(providersFile).providers.find(p => p.id === id);
            if (!provider) { json(404, { error: "Unknown provider id" }); return; }
            if (path.endsWith("/sync")) {
              if (provider.auth !== "chatgpt" || provider.sync !== true || provider.source?.type !== "cc-switch") throw Error("Sync requires a ChatGPT cc-switch provider with sync enabled");
              json(200, await syncTokens(provider, options));
            } else json(200, await testProvider(provider, options));
          } else json(404, { error: "Not found" });
        } catch (e) {
          // Validation errors contain field names/line numbers only, never submitted values.
          json(400, { error: e instanceof SyntaxError ? "Invalid JSON body" : e instanceof Error ? e.message : "Invalid provider request" });
        }
      } else if (path === "/api/policy") {
        if (req.method === "PUT") {
          if (!sameOrigin(req)) { json(403, { error: "Forbidden" }); return; }
          let parsed: unknown;
          try { parsed = JSON.parse(await body(req)); } catch { json(400, { error: "Body must be a JSON policy of at most 64 KB" }); return; }
          const r = validatePolicy(parsed);
          if (!r.ok) { json(400, { error: r.error }); return; }
          savePolicy(r.policy, policyFile);
        }
        const { policy, error } = loadPolicy(policyFile);
        json(200, {
          policy, error, defaults: DEFAULT_POLICY, file: policyFile, models: listModels(), efforts: EFFORT_ORDER,
          defaultModel: config.defaultModel ?? configuredModel(),
        });
      } else if (path === "/") {
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
        const timeline = path.endsWith("/timeline");
        let id: string;
        try { id = decodeURIComponent(path.slice("/api/runs/".length, timeline ? -"/timeline".length : undefined)); } catch { json(400, { error: "Invalid run id" }); return; }
        if (!validId.test(id)) { json(400, { error: "Invalid run id" }); return; }
        const run = await readRun(runsDir, id);
        if (!run) { json(404, { error: "Run not found" }); return; }
        if (timeline) {
          const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
          const value = query.get("after") ?? "0";
          if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || query.getAll("after").length > 1) {
            json(400, { error: "Invalid after sequence" }); return;
          }
          const provider = loadProviders(providersFile).providers.find(p => p.id === run.provider);
          json(200, await readTimeline(runsDir, run, Number(value), provider?.auth === "chatgpt" ? providerHome(provider, options.homesRoot) : options.codexHome));
          return;
        }
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
