# Retention priorities

When context must shrink, content goes in this order — earlier survives longer:

**decisions > constraints > code > examples > prose**

## Why this order

**1. Decisions** — the irreplaceable category. Code can be re-read, prose can be regenerated, but *why* an option was rejected exists only in the conversation. Dropping a decision guarantees it is re-litigated at full cost later. Open decisions count as decisions.

**2. Constraints** — requirements, interfaces, versions, security and auth rules. Cheap to keep (they are short) and expensive to lose (violations are silent). Safety and auth material is copied verbatim, never summarized: a paraphrase of a permission rule is a new permission rule.

**3. Code** — but as *syntax*, not prose. Keep signatures, imports, error paths and exact identifiers. Prefer a precise pointer (`file.ts:42, function parseConfig`) over both a paraphrase and a full copy: the pointer stays valid and costs a dozen tokens.

**4. Examples** — sample inputs, expected outputs, error messages, one or two representative log lines. Keep the one that anchors the behaviour and drop the rest. A pattern is worth keeping; fifteen variations are not.

**5. Prose** — explanations, restatements, apologies, exploratory reasoning, intermediate plans that were replaced. This is where nearly all pruning happens, and where the savings are.

## Practical order of cuts

1. Raw tool output already reduced to a conclusion — keep the conclusion.
2. Repeated reads of the same file — keep one, plus a pointer.
3. Superseded plans and abandoned approaches — keep only the decision that replaced them.
4. Long pasted logs — keep the failing lines and the exit code.
5. Verbose formatting, tables and directory trees — keep what the decision used.

## Never cut

- Active decisions and their reasons.
- Constraints, interfaces and any safety/auth/security text.
- The current failing symptom, in its exact wording.
- Anything the user explicitly asked to keep.

## Signals that pruning went too far

- You are re-reading a file you already read.
- The user repeats something you "should" know.
- You cannot say why the current approach was chosen.
- You are about to change a constraint you no longer remember.

Any of these means restore the decision layer before continuing — re-derive it from the user, or start from the last compaction brief.
