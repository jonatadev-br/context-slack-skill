#!/usr/bin/env node

/**
 * context-slack — audit.mjs
 *
 * Estimates how much of the context window a session has consumed, broken down
 * by category, and reports the remaining slack.
 *
 * Usage:
 *   node scripts/audit.mjs --transcript transcript.json [--window 200000] [--json]
 *   cat session.txt | node scripts/audit.mjs
 *
 * Exit codes: 0 below the warn threshold, 2 at or above it, 1 on bad input.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.resolve(HERE, '..', 'context-slack-config.yaml');

const USAGE = `context-slack audit — measure context slack

Usage:
  node scripts/audit.mjs --transcript <file.json>
  node scripts/audit.mjs --transcript <file.txt> --window 200000
  cat <session.txt> | node scripts/audit.mjs

Options:
  --transcript <path>   Session transcript (JSON messages, or plain text).
                        Omit to read from stdin.
  --window <tokens>     Override the context window size.
  --config <path>       Config file (default: ../context-slack-config.yaml).
  --json                Emit machine-readable JSON instead of Markdown.
  -h, --help            Show this help.

JSON shape accepted: an array of messages, or { "messages": [...] }.
Each message may be { "role", "content" } where content is a string or an
array of blocks ({ "type": "text" | "tool_result", ... }).

Exit codes: 0 = healthy, 2 = at or above the warn threshold.`;

// ------------------------------------------------------------------- secrets

// Transcripts are real work, and real work contains tokens. Preview lines and
// reports end up in logs and in the model's own context, so anything that looks
// like a credential is masked. The label stays so nothing disappears silently.
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[REDACTED:github-token]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:api-key]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED:jwt]'],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '[REDACTED:auth-header]'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]+@/gi, '[REDACTED:credentials-in-url]@'],
];

function redactSecrets(text, config) {
  if (!text || (config && config.redact_secrets === false)) return text;
  let out = String(text);
  for (const [pattern, label] of SECRET_PATTERNS) out = out.replace(pattern, label);
  return out;
}

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') out.help = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--transcript' || arg === '--config' || arg === '--window') {
      const value = argv[i + 1];
      // `--transcript --json` means the value is missing, not that the file is
      // called "--json".
      if (value === undefined || value.startsWith('--')) die(`missing value for ${arg}`);
      if (arg === '--transcript') out.transcript = value;
      if (arg === '--config') out.config = value;
      if (arg === '--window') {
        const tokens = Number(value);
        if (!Number.isFinite(tokens) || tokens <= 0) {
          die(`--window must be a positive number of tokens (got "${value}")`);
        }
        out.window = tokens;
      }
      i += 1;
    } else if (arg.startsWith('--')) die(`unknown option ${arg}`);
    else out.positional.push(arg);
  }
  return out;
}

function die(message) {
  console.error(`context-slack audit: ${message}`);
  process.exit(1);
}

// ------------------------------------------------------- minimal YAML reader

function parseScalar(raw) {
  const value = String(raw).trim();
  if (value === '' || value === '~' || value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseInlineList(raw) {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!inner.trim()) return [];
  return inner.split(',').map((part) => parseScalar(part));
}

/** Flat-subset YAML parser: maps, nested maps, scalar lists. Enough for our config. */
function parseYaml(source) {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .filter((line) => line.trim() !== '')
    .map((line) => ({
      indent: (line.match(/^ */) || [''])[0].length,
      text: line.trim(),
    }));

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
      // A config file must never reshape the object model.
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        while (index < lines.length && lines[index].indent > indent) index += 1;
        continue;
      }
      if (rest !== '') {
        map[key] = rest.startsWith('[') ? parseInlineList(rest) : parseScalar(rest);
      } else if (index < lines.length && lines[index].indent > indent) {
        const next = lines[index];
        map[key] = next.text.startsWith('-') ? parseList(next.indent) : parseMap(next.indent);
      } else if (index < lines.length && lines[index].indent === indent && lines[index].text.startsWith('-')) {
        map[key] = parseList(indent);
      } else {
        map[key] = null;
      }
    }
    return map;
  }

  if (!lines.length) return {};
  return lines[0].text.startsWith('-') ? parseList(lines[0].indent) : parseMap(lines[0].indent);
}

function loadConfig(configPath) {
  const defaults = {
    thresholds: { audit_warn: 0.7, compact_at: 0.8, slack_min: 0.2 },
    context_window: {
      tokens: 200000,
      reserve_output_tokens: 8000,
      reserve_ratio: 0.1,
      reserve_floor_tokens: 1024,
    },
    token_estimate: { chars_per_token: 3.8 },
    retention_priority: ['decisions', 'constraints', 'code', 'examples', 'prose'],
    compaction: { preserve_verbatim: [], max_bullets_per_section: 12, max_chars_per_bullet: 240 },
    delegation: { default: 'inline' },
    redact_secrets: true,
  };
  if (!configPath || !existsSync(configPath)) return defaults;

  let parsed;
  try {
    parsed = parseYaml(readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.error(`context-slack audit: could not read config (${error.message}); using defaults`);
    return defaults;
  }

  return {
    thresholds: { ...defaults.thresholds, ...(parsed.thresholds || {}) },
    context_window: { ...defaults.context_window, ...(parsed.context_window || {}) },
    token_estimate: { ...defaults.token_estimate, ...(parsed.token_estimate || {}) },
    retention_priority: Array.isArray(parsed.retention_priority)
      ? parsed.retention_priority
      : defaults.retention_priority,
    compaction: { ...defaults.compaction, ...(parsed.compaction || {}) },
    delegation: { ...defaults.delegation, ...(parsed.delegation || {}) },
    redact_secrets: parsed.redact_secrets === false ? false : true,
  };
}

// --------------------------------------------------------------- transcript

function blockText(block) {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return '';
  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) return block.content.map(blockText).join('\n');
  if (typeof block.input === 'object' && block.input !== null) return JSON.stringify(block.input, null, 2);
  if (typeof block.output === 'string') return block.output;
  return '';
}

/** Accepts an array, a { messages: [] } object, JSONL (one object per line), or plain text. */
function parseTranscript(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to JSONL / text
    }
  }
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().startsWith('{'));
  if (lines.length) {
    try {
      return lines.map((line) => JSON.parse(line));
    } catch {
      // fall through to text
    }
  }
  return raw;
}

function normalise(raw) {
  let data = raw;
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of ['messages', 'turns', 'conversation', 'history']) {
      if (Array.isArray(data[key])) return data[key];
    }
    if (typeof data.content === 'string' || Array.isArray(data.content)) return [data];
  }
  return [{ role: 'user', content: String(raw) }];
}

/**
 * Claude Code session files store { type, message: { role, content } }; some
 * entries (summary, file-history-snapshot) carry no message at all.
 */
const MESSAGE_TYPES = new Set(['user', 'assistant', 'system', 'tool', 'function', 'developer']);

function sessionEntries(items) {
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const message = item.message && typeof item.message === 'object' ? item.message : item;
    if (message.content === undefined && message.text === undefined) continue;
    if (message.role) {
      out.push(message);
      continue;
    }
    // Session files also carry housekeeping entries (queue-operation, summary,
    // snapshots). Only recognise the ones that are real turns.
    const type = String(message.type || '').toLowerCase();
    if (MESSAGE_TYPES.has(type)) {
      out.push({ role: type, content: message.content !== undefined ? message.content : message.text });
    }
  }
  return out;
}

function messageParts(message) {
  if (typeof message === 'string') return [{ role: 'user', text: message, tool: false }];
  const role = String(message.role || message.author || message.type || 'user').toLowerCase();
  const isToolRole = role === 'tool' || role === 'function' || role === 'tool_result' || role === 'tool_use';
  const content = message.content !== undefined ? message.content : message.text;
  const parts = [];

  if (Array.isArray(content)) {
    for (const block of content) {
      const type = String((block && block.type) || '').toLowerCase();
      const isToolBlock = type.startsWith('tool_') || type.includes('tool_result') || type.includes('tool_use');
      const text = blockText(block);
      if (text) parts.push({ role, text, tool: isToolBlock || isToolRole });
    }
  } else {
    const text = blockText(content);
    if (text) parts.push({ role, text, tool: isToolRole });
  }
  return parts;
}

// ------------------------------------------------------------ classification

// Bilingual on purpose: a session in Portuguese must not lose its decisions
// just because the heuristic was written in English.
const DECISION_RE =
  /\b(decid(?:e|ed|ing|ion)|we (?:will|'ll|should|agreed)|chose|chosen|going with|instead of|rejected|approved|plan is|approach(?:es)? is|root cause|trade-?off|constraint|requirement|must not|do not|never|always)\b|\b(?:decid(?:i|imos|ido|ida)|escolh(?:i|emos|ido|ida)|opt(?:ei|amos|ado|ada)|vamos (?:usar|fazer|seguir|com)|em vez de|rejeit(?:ei|amos)|aprov(?:ei|amos)|requisito|restri[çc][ãa]o|n[ãa]o podemos|nunca|sempre)\b/i;

const FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function classify(parts, config) {
  const chars = { system: 0, decisions: 0, code: 0, prose: 0, tool_outputs: 0 };
  const heaviest = [];

  // Measured chars/token by category (see context-slack-config.yaml): JSON-heavy
  // tool output packs ~1.5x the tokens of the same character count of prose.
  const byCategory = config.token_estimate.by_category || {};
  const ratio = (key) =>
    Number(byCategory[key]) || Number(config.token_estimate.chars_per_token) || 4;

  for (const part of parts) {
    const partChars = { system: 0, decisions: 0, code: 0, prose: 0, tool_outputs: 0 };

    if (part.tool) {
      partChars.tool_outputs = part.text.length;
    } else if (part.role === 'system' || part.role === 'developer') {
      partChars.system = part.text.length;
    } else {
      let remaining = part.text;
      for (const fence of remaining.match(FENCE_RE) || []) {
        partChars.code += fence.length;
        remaining = remaining.replace(fence, ' ');
      }
      for (const sentence of splitSentences(remaining)) {
        if (DECISION_RE.test(sentence)) partChars.decisions += sentence.length;
        else partChars.prose += sentence.length;
      }
    }

    let partTokens = 0;
    for (const [key, value] of Object.entries(partChars)) {
      chars[key] += value;
      partTokens += Math.ceil(value / ratio(key));
    }
    heaviest.push({
      role: part.role,
      tokens: partTokens,
      preview: redactSecrets(part.text, config).slice(0, 70).replace(/\s+/g, ' '),
    });
  }

  const tokens = {};
  for (const [key, value] of Object.entries(chars)) tokens[key] = Math.ceil(value / ratio(key));

  heaviest.sort((a, b) => b.tokens - a.tokens);
  return { chars, tokens, heaviest: heaviest.slice(0, 5) };
}

// ------------------------------------------------------------------ report

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Output reservation scales with the window: min(cap, max(floor, ratio * window)).
 * A flat 8000 was right for 200k and reserved half of a 16k window.
 */
function reserveFor(window, config) {
  const cap = Number(config.context_window.reserve_output_tokens);
  const ratio = Number(config.context_window.reserve_ratio);
  const floor = Number(config.context_window.reserve_floor_tokens);
  const effectiveCap = Number.isFinite(cap) && cap > 0 ? cap : 8000;
  const effectiveRatio = Number.isFinite(ratio) && ratio >= 0 && ratio <= 0.5 ? ratio : 0.1;
  const effectiveFloor = Number.isFinite(floor) && floor > 0 ? floor : 1024;
  return Math.round(Math.min(effectiveCap, Math.max(effectiveFloor, window * effectiveRatio)));
}

function buildReport({ tokens, chars, heaviest, window, usable, usedTokens, config }) {
  const used = usedTokens / usable;
  const slack = 1 - used;
  const { audit_warn: warn, compact_at: compact, slack_min: minSlack } = config.thresholds;

  let status = 'OK';
  if (used >= compact) status = 'COMPACT NOW';
  else if (used >= warn) status = 'WARN';

  const labels = {
    system: 'system / instructions',
    decisions: 'decisions & constraints',
    code: 'code',
    prose: 'prose',
    tool_outputs: 'tool outputs',
  };

  const rows = Object.entries(tokens)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => {
      const share = usedTokens ? value / usedTokens : 0;
      return `| ${labels[key] || key} | ${value.toLocaleString('en-US')} | ${percent(share)} |`;
    });

  const totalChars = Object.values(chars).reduce((sum, value) => sum + value, 0);

  const lines = [];
  lines.push('# context-slack audit');
  lines.push('');
  lines.push(
    `- Window (usable): **${usable.toLocaleString('en-US')}** tokens (${window.toLocaleString('en-US')} minus ${(window - usable).toLocaleString('en-US')} reserved for output)`,
  );
  lines.push(`- Estimated usage: **${usedTokens.toLocaleString('en-US')}** tokens (${percent(used)})`);
  // A negative slack is honest but confusing to read; say it in words.
  const slackText = slack < 0 ? `over budget by ${percent(-slack)}` : percent(slack);
  lines.push(`- Remaining slack: **${slackText}** (target ≥ ${percent(minSlack)})`);
  lines.push(`- Status: **${status}** (warn at ${percent(warn)}, compact at ${percent(compact)})`);
  lines.push('');
  lines.push('| Category | Tokens | Share |');
  lines.push('| --- | ---: | ---: |');
  lines.push(...rows);
  lines.push('');
  const byCategory = config.token_estimate.by_category || {};
  const basis = Object.entries(byCategory)
    .map(([key, value]) => `${labels[key] || key} ${value}`)
    .join(', ');
  lines.push(
    `Basis: ${totalChars.toLocaleString('en-US')} characters ÷ per-category chars/token${basis ? ` (${basis})` : ''}.`,
  );
  lines.push('');
  if (heaviest.length) {
    lines.push('Heaviest messages:');
    for (const item of heaviest) {
      lines.push(`- \`${item.role}\` · ${item.tokens.toLocaleString('en-US')} tok · "${item.preview}${item.preview.length >= 70 ? '…' : ''}"`);
    }
    lines.push('');
  }
  if (status === 'COMPACT NOW') {
    lines.push('Next: run `node scripts/compact.mjs --transcript <file>` before doing more work.');
  } else if (status === 'WARN') {
    lines.push('Next: prune tool outputs first (see references/retention-priorities.md).');
  } else if (slack < minSlack) {
    lines.push(`Note: usage is under the warn threshold but slack is below the ${percent(minSlack)} floor.`);
  }

  return { text: lines.join('\n'), status, used, slack };
}

// -------------------------------------------------------------------- main

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.positional.length && !args.transcript) args.transcript = args.positional[0];

  const configPath = args.config ? path.resolve(args.config) : DEFAULT_CONFIG;
  const config = loadConfig(configPath);

  let raw;
  if (args.transcript) {
    const file = path.resolve(args.transcript);
    if (!existsSync(file)) die(`transcript not found: ${file}`);
    raw = readFileSync(file, 'utf8');
  } else if (!process.stdin.isTTY) {
    raw = readFileSync(0, 'utf8');
  } else {
    console.error('context-slack audit: no transcript provided.\n');
    console.log(USAGE);
    return;
  }

  if (!raw.trim()) die('transcript is empty');

  const data = parseTranscript(raw);
  const messages = sessionEntries(normalise(data));
  const parts = messages.flatMap(messageParts);
  const { chars, tokens, heaviest } = classify(parts, config);

  const configuredWindow = Number(config.context_window.tokens);
  const window =
    Number.isFinite(args.window) && args.window > 0
      ? args.window
      : Number.isFinite(configuredWindow) && configuredWindow > 0
        ? configuredWindow
        : 200000;
  const usable = Math.max(window - reserveFor(window, config), 1);
  const usedTokens = Object.values(tokens).reduce((sum, value) => sum + value, 0);

  const { text, status, used, slack } = buildReport({
    tokens,
    chars,
    heaviest,
    window,
    usable,
    usedTokens,
    config,
  });

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          window,
          usable,
          used_tokens: usedTokens,
          used_ratio: Number(used.toFixed(4)),
          slack_ratio: Number(slack.toFixed(4)),
          status,
          tokens,
          threshold: config.thresholds,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(text);
  }

  // process.exit() can truncate buffered stdout when it is a pipe, which would
  // cut the report in half exactly when a caller is gating on it. Set the code
  // and let Node flush and exit on its own.
  process.exitCode = used >= config.thresholds.audit_warn ? 2 : 0;
}

main();
