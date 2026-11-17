# Compaction template

Use this before the context window forces a summary on you. Six sections, in this order, no preamble. A brief that fits in ~300 tokens replaces thousands.

`scripts/compact.mjs` fills this in deterministically and uses the `##` headings below, so keep them stable if you edit the file.

## 1. Objective

One or two sentences: what the session is trying to accomplish, for whom, and what "done" means. If the goal drifted, state the current goal and note the drift — do not keep the abandoned framing.

**How to fill:** copy the earliest explicit statement of the goal, then correct it against the latest turn. Never write "continue the work".

## 2. Decisions

Every decision still in force, as one line each:

- What was decided — and *why* (the reason is what makes it reversible later).
- Options that were rejected, with the reason. One line, no debate.

**How to fill:** open questions are not decisions — mark them `OPEN:` instead of deleting them. Never drop a decision because its discussion is gone.

## 3. Current state

What is true right now:

- What works and was verified (say how).
- What is broken, failing, or half-finished.
- What is currently being edited.

**How to fill:** state facts as of the last turn, not the plan you had earlier. Include the exact failing symptom if one exists.

## 4. Files touched

Each file with one clause of why it matters:

- `path/to/file.ts` — role in the change (created / edited / read-only reference).

**How to fill:** keep paths exact. Pointers beat copies: "function `parseConfig` at line 42" is cheaper than pasting the function, and stays valid if the file is re-read.

## 5. Constraints

Anything that must not be broken:

- Requirements, interfaces and contracts that must stay compatible.
- Security, authentication, authorization, secrets, migrations and data-loss rules — **verbatim**, never paraphrased.
- Environment limits: versions, platforms, deadline, forbidden dependencies.

**How to fill:** copy safety-critical and interface text word for word. This section is the one place where length is preferable to brevity.

## 6. Next step

Exactly one next action, plus how it will be verified:

- Action: the single next concrete step.
- Verify: the command, check or observation that proves it worked.
- Then: the step after that, in one line (optional).

**How to fill:** if there are several candidates, pick the one that unblocks the others and list the rest under Decisions as `OPEN:`.

---

## After filling

1. Count the brief. If it is over ~400 words, the state and files sections are carrying too much detail — move paths into pointers.
2. Confirm slack is above the minimum with `node scripts/audit.mjs --transcript <brief>`.
3. Keep the brief as the first message of the next session, or as the fork's prompt.
4. Say what was dropped. A brief that hides its own omissions is worse than a long session.
