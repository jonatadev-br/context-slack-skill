---
name: context-slack
description: >
  Preserves context slack — the free space left in the context window — by
  auditing, pruning, and compacting agent context without losing active
  decisions. Use when a session is growing long, costs are rising, or the
  agent needs to decide between inline work, a fresh subagent, or a fork.
---

# context-slack

Context slack is the free space left in the context window. Keep at least **20%** of it free at all times. That margin is what leaves room to read one more file, reason about a hard failure, and finish the task without an emergency compaction at the worst possible moment.

Slack is not wasted capacity — it is working memory for the next step.

## When to use

Reach for this skill when any of these is true:

- **Session is long.** Many turns, repeated file reads, or the same facts restated several times.
- **Cost is rising.** Input tokens per turn keep growing while output stays the same size.
- **A delegation decision is due.** You must choose between doing work inline, forking, or launching a fresh subagent.
- **Before heavy work.** You are about to read a large tree, run a long build, or load several big files.
- **Context is above 70%.** The audit threshold in the config has been crossed, or the host reports compaction soon.

Do not use it for short sessions or small edits — auditing has its own cost.

## Workflow

Four layers, applied in order. Stop as soon as slack is back above the minimum.

### A. Audit — measure before cutting

Measure the window instead of guessing:

```bash
node scripts/audit.mjs --transcript <session.json>
# or pipe raw text: cat session.txt | node scripts/audit.mjs
```

It prints used %, remaining slack, and a breakdown by category (system, decisions, code, prose, tool outputs), then exits `2` when the warning threshold is crossed. Only if you need the retention order, read `references/retention-priorities.md`.

### B. Prune / prioritize

Cut from the cheapest category first, in the order from `references/retention-priorities.md`: **decisions > constraints > code > examples > prose.**

Practical moves, highest yield first:

1. Drop raw tool output that has already been reduced to a conclusion (full logs, whole test suites, entire directory listings). Keep the one line that mattered.
2. Replace re-reads with a pointer: "file X, function Y, as read at turn 4".
3. Collapse repeated discussion into a single decision line.
4. Keep constraints, interfaces, and anything a reviewer would call a requirement.

### C. Structured compaction

Never summarize into free-form prose. Use the six-section template so the next turn can continue without asking anything again:

```bash
node scripts/compact.mjs --transcript <session.json> --focus "auth refactor"
# or read references/compaction-template.md and fill it in by hand
```

The script extracts deterministically — no model call — and copies safety/auth/security material verbatim per `compaction.preserve_verbatim` in the config. The result is a base to edit, not a finished summary.

### D. Delegation decision

Before starting an expensive task, decide **inline vs fork vs fresh subagent**. The tree, with its two axes (main-agent context pressure and total token cost), lives in `references/delegation-decision-tree.md` — read it only when the choice is not obvious.

Default is inline. Choose a fork when the main thread must keep its reasoning and the sub-work is exploratory. Choose a fresh subagent when the task is self-contained and its raw output would be noise in the main window.

## Rules

- **Never remove an active decision.** Open decisions, chosen interfaces, rejected options and their reasons stay, even if the surrounding discussion goes.
- **Never summarize code without preserving syntax.** Keep signatures, imports, error handling and exact identifiers; if it cannot be kept intact, keep the snippet or a file pointer instead of a paraphrase.
- **Never use lossy summarization on safety material.** Security, authentication, authorization, secrets handling, migrations and data-loss risks are copied verbatim — always.
- **Never let slack fall below 20%.** If compaction cannot restore it, delegate or start a fresh session with the compacted brief.
- **State what was dropped.** A compaction that hides its own omissions is worse than a long session.
