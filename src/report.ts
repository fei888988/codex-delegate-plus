/** What a delegated run that may edit files must end with (`--output-schema`). */
export const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "changes", "verification", "risks", "questions"],
  properties: {
    status: { type: "string", enum: ["done", "partial", "blocked", "needs_decision"] },
    summary: { type: "string" },
    changes: { type: "array", items: { type: "string" } },
    verification: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "result"],
        properties: { command: { type: "string" }, result: { type: "string" } },
      },
    },
    risks: { type: "array", items: { type: "string" } },
    questions: { type: "array", items: { type: "string" } },
  },
} as const;

export interface Report {
  status: "done" | "partial" | "blocked" | "needs_decision";
  summary: string;
  changes: string[];
  verification: { command: string; result: string }[];
  risks: string[];
  questions: string[];
}

/**
 * Appended to every brief. It lets the caller write short briefs (goal, constraints, acceptance)
 * and moves investigation, detail decisions and self-testing to the delegated model.
 */
export const WRITE_CONTRACT = `

---
Working agreement (added by the delegating tool):
- You own this task end to end: read the code you need, decide implementation details, implement, and run the relevant tests/build yourself. The brief gives goals and constraints, not every step.
- Stay in scope. Do not commit, even if the brief includes a commit request: the lead owns that step after reviewing your uncommitted changes and the host check results. Complete the implementation, tests and report without pausing over that request. Do not modify unrelated files or the tests you were told not to touch.
- If a point the brief leaves open would materially change behavior or interfaces and the code does not settle it, stop and report status "needs_decision" with concrete options in "questions" instead of guessing. Use "blocked" if the environment prevents progress.
- End with the report only. summary: at most 120 words. changes: "path: what and why". verification: the exact commands you ran and their outcome. risks: real ones only, else empty.`;

export const READ_CONTRACT = `

---
Answer format (added by the delegating tool): lead with the answer, cite file:line, no preamble or narration of your process. Be complete but terse.`;

export function parseReport(text: string): Report | undefined {
  const body = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    const r = JSON.parse(body);
    if (r && typeof r.status === "string" && typeof r.summary === "string") {
      return {
        status: r.status,
        summary: r.summary,
        changes: Array.isArray(r.changes) ? r.changes.map(String) : [],
        verification: Array.isArray(r.verification) ? r.verification : [],
        risks: Array.isArray(r.risks) ? r.risks.map(String) : [],
        questions: Array.isArray(r.questions) ? r.questions.map(String) : [],
      };
    }
  } catch {}
  return undefined;
}

export function renderReport(r: Report): string {
  const lines = [`codex status: ${r.status}`, `summary: ${r.summary.trim()}`];
  const list = (title: string, items: string[]) => {
    if (items.length) lines.push(`${title}:`, ...items.map((i) => `  - ${i}`));
  };
  list("changes (codex)", r.changes);
  list(
    "verification (codex, self-reported)",
    r.verification.map((v) => `${v.command} → ${v.result}`),
  );
  list("risks", r.risks);
  list("QUESTIONS (need your decision)", r.questions);
  return lines.join("\n");
}
