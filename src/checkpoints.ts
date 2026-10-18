import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Stage reports for long runs. Codex writes `checkpoint-<n>.md` into the run directory at points
 * where the lead might change direction and keeps working; the server notices the file and wakes the
 * lead (sync delegate returns early, task_result wait_s returns), who either lets it go on or steers.
 */

export interface Checkpoint { n: number; file: string; at: number; title: string; text: string }

export const MAX_CHECKPOINT_CHARS = 2500;

export function checkpointContract(runDir: string): string {
  return `

Checkpoints (requested by the lead): this is a longer task, and the lead wants to review direction while you work. At each point below, write a short stage report to ${join(runDir, "checkpoint-<n>.md")} (n = 1, 2, 3 …, a new file each time, written in one go), then KEEP WORKING; do not wait for an answer. If the lead changes direction, the new instruction arrives as a user message in this conversation.
Write one when:
- investigation is done and you are about to implement: what you found, the approach you chose, the alternatives you rejected;
- you find something that contradicts the brief or changes its scope (an assumption is wrong, the fix belongs elsewhere, much more work than expected);
- before a large, slow or hard-to-undo step (a long run, a migration, a wide refactor, deleting data);
- a major phase finishes and the next one depends on its result.
Usually 1–3 per task; never for routine progress. Format, under ~25 lines:
# <one-line stage title>
Found: …
Plan next: …
Open choice / risk: … (or "none")
If a choice is genuinely the lead's (product, scope, risk) and continuing would waste the work, write the checkpoint, then end the turn with status needs_decision instead of guessing.`;
}

/** Checkpoints in `runDir` not in `seen`, oldest first. Files still being written are skipped. */
export function scanCheckpoints(runDir: string, seen: ReadonlySet<number> = new Set(), now = Date.now()): Checkpoint[] {
  let names: string[];
  try { names = readdirSync(runDir); } catch { return []; }
  const found: Checkpoint[] = [];
  for (const name of names) {
    const n = Number(/^checkpoint-(\d+)\.md$/i.exec(name)?.[1]);
    if (!Number.isInteger(n) || seen.has(n)) continue;
    const file = join(runDir, name);
    try {
      const st = statSync(file);
      // A file touched in the last second may be half written; the next scan picks it up.
      if (!st.size || now - st.mtimeMs < 1000) continue;
      const text = readFileSync(file, "utf8").trim();
      const title = text.split(/\r?\n/).find((l) => l.trim())?.replace(/^#+\s*/, "").slice(0, 120) ?? `checkpoint ${n}`;
      found.push({ n, file, at: st.mtimeMs, title, text });
    } catch {}
  }
  return found.sort((a, b) => a.n - b.n);
}

export function renderCheckpoint(c: Checkpoint): string {
  const body = c.text.length > MAX_CHECKPOINT_CHARS ? `${c.text.slice(0, MAX_CHECKPOINT_CHARS)}\n…[truncated; full text in ${c.file}]` : c.text;
  return `--- checkpoint ${c.n} (${c.file}) ---\n${body}`;
}
