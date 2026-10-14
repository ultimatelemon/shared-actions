// Minimal, dependency-free helpers for asserting on the structure of this
// repo's GitHub Actions YAML files.
//
// This is deliberately NOT a general YAML parser. These workflow/action
// files use a small, consistent subset of YAML (block mappings, block
// sequences of "- " items, and ">-"/"|" block scalars for multi-line
// strings). Writing a tiny, purpose-built reader for that subset is more
// robust here than depending on a full YAML library, and needs no
// `package.json` / `npm install` in a repo that otherwise ships none.
//
// Every test file in this directory runs with Node's built-in test runner
// (`node --test test/`), which ships with Node 22+ and needs no extra
// tooling.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..');

export function repoPath(relPath) {
  return path.join(REPO_ROOT, relPath);
}

export function fileExists(relPath) {
  return fs.existsSync(repoPath(relPath));
}

export function readRepoFile(relPath) {
  return fs.readFileSync(repoPath(relPath), 'utf8');
}

export function lines(text) {
  return text.split(/\r?\n/);
}

function indentOf(line) {
  const m = /^( *)/.exec(line);
  return m[1].length;
}

function isBlankOrComment(line) {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

/** Indentation of the first non-blank, non-comment line, or 0 if there is none. */
function baseIndentOf(allLines) {
  for (const l of allLines) {
    if (!isBlankOrComment(l)) return indentOf(l);
  }
  return 0;
}

/**
 * Finds the line that declares `${keyName}:` as a *direct child* of the
 * given lines, i.e. at the same indentation as the first non-blank line
 * in `allLines`.
 *
 * This is intentionally not "the first line matching /keyName:/ anywhere"
 * — a block like a job can legitimately contain the same key name at two
 * depths (e.g. the job's own `if:` versus one of its steps' `if:`), and a
 * caller that scoped the search to "this job's block" means the job's own
 * key, not whatever matching key happens to appear first while scanning
 * top to bottom at any depth.
 */
export function findKeyIndex(allLines, keyName, { from = 0, to = allLines.length } = {}) {
  const indent = baseIndentOf(allLines.slice(from, to));
  const re = new RegExp(`^ {${indent}}${escapeRegExp(keyName)}:(.*)$`);
  for (let i = from; i < to; i++) {
    if (re.test(allLines[i])) return i;
  }
  return -1;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Given the index of a "key:" line, returns the lines that make up its
 * nested block: every following blank/comment line, or any line indented
 * strictly more than the key line, stopping at the first shallower-or-equal
 * non-blank/non-comment line (a sibling key) or EOF.
 */
export function blockAfter(allLines, keyIndex) {
  const parentIndent = indentOf(allLines[keyIndex]);
  const block = [];
  let end = keyIndex + 1;
  for (; end < allLines.length; end++) {
    const line = allLines[end];
    if (isBlankOrComment(line)) {
      block.push(line);
      continue;
    }
    if (indentOf(line) <= parentIndent) break;
    block.push(line);
  }
  return { lines: block, text: block.join('\n'), endIndex: end, indent: parentIndent };
}

function inlineValueOf(line, keyName) {
  const re = new RegExp(`^\\s*${escapeRegExp(keyName)}:(.*)$`);
  const m = re.exec(line);
  if (!m) return undefined;
  return m[1].trim();
}

function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Finds `keyName:` within `text` (the first match, read top to bottom) and
 * returns its scalar value as a plain string, handling:
 *   - an inline value on the same line ("key: value")
 *   - a literal block scalar ("key: |" / "key: |-"), newlines preserved
 *   - a folded block scalar ("key: >" / "key: >-"), or an un-marked
 *     multi-line continuation, collapsed to a single space-joined line
 *     (this is how YAML folding behaves, and matches how this repo wraps
 *     long `${{ ... }}` expressions across lines)
 * Returns `undefined` if the key is not found.
 */
export function getValue(text, keyName) {
  const allLines = lines(text);
  const idx = findKeyIndex(allLines, keyName);
  if (idx === -1) return undefined;
  const inline = inlineValueOf(allLines[idx], keyName);
  const isBlockIndicator = inline !== undefined && /^[|>][+-]?\d*$/.test(inline);
  if (inline && !isBlockIndicator) {
    return stripQuotes(inline);
  }
  const { lines: blockLines } = blockAfter(allLines, idx);
  const nonEmpty = blockLines.filter((l) => l.trim() !== '');
  if (nonEmpty.length === 0) return '';
  if (inline && inline.startsWith('|')) {
    const baseIndent = indentOf(nonEmpty[0]);
    return nonEmpty.map((l) => l.slice(baseIndent)).join('\n');
  }
  return nonEmpty.map((l) => l.trim()).join(' ');
}

/**
 * Returns the raw nested block text for `keyName` (its children), without
 * collapsing it to a scalar — used for container keys ("env:", "services:",
 * "with:", a single input's own block, ...).
 * Returns `null` if the key is not found.
 */
export function getBlock(text, keyName) {
  const allLines = lines(text);
  const idx = findKeyIndex(allLines, keyName);
  if (idx === -1) return null;
  return blockAfter(allLines, idx).text;
}

/**
 * Slices out a named top-level job from a workflow's "jobs:" mapping: the
 * block indented under "  <jobName>:", up to (not including) the next
 * sibling job at the same indentation, or EOF. Returns `null` if either
 * "jobs:" or the job itself is missing.
 */
export function getJobBlock(workflowText, jobName) {
  const jobsBlock = getBlock(workflowText, 'jobs');
  if (jobsBlock === null) return null;
  const jobLines = lines(jobsBlock);
  const idx = findKeyIndex(jobLines, jobName);
  if (idx === -1) return null;
  return blockAfter(jobLines, idx).text;
}

/**
 * Splits a "steps:" block's raw text (as returned by `getBlock(job, 'steps')`)
 * into one raw-text chunk per "- " list item, each normalized so the item's
 * own keys (name, uses, run, ...) read like a plain nested mapping.
 */
export function splitSteps(stepsBlockText) {
  if (!stepsBlockText) return [];
  const allLines = lines(stepsBlockText);
  const firstNonBlank = allLines.findIndex((l) => l.trim() !== '');
  if (firstNonBlank === -1) return [];
  const itemIndent = indentOf(allLines[firstNonBlank]);
  const items = [];
  let current = null;
  for (const raw of allLines) {
    if (raw.trim() === '') {
      if (current) current.push(raw);
      continue;
    }
    const ind = indentOf(raw);
    if (ind === itemIndent && raw.trim().startsWith('- ')) {
      if (current) items.push(current);
      current = [raw];
    } else if (current) {
      current.push(raw);
    }
  }
  if (current) items.push(current);

  return items.map((rawLines) => {
    const first = rawLines[0];
    const ind = indentOf(first);
    const afterDash = first.slice(ind + 2);
    const normalized = [' '.repeat(ind + 2) + afterDash, ...rawLines.slice(1)];
    return normalized.join('\n');
  });
}

export function stepName(stepText) {
  return getValue(stepText, 'name');
}

/** Normalizes a quoted/unquoted condition expression for comparison. */
export function normalizeCondition(value) {
  if (value === undefined) return undefined;
  return value.trim().replace(/"/g, "'").replace(/\s+/g, ' ');
}

/** Runs a bash snippet synchronously in a scratch directory with extra env vars. */
export function runBash(script, env = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'go-checks-test-'));
  const result = spawnSync('bash', ['-c', script], {
    cwd: scratch,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { ...result, scratch };
}
