const mode = process.argv[2];
process.stdin.resume();
const out = (event) => console.log(JSON.stringify(event));
out({ type: "thread.started", thread_id: "watchdog-session" });
if (mode === "empty") process.exit(0);
if (mode === "crash") process.exit(2);
if (mode === "failed") {
  out({ type: "turn.failed", error: { message: "network connection reset" } });
  process.exit(1);
}
if (mode === "complete") {
  out({ type: "turn.completed" });
  process.exit(0);
}
if (mode !== "silent") out({ type: "item.started", item: { id: "cmd-1", type: mode === "tool" ? "mcp_tool_call" : "command_execution", command: mode === "tool" ? undefined : "python -m unittest hung" } });
if (mode === "output") {
  const timer = setInterval(() => console.log("still working"), 40);
  setTimeout(() => {
    clearInterval(timer);
    out({ type: "item.completed", item: { id: "cmd-1", type: "command_execution", status: "completed", exit_code: 0 } });
    out({ type: "turn.completed" });
  }, 700);
} else setInterval(() => {}, 1000);
