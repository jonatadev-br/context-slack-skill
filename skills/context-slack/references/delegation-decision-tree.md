# Delegation decision tree: inline vs fork vs fresh subagent

Two axes decide almost every case:

1. **Main-agent context pressure** — how full the primary session's window is. Delegation that removes raw output protects this; delegation that duplicates the whole conversation does not.
2. **Total token cost** — everything spent across all agents. A fork re-sends the parent's context, so it is cheap in main-window terms and expensive in total terms. A fresh subagent is the opposite: cheap in total terms, but it must be told what it needs.

Delegation is a trade between those two, never a free win.

## The tree

```
Is the task already understood and self-contained?
├─ no  → keep it inline (or fork to explore first)
└─ yes
   ├─ Would its output be mostly noise in the main window?
   │   (full logs, big listings, long search results, many failed attempts)
   │   ├─ yes → FRESH SUBAGENT, with a narrow brief and a strict return format
   │   └─ no
   │      ├─ Is main context pressure ≥ 0.75?
   │      │   ├─ yes → FRESH SUBAGENT if self-contained,
   │      │   │        otherwise FORK (needs this thread's reasoning)
   │      │   └─ no
   │      │      ├─ Does the work depend on reasoning built up in this thread?
   │      │      │   ├─ yes → INLINE, or FORK if you must keep the main thread clean
   │      │      │   └─ no  → INLINE (small tasks: delegation overhead exceeds the saving)
```

## The three options

**Inline** — default. Same thread, no re-sending, cheapest in total tokens. Correct when the work is small, or depends on context you would have to re-explain.

**Fork** — a copy of the current conversation continues on a side path. The parent keeps its window clean; the fork inherits all the reasoning already done. Costs a full copy of the context, so it pays off only when the inherited reasoning is the expensive part.

Choose a fork when: the main thread must stay clean for a long review or refactor, the sub-investigation needs the *why* behind current code, or you want to try an alternative approach without contaminating the main line.

**Fresh subagent** — new, empty context with a written brief. Cheapest in total tokens when the brief is short; useless when the task needs implicit context. Always give it: objective, constraints, the files it may touch, the exact return format, and what *not* to do.

Choose a fresh subagent when: the task is mechanical or search-heavy, the expected output is a compact answer, or the raw output would otherwise flood the main window.

## Rules of thumb

- If you cannot state the task in three sentences, it is not ready to delegate.
- If the delegate's output would be longer than the brief, its return format is wrong.
- Never delegate the decision itself — delegation moves work, not accountability.
- After delegating, the main thread should keep only the conclusion plus a pointer, not a copy of the work.
- If main pressure is ≥ 0.60 and the focus is shifting, decide explicitly instead of drifting inline.

## When none of this applies

If the session is nearly full and the task cannot be delegated (it needs everything), compact first (`references/compaction-template.md`), then start a fresh session seeded with the brief. A well-compacted restart is usually cheaper than either a fork or a forced summary mid-task.
