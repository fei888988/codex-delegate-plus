import { HEARTBEAT_INTERVAL_MS, trackOwnedRun } from "./run-lifecycle.ts";
import { appendHandoff } from "./handoffs.ts";
import { readFile } from "node:fs/promises";
import { finishInputs, interruptText, launcherJobs, messages, renderInputs } from "./inbox.ts";
import { loadProviders, selectProvider, selectModel, type Provider } from "./providers.ts";
import { sessionProvider } from "./sessions.ts";
import { effectiveSandbox, previousDiagnosis, denialBlock, commandLogs, trimCommandLogs, finishCommandLogs, type TrendPoint } from "./observability.ts";
import { sampleTreeEvidence } from "./watchdog.ts";
import type { StallPolicy } from "./watchdog.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { runChecks, type CheckResult } from "./checks.ts";
import { clampEffort, config, configuredModel, type Sandbox } from "./config.ts";
import { classifyError, runCodex, type RunResult, type StallControl } from "./codex.ts";
import { diffSnapshots, diffStat, snapshot, type FileStat } from "./git.ts";
import { resolveModelOrThrow } from "./models.ts";
import { findTier, loadPolicy, type Retention } from "./policy.ts";
import { checkpointContract, scanCheckpoints } from "./checkpoints.ts";
import { installLauncher, reapLongruns, untrackRunDir, refresh, trackRunDir, type KeptCommand } from "./longruns.ts";
import { clearPending, continuationPreamble, loadPending, savePending, type PendingRun } from "./pending.ts";
import { parseReport, READ_CONTRACT, renderReport, REPORT_SCHEMA, WRITE_CONTRACT, type Report } from "./report.ts";
import { version, type RunSummary } from "./run-summary.ts";
import { PatrolMonitor, patrolConfig, type PatrolInput } from "./patrol.ts";

export interface DelegateContext {
  origin: "dashboard"; parentRunId: string; runsDir: string;
  original: RunSummary; text: string; notify: boolean; providersFile?: string;
}

export interface DelegateInput {
  patrol?: false | PatrolInput;
  prompt: string;
  provider?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
  cwd?: string;
  images?: string[];
  session_id?: string;
  fork?: boolean;
  sandbox?: Sandbox | "write";
  add_dirs?: string[];
  auto?: boolean;
  title?: string;
  timeout_s?: number;
  idle_timeout_s?: number;
  stall?: StallPolicy;
  /** Commands the server runs on the host after codex finishes (tests, build, lint). */
  checks?: string[];
  /** false = free-form final answer instead of the JSON report. */
  structured?: boolean;
  /** Start a new session even if an interrupted run in this cwd could be continued. */
  fresh?: boolean;
  /** Ask codex for stage reports at direction-changing points; each one wakes the lead. */
  checkpoints?: boolean;
}

export interface DelegateOutcome {
  patrols?: RunSummary["patrols"];
  model?: string;
  effort?: string;
  /** Policy tier the effort came from. */
  tier?: string;
  fast?: boolean;
  sandbox: Sandbox;
  resumed: boolean;
  cwd: string;
  notes: string[];
  result: RunResult;
  report?: Report;
  runDir?: string;
  changes?: FileStat[];
  checks?: CheckResult[];
  /** The interrupted run this one continued. */
  continued?: PendingRun;
  checkpoints?: RunSummary["checkpoints"];
}

function newRunDir(runsDir = config.runsDir): string | undefined {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const dir = resolve(runsDir, `${stamp}-${randomUUID().slice(0, 6)}`);
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return undefined;
  }
}

export async function delegate(input: DelegateInput, signal?: AbortSignal, onProgress?: (info: RunSummary) => void, stallControl?: StallControl, context?: DelegateContext): Promise<DelegateOutcome> {
  stallControl ??= { lastObservedAt: Date.now() };
  const cwd = resolve(config.defaultCwd, input.cwd ?? ".");
  if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  const auto = input.auto ?? config.auto;
  const { policy, error: policyError } = loadPolicy();
  const sandbox = context?.original.sandbox ?? effectiveSandbox(input.sandbox, auto && config.sandbox !== "read-only", policy.sandboxWrites);
  const readOnly = sandbox === "read-only";
  const notes: string[] = [];

  // Two writers in one directory overwrite each other's edits and confuse the change report.
  // A writer that was just cancelled (the user pressed Stop) is still winding down for a moment;
  // the redirected call that follows waits for it instead of failing.
  const lockKey = cwd.toLowerCase();
  if (!readOnly) {
    const holder = activeWriters.get(lockKey);
    if (holder?.signal?.aborted) await Promise.race([holder.done, new Promise((r) => setTimeout(r, 30000))]);
    if (activeWriters.has(lockKey)) {
      throw new Error(`another delegated run is already editing ${cwd}; wait for it, or give this one its own git worktree (git worktree add) as cwd`);
    }
  }

  // Continue a run in this directory that the user interrupted, unless told otherwise.
  let pending = !context && !readOnly && !input.fresh ? loadPending(cwd) : undefined;
  // Preserve the lead's record, but never silently follow a session subsequently driven by a human.
  if (pending?.sessionId && !input.session_id) {
    try {
      const events = await readFile(join(config.runsDir, "handoffs", encodeURIComponent(pending.sessionId) + ".jsonl"), "utf8");
      const since = pending.startedAt;
      if (events.split("\n").some(line => {
        try { const event = JSON.parse(line); return event.state === "started" && event.at >= since; } catch { return false; }
      })) pending = undefined;
    } catch {}
  }
  const continued = pending && (!input.session_id || input.session_id === pending.sessionId) ? pending : undefined;
  if (continued && !input.session_id) input = { ...input, session_id: continued.sessionId };

  // `effort` names a tier of the cost policy (model + effort); a plain effort name still works.
  if (policyError) notes.push(policyError);
  const tier = findTier(policy, input.effort);

  // A tier pins its model, so escalating a follow-up to a tier on another model switches models.
  // Without one, a follow-up keeps the session's model unless one is asked for explicitly.
  const doc = (input.provider ?? tier?.provider) === "system" && (!input.session_id || input.provider === "system") ? { defaultProvider: null, providers: [] } : loadProviders(context?.providersFile);
  const resumedProvider = input.session_id && input.provider === undefined ? sessionProvider(input.session_id, doc) : undefined;
  const provider = resumedProvider ?? ((input.provider ?? tier?.provider) === "system" ? undefined : selectProvider(doc, input.provider, tier?.provider));
  const query = selectModel(input.model, provider, tier?.model, input.session_id ? undefined : auto ? config.defaultModel : config.readModel);
  let model: string | undefined;
  // Policy first: a tier's own effort wins; the provider's value is only a default for what the tier leaves unset.
  let effort = (tier ? undefined : input.effort) ?? tier?.effort ?? provider?.effort ?? (readOnly ? config.readEffort : config.writeEffort);
  if (query) {
    const r = resolveModelOrThrow(query);
    model = r.model;
    if (r.effort && !input.effort && !tier?.effort && !provider?.effort) effort = r.effort;
    if (!r.known) notes.push(`'${r.model}' is not in codex's model cache; passed through as-is`);
  }
  if (!context && model && policy.models.length && !policy.models.includes(model)) {
    throw new Error(`model '${model}' is not allowed by the delegation policy (allowed: ${policy.models.join(", ")}); pick a tier instead`);
  }
  // Tier efforts are the user's own choice; anything else is fitted into the allowed range.
  const clamped = context || tier ? effort : clampEffort(effort, config.efforts);
  if (clamped !== effort) {
    notes.push(`effort '${effort}' is outside the allowed range (${config.efforts!.join(", ")}); used '${clamped}'`);
    effort = clamped;
  }
  const fast = input.fast ?? config.fast;
  const images = input.images?.map((f) => (isAbsolute(f) ? f : resolve(cwd, f)));
  const structured = !readOnly && (input.structured ?? config.structured);

  let release = () => {};
  if (!readOnly) {
    // The handoff lookup above yields; another writer may have acquired the cwd meanwhile.
    if (activeWriters.has(lockKey)) throw new Error(`another delegated run is already editing ${cwd}; wait for it, or give this one its own git worktree (git worktree add) as cwd`);
    const done = new Promise<void>((r) => (release = r));
    activeWriters.set(lockKey, { signal, done });
  }
  try {
    const run = { provider, cwd, sandbox, readOnly, model: context?.original.model ?? model, effort: context?.original.effort ?? effort, tier: context ? context.original.tier : tier?.id, codexGuidance: policy.codexGuidance, retention: policy.retention, fast: context ? context.original.fast : fast, images, structured, notes, continued, context };
    const stall: StallPolicy = {
      silent_s: input.stall?.silent_s ?? input.idle_timeout_s ?? policy.stall?.silent_s ?? config.idleTimeoutSec,
      command_s: input.stall?.command_s ?? input.idle_timeout_s ?? policy.stall?.command_s ?? config.commandIdleTimeoutSec,
      long_commands: [...(input.stall?.long_commands ?? []), ...(policy.stall?.long_commands ?? [])],
    };
    return await execute({ ...input, stall }, run, signal, onProgress, stallControl);
  } finally {
    if (!readOnly) {
      activeWriters.delete(lockKey);
      release();
    }
  }
}

interface Resolved {
  context?: DelegateContext;
  provider?: Provider;
  cwd: string;
  sandbox: Sandbox;
  readOnly: boolean;
  model?: string;
  effort?: string;
  tier?: string;
  codexGuidance: string;
  retention: Retention;
  fast?: boolean;
  images?: string[];
  structured: boolean;
  notes: string[];
  continued?: PendingRun;
}

async function execute(input: DelegateInput, r: Resolved, signal?: AbortSignal, onProgress?: (info: RunSummary) => void, stallControl?: StallControl): Promise<DelegateOutcome> {
  const { cwd, sandbox, readOnly, model, effort, tier, codexGuidance, fast, images, structured, notes, continued } = r;
  const runDir = newRunDir(r.context?.runsDir);
  if (r.context && !runDir) throw new Error("Cannot create dashboard run directory");
  const engine = r.context ? "app-server" : config.engine;
  const patrolSettings = patrolConfig(input.patrol);
  const timeoutSource = input.timeout_s !== undefined ? "timeout_s" : process.env.CODEX_DELEGATE_TIMEOUT !== undefined
    ? "CODEX_DELEGATE_TIMEOUT" : patrolSettings ? "patrol.timeout_default_s" : "config.timeoutSec";
  const timeoutSec = input.timeout_s ?? (timeoutSource === "patrol.timeout_default_s" ? loadPolicy().policy.patrol?.timeout_default_s ?? 14400 : config.timeoutSec);
  const meta: RunSummary = {
    id: runDir ? basename(runDir) : "", startedAt: Date.now(), state: "running",
    origin: r.context?.origin, parentRunId: r.context?.parentRunId,
    title: input.title, cwd, provider: r.provider?.id ?? "system", model, effort, tier, fast, sandbox, resumed: !!input.session_id,
    sessionId: input.session_id, continuedFrom: continued?.sessionId,
    prompt: input.prompt.slice(0, 2000), version,
    phase: "codex", engine, pid: process.pid, heartbeatAt: Date.now(), lastEventAt: Date.now(),
    idleTimeoutSec: input.stall?.silent_s ?? config.idleTimeoutSec,
    commandIdleTimeoutSec: input.stall?.command_s ?? config.commandIdleTimeoutSec,
    checkIdleTimeoutSec: config.checkIdleTimeoutSec,
    stallPolicy: input.stall,
    patrol: patrolSettings, timeoutSec, timeoutSource,
  };
  let lastWrite = 0;
  let lastSnapshot = "";
  let pendingWrite: ReturnType<typeof setTimeout> | undefined;
  const writeMeta = () => {
    clearTimeout(pendingWrite);
    pendingWrite = undefined;
    const serialized = JSON.stringify(meta);
    if (serialized === lastSnapshot) return;
    lastSnapshot = serialized;
    lastWrite = Date.now();
    try {
      if (runDir) writeFileSync(join(runDir, "meta.json"), serialized);
    } catch {}
  };
  const progress = () => {
    if (r.context && meta.phase === "done") return;
    try { onProgress?.({ ...meta }); } catch {}
    if (Date.now() - lastWrite >= 2000) writeMeta();
    else pendingWrite ??= setTimeout(writeMeta, 2000 - (Date.now() - lastWrite));
  };
  const patrol = new PatrolMonitor(meta, runDir, () => { progress(); writeMeta(); }, () => stallControl?.rearm?.());
  const stopPatrol = () => { void patrol.stop(); };
  signal?.addEventListener("abort", stopPatrol, { once: true });
  if (signal?.aborted) stopPatrol();
  writeMeta();
  const untrackOwned = runDir ? trackOwnedRun(runDir, meta) : () => {};
  if (r.context && input.session_id) {
    try {
      await appendHandoff(r.context.runsDir, input.session_id, {
        runId: meta.id, parentRunId: r.context.parentRunId, sessionId: input.session_id, cwd,
        text: r.context.text, notify: r.context.notify, parentPid: r.context.original.pid,
        at: meta.startedAt, state: "started",
      });
    } catch (error) {
      meta.state = "error"; meta.endedAt = Date.now(); writeMeta(); untrackOwned();
      throw error;
    }
  }
  progress();
  let sampling = false;
  const sampleController = new AbortController();
  const sampler = setInterval(async () => {
    if (sampling || !meta.inflight || meta.inflight.type !== "command_execution" || !meta.codexPid) return;
    sampling = true;
    const inflight = meta.inflight;
    try {
      const evidence = await (stallControl?.evidenceSampler ?? sampleTreeEvidence)(meta.codexPid, sampleController.signal);
      if (sampleController.signal.aborted || meta.inflight?.startedAt !== inflight.startedAt) return;
      if (runDir) trimCommandLogs(runDir, r.retention.cmdLogMaxMB);
      const point: TrendPoint = { ...evidence, at: Date.now(), command: inflight.command, commandStartedAt: inflight.startedAt,
        logBytes: runDir ? commandLogs(runDir).reduce((n, log) => n + log.bytes, 0) : 0 };
      meta.trend = [...(meta.trend ?? []), point].slice(-10);
      progress();
    } catch {} finally { sampling = false; }
  }, 60000);
  sampler.unref();
  const heartbeat = setInterval(() => { meta.heartbeatAt = Date.now(); progress(); }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();
  // New checkpoint files go into meta at once (progress() notifies waiting task_result calls).
  const seenCheckpoints = new Set<number>();
  const pollCheckpoints = () => {
    if (!runDir || !input.checkpoints) return;
    const found = scanCheckpoints(runDir, seenCheckpoints);
    if (!found.length) return;
    for (const c of found) seenCheckpoints.add(c.n);
    meta.checkpoints = [...(meta.checkpoints ?? []), ...found.map(({ n, at, title, needsLead }) => ({ n, at, title, needsLead }))];
    progress();
    writeMeta();
  };
  const checksController = new AbortController();
  let pollingInputs = false;
  const pollInputs = async () => {
    if (!runDir || engine !== "app-server" || pollingInputs) return;
    pollingInputs = true;
    try {
      void stallControl?.live?.pollInbox?.().then(() => {
        if (stallControl?.live?.userInterrupt) checksController.abort();
      }).catch(() => {});
      meta.inputs = await messages(runDir);
      progress();
    } catch {} finally { pollingInputs = false; }
  };
  const checkpointTimer = setInterval(() => { pollCheckpoints(); void pollInputs(); }, config.checkpointPollMs);
  checkpointTimer.unref();
  try {
    let prompt = previousDiagnosis(config.runsDir, input.session_id) + (continued ? continuationPreamble(continued) : "") + input.prompt;
    if (config.contract) prompt += r.context ? "\n\nReply directly to the human user in plain prose." : readOnly ? READ_CONTRACT : WRITE_CONTRACT;
    if (codexGuidance) prompt += `\n\n${codexGuidance}`;
    if (runDir && input.checkpoints) prompt += checkpointContract(runDir);
    const launcher = runDir && installLauncher(runDir);
    if (runDir) trackRunDir(runDir);
    if (runDir && launcher) {
      prompt += `\n\nLong commands (added by the server): run every command likely to take longer than ~1 minute through the launcher, with a new n per command (1, 2, 3 …):
  node "${launcher}" "${runDir}" run <n> -- <program> <args…>
  node "${launcher}" "${runDir}" run <n> "<one shell command string, for pipes/redirects>"
It streams the output, blocks until the command ends and exits with its exit code, so use it exactly like running the command directly (one blocking call; fine under any long-script rules you follow). It also writes ${join(runDir, "cmd-<n>.log")} ending in EXIT=<code>, and keeps the command alive if your turn is interrupted, so the lead can talk to you without killing the job. Don't wrap it in tee. Absolute run directory: ${runDir}.`;
    } else if (runDir) {
      prompt += `\n\nCommand logs (added by the server): for commands likely to run longer than ~1 minute, tee output to ${join(runDir, "cmd-<n>.log")} (use a new n per command). Absolute run directory: ${runDir}.`;
    }
    let outputSchemaFile: string | undefined;
    if (runDir) {
      writeFileSync(join(runDir, "prompt.md"), prompt);
      if (structured) {
        outputSchemaFile = join(runDir, "report.schema.json");
        writeFileSync(outputSchemaFile, JSON.stringify(REPORT_SCHEMA, null, 2));
      }
    }

    // Editing runs leave a record so a Stop can be followed by a redirect (see pending.ts).
    const rec: PendingRun | undefined = readOnly || r.context !== undefined
      ? undefined
      : {
          cwd,
          sessionId: input.fork ? undefined : input.session_id,
          state: "running",
          pid: process.pid,
          startedAt: Date.now(),
          model,
          effort,
          sandbox,
          title: input.title,
          prompt: input.prompt.slice(0, 500),
          runDir,
        };
    if (rec) savePending(rec);

    const before = await snapshot(cwd);
    const tempDir = runDir && sandbox === "workspace-write" ? join(runDir, "tmp") : undefined;
    if (tempDir) mkdirSync(tempDir, { recursive: true });
    const result = await runCodex({
      engine,
      provider: r.provider,
      addDirs: [...(runDir ? [runDir] : []), ...(input.add_dirs ?? []).map(dir => resolve(cwd, dir))],
      env: tempDir ? { TEMP: tempDir, TMP: tempDir } : undefined,
      onSpawn: (pid) => {
        patrol.start();
        meta.codexPid = pid;
        progress();
        if (rec) savePending({ ...rec, codexPid: (rec.codexPid = pid) });
      },
      onSession: (id) => {
        meta.sessionId = id;
        progress();
        if (rec && rec.sessionId !== id) savePending({ ...rec, sessionId: (rec.sessionId = id) });
      },
      onProgress: (info) => {
        const wasSuspected = !!meta.suspicion;
        const it = info.inflight;
        if (info.suspicion) meta.lastEvidence = { ...info.suspicion.evidence, at: info.suspicion.suspectedAt, command: info.suspicion.command, commandStartedAt: info.suspicion.commandStartedAt };
        if (it?.type === "command_execution") meta.lastInflight = { command: it.command, startedAt: it.startedAt };
        if (info.turnId) meta.turnId = info.turnId;
        if (info.steers) meta.steers = info.steers.map(({ at, text, consumedAt, redirect }) => ({ at, text, consumedAt, redirect }));
        if (info.kept) meta.kept = info.kept;
        Object.assign(meta, { commands: info.commands, denials: info.denials, codexPid: info.codexPid, lastEventAt: info.lastEventAt,
          suspicion: info.suspicion, stallWindowSince: info.stallWindowSince, effectiveThresholdSec: info.effectiveThresholdSec, matchedRule: info.matchedRule,
          inflight: it && { type: it.type, command: it.command, startedAt: it.startedAt } });
        progress();
        if (info.suspicion || wasSuspected) writeMeta();
        patrol.observe(info.suspicion);
      },
      stall: input.stall,
      stallControl,
      evidenceSampler: stallControl?.evidenceSampler,
      prompt,
      model,
      effort,
      fast,
      cwd,
      images,
      sessionId: input.session_id,
      fork: input.fork,
      sandbox,
      timeoutMs: timeoutSec * 1000,
      idleTimeoutMs: input.idle_timeout_s === undefined ? undefined : input.idle_timeout_s * 1000,
      signal,
      lastMessageFile: runDir && join(runDir, "last-message.txt"),
      outputSchemaFile,
      logFile: runDir && join(runDir, "events.jsonl"),
      runDir,
    });
    await patrol.stop();
    if (runDir && engine === "app-server") {
      // A final scan covers inputs submitted between the last timer tick and run failure/end.
      await stallControl?.live?.flushInbox?.();
      result.inputs = await finishInputs(runDir);
      meta.inputs = result.inputs;
      if (result.userInterrupt) {
        result.interruptedJobs = stallControl?.live?.interruptedJobs ?? await launcherJobs(runDir);
        if (!result.userInterrupt.killLongruns) untrackRunDir(runDir);
      }
    }
    // Nothing the run started may outlive it unnoticed: stop what is still running and say so.
    if (runDir && !(result.userInterrupt && !result.userInterrupt.killLongruns)) {
      const leftover = reapLongruns(runDir, signal?.aborted ? "task cancelled" : "the codex run ended");
      const forgotten = leftover.filter((n) => !result.kept?.some((k) => k.n === n && k.outcome !== "running"));
      if (forgotten.length) notes.push(`background command(s) ${forgotten.map((n) => `cmd-${n}`).join(", ")} were still running when codex finished; the server stopped them (logs in the run directory)`);
      if (result.kept) result.kept = result.kept.map((k) => leftover.includes(k.n) && k.outcome === "running" ? { ...k, outcome: "killed_forgotten" as const } : refresh(runDir, k));
    }
    if (runDir && input.checkpoints) {
      // A checkpoint written just before the end is still listed; the mtime guard no longer applies.
      for (const c of scanCheckpoints(runDir, seenCheckpoints, Infinity)) {
        seenCheckpoints.add(c.n);
        meta.checkpoints = [...(meta.checkpoints ?? []), { n: c.n, at: c.at, title: c.title, needsLead: c.needsLead }];
      }
    }
    Object.assign(meta, { exitKind: result.exitKind, errorKind: result.errorKind, stall: result.stall,
      inflight: undefined, suspicion: undefined, error: result.error });
    progress();
    const after = before && await snapshot(cwd);
    const changes = before && after ? await diffStat(cwd, diffSnapshots(before, after)) : undefined;
    if (rec) {
      if ((signal?.aborted || result.userInterrupt) && result.sessionId) {
        // Merge in what the continued run had already touched, so the next preamble lists it all.
        const changed = [...new Set([...(continued?.changed ?? []), ...(changes ?? []).map((c) => c.path)])];
        savePending({ ...rec, sessionId: result.sessionId, state: "interrupted", endedAt: Date.now(), changed });
      } else {
        clearPending(cwd, rec);
      }
    }
    const report = structured ? parseReport(result.text) : undefined;
    if (structured && !report && result.ok) notes.push("codex did not return the JSON report; showing its raw final message");

    let checks: CheckResult[] | undefined;
    // Out of quota or logged out: report at once instead of spending minutes on checks first.
    const envStop = !!result.userInterrupt || !result.ok && (result.errorKind === "quota" || result.errorKind === "auth");
    if (envStop && input.checks?.length) notes.push(`host checks skipped: ${result.userInterrupt ? "user interrupted" : `codex stopped on ${result.errorKind}`}`);
    if (input.checks?.length && !signal?.aborted && !envStop) {
      meta.phase = "checks";
      meta.checksStartedAt = Date.now();
      meta.checks = [];
      progress();
      checks = await runChecks(input.checks, cwd, config.checkTimeoutSec * 1000, signal ? AbortSignal.any([signal, checksController.signal]) : checksController.signal, {
        onProgress: ({ command, startedAt, lastOutputAt, result }) => {
          // Sequential checks: the active record is always the last one, even for duplicate commands.
          const records = meta.checks!;
          if (!records.length || records.at(-1)!.state !== "running") records.push({ command, startedAt, state: "running" });
          const { tail, ...summary } = result ?? {};
          Object.assign(records.at(-1)!, summary, { lastOutputAt, state: result ? "done" : "running" });
          progress();
        },
      });
    }
    if (runDir && engine === "app-server") {
      result.userInterrupt ??= stallControl?.live?.userInterrupt;
      result.inputs = await finishInputs(runDir);
      if (result.userInterrupt) {
        result.exitKind = "user_interrupted";
        result.ok = false;
        result.interruptedJobs ??= stallControl?.live?.interruptedJobs;
        if (rec && result.sessionId) savePending({ ...rec, sessionId: result.sessionId, state: "interrupted", endedAt: Date.now(), changed: [...new Set([...(continued?.changed ?? []), ...(changes ?? []).map(c => c.path)])] });
      }
    }
    Object.assign(meta, {
      state: result.userInterrupt ? "user_interrupted" : signal?.aborted ? "interrupted" : result.ok ? "ok" : "error",
      exitKind: result.exitKind, inputs: result.inputs,
      sessionId: result.sessionId ?? meta.sessionId, tokens: result.tokens, turns: result.turns,
      reportStatus: report?.status, summary: report?.summary, report, changes,
      notes: [...notes, ...result.warnings],
      error: result.error, toolCalls: result.toolCalls.length,
    });
    return { model, effort, tier, fast, sandbox, resumed: !!input.session_id, cwd, notes, result, report, runDir, changes, checks, continued, checkpoints: meta.checkpoints, patrols: meta.patrols };
  } catch (error) {
    meta.state = signal?.aborted ? "interrupted" : "error";
    meta.error = error instanceof Error ? error.message : String(error);
    meta.exitKind ??= signal?.aborted ? "cancelled" : "crashed";
    meta.errorKind = classifyError(meta.error);
    throw error;
  } finally {
    await patrol.stop();
    signal?.removeEventListener("abort", stopPatrol);
    clearInterval(heartbeat);
    clearInterval(checkpointTimer);
    clearInterval(sampler);
    sampleController.abort();
    if (runDir) {
      try {
        trimCommandLogs(runDir, r.retention.cmdLogMaxMB);
        meta.cmdLogTails = finishCommandLogs(runDir, meta.state === "ok" && !meta.checks?.some(c => c.ok === false), (meta.kept ?? []).map((k) => `cmd-${k.n}.log`));
      } catch {}
      try { rmSync(join(runDir, "tmp"), { recursive: true, force: true }); } catch {}
    }
    meta.phase = "done";
    meta.inflight = undefined;
    meta.endedAt = Date.now();
    meta.durationMs = meta.endedAt - meta.startedAt;
    // Publish the terminal meta only after its handoff is durable. Otherwise a reader can
    // observe "ok" while this writer still holds the cwd lock during the asynchronous append.
    clearTimeout(pendingWrite);
    try {
      if (r.context && input.session_id) {
        let reply = ""; try { reply = await readFile(join(runDir!, "last-message.txt"), "utf8"); } catch {}
        await appendHandoff(r.context.runsDir, input.session_id, { runId: meta.id, state: meta.state, endedAt: meta.endedAt, reply: reply.slice(0, 1500), changes: meta.changes?.map(c => c.path) });
      }
    } finally {
      try { onProgress?.({ ...meta }); } catch {}
      writeMeta();
      untrackOwned();
    }
  }
}

const activeWriters = new Map<string, { signal?: AbortSignal; done: Promise<void> }>();

function truncate(s: string, max: number, where?: string): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars${where ? `; full text in ${where}` : ""}]`;
}

const MAX_LISTED_FILES = 40;

function renderChanges(cwd: string, changes: FileStat[]): string {
  if (!changes.length) return "git changes: none";
  const rows = changes.slice(0, MAX_LISTED_FILES).map((c) => {
    const n = c.binary ? "binary" : c.added !== undefined ? `+${c.added} -${c.removed ?? 0}` : "";
    return `  ${c.xy.replace(/ /g, ".")} ${c.path}${n ? `  ${n}` : ""}`;
  });
  if (changes.length > MAX_LISTED_FILES) rows.push(`  … ${changes.length - MAX_LISTED_FILES} more`);
  return `git changes (this run; review with git diff -- <path>):\n${rows.join("\n")}`;
}

function renderChecks(checks: CheckResult[]): string {
  const lines = ["host checks (run by the server after codex):"];
  for (const c of checks) {
    const secs = (c.durationMs / 1000).toFixed(1);
    if (c.ok) {
      lines.push(`  PASS ${c.command} (${secs}s)${c.lastLine ? ` | ${c.lastLine}` : ""}`);
    } else {
      lines.push(`  FAIL ${c.command} (${c.timedOut ? "timed out" : `exit ${c.exitCode}`}, ${secs}s)`);
      if (c.tail) lines.push(c.tail.split("\n").map((l) => `    ${l}`).join("\n"));
    }
  }
  return lines.join("\n");
}

const REPORT_NEXT: Record<Exclude<Report["status"], "done">, string> = {
  needs_decision: "decide now: answer each QUESTION yourself from the brief, the code and the user's stated goals, then resume with session_id and your decisions; ask the user only when it is genuinely their call (product, risk, scope)",
  partial: "resume with session_id to finish the remaining items, or take over only if they are small",
  blocked: "codex could not proceed: read the reason; fix the environment or brief and resume, or ask the user if it needs them",
};

const KEPT_OUTCOME: Record<KeptCommand["outcome"], string> = {
  running: "STILL RUNNING",
  exited: "finished",
  stopped: "stopped by codex",
  gone: "ended (exit code unknown)",
  killed_cancel: "stopped: task cancelled",
  killed_forgotten: "STOPPED BY THE SERVER: codex ended without dealing with it; check whether it should be rerun",
};

/** Long commands kept alive across a redirect: each one must have an outcome. */
export function renderKept(kept: KeptCommand[]): string {
  return ["background commands kept across a redirect:", ...kept.map((k) =>
    `  cmd-${k.n}: ${KEPT_OUTCOME[k.outcome]}${k.exitCode !== undefined ? ` (exit ${k.exitCode})` : ""} | ${k.command.replace(/\s+/g, " ").slice(0, 160)} | log ${k.log}`)].join("\n");
}

/** When the usage window reopens: from the rate-limit snapshot, else the "try again at …" in the message. */
function quotaReset(r: RunResult): string | undefined {
  const said = r.error?.match(/try again (?:at|in) ([^.;]+)/i)?.[1]?.trim();
  if (said) return said;
  const at = r.rateLimits?.resetsAt;
  return at ? new Date(at * 1000).toLocaleString() : undefined;
}

export function formatOutcome(o: DelegateOutcome): string {
  const r = o.result;
  const patrolLine = o.patrols?.length ? `patrol: ${o.patrols.length} checks, ${o.patrols.filter(p => p.error || (p.verdict !== "healthy" && !p.repeat)).length} alerts${o.patrols.some(p => p.repeat) ? `, ${o.patrols.filter(p => p.repeat).length} repeats` : ""}` : "";
  if (r.userInterrupt) return interruptText(r.userInterrupt, r.sessionId, r.inputs ?? [], r.interruptedJobs ?? [], o.runDir ?? "") + "\n" + renderInputs(r.inputs ?? []) + (patrolLine ? `\n${patrolLine}` : "");
  const model = o.model ?? (o.resumed ? "(same as session)" : `(codex config${configuredModel() ? `: ${configuredModel()}` : ""})`);
  const lines = [
    r.exitKind === "completed" ? "status: ok" : `status: error (${r.exitKind}${r.errorKind ? `/${r.errorKind}` : ""})`,
    `model: ${model}${o.effort ? `#${o.effort}` : ""}${o.tier ? ` (tier ${o.tier})` : ""}${o.fast !== undefined ? `, fast: ${o.fast}` : ""}, sandbox: ${o.sandbox}`,
    `session_id: ${r.sessionId ?? "(none)"}`,
    `duration: ${(r.durationMs / 1000).toFixed(0)}s, codex tokens in/cached/out: ${r.tokens.input}/${r.tokens.cachedInput}/${r.tokens.output}`,
  ];
  if (patrolLine) lines.push(patrolLine);
  if (r.exitKind !== "completed") {
    const hint = r.errorKind === "quota"
      ? `codex is out of quota${quotaReset(r) ? ` until ${quotaReset(r)}` : ""}. STOP now: do not continue the delegated work yourself, do not sleep or poll for the reset. End your turn with what codex finished (git changes below), what is left, and ask the user whether to wait for the reset, have you take over the rest, or something else. Resume later with session_id.`
      : r.errorKind === "auth"
        ? "codex is not logged in or its credentials were rejected. STOP: tell the user (they run `codex login`), don't take over the work."
      : r.exitKind === "stalled"
        ? `codex hung on ${r.stall?.command?.replace(/\s+/g, " ").slice(0, 200) ?? "a silent model turn"}; the session keeps context: resume with session_id and tell it the command hung (run it with a timeout / fix the hang)`
        : (r.exitKind === "crashed" || r.exitKind === "api_error") && (r.errorKind === "network" || r.errorKind === "rate_limit")
          ? "transient: retry once with the same session_id" : undefined;
    if (hint) lines.splice(1, 0, `next: ${hint}`);
  } else if (o.report && o.report.status !== "done") {
    // The process finished fine but the work didn't: say so first, so a skimming lead doesn't take it as done.
    const n = o.report.questions?.length ?? 0;
    lines[0] = `status: ${o.report.status} (codex finished but the work is not done)`;
    lines.splice(1, 0, `next: ${REPORT_NEXT[o.report.status]}${o.report.status === "needs_decision" && n ? ` (${n} question${n > 1 ? "s" : ""} below)` : ""}`);
  }
  if (o.continued) {
    lines.push(`continued: the interrupted run in this cwd (session ${o.continued.sessionId}); codex kept its context and partial edits and was told your new message wins. Pass fresh: true to start over instead.`);
  }
  if (r.inputs?.length) lines.push(renderInputs(r.inputs));
  if (r.kept?.length) lines.push(renderKept(r.kept));
  if (o.checkpoints?.length) {
    lines.push(`checkpoints (stage reports in the run log): ${o.checkpoints.map((c) => `${c.n}. ${c.title} (${join(o.runDir ?? "", `checkpoint-${c.n}.md`)})`).join("; ")}`);
  }
  if (r.steers?.length) {
    const unread = r.steers.filter((s) => !s.consumedAt).length;
    lines.push(`steered: ${r.steers.length} message(s) sent into the turn${unread ? `; ${unread} not read by codex before it finished: resend with session_id` : ", all read by codex"}`);
  }
  const used = r.rateLimits?.usedPercent;
  if (used !== undefined && used >= 80 && r.errorKind !== "quota") {
    lines.push(`note: codex usage window ${used}% used${quotaReset(r) ? `, resets ${quotaReset(r)}` : ""}; keep further briefs small or tell the user`);
  }
  for (const n of [...o.notes, ...r.warnings]) lines.push(`note: ${n}`);
  if (r.error) lines.push(`error: ${truncate(r.error, 1500)}`);
  if (o.report) lines.push(renderReport(o.report));
  if (o.changes) lines.push(renderChanges(o.cwd, o.changes));
  else if (r.fileChanges.length) {
    const seen = [...new Set(r.fileChanges.map((c) => relative(o.cwd, c.path) || c.path))];
    lines.push(`files edited by codex:\n${seen.map((p) => `  ${p}`).join("\n")}`);
  }
  if (o.checks?.length) lines.push(renderChecks(o.checks));
  if (!o.report) {
    const where = o.runDir && join(o.runDir, "last-message.txt");
    lines.push("--- response ---", truncate(r.text || "(no text output)", config.maxOutputChars, where));
  }
  if (o.runDir) lines.push(`run log: ${o.runDir}`);
  return [denialBlock(r.denials), ...lines].filter(Boolean).join("\n");
}
