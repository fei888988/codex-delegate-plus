import { createInterface } from "node:readline";

const send = message => process.stdout.write(JSON.stringify(message) + "\n");
const note = (method, params) => send({ method, params: { threadId: "overload-thread", ...params } });
let turns = 0, forever = false, turnId;
createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "initialize") return send({ id: m.id, result: {} });
  if (m.method?.startsWith("thread/")) return send({ id: m.id, result: { thread: { id: "overload-thread" } } });
  if (m.method === "turn/interrupt") {
    send({ id: m.id, result: {} });
    return note("turn/completed", { turn: { id: turnId, status: "interrupted" } });
  }
  if (m.method !== "turn/start") return;
  turns++; turnId = `turn-${turns}`;
  forever ||= m.params.input[0].text.includes("forever");
  send({ id: m.id, result: { turn: { id: turnId } } });
  note("turn/started", { turn: { id: turnId } });
  note("thread/tokenUsage/updated", { tokenUsage: {
    total: { inputTokens: 1000 + turns * 720000, cachedInputTokens: 500 + turns * 100, outputTokens: turns * 10, reasoningOutputTokens: 0 },
    last: { inputTokens: 720000, cachedInputTokens: 100, outputTokens: 10, reasoningOutputTokens: 0 },
  } });
  if (turns === 1 || forever) {
    const error = { message: "Selected model is at capacity. Please try a different model." + (process.env.CODEX_DELEGATE_PROVIDER_KEY ?? ""), codexErrorInfo: "serverOverloaded" };
    note("error", { error, willRetry: false });
    return note("turn/completed", { turn: { id: turnId, status: "failed", error } });
  }
  note("item/completed", { item: { id: "answer", type: "agentMessage", text: "finished original task" } });
  note("turn/completed", { turn: { id: turnId, status: "completed" } });
});
