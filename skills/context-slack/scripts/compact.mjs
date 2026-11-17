#!/usr/bin/env node

/**
 * context-slack — compact.mjs
 *
 * Builds a deterministic, six-section compaction brief from a transcript.
 * No model call: the output is an extraction the agent then edits.
 *
 * Usage:
 *   node scripts/compact.mjs --transcript session.json [--focus "auth refactor"]
 *   node scripts/compact.mjs --transcript session.json --out brief.md
 *
 * Sections: objective, decisions, current state, files touched, constraints,
 * next step. Safety/auth material is copied verbatim (compaction.preserve_verbatim).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEFAULT_CONFIG = path.join(ROOT, 'context-slack-config.yaml');
const DEFAULT_TEMPLATE = path.join(ROOT, 'references', 'compaction-template.md');

const USAGE = `context-slack compact — build a six-section brief

Usage:
  node scripts/compact.mjs --transcript <file.json> [--focus "<topic>"] [--out <file.md>]

Options:
  --transcript <path>   Session transcript (JSON messages, or plain text). Required.
  --focus <topic>       Subject to prioritise when selecting content.
  --config <path>       Config file (default: ../context-slack-config.yaml).
  --template <path>     Template file (default: ../references/compaction-template.md).
  --out <path>          Write the brief to a file instead of stdout.
  -h, --help            Show this help.

The brief is deterministic: it extracts and orders what is already in the
transcript. Review it, fix the parts marked TODO, then keep it as the new
working context.`;

const SECTION_KEYS = ['objective', 'decisions', 'state', 'files', 'constraints', 'next'];

const FALLBACK_HEADINGS = {
  objective: '1. Objective',
  decisions: '2. Decisions',
  state: '3. Current state',
  files: '4. Files touched',
  constraints: '5. Constraints',
  next: '6. Next step',
};

// ---------------------------------------------------------------- arguments

function die(message) {
  console.error(`context-slack compact: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') out.help = true;
    else if (['--transcript', '--focus', '--out', '--config', '--template'].includes(arg)) {
      const value = argv[i + 1];
      if (value === undefined) die(`missing value for ${arg}`);
      out[arg.slice(2)] = value;
      i += 1;
    } else if (arg.startsWith('--')) die(`unknown option ${arg}`);
    else out.positional.push(arg);
  }
  return out;
}

// ------------------------------------------------------- minimal YAML reader

function parseScalar(raw) {
  const value = String(raw).trim();
  if (value === '' || value === '~' || value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseInlineList(raw) {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!inner.trim()) return [];
  return inner.split(',').map((part) => parseScalar(part));
}

function parseYaml(source) {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .filter((line) => line.trim() !== '')
    .map((line) => ({ indent: (line.match(/^ */) || [''])[0].length, text: line.trim() }));

  let index = 0;

  function parseList(indent) {
    const list = [];
    while (index < lines.length && lines[index].indent === indent && lines[index].text.startsWith('-')) {
      list.push(parseScalar(lines[index].text.replace(/^-\s*/, '')));
      index += 1;
    }
    return list;
  }

  function parseMap(indent) {
    const map = {};
    while (index < lines.length && lines[index].indent === indent && !lines[index].text.startsWith('-')) {
      const match = lines[index].text.match(/^("[^"]+"|'[^']+'|[^:]+):(.*)$/);
      if (!match) {
        index += 1;
        continue;
      }
      const key = parseScalar(match[1]);
      const rest = match[2].trim();
      index += 1;
      if (rest !== '') map[key] = rest.startsWith('[') ? parseInlineList(rest) : parseScalar(rest);
      else if (index < lines.length && lines[index].indent > indent) {
        const next = lines[index];
        map[key] = next.text.startsWith('-') ? parseList(next.indent) : parseMap(next.indent);
      } else if (index < lines.length && lines[index].indent === indent && lines[index].text.startsWith('-')) {
        map[key] = parseList(indent);
      } else map[key] = null;
    }
    return map;
  }

  if (!lines.length) return {};
  return lines[0].text.startsWith('-') ? parseList(lines[0].indent) : parseMap(lines[0].indent);
}

function loadConfig(configPath) {
  const defaults = {
    compaction: { preserve_verbatim: [], max_bullets_per_section: 12, max_chars_per_bullet: 240 },
    retention_priority: ['decisions', 'constraints', 'code', 'examples', 'prose'],
  };
  if (!configPath || !existsSync(configPath)) return defaults;
  let parsed = {};
  try {
    parsed = parseYaml(readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.error(`context-slack compact: config unreadable (${error.message}); using defaults`);
    return defaults;
  }
  return {
    compaction: { ...defaults.compaction, ...(parsed.compaction || {}) },
    retention_priority: Array.isArray(parsed.retention_priority)
      ? parsed.retention_priority
      : defaults.retention_priority,
  };
}

// --------------------------------------------------------------- transcript

function blockText(block) {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return '';
  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) return block.content.map(blockText).join('\n');
  if (typeof block.input === 'object' && block.input !== null) return JSON.stringify(block.input);
  if (typeof block.output === 'string') return block.output;
  return '';
}

function normalise(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    for (const key of ['messages', 'turns', 'conversation', 'history']) {
      if (Array.isArray(raw[key])) return raw[key];
    }
    if (raw.content !== undefined || raw.text !== undefined) return [raw];
  }
  return [{ role: 'user', content: String(raw) }];
}

function toMessages(raw) {
  return normalise(raw).map((message) => {
    if (typeof message === 'string') return { role: 'user', text: message, tool: false };
    const role = String(message.role || message.author || message.type || 'user').toLowerCase();
    const content = message.content !== undefined ? message.content : message.text;
    const tool = role === 'tool' || role === 'function';
    const text = Array.isArray(content)
      ? content
          .map((block) => {
            const type = String((block && block.type) || '').toLowerCase();
            return blockText(block);
          })
          .filter(Boolean)
          .join('\n')
      : blockText(content);
    return { role, text: text || '', tool };
  });
}

// ----------------------------------------------------------------- extraction

const DECISION_RE =
  /\b(decid(?:e|ed|ing|ion)|we (?:will|'ll|should|agreed)|chose|chosen|going with|instead of|rejected|approved|plan is|approach(?:es)? is|root cause|trade-?off)\b/i;

const CONSTRAINT_RE =
  /\b(must|must not|never|required|requirement|only|forbidden|do not|cannot|can't|constraint|compatib\w*|policy|deadline|hard requirement)\b/i;

const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;

const NEXT_RE = /\b(next|todo|to do|remaining|pending|follow-?up|then we|after that|blocker|waiting on)\b/i;

const FILE_RE =
  /(?:^|[\s`'"(])((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.(?:[cm]?[jt]sx?|json|ya?ml|md|py|rb|go|rs|java|kt|swift|sh|bash|sql|html|css|scss|toml|ini|env|txt|lock))(?=[\s`'").,:;]|$)/g;

function sentences(text) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => line.replace(/^[-*•]\s*/, '').trim())
    .filter((line) => line.length > 2);
}

/** Replace fenced code with a one-line marker so it is never split into fragments. */
function withoutCode(text) {
  return text.replace(FENCE_RE, (block) => {
    const lines = block.split('\n').length - 2;
    return `\n[code block: ${lines} lines, kept separately]\n`;
  });
}

function codeBlocks(text) {
  return text.match(FENCE_RE) || [];
}

function trimTo(text, max) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function uniquePush(list, seen, value) {
  const key = value.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  list.push(value);
}

function isVerbatim(text, topics) {
  const lower = text.toLowerCase();
  return topics.some((topic) => topic && lower.includes(String(topic).toLowerCase()));
}

function templateHeadings(templatePath) {
  const headings = { ...FALLBACK_HEADINGS };
  if (!templatePath || !existsSync(templatePath)) {
    console.error(`context-slack compact: template not found at ${templatePath}; using built-in headings`);
    return headings;
  }
  const body = readFileSync(templatePath, 'utf8');
  const found = [...body.matchAll(/^##\s+(.+)$/gm)].map((match) => match[1].trim());
  for (const heading of found) {
    const lower = heading.toLowerCase();
    if (/objective|goal/.test(lower)) headings.objective = heading;
    else if (/decision/.test(lower)) headings.decisions = heading;
    else if (/state/.test(lower)) headings.state = heading;
    else if (/file/.test(lower)) headings.files = heading;
    else if (/constraint|restriction|rule/.test(lower)) headings.constraints = heading;
    else if (/next|step/.test(lower)) headings.next = heading;
  }
  return headings;
}

function buildBrief({ messages, focus, config, headings }) {
  const maxBullets = Number(config.compaction.max_bullets_per_section) || 12;
  const maxChars = Number(config.compaction.max_chars_per_bullet) || 240;
  const verbatimTopics = Array.isArray(config.compaction.preserve_verbatim)
    ? config.compaction.preserve_verbatim
    : [];

  const chat = messages.filter((message) => !message.tool && message.text.trim());
  const focusLower = (focus || '').toLowerCase();

  const scored = (sentence) => (focusLower && sentence.toLowerCase().includes(focusLower) ? 1 : 0);
  const sectionScore = (text) => (focusLower && text.toLowerCase().includes(focusLower) ? 1 : 0);

  const decisions = [];
  const constraints = [];
  const verbatim = [];
  const files = [];
  const nextSteps = [];
  const stateLines = [];

  const seenDecisions = new Set();
  const seenConstraints = new Set();
  const seenFiles = new Set();
  const seenNext = new Set();

  const seenVerbatim = new Set();

  for (const message of chat) {
    const prose = withoutCode(message.text);

    if (isVerbatim(message.text, verbatimTopics)) {
      for (const sentence of sentences(prose)) {
        if (isVerbatim(sentence, verbatimTopics)) {
          uniquePush(verbatim, seenVerbatim, `[${message.role}] ${sentence}`);
        }
      }
      for (const block of codeBlocks(message.text)) {
        if (isVerbatim(block, verbatimTopics)) uniquePush(verbatim, seenVerbatim, `[${message.role}] ${block}`);
      }
    }

    for (const sentence of sentences(prose)) {
      if (DECISION_RE.test(sentence)) uniquePush(decisions, seenDecisions, sentence);
      else if (CONSTRAINT_RE.test(sentence)) uniquePush(constraints, seenConstraints, sentence);
      if (NEXT_RE.test(sentence)) uniquePush(nextSteps, seenNext, sentence);
      for (const match of sentence.matchAll(FILE_RE)) uniquePush(files, seenFiles, match[1]);
    }
  }

  const lastAssistant = [...chat].reverse().find((message) => message.role === 'assistant');
  if (lastAssistant) {
    const stateText = sentences(withoutCode(lastAssistant.text)).filter(
      (line) => !DECISION_RE.test(line) && !line.startsWith('[code block'),
    );
    stateLines.push(...stateText.slice(-4));
  }

  const firstUser = chat.find((message) => message.role === 'user') || chat[0];
  const objective = firstUser
    ? `${trimTo(withoutCode(firstUser.text), 400)}${focus ? ` (focus: ${focus})` : ''}`
    : focus
      ? focus
      : 'TODO: restate the objective in one sentence.';

  const priority = (list) =>
    list
      .map((item) => ({ item, score: scored(item) }))
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item)
      .slice(0, maxBullets);

  const bulletList = (items, empty) => {
    if (!items.length) return [`- ${empty}`];
    return items.map((item) => `- ${trimTo(item, maxChars)}`);
  };

  const lines = [];
  lines.push('# Compaction brief');
  lines.push('');
  lines.push(
    `Extracted deterministically from ${chat.length} messages${focus ? ` (focus: "${focus}")` : ''}. Edit before use: the script cannot infer intent, and anything marked TODO needs a human or model pass.`,
  );
  lines.push('');

  lines.push(`## ${headings.objective}`);
  lines.push('');
  lines.push(objective);
  lines.push('');

  lines.push(`## ${headings.decisions}`);
  lines.push('');
  lines.push(...bulletList(priority(decisions), 'Nothing extracted — record the decisions that are still active.'));
  lines.push('');

  lines.push(`## ${headings.state}`);
  lines.push('');
  lines.push(
    ...(stateLines.length
      ? bulletList(stateLines.slice(-maxBullets), '')
      : ['- TODO: describe what is working, what is broken, and what is verified.']),
  );
  lines.push('');

  lines.push(`## ${headings.files}`);
  lines.push('');
  const fileList = [...files]
    .sort((a, b) => sectionScore(b) - sectionScore(a))
    .slice(0, maxBullets * 2);
  lines.push(...(fileList.length ? fileList.map((file) => `- \`${file}\``) : ['- None detected.']));
  lines.push('');

  lines.push(`## ${headings.constraints}`);
  lines.push('');
  if (constraints.length) lines.push(...bulletList(priority(constraints), ''));
  else lines.push('- TODO: list the requirements, interfaces and hard limits that must not change.');
  if (verbatim.length) {
    lines.push('');
    lines.push('**Preserved verbatim** (`compaction.preserve_verbatim`) — do not summarize or paraphrase:');
    for (const block of verbatim.slice(0, 8)) {
      lines.push('');
      lines.push(`> ${trimTo(block, maxChars * 2)}`);
    }
  }
  lines.push('');

  lines.push(`## ${headings.next}`);
  lines.push('');
  const finalNext = nextSteps.length
    ? priority(nextSteps).slice(0, 5)
    : ['TODO: state the single next action and how it will be verified.'];
  lines.push(...(nextSteps.length ? bulletList(finalNext, '') : finalNext.map((item) => `- ${item}`)));
  lines.push('');

  return { text: lines.join('\n'), stats: { decisions: decisions.length, constraints: constraints.length, files: files.length, verbatim: verbatim.length } };
}

// -------------------------------------------------------------------- main

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (args.positional.length && !args.transcript) args.transcript = args.positional[0];
  if (!args.transcript) {
    console.error('context-slack compact: --transcript is required.\n');
    console.log(USAGE);
    process.exit(0);
  }

  const file = path.resolve(args.transcript);
  if (!existsSync(file)) die(`transcript not found: ${file}`);
  const raw = readFileSync(file, 'utf8');
  if (!raw.trim()) die('transcript is empty');

  let data = raw;
  if (raw.trim().startsWith('{') || raw.trim().startsWith('[')) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  }

  const config = loadConfig(args.config ? path.resolve(args.config) : DEFAULT_CONFIG);
  const headings = templateHeadings(args.template ? path.resolve(args.template) : DEFAULT_TEMPLATE);
  const messages = toMessages(data);
  const { text, stats } = buildBrief({ messages, focus: args.focus, config, headings });

  if (args.out) {
    const outPath = path.resolve(args.out);
    writeFileSync(outPath, `${text}\n`, 'utf8');
    console.error(
      `context-slack compact: wrote ${outPath} (${stats.decisions} decisions, ${stats.constraints} constraints, ${stats.files} files, ${stats.verbatim} verbatim blocks)`,
    );
  } else {
    console.log(text);
    console.error(
      `context-slack compact: ${stats.decisions} decisions, ${stats.constraints} constraints, ${stats.files} files, ${stats.verbatim} verbatim blocks`,
    );
  }
  process.exit(0);
}

main();
