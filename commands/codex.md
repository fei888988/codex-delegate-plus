---
description: Delegate a task to an OpenAI Codex model (e.g. /codex sol 6#high -- add input validation to the signup form)
argument-hint: [model] -- <task>
---

Delegate this to a Codex model, following the codex-delegate skill: $ARGUMENTS

The text before `--` is the model name, with an optional `#effort`. Pass it to the tool unchanged,
and the server will resolve it. If there is no `--`, work out the model name from the text, or leave
the model out to use the default (gpt-6-sol).

The text after `--` is the task. Before you call `delegate`, expand it into a self-contained brief
using what you know about this project.

When it returns, review the files it edited, run the relevant tests, and give me a summary. The
summary should say which model did the work, what it changed, and your verdict.
