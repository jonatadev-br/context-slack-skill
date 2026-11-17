# context-slack

**Keep the last 20% of the context window free — on purpose.**

An agent session degrades long before it crashes: the same facts get restated, files get re-read, and the model starts summarizing what it needs instead of doing the work. The cause is usually not a bad model, it is a full window. *Context slack* is the free space left in that window, and this skill is a small discipline for protecting it: measure, prune, compact in a fixed shape, and delegate deliberately.

Works with any agent that reads `SKILL.md` (Claude Code, Claude.ai, and other agent runtimes through [ai-agent-skills](https://www.npmjs.com/package/ai-agent-skills)), plus two dependency-free Node scripts.

## In plain words

Picture the context window as the desk the agent works on. Every file it reads, every command it runs, every turn of conversation piles paper on that desk. When the desk fills up the work gets worse before it stops: the agent re-reads what it already read, restates what was already settled, and starts summarising things it still needs.

Slack is the clear corner of that desk, and this skill keeps at least 20% of it clear at all times — room to read one more file and finish the job, instead of being forced to throw things away at the worst moment.

It is not a summariser you run at the end. It is a short routine you run *while* working: measure the desk, clear what is cheap to lose, write down what must survive in six fixed lines, and decide consciously whether the next step even belongs in this conversation.

Concretely, from a real session: 13,781 tokens compacted to a ~330-token brief, with all four active decisions kept and the authentication requirements quoted word for word.

## What it actually does

The skill runs four layers, in order, and stops as soon as slack is back above the floor:

| Layer | Question it answers | Tool |
| --- | --- | --- |
| **A. Audit** | How full is the window, and with what? | `scripts/audit.mjs` |
| **B. Prune** | What can go without losing a decision? | `references/retention-priorities.md` |
| **C. Compact** | What must survive into the next context? | `scripts/compact.mjs` + `references/compaction-template.md` |
| **D. Delegate** | Inline, fork, or fresh subagent? | `references/delegation-decision-tree.md` |

The rules are deliberately strict:

- Never remove an active decision.
- Never summarize code without preserving syntax.
- Never use lossy summarization on security, auth or permission material — it is copied verbatim.
- Never let slack fall below 20%.

Layer A gives you numbers instead of a feeling. Layer C produces a six-section brief (objective, decisions, current state, files touched, constraints, next step) that is deterministic — no model call, no paraphrase of your code — so you can review it and trust it.

## Install

### As a local skill

```bash
git clone https://github.com/jonataprezende-commits/context-slack-skill.git
cp -r context-slack-skill/skills/context-slack ~/.claude/skills/context-slack
```

The skill is then available as `context-slack` in Claude Code. To keep working on it in place, symlink instead:

```bash
ln -s "$(pwd)/context-slack-skill/skills/context-slack" ~/.claude/skills/context-slack
```

### Cross-agent

```bash
npx ai-agent-skills install jonataprezende-commits/context-slack-skill
```

This installs the skill into the agents it detects on your machine. Add `--list` to preview what would be installed without writing anything:

```bash
npx ai-agent-skills install jonataprezende-commits/context-slack-skill --list
```

### As a Claude Code plugin

```
/plugin marketplace add jonataprezende-commits/context-slack-skill
/plugin install context-slack@context-slack-marketplace
```

Both install paths ship the same skill; the plugin path also gets managed updates through `/plugin`.

## Usage

### Audit a session

From the repository root:

```bash
node skills/context-slack/scripts/audit.mjs --transcript session.json
cat session.txt | node skills/context-slack/scripts/audit.mjs
node skills/context-slack/scripts/audit.mjs --transcript session.json --window 128000 --json
```

(or `cd skills/context-slack` and drop the prefix — the npm scripts `npm run audit` / `npm run compact` do the same.)

Output:

```
# context-slack audit

- Window (usable): 192,000 tokens (200,000 minus 8,000 reserved)
- Estimated usage: 148,300 tokens (77.2%)
- Remaining slack: 22.8% (target ≥ 20.0%)
- Status: WARN (warn at 65.0%, compact at 80.0%)

| Category | Tokens | Share |
| --- | ---: | ---: |
| tool outputs | 91,200 | 61.5% |
...
```

Exit code `0` means healthy, `2` means you are at or above the warn threshold — so the audit can gate a workflow in a one-liner.

The transcript may be a JSON array of messages, `{ "messages": [...] }`, or plain text. Messages accept `{ "role", "content" }` where `content` is a string or an array of blocks. Tokens are estimated from measured per-category char/token ratios (see [Why these numbers](#why-these-numbers)) — close enough to decide *whether* to prune, not a billing figure.

### Build a compaction brief

```bash
node skills/context-slack/scripts/compact.mjs --transcript session.json --focus "auth refactor" --out brief.md
```

Six sections, extracted from the transcript and ordered by the retention priorities. Safety/auth/security material is copied verbatim per `compaction.preserve_verbatim`. Anything the script cannot infer is marked `TODO` — the brief is a base you edit, not an autopilot summary.

Decision and constraint detection is heuristic and bilingual (English and Portuguese). It is deliberately conservative: a missed decision line shows up as `TODO` in the brief rather than as a confident wrong summary, so skim section 2 before you discard the transcript.

## Configuration

`context-slack-config.yaml` is the only place to tune behaviour:

```yaml
thresholds:
  audit_warn: 0.65   # warn at 65% of the usable window
  compact_at: 0.80   # compact now at 80% (= 1 - slack_min by design)
  slack_min: 0.20    # free space that must always remain
token_estimate:
  by_category:
    tool_outputs: 2.7   # measured, see below
compaction:
  preserve_verbatim: [security, auth, secrets, ...]
delegation:
  default: inline
```

### Why these numbers

The token ratios are measured, not guessed. Running a real tokenizer over representative material gives **4.0–4.5 chars/token** for English prose, **3.9** for code, and **2.6** for JSON-shaped tool output. A single average of 3.8 therefore under-counts tool output — usually the biggest category, and the one worth pruning — by roughly 45%. The config splits the ratio per category and rounds it slightly pessimistic, so the audit errs toward warning early.

The thresholds follow from that: a compaction brief costs about 1–2k tokens, while finishing the work already in flight needs 10–15% of the window. Warning at 70% left too little room to land that work, so the warn line sits at **65%**; compaction triggers at **80%**, which is exactly where the 20% floor would break. `slack_min` stays at 0.20 — it is the promise the skill exists to keep.

Pass a different file with `--config path/to/config.yaml`. The scripts read the subset they need with a tiny built-in YAML reader, so there are no dependencies to install.

## Repository layout

```
skills/context-slack/          # the skill itself (the path agents discover)
├── SKILL.md                   # frontmatter + workflow (progressive disclosure)
├── context-slack-config.yaml  # thresholds, retention order, delegation defaults
├── references/
│   ├── compaction-template.md
│   ├── delegation-decision-tree.md
│   └── retention-priorities.md
├── scripts/
│   ├── audit.mjs
│   └── compact.mjs
├── package.json
└── README.md
.claude-plugin/
├── plugin.json
└── marketplace.json
```

`SKILL.md` stays short on purpose and points at `references/` one layer at a time — reading the delegation tree while you are still auditing would waste exactly the context this skill exists to protect.

## License

MIT
