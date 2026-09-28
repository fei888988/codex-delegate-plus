#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { z } from "zod";
import { config, SANDBOXES } from "./config.ts";
import { delegate, formatOutcome } from "./delegate.ts";
import { listModels } from "./models.ts";
import { listSessions } from "./sessions.ts";
import { getTask, listTasks, startTask, waitTask, type Task } from "./tasks.ts";
import pkg from "../package.json" with { type: "json" };

const server = new McpServer({ name: "codex-delegate", version: pkg.version });

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

const delegateShape = {
  prompt: z
    .string()
    .min(1)
    .describe(
      "Complete, self-contained task for the Codex model. It cannot see this conversation: include goal, relevant files/paths, constraints, and acceptance criteria.",
    ),
  model: z
    .string()
    .optional()
    .describe(
      `Codex model: exact slug (e.g. 'gpt-6-sol') or a loose name ('sol 6', 'gpt 6 luna', '5.6 terra'). Append '#effort' for reasoning effort ('sol 6#high'). Omit to use the default: ${config.defaultModel ?? "codex's configured model"}. On a follow-up (session_id) omitting it keeps the session's model.`,
    ),
  effort: z
    .string()
    .optional()
    .describe(`Reasoning effort: low, medium, high, xhigh, max (ultra on some models). Default: ${config.effort ?? "model_reasoning_effort from ~/.codex/config.toml"}.`),
  cwd: z.string().optional().describe("Working directory for the task (absolute, or relative to the server's cwd). Defaults to the current project."),
  images: z.array(z.string()).optional().describe("Image files to attach to the prompt (screenshots, mockups)."),
  session_id: z.string().optional().describe("Continue an existing Codex session (returned by a previous call) for follow-ups."),
  fork: z.boolean().optional().describe("Fork the session given by session_id into a new session instead of appending to it."),
  sandbox: z
    .enum(SANDBOXES)
    .optional()
    .describe(
      `Codex sandbox. 'workspace-write' (default: ${config.sandbox}): edit files in cwd and run commands, no network. 'danger-full-access': no sandbox — use when the task must install packages or reach the network. 'read-only': no edits.`,
    ),
  auto: z
    .boolean()
    .optional()
    .describe(`Shorthand: false = read-only sandbox, for reading files, reviews and questions. Default: ${config.auto}. An explicit sandbox wins.`),
  title: z.string().optional().describe("Short label shown in task_list."),
  timeout_s: z.number().int().positive().optional().describe(`Kill the run after this many seconds. Default: ${config.timeoutSec}.`),
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
    const lines = models.map((m) => `${m.slug}${m.slug === config.defaultModel ? " (default)" : ""}  efforts: ${m.efforts.join(", ")}`);
    return text(lines.length ? lines.join("\n") : "(no models match)");
  },
);

server.registerTool(
  "delegate",
  {
    title: "Delegate a task to a Codex model",
    description:
      "Run a task with an OpenAI model through the Codex CLI (`codex exec`) and wait for it to finish. The model works in `cwd` with Codex's own tools (shell, apply_patch), so it can implement code, not just answer. Returns its final response, session_id (for follow-ups), token usage, the files it edited and git changes. You remain the orchestrator: review its changes afterwards. For long tasks or running several in parallel, use delegate_async.",
    inputSchema: delegateShape,
  },
  async (input, extra) => {
    const progressToken = extra._meta?.progressToken;
    let tick = 0;
    // Keep-alive progress so clients that reset timeouts on progress don't give up on long runs.
    const heartbeat = progressToken
      ? setInterval(() => {
          tick++;
          extra
            .sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress: tick, message: `codex running (${tick * 15}s)` },
            })
            .catch(() => {});
        }, 15000)
      : undefined;
    try {
      const outcome = await delegate(input, extra.signal);
      return text(formatOutcome(outcome), !outcome.result.ok);
    } catch (e) {
      return text(String(e instanceof Error ? e.message : e), true);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  },
);

function taskSummary(t: Task): string {
  const secs = (((t.finishedAt ?? Date.now()) - t.startedAt) / 1000).toFixed(0);
  const model = t.outcome?.model ?? t.input.model ?? "(default)";
  return `${t.id}  ${t.status.padEnd(9)} ${secs}s  ${model}  ${t.input.title ?? t.input.prompt.slice(0, 60).replace(/\s+/g, " ")}`;
}

server.registerTool(
  "delegate_async",
  {
    title: "Start a Codex task in the background",
    description:
      "Same as delegate, but returns a task_id immediately while the Codex model works in the background. Use for long tasks or to run several in parallel; then call task_result to collect output. Parallel tasks editing the same directory can conflict — give each its own cwd/worktree or non-overlapping files.",
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
    description: "Return the status/result of a delegate_async task, optionally waiting up to wait_s seconds for it to finish.",
    inputSchema: {
      task_id: z.string(),
      wait_s: z.number().int().min(0).max(3600).optional().describe("Seconds to wait for completion before returning (default 0)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ task_id, wait_s }) => {
    const t = getTask(task_id);
    if (!t) return text(`unknown task_id '${task_id}'`, true);
    await waitTask(t, wait_s ?? 0);
    if (t.status === "running") return text(`${taskSummary(t)}\nstill running — call again later or with a larger wait_s.`);
    if (t.outcome) return text(`task: ${t.id} (${t.status})\n${formatOutcome(t.outcome)}`, t.status !== "done");
    return text(`task: ${t.id} (${t.status})\nerror: ${t.error}`, true);
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

await server.connect(new StdioServerTransport());
