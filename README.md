# context-slack-skill

**Keep the last 20% of the context window free.**

`context-slack` is an agent skill that keeps a working session from drowning in its own context. It audits how the window is actually being spent, prunes the cheap categories first, compacts what remains into a fixed six-section brief, and decides deliberately between working inline, forking the thread, or handing the task to a fresh subagent.

The rule it enforces is simple: **never let slack — the free space left in the context window — fall below 20%.** That margin is what leaves room to read one more file and finish the task properly, instead of being forced into a lossy summary at the worst moment.

## What's inside

- `SKILL.md` — the workflow: audit → prune → compact → delegate, with hard retention rules.
- `scripts/audit.mjs` — measures usage by category (system, decisions, code, prose, tool outputs) and reports remaining slack. Exit code `2` when you cross the threshold, so it can gate a workflow.
- `scripts/compact.mjs` — builds the six-section brief deterministically. No model call, no paraphrased code, safety/auth material copied verbatim.
- `references/` — the compaction template, the delegation decision tree, and the retention priorities, loaded only when the current layer needs them.
- `context-slack-config.yaml` — thresholds (`audit_warn: 0.70`, `compact_at: 0.80`, `slack_min: 0.20`), retention order, and delegation defaults.

No dependencies. Node 18+.

## Install

### As a Claude Code plugin

```
/plugin marketplace add jonataprezende-commits/context-slack-skill
/plugin install context-slack@context-slack-marketplace
```

### Cross-agent

```bash
npx ai-agent-skills install jonataprezende-commits/context-slack-skill
```

### Local skill folder

```bash
git clone https://github.com/jonataprezende-commits/context-slack-skill.git
cp -r context-slack-skill/skills/context-slack ~/.claude/skills/context-slack
```

## Usage

```bash
node skills/context-slack/scripts/audit.mjs --transcript session.json
node skills/context-slack/scripts/compact.mjs --transcript session.json --focus "auth refactor"
```

Full documentation, thresholds and examples: [`skills/context-slack/README.md`](skills/context-slack/README.md).

## License

MIT — see [LICENSE](LICENSE).
