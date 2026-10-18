#!/usr/bin/env node
// Long-command launcher for delegated Codex runs (copied into each run directory by the server).
//
//   node longrun.mjs <runDir> run  <n> -- <program> [args…]   start, stream output, wait, exit with its code
//   node longrun.mjs <runDir> run  <n> "<shell command>"       same, through the platform shell (PowerShell / sh)
//   node longrun.mjs <runDir> wait <n>                         re-attach: stream new output until it ends
//   node longrun.mjs <runDir> status <n>                       alive or exit code, plus the log tail
//   node longrun.mjs <runDir> stop <n>                         kill the command and everything it started
//
// The command is started detached and writes straight into cmd-<n>.log, so it keeps running and keeps
// logging when this launcher (or the Codex turn that started it) is interrupted. cmd-<n>.pid holds its
// pid; cmd-<n>.exit its exit code, also appended to the log as `EXIT=<code>`.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const [runDir, verb, n, ...rest] = process.argv.slice(2);
if (!runDir || !verb || !/^\d+$/.test(n ?? "")) {
  console.error("usage: node longrun.mjs <runDir> run|wait|status|stop <n> [-- program args… | \"shell command\"]");
  process.exit(2);
}
const file = (ext) => join(runDir, `cmd-${n}.${ext}`);
const win = process.platform === "win32";
const readInt = (f) => { try { const v = Number.parseInt(readFileSync(f, "utf8"), 10); return Number.isFinite(v) ? v : undefined; } catch { return undefined; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const exitCode = () => readInt(file("exit"));
const pid = () => readInt(file("pid"));

/** Copy what the log gains to our stdout until `done()`; a closed stdout is ignored. */
async function follow(from, done) {
  let pos = from;
  let out = true;
  process.stdout.on("error", () => { out = false; });
  const pump = () => {
    let size = 0;
    try { size = statSync(file("log")).size; } catch { return; }
    if (size < pos) pos = 0; // trimmed by the server
    if (size === pos) return;
    const fd = openSync(file("log"), "r");
    try {
      const buf = Buffer.alloc(Math.min(size - pos, 1 << 20));
      const got = readSync(fd, buf, 0, buf.length, pos);
      pos += got;
      if (out) try { process.stdout.write(buf.subarray(0, got)); } catch { out = false; }
    } finally { closeSync(fd); }
  };
  while (!done()) { pump(); await new Promise((r) => setTimeout(r, 500)); }
  pump();
}

function tail(bytes = 2000) {
  try { const t = readFileSync(file("log"), "utf8"); return t.slice(-bytes); } catch { return ""; }
}

if (verb === "run") {
  if (existsSync(file("json"))) { console.error(`cmd-${n} already exists in ${runDir}; use a new n, or 'wait ${n}'`); process.exit(2); }
  let program, args;
  if (rest[0] === "--") { [program, ...args] = rest.slice(1); }
  else if (rest.length === 1) {
    // One string: run it through the shell from a script file, so no quoting survives two parsers.
    const script = file(win ? "ps1" : "sh");
    writeFileSync(script, win ? `${rest[0]}\nexit $LASTEXITCODE\n` : `${rest[0]}\n`);
    [program, args] = win ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script]] : ["/bin/sh", [script]];
  } else { console.error("give the command after --, or as one quoted shell string"); process.exit(2); }
  if (!program) { console.error("no command"); process.exit(2); }
  writeFileSync(file("json"), JSON.stringify({ program, args, startedAt: Date.now() }));
  writeFileSync(file("log"), "");
  // launcher → hop (exits at once) → monitor → command. With the hop gone the monitor has no live
  // parent, so a tree kill of this launcher or of codex (taskkill /T follows parent pids) misses it.
  spawnSync(process.execPath, [process.argv[1], runDir, "__hop", n], { stdio: "ignore", windowsHide: true });
  for (let i = 0; i < 40 && pid() === undefined && exitCode() === undefined; i++) await new Promise((r) => setTimeout(r, 100));
  if (pid() === undefined && exitCode() === undefined) { console.error(`cmd-${n} did not start`); process.exit(127); }
  await follow(0, () => exitCode() !== undefined || (pid() !== undefined && !alive(pid())));
  process.exit(exitCode() ?? 1);
}

if (verb === "__hop") {
  const m = spawn(process.execPath, [process.argv[1], runDir, "__monitor", n], { detached: true, stdio: "ignore", windowsHide: true });
  m.unref();
  process.exit(0);
}

if (verb === "__monitor") {
  // Holds the command, so its exit code is known even after everyone above is gone.
  const { program, args } = JSON.parse(readFileSync(file("json"), "utf8"));
  const log = openSync(file("log"), "a");
  const child = spawn(program, args, { stdio: ["ignore", log, log], windowsHide: true });
  closeSync(log);
  const end = (c) => {
    if (existsSync(file("stopping"))) process.exit(0); // `stop` records the outcome
    appendFileSync(file("log"), `\nEXIT=${c}\n`);
    writeFileSync(file("exit"), String(c));
    process.exit(0);
  };
  child.on("error", (e) => { appendFileSync(file("log"), `failed to start: ${e.message}\n`); end(127); });
  if (child.pid !== undefined) {
    // pid = the monitor: stopping it with its tree takes the command too.
    writeFileSync(file("pid"), String(process.pid));
    writeFileSync(file("json"), JSON.stringify({ program, args, monitorPid: process.pid, commandPid: child.pid, startedAt: Date.now() }));
  }
  child.on("exit", (code, signal) => end(code ?? (signal ? 128 : 1)));
}

if (verb === "wait") {
  const p = pid();
  if (p === undefined) { console.error(`no cmd-${n} in ${runDir}`); process.exit(2); }
  let size = 0;
  try { size = statSync(file("log")).size; } catch {}
  // Re-attaching: start from the last part of the log so the caller sees where it is.
  await follow(Math.max(0, size - 4000), () => exitCode() !== undefined || !alive(p));
  const c = exitCode();
  if (c === undefined) { console.log(`\ncmd-${n} (pid ${p}) ended without an exit code (its launcher was killed); judge from the log`); process.exit(1); }
  process.exit(c);
}

if (verb === "status") {
  const p = pid();
  const c = exitCode();
  console.log(p === undefined ? `cmd-${n}: unknown` : c !== undefined ? `cmd-${n}: exited ${c}` : alive(p) ? `cmd-${n}: running (pid ${p})` : `cmd-${n}: ended, exit code unknown`);
  console.log(tail());
  process.exit(0);
}

if (verb === "stop") {
  const p = pid();
  if (p === undefined) { console.error(`no cmd-${n}`); process.exit(2); }
  if (exitCode() === undefined && alive(p)) {
    // Marked first, so the monitor (if it sees the command die) does not record an ordinary failure.
    writeFileSync(file("stopping"), "");
    if (win) spawnSync("taskkill", ["/pid", String(p), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else { try { process.kill(-p, "SIGTERM"); } catch {} setTimeout(() => { try { process.kill(-p, "SIGKILL"); } catch {} }, 3000).unref(); }
  }
  for (let i = 0; i < 20 && exitCode() === undefined && alive(p); i++) await new Promise((r) => setTimeout(r, 250));
  if (existsSync(file("stopping")) && exitCode() === undefined) { appendFileSync(file("log"), "\nEXIT=stopped\n"); writeFileSync(file("exit"), "137"); }
  console.log(`cmd-${n}: stopped`);
  process.exit(0);
}

if (!["run", "__hop", "__monitor", "wait", "status", "stop"].includes(verb)) {
  console.error(`unknown verb '${verb}'`);
  process.exit(2);
}
