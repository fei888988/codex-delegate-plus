#!/usr/bin/env node
import { sweepOrphanedRuns } from "./run-lifecycle.ts";
import { consumeHandoffs } from "./handoffs.ts";
import { watchProviders } from "./providers.ts";
import { cleanupRuns } from "./observability.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { z } from "zod";
import { config, configuredModel } from "./config.ts";
import { formatOutcome } from "./delegate.ts";
import { listModels } from "./models.ts";
import { loadPolicy, tierLabel, type Policy } from "./policy.ts";
import { watchFile } from "node:fs";
import { listSessions } from "./sessions.ts";
import { appendDeferredCheckpoints, delegateSync, formatUserInputs, newUserInputs, inspectTask, formatCheckpoints, formatSuspicion, getTask, newCheckpoints, runningProgress, listTasks, startTask, steerTask, storedTask, waitTask, type Task } from "./tasks.ts";
import { installExitCleanup } from "./procs.ts";
import { progressHeartbeat } from "./heartbeat.ts";
import { patrolMinimum } from "./patrol.ts";
import { formatPatrolAlerts, newPatrolAlerts, wakeSuspicion } from "./tasks.ts";
import pkg from "../package.json" with { type: "json" };

installExitCleanup();
void sweepOrphanedRuns(config.runsDir);
const cleanup = () => {
  try { cleanupRuns(config.runsDir, loadPolicy().policy.retention); } catch (e) { console.error(`codex-delegate cleanup: ${e}`); }
};
cleanup();
setInterval(cleanup, 3600000).unref();
const server = new McpServer({ name: "codex-delegate", version: pkg.version });

const text = async (t: string, isError = false, session?: string) => {
  const notified = await consumeHandoffs(undefined, config.runsDir, true);
  const matching = session ? await consumeHandoffs(session) : "";
  return { content: [{ type: "text" as const, text: [matching, notified, t].filter(Boolean).join("\n\n") }], isError };
};

/**
 * `effort` names a tier of the cost policy (policy.ts): each tier fixes a model and an effort. The
 * enum, the tier list and the guidance follow the policy file, which the dashboard edits.
 */
function effortParam(policy: Policy) {
  const ids = policy.tiers.map((t) => t.id) as [string, ...string[]];
  return z.enum(ids).describe(
    "Cost tier for this run, chosen by you from the task's difficulty; it sets the model and reasoning effort (an explicit `model` overrides the tier's model). Tiers, cheapest first:\n" +
      policy.tiers.map((t) => `- ${t.id} (${tierLabel(t)}): ${t.use}`).join("\n") +
      "\nA follow-up (same session_id) may use a different tier.",
  );
}

const CHECKPOINT_DESCRIPTION = "\n\nCheckpoints: for long tasks (roughly 10+ minutes, multi-phase work, or an investigation whose findings could change the plan) set checkpoints: true. Codex then writes a short stage report at points where direction may change (findings before implementing, scope surprises, before slow or hard-to-undo steps) and keeps working; only reports marked Needs lead: yes return early with `status: checkpoint`; progress reports accompany the next result. Read it and either keep waiting (task_result with wait_s) or redirect (task_steer). Skip checkpoints for short, well-specified tasks: decision reports cost a turn.";
const STALL_DESCRIPTION = " Patrol is on by default: use task_result(wait_s: 86400) once for long waits. Healthy and uncertain patrols do not wake you, nor does a first off_course (a second in a row does); those ride along on the next result as patrol notes. patrol_alert or patrol_failed means the worker is still running. Watchdog suspicions are triaged first; the third consecutive suspicion always wakes you. Set patrol: false for direct suspicion wakes. When the brief includes long-running commands (full test suites, training, backtests, big builds), set stall.long_commands for them. A status: suspected_stall result means Codex is still running: inspect cheaply, then task_result to keep waiting or task_cancel.";
const DELEGATE_DESCRIPTION =
  "Run a task with an OpenAI model through the Codex CLI and wait for it to finish. The model works in `cwd` with Codex's own tools (shell, apply_patch), so it investigates, implements and tests on its own. Returns a compact report (status, summary, verification, questions), session_id (for follow-ups), per-file git line counts and, if `checks` were given, host-run PASS/FAIL. The full event log stays on disk. For long tasks or running several in parallel, use delegate_async.\n\nYou are the lead; your tokens are the expensive ones. Delegate early: don't read the codebase first to plan steps, Codex does that. Brief = goal, constraints, acceptance (what, not how); if the user already wrote a spec, pass its implementation requirements as written and keep any commit step with you. Put test/build commands in `checks`. Codex leaves changes uncommitted: never ask it to commit in a brief or follow-up. If the user requests a commit, keep that step with you after acceptance and passing host checks; push only when authorized. When passing through a user spec, delegate its implementation requirements and retain its commit step yourself. Afterwards, treat PASS checks as evidence and spot-check only the diffs where design or risk matters; send problems back with session_id. A result whose first line is `status: needs_decision` (or partial/blocked) is not finished: make the decisions yourself and resume the same session_id with them in this turn; ask the user only for choices that are really theirs.\n\nIf the user stopped a delegate call (no result came back) and then changed or added requirements, just call delegate again in the same cwd with the new direction: the server continues the interrupted Codex session automatically, with its context and partial edits, and tells Codex the new message wins. Don't inspect the working tree first or restate the old brief; state what changed plus anything Codex needs to know. Pass fresh: true only to abandon the interrupted work.";
const ASYNC_DESCRIPTION =
  "Same as delegate, but returns a task_id immediately while the Codex model works in the background. Use for long tasks or to run several in parallel; then call task_result to collect output. Parallel tasks editing the same directory can conflict — give each its own cwd/worktree or non-overlapping files.\n\nA running task can be steered: when the user adds or changes requirements mid-task, call task_steer(task_id, prompt) with the change instead of cancelling and restarting; Codex keeps its context and work. Prefer delegate_async over delegate for long writer tasks the user may want to redirect.";
const withGuidance = (d: string, policy: Policy) => (policy.guidance ? `${d}\n\n${policy.guidance}` : d);

const delegateShape = {
  prompt: z
    .string()
    .min(1)
    .describe(
      "Complete, self-contained task for the Codex model. It cannot see this conversation: include goal, relevant files/paths, constraints, and acceptance criteria.",
    ),
  provider: z.string().optional().describe("Provider id from ~/.codex-delegate/providers.json, or system to force the system Codex configuration. Precedence: call > tier provider > defaultProvider > system. Explicit model wins, then the tier's model/effort; provider.model/effort only fill what the tier leaves unset."),
  model: z
    .string()
    .optional()
    .describe(
      `Codex model: exact slug (e.g. 'gpt-6-sol') or a loose name ('sol 6', 'gpt 6 luna', '5.6 terra'). Omit to use the default: ${config.defaultModel ?? `the model in ~/.codex/config.toml${configuredModel() ? ` (${configuredModel()})` : ""}`}. On a follow-up (session_id) omitting it keeps the session's model.`,
    ),
  effort: effortParam(loadPolicy().policy),
  fast: z
    .boolean()
    .optional()
    .describe(`Fast service tier (priority): faster responses, higher usage. false forces the normal tier. Default: ${config.fast ?? "service_tier from ~/.codex/config.toml"}.`),
  cwd: z.string().optional().describe("Working directory for the task (absolute, or relative to the server's cwd). Defaults to the current project."),
  images: z.array(z.string()).optional().describe("Image files to attach to the prompt (screenshots, mockups)."),
  session_id: z.string().optional().describe("Continue an existing Codex session (returned by a previous call) for follow-ups."),
  fork: z.boolean().optional().describe("Fork the session given by session_id into a new session instead of appending to it."),
  sandbox: z.preprocess(value => value === "workspace-write" || value === "danger-full-access" ? "write" : value,
    z.enum(["read-only", "write"]).optional()).meta({ type: "string", enum: ["read-only", "write"] })
    .describe("read-only for investigations, reviews and questions; write for anything that edits files or runs builds/tests. Write uses the panel sandbox toggle (off by default)."),
  add_dirs: z.array(z.string()).optional().describe("Additional writable directories for the panel sandbox; one --add-dir per directory."),
  auto: z
    .boolean()
    .optional()
    .describe(`Shorthand: false = read-only sandbox, for reading files, reviews and questions. Default: ${config.auto}. An explicit sandbox wins.`),
  title: z.string().optional().describe("Short label shown in task_list."),
  patrol: z.union([z.literal(false), z.object({ every_s: z.number().min(patrolMinimum()).optional(), watch: z.string().optional() })]).optional().describe("Default ON: cheap read-only Codex patrol. every_s >= 600 (policy default 1800); watch describes expected duration, off-course signs and known silent commands. false disables."),
  stall: z.object({
    silent_s: z.number().int().min(0).optional(),
    command_s: z.number().int().min(0).optional(),
    long_commands: z.array(z.object({ match: z.string(), idle_s: z.number().int().min(0) })).optional(),
  }).optional().describe("Soft suspicion windows in seconds (0 disables); first case-insensitive command regex wins, call rules before policy rules; invalid regex is ignored."),
  idle_timeout_s: z.number().int().min(0).optional().describe("Compatibility: set both soft suspicion windows; explicit stall fields win; 0 disables."),
  timeout_s: z.number().int().positive().optional().describe(`Kill the run after this many seconds. Default with patrol: policy patrol.timeout_default_s (14400); without patrol: ${config.timeoutSec}. Explicit CODEX_DELEGATE_TIMEOUT overrides the patrol default; timeout_s always wins.`),
  checks: z
    .array(z.string())
    .optional()
    .describe(
      `Shell commands (tests, build, lint) the server runs on the host in cwd after codex finishes, through ${process.platform === "win32" ? "cmd.exe (Windows: no bash syntax)" : "/bin/sh"}. Results come back as PASS/FAIL with the output tail on failure, so you don't need to re-run them yourself.`,
    ),
  structured: z
    .boolean()
    .optional()
    .describe(`Ask codex to finish with a JSON report (status done/partial/blocked/needs_decision, summary, changes, verification, risks, questions). Default: ${config.structured} for runs that may edit files; read-only runs always answer in prose.`),
  fresh: z
    .boolean()
    .optional()
    .describe("Start a new Codex session even if an interrupted run in this cwd would otherwise be continued (the user wants to drop it, or the new task is unrelated)."),
  checkpoints: z
    .boolean()
    .optional()
    .describe("Ask Codex for stage reports at direction-changing points; only reports marked Needs lead: yes return this call early (status: checkpoint) while Codex keeps working. For long or open-ended tasks."),
};

server.registerTool(
  "list_models",
  {
    title: "List Codex models",
    description: "List the models available to the local Codex CLI account, with their supported reasoning efforts.",
    inputSchema: {
      filter: z.string().optional().describe("Case-insensitive substring filter, e.g. 'sol' or 'gpt-6'."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ filter }) => {
    let models = listModels();
    if (!models.length) return text(`no model cache at ${config.codexHome}/models_cache.json — run \`codex\` once to populate it. Model slugs are still passed through as given.`, true);
    if (filter) models = models.filter((m) => m.slug.toLowerCase().includes(filter.toLowerCase()));
    const dflt = config.defaultModel ?? configuredModel();
    const lines = models.map((m) => `${m.slug}${m.slug === dflt ? " (default)" : ""}  efforts: ${m.efforts.join(", ")}`);
    return text(lines.length ? lines.join("\n") : "(no models match)");
  },
);

const delegateTool = server.registerTool(
  "delegate",
  {
    title: "Delegate a task to a Codex model",
    description: withGuidance(DELEGATE_DESCRIPTION + CHECKPOINT_DESCRIPTION + STALL_DESCRIPTION, loadPolicy().policy),
    inputSchema: delegateShape,
  },
  async (input, extra) => {
    const stopHeartbeat = progressHeartbeat(extra);
    try {
      const task = await delegateSync(input, extra.signal);
      const sessionText = (value: string, error = false) => text(appendDeferredCheckpoints(task, value), error, task.progress?.sessionId ?? task.outcome?.result.sessionId);
      if (task.status === "running" && newUserInputs(task).length) return sessionText(formatUserInputs(task));
      if (task.status === "running" && newCheckpoints(task).length) return sessionText(formatCheckpoints(task));
      if (task.status === "running" && newPatrolAlerts(task).length) return sessionText(formatPatrolAlerts(task));
      if (task.status === "running" && wakeSuspicion(task)) return sessionText(formatSuspicion(task));
      if (task.status === "running") return sessionText(`${taskSummary(task)}\n${runningProgress(task)}\nstill running; call task_result to keep waiting.`);
      if (task.outcome) {
        // Alerts raised before the worker finished ride along with its result instead of costing an extra wake.
        const alerts = newPatrolAlerts(task).length ? `${formatPatrolAlerts(task)}\n\n` : "";
        task.shownStop = true;
        return sessionText(alerts + formatOutcome(task.outcome), !task.outcome.result.ok);
      }
      return sessionText(task.error ?? "delegate failed", true);
    } catch (e) {
      return text(String(e instanceof Error ? e.message : e), true, input.session_id);
    } finally {
      stopHeartbeat();
    }
  },
);

function taskSummary(t: Task): string {
  const secs = (((t.finishedAt ?? Date.now()) - t.startedAt) / 1000).toFixed(0);
  const model = t.outcome?.model ?? t.input.model ?? "(default)";
  // A finished task whose report isn't "done" (needs_decision, partial, blocked) is waiting on the lead.
  const report = t.outcome?.report?.status;
  const status = t.status === "done" && report && report !== "done" ? `${report} ← needs you` : t.status === "running" && wakeSuspicion(t) ? "suspected_stall" : t.status;
  return `${t.id}  ${status.padEnd(9)} ${secs}s  ${model}  ${t.input.title ?? t.input.prompt.slice(0, 60).replace(/\s+/g, " ")}`;
}

const asyncTool = server.registerTool(
  "delegate_async",
  {
    title: "Start a Codex task in the background",
    description: withGuidance(ASYNC_DESCRIPTION + CHECKPOINT_DESCRIPTION + STALL_DESCRIPTION, loadPolicy().policy),
    inputSchema: delegateShape,
  },
  async (input) => {
    const t = startTask(input);
    return text(`started ${t.id}\nCall task_result with task_id="${t.id}" (optionally wait_s) to get the output.`);
  },
);

server.registerTool(
  "task_result",
  {
    title: "Get a background Codex task's result",
    description: "Return a background task result; wait_s waits for completion or an alert. With patrol on (default), pass a large wait_s (e.g. 86400) once instead of repeating short waits. Progress heartbeats keep the wait alive; patrol_alert/patrol_failed leave the worker running. stall_after_s sets the next window for the current item; otherwise each acknowledged wake doubles it.",
    inputSchema: {
      task_id: z.string(),
      stall_after_s: z.number().int().min(0).optional().describe("Next suspicion window for the current item in seconds; 0 disables until new output."),
      wait_s: z.number().int().min(0).max(86400).optional().describe("Seconds to wait for completion before returning (default 0)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ task_id, wait_s, stall_after_s }, extra) => {
    const stopHeartbeat = progressHeartbeat(extra);
    try {
      const t = getTask(task_id);
      const sessionText = (value: string, error = false) => text(t ? appendDeferredCheckpoints(t, value) : value, error, t?.progress?.sessionId ?? t?.outcome?.result.sessionId ?? storedTask(task_id)?.sessionId);
      if (!t) {
        const s = storedTask(task_id);
        if (!s) return sessionText(`unknown task_id '${task_id}'`, true);
        if (s.status === "interrupted") return sessionText(`task: ${s.id} (interrupted)\nthe server that ran it exited before it finished; ${s.sessionId ? `continue it with delegate(session_id="${s.sessionId}")` : "re-run it"} (check git status first).`, true);
        if (s.status === "user_interrupted") return sessionText(s.text ?? "status: user_interrupted");
        return sessionText(`task: ${s.id} (${s.status})\n${s.text ?? ""}`, s.status !== "done");
      }
      await waitTask(t, wait_s ?? 0, stall_after_s);
      if (t.status === "running" && newUserInputs(t).length) return sessionText(formatUserInputs(t));
      if (t.status === "running" && newCheckpoints(t).length) return sessionText(formatCheckpoints(t));
      if (t.status === "running" && newPatrolAlerts(t).length) return sessionText(formatPatrolAlerts(t));
      if (t.status === "running" && wakeSuspicion(t)) return sessionText(formatSuspicion(t));
      if (t.status === "running") return sessionText(`${taskSummary(t)}\n${runningProgress(t)}\nstill running — call again later or with a larger wait_s.`);
      if (t.outcome?.result.userInterrupt) return sessionText(formatOutcome(t.outcome));
      if (t.outcome) {
        const alerts = newPatrolAlerts(t).length ? `${formatPatrolAlerts(t)}\n\n` : "";
        t.shownStop = true;
        return sessionText(`${alerts}task: ${t.id} (${t.status})\n${formatOutcome(t.outcome)}`, t.status !== "done");
      }
      return sessionText(`task: ${t.id} (${t.status})\nerror: ${t.error}`, true);
    } finally { stopHeartbeat(); }
  },
);

server.registerTool(
  "task_inspect",
  {
    title: "Inspect a Codex task",
    description: "Fresh process evidence and delta, newest command log tail, last five events and recently modified files. Does not acknowledge or re-arm a stall wake.",
    inputSchema: { task_id: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ task_id }) => {
    const task = getTask(task_id);
    if (task) return text(await inspectTask(task), false, task.progress?.sessionId ?? task.outcome?.result.sessionId);
    const stored = storedTask(task_id);
    return stored ? text(stored.text ?? `task: ${stored.id} (${stored.status})`, false, stored.sessionId) : text(`unknown task_id '${task_id}'`, true);
  },
);

server.registerTool(
  "task_list",
  {
    title: "List background Codex tasks",
    description: "List delegate_async tasks started by this server with their status.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const all = listTasks();
    return text(all.length ? all.map(taskSummary).join("\n") : "(no tasks)");
  },
);

server.registerTool(
  "task_steer",
  {
    title: "Steer a running Codex task",
    description: "Add a message to a running Codex task (delegate_async, or a delegate that returned at a checkpoint): new or changed requirements, a correction, a hint. Codex keeps its context and edits. By default it reads the message at its next step, after any command in flight. With now: true Codex reads it at once while a long command keeps running: say in the message whether that command should continue, what to check first (log, partial results), or that it should be stopped; Codex must account for it before finishing. Look at it first with task_inspect if you need to. kill: true also stops the command. task_cancel stops the whole task. Returns right away; collect with task_result.",
    inputSchema: {
      task_id: z.string(),
      prompt: z.string().min(1).describe("What changed, in full: Codex sees only this text plus its own context. State whether it replaces or adds to the brief."),
      now: z.boolean().optional().describe("true = interrupt Codex's current step so it reads this at once. A long command it started through the server's launcher keeps running and Codex must decide what to do with it (wait, check, stop) as part of your message. Default false: Codex reads it at its next step, after the command in flight."),
      kill: z.boolean().optional().describe("With now: true, also stop the long command(s) in flight at once. Only when they must not continue (e.g. writing bad data); otherwise say in prompt what Codex should check before deciding."),
    },
  },
  async ({ task_id, prompt, now, kill }) => {
    const t = getTask(task_id);
    if (!t) return text(`unknown task_id '${task_id}' (only tasks of this server can be steered)`, true);
    const r = await steerTask(t, prompt, now ?? false, undefined, kill ?? false);
    return text(r.text, r.isError);
  },
);

server.registerTool(
  "task_cancel",
  {
    title: "Cancel a background Codex task",
    description: "Stop a running delegate_async task.",
    inputSchema: { task_id: z.string() },
  },
  async ({ task_id }) => {
    const t = getTask(task_id);
    if (!t) return text(`unknown task_id '${task_id}'`, true);
    if (t.status !== "running") return text(`${t.id} already ${t.status}`);
    t.controller.abort();
    await waitTask(t, 5);
    return text(`${t.id} ${t.status === "running" ? "cancelling" : t.status}`);
  },
);

server.registerTool(
  "list_sessions",
  {
    title: "List Codex sessions",
    description: "List recent Codex sessions for a project directory (to find a session_id to continue).",
    inputSchema: {
      cwd: z.string().optional().describe("Project directory. Defaults to the current project."),
      limit: z.number().int().positive().max(100).optional().describe("Max sessions (default 20)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ cwd, limit }) => {
    const dir = resolve(config.defaultCwd, cwd ?? ".");
    const sessions = listSessions(dir, limit ?? 20);
    if (!sessions.length) return text(`(no codex sessions for ${dir})`);
    return text(
      sessions
        .map((s) => `${s.id}  ${s.timestamp}  ${(s.prompt ?? "").slice(0, 80).replace(/\s+/g, " ")}`)
        .join("\n"),
    );
  },
);

// The dashboard rewrites the policy file; refresh the tool definitions so the client sees the new
// tiers and guidance (Claude Code re-reads them on list_changed; other clients on the next session).
watchFile(config.policyFile, { interval: 2000, persistent: false }, () => {
  const { policy, error } = loadPolicy();
  if (error) console.error(`codex-delegate: ${error}`);
  const paramsSchema = { ...delegateShape, effort: effortParam(policy) };
  delegateTool.update({ description: withGuidance(DELEGATE_DESCRIPTION + CHECKPOINT_DESCRIPTION + STALL_DESCRIPTION, policy), paramsSchema });
  asyncTool.update({ description: withGuidance(ASYNC_DESCRIPTION + CHECKPOINT_DESCRIPTION + STALL_DESCRIPTION, policy), paramsSchema });
});

await server.connect(new StdioServerTransport());

watchProviders(() => { server.sendToolListChanged(); });
