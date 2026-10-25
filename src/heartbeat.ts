/** MCP progress keeps Claude Code's 1800s inactivity timeout from aborting long waits. */
export function progressHeartbeat(extra: {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message: string } }) => Promise<void>;
}): () => void {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return () => {};
  let tick = 0;
  const interval = process.env.NODE_TEST_CONTEXT && process.env.CODEX_DELEGATE_TEST_HEARTBEAT_MS
    ? Number(process.env.CODEX_DELEGATE_TEST_HEARTBEAT_MS) : 15000;
  const timer = setInterval(() => {
    tick++;
    extra.sendNotification({ method: "notifications/progress", params: {
      progressToken, progress: tick, message: `codex running (${tick * interval / 1000}s)`,
    } }).catch(() => {});
  }, interval);
  return () => clearInterval(timer);
}
