#!/usr/bin/env node
// Go-live checklist check (Milestone 2 plan K.6, package M2-S04).
//
// Parses the checklist tables of docs/saas/go-live-checklist.md: one table per area, each with the columns ID,
// Item, Why it matters, Who, Evidence and Status. A table is a checklist table when its header has an ID and a
// Status column. The check fails when:
//   - a row lacks an id (GL-nn), an item, a reason, a valid Who (agent or owner), evidence or a valid Status
//     (open, done or n/a), when an id repeats, or when a row has more or fewer cells than its header;
//   - a checklist table lacks one of the six columns, or a GL row sits in another table or outside any table
//     (for example after a blank line that split the table, with or without a leading pipe);
//   - a link to a repository file is broken (missing file, a path outside the repository, or a missing heading
//     when the link points to a heading of a Markdown file). Links inside code spans and code blocks are text.
// Modes:
//   (default)           the checks above
//   --agent-items-done  also fails on any open row whose Who is agent (M2-S13)
//   --require-done      also fails on any open row (the go-live day, plan K.7 step 9)
//
// Usage: node tools/scripts/check-golive.mjs [--agent-items-done | --require-done] <checklist.md>...
//        node tools/scripts/check-golive.mjs --self-test
// Exit codes: 0 pass, 1 problems found, 2 usage error.
//
// Tables follow GitHub Flavored Markdown: the header and the delimiter row have the same number of cells, and the
// rows run until a blank line or the start of another block (heading, block quote, code fence, thematic break),
// whether or not a row starts with a pipe.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const WHO_VALUES = ['agent', 'owner'];
export const STATUS_VALUES = ['open', 'done', 'n/a'];
export const ID_PATTERN = /^GL-\d{2,}$/;
const REQUIRED_COLUMNS = ['id', 'item', 'why', 'who', 'evidence', 'status'];
const COLUMN_TITLES = { id: 'ID', item: 'Item', why: 'Why it matters', who: 'Who', evidence: 'Evidence', status: 'Status' };
const EMPTY_EVIDENCE = new Set(['', '-', 'tbd', 'todo', '?']);
const MODES = new Set(['default', 'agent-items-done', 'require-done']);

// ---------------------------------------------------------------------------------------------------------------
// Markdown helpers

/** Splits a GFM table line into cells: outer pipes removed, `\|` kept as a literal pipe, cells trimmed. */
export function splitCells(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells = [];
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\' && text[i + 1] === '|') {
      current += '|';
      i += 1;
    } else if (c === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  cells.push(current.trim());
  return cells;
}

const DELIMITER_ROW = /^\s{0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const TABLE_LINE = /^\s{0,3}\|/;
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;
/** Lines that end a table: blank, ATX heading, block quote or thematic break (code fences are handled apart). */
const TABLE_END = /^\s*$|^\s{0,3}(#{1,6}(\s|$)|>|([-*_])(\s*\3){2,}\s*$)/;
/** A line that looks like a GL row: a GL id as the first cell, with or without a leading pipe. */
const GL_ROW_LIKE = /^\s{0,3}\|?\s*[`*]*GL-\d+[`*]*\s*\|/i;

/** True when `line` and `next` open a GFM table: a pipe in the header, a delimiter row, and equal cell counts. */
function opensTable(line, next) {
  if (!line.includes('|') || !DELIMITER_ROW.test(next)) return false;
  if (!TABLE_LINE.test(line) && !next.includes('|')) return false;
  return splitCells(line).length === splitCells(next).length;
}

/** Marks the lines that are inside fenced code blocks (the fence lines included). */
function fencedLines(lines) {
  const inside = new Array(lines.length).fill(false);
  let fence = null;
  lines.forEach((line, index) => {
    if (fence) {
      inside[index] = true;
      const close = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      return;
    }
    const open = line.match(FENCE_OPEN);
    if (open) {
      fence = open[1];
      inside[index] = true;
    }
  });
  return inside;
}

/** Replaces inline code spans by spaces, so links and pipes inside them are not read as Markdown. */
function withoutCodeSpans(line) {
  return line.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (match) => ' '.repeat(match.length));
}

/** Plain cell value for Who and Status: code ticks and emphasis removed, lower case. */
function plain(value) {
  return value.replace(/[`*]/g, '').trim().toLowerCase();
}

/** Heading text as GitHub renders it, then the GitHub anchor slug. */
export function headingSlug(text) {
  const rendered = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*]/g, '')
    .trim()
    .toLowerCase();
  return rendered.replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
}

/** Every anchor a Markdown file offers: heading slugs (with GitHub's -1, -2 suffixes) and HTML ids. */
export function markdownAnchors(text) {
  const lines = text.split(/\r?\n/);
  const fenced = fencedLines(lines);
  const anchors = new Set();
  const seen = new Map();
  lines.forEach((line, index) => {
    if (fenced[index]) return;
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const base = headingSlug(heading[1]);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      anchors.add(count === 0 ? base : `${base}-${count}`);
    }
    for (const match of line.matchAll(/<[a-z][^>]*\s(?:id|name)\s*=\s*"([^"]+)"/gi)) anchors.add(match[1].toLowerCase());
  });
  return anchors;
}

/** Link targets of one line (inline links, images and reference definitions), outside code spans. */
function linkTargets(line) {
  const text = withoutCodeSpans(line);
  const targets = [];
  const inline = /!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^)\s]*)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  for (const match of text.matchAll(inline)) targets.push(match[1]);
  const definition = text.match(/^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/);
  if (definition) targets.push(definition[1]);
  return targets.map((target) => target.replace(/^<(.*)>$/, '$1'));
}

/** The repository root: the nearest folder above `start` that holds `.git`, or the working folder. */
export function findRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The check

/**
 * Checks one checklist file. Returns `{rows, problems, tables}`: every GL row with its area, line, id, who and
 * status, and every problem as `{line, message}` (line 0 for the file as a whole).
 */
export function checkChecklist(file, { mode = 'default', root = findRoot(path.dirname(file)) } = {}) {
  if (!MODES.has(mode)) throw new Error(`unknown mode ${mode}`);
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const fenced = fencedLines(lines);
  const problems = [];
  const rows = [];
  const problem = (line, message) => problems.push({ line, message });
  const ids = new Map();
  let area = '';
  let tables = 0;

  for (let index = 0; index < lines.length; index += 1) {
    if (fenced[index]) continue;
    const line = lines[index];
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/);
    if (heading) {
      area = heading[1];
      continue;
    }
    const isHeader = index + 1 < lines.length && !fenced[index + 1] && opensTable(line, lines[index + 1]);
    if (!isHeader) {
      if (GL_ROW_LIKE.test(line)) {
        problem(index + 1, 'a GL row outside a checklist table (a blank line ends a table, and a table needs a header and a delimiter row with the same number of cells)');
      }
      continue;
    }

    const header = splitCells(line).map(plain);
    const columns = {};
    header.forEach((name, position) => {
      const key = name === 'id' ? 'id' : name.startsWith('why') ? 'why' : REQUIRED_COLUMNS.includes(name) ? name : null;
      if (key && columns[key] === undefined) columns[key] = position;
    });
    const isChecklist = columns.id !== undefined && columns.status !== undefined;
    const missing = REQUIRED_COLUMNS.filter((key) => columns[key] === undefined);
    if (isChecklist && missing.length > 0) {
      problem(index + 1, `checklist table lacks the column(s) ${missing.map((key) => COLUMN_TITLES[key]).join(', ')}`);
    }
    if (isChecklist) tables += 1;

    let rowIndex = index + 2;
    for (; rowIndex < lines.length && !fenced[rowIndex] && !TABLE_END.test(lines[rowIndex]); rowIndex += 1) {
      const rowLine = lines[rowIndex];
      const lineNo = rowIndex + 1;
      const cells = splitCells(rowLine);
      if (!isChecklist || missing.length > 0) {
        if (!isChecklist && cells.some((cell) => /^gl-\d+$/.test(plain(cell)))) {
          problem(lineNo, 'a GL row outside a checklist table (the table needs the columns ID, Item, Why it matters, Who, Evidence and Status)');
        }
        continue;
      }
      if (cells.length !== header.length) {
        problem(lineNo, `the row has ${cells.length} cells and the header has ${header.length} (an unescaped | in a cell?)`);
      }
      const cell = (key) => cells[columns[key]] ?? '';
      const id = plain(cell('id')).toUpperCase();
      const label = id || `row at line ${lineNo}`;
      if (!id) problem(lineNo, 'the row lacks an id');
      else if (!ID_PATTERN.test(id)) problem(lineNo, `the id "${cell('id')}" does not match GL-nn`);
      else if (ids.has(id)) problem(lineNo, `${id} repeats the id of line ${ids.get(id)}`);
      else ids.set(id, lineNo);
      if (!cell('item')) problem(lineNo, `${label} lacks an item`);
      if (!cell('why')) problem(lineNo, `${label} lacks the reason (Why it matters)`);
      const who = plain(cell('who'));
      if (!who) problem(lineNo, `${label} lacks who (agent or owner)`);
      else if (!WHO_VALUES.includes(who)) problem(lineNo, `${label} has who "${cell('who')}"; use agent or owner`);
      if (EMPTY_EVIDENCE.has(plain(cell('evidence')))) problem(lineNo, `${label} lacks evidence (a command, CI job or document)`);
      const status = plain(cell('status'));
      if (!STATUS_VALUES.includes(status)) problem(lineNo, `${label} has status "${cell('status')}"; use open, done or n/a`);
      rows.push({ line: lineNo, area, id, item: cell('item'), who, status });
    }
    index = rowIndex - 1;
  }

  if (tables === 0) problem(0, 'no checklist table found (a table with the columns ID, Item, Why it matters, Who, Evidence and Status)');

  for (const row of rows) {
    if (row.status !== 'open') continue;
    const short = row.item.length > 90 ? `${row.item.slice(0, 87)}...` : row.item;
    if (mode === 'require-done') problem(row.line, `${row.id} is open (${row.who}): ${short}`);
    else if (mode === 'agent-items-done' && row.who === 'agent') problem(row.line, `${row.id} is an open agent row: ${short}`);
  }

  checkLinks(file, lines, fenced, root, problem);
  problems.sort((a, b) => a.line - b.line);
  return { rows, problems, tables };
}

/** Checks every relative link of the file: the target exists inside the repository, and its heading exists. */
function checkLinks(file, lines, fenced, root, problem) {
  const dir = path.dirname(path.resolve(file));
  const anchorCache = new Map();
  const anchorsOf = (target) => {
    if (!anchorCache.has(target)) anchorCache.set(target, markdownAnchors(readFileSync(target, 'utf8')));
    return anchorCache.get(target);
  };
  lines.forEach((line, index) => {
    if (fenced[index]) return;
    for (const target of linkTargets(line)) {
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue;
      const hash = target.indexOf('#');
      const rawPath = hash < 0 ? target : target.slice(0, hash);
      const anchor = hash < 0 ? '' : target.slice(hash + 1);
      let decoded;
      try {
        decoded = decodeURIComponent(rawPath);
      } catch {
        problem(index + 1, `the link ${target} is not valid percent-encoding`);
        continue;
      }
      const resolved = decoded === '' ? path.resolve(file) : decoded.startsWith('/') ? path.join(root, decoded) : path.resolve(dir, decoded);
      const relative = path.relative(root, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        problem(index + 1, `the link ${target} points outside the repository`);
        continue;
      }
      if (!existsSync(resolved)) {
        problem(index + 1, `broken link ${target}: ${relative} does not exist`);
        continue;
      }
      if (anchor && statSync(resolved).isFile() && /\.md$/i.test(resolved)) {
        let wanted = anchor;
        try {
          wanted = decodeURIComponent(anchor);
        } catch {
          // Compare the raw anchor when it is not valid percent-encoding.
        }
        if (!anchorsOf(resolved).has(wanted.toLowerCase())) problem(index + 1, `broken link ${target}: ${relative || path.basename(resolved)} has no heading #${anchor}`);
      }
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Report

function summarise(rows) {
  const count = (list, key, value) => list.filter((row) => row[key] === value).length;
  const areas = [...new Set(rows.map((row) => row.area))];
  const lines = areas.map((area) => {
    const inArea = rows.filter((row) => row.area === area);
    return `  ${area || '(no heading)'}: ${inArea.length} rows, ${count(inArea, 'status', 'done')} done, ${count(inArea, 'status', 'open')} open, ${count(inArea, 'status', 'n/a')} n/a`;
  });
  const who = WHO_VALUES.map((value) => {
    const list = rows.filter((row) => row.who === value);
    return `${value} ${list.length} (${count(list, 'status', 'open')} open)`;
  }).join(', ');
  return { header: `${rows.length} rows in ${areas.length} areas; ${who}`, lines };
}

function usage(stream) {
  stream.write(
    'Usage: node tools/scripts/check-golive.mjs [--agent-items-done | --require-done] <checklist.md>...\n' +
      '       node tools/scripts/check-golive.mjs --self-test\n' +
      '  --agent-items-done  also fail on any open row whose Who is agent\n' +
      '  --require-done      also fail on any open row (go-live day)\n',
  );
}

function main(argv) {
  if (argv.includes('--help')) {
    usage(process.stdout);
    return 0;
  }
  if (argv.includes('--self-test')) return selfTest();
  let mode = 'default';
  const files = [];
  for (const arg of argv) {
    if (arg === '--agent-items-done' || arg === '--require-done') {
      if (mode !== 'default' && mode !== arg.slice(2)) {
        process.stderr.write('check-golive: use --agent-items-done or --require-done, not both\n');
        return 2;
      }
      mode = arg.slice(2);
    } else if (arg.startsWith('--')) {
      process.stderr.write(`check-golive: unknown option ${arg}\n`);
      usage(process.stderr);
      return 2;
    } else {
      files.push(arg);
    }
  }
  if (files.length === 0) {
    usage(process.stderr);
    return 2;
  }
  let total = 0;
  for (const file of files) {
    if (!existsSync(file) || !statSync(file).isFile()) {
      process.stderr.write(`check-golive: ${file} does not exist\n`);
      return 2;
    }
    const { rows, problems } = checkChecklist(file, { mode });
    const shown = path.relative(process.cwd(), path.resolve(file)) || file;
    const summary = summarise(rows);
    process.stdout.write(`check-golive: ${shown}: ${summary.header}\n${summary.lines.join('\n')}\n`);
    for (const { line, message } of problems) process.stdout.write(`${shown}:${line}: ${message}\n`);
    total += problems.length;
  }
  const modeText = mode === 'default' ? 'default mode' : `--${mode}`;
  if (total > 0) {
    process.stderr.write(`check-golive: ${total} problem(s) found (${modeText})\n`);
    return 1;
  }
  process.stdout.write(`check-golive: pass (${modeText})\n`);
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Self-test: fixtures in a temporary folder that stands in for a repository

function selfTest() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mscd-check-golive-'));
  const results = [];
  const expect = (name, condition, detail = '') => results.push({ name, ok: Boolean(condition), detail });
  try {
    mkdirSync(path.join(dir, '.git'));
    mkdirSync(path.join(dir, 'docs'));
    writeFileSync(path.join(dir, 'README.md'), '# Root\n');
    writeFileSync(path.join(dir, 'docs', 'guide.md'), '# Guide\n\n## Second part: K.7 notes\n\n## Second part: K.7 notes\n\n<a id="custom"></a>\n');
    const header = '| ID | Item | Why it matters | Who | Evidence | Status |\n|---|---|---|---|---|---|\n';
    writeFileSync(
      path.join(dir, 'docs', 'good.md'),
      '# Checklist\n\nSee [guide](guide.md#second-part-k7-notes-1), [root](/README.md), [custom](guide.md#custom), ' +
        '[web](https://example.com), [mail](mailto:a@example.com), `[code](missing.md)` and [top](#checklist).\n\n' +
        '| Column | Meaning |\n|---|---|\n| ID | `GL-nn`, never reused |\n\n' +
        '## Security\n\n' + header +
        '| GL-01 | First | Reason | agent | `cmd a \\| b` | done |\n' +
        '| GL-02 | Second | Reason | owner | [doc](guide.md) | open |\n' +
        '| GL-03 | Third | Reason | `agent` | CI job `x` | open |\n' +
        '| GL-04 | Fourth | Reason | owner | Not used on this host | n/a |\n\n' +
        '```text\n| GL-99 | in a fence | ignored | x | | |\n[broken](nowhere.md)\n```\n\n' +
        '## Sign-off\n\n| Name | Date |\n|---|---|\n| | |\n',
    );
    const good = (mode) => checkChecklist(path.join(dir, 'docs', 'good.md'), { mode });
    const plainRun = good('default');
    expect('valid checklist passes the default mode', plainRun.problems.length === 0, JSON.stringify(plainRun.problems));
    expect('four rows are read, the fenced row is ignored', plainRun.rows.length === 4, String(plainRun.rows.length));
    expect('an escaped pipe stays inside its cell', plainRun.rows[0].status === 'done');
    const agentRun = good('agent-items-done');
    expect('--agent-items-done fails on the open agent row only', agentRun.problems.length === 1 && /GL-03 is an open agent row/.test(agentRun.problems[0].message), JSON.stringify(agentRun.problems));
    const doneRun = good('require-done');
    expect('--require-done fails on both open rows', doneRun.problems.length === 2 && doneRun.problems.every((p) => / is open /.test(p.message)), JSON.stringify(doneRun.problems));

    writeFileSync(
      path.join(dir, 'docs', 'bad.md'),
      '# Bad\n\n## Area\n\n' + header +
        '|  | No id | Reason | agent | cmd | open |\n' +
        '| GL-05 | Bad who | Reason | vendor | cmd | open |\n' +
        '| GL-06 | No evidence | Reason | owner |  | open |\n' +
        '| GL-07 | Bad status | Reason | owner | cmd | started |\n' +
        '| GL-07 | Repeated id | Reason | owner | cmd | open |\n' +
        '| GL-08 | Too few cells | Reason | owner | open |\n' +
        '| GL-09 | No reason |  | owner | TBD | open |\n' +
        '| GL-1 | Short id | Reason | owner | cmd | open |\n\n' +
        '| ID | Item | Status |\n|---|---|---|\n| GL-10 | Missing columns | open |\n\n' +
        '| Name | Value |\n|---|---|\n| GL-11 | in another table |\n\n' +
        '| GL-12 | no header | x | owner | cmd | open |\n\n' +
        '[missing](missing.md) [anchor](guide.md#nope) [outside](../../outside.md) [same](#area) [same bad](#nothing)\n' +
        '[ref]: ./also-missing.md\n',
    );
    const bad = checkChecklist(path.join(dir, 'docs', 'bad.md'));
    const has = (pattern) => bad.problems.some((p) => pattern.test(p.message));
    expect('a row without an id fails', has(/the row lacks an id/));
    expect('an unknown who fails', has(/GL-05 has who "vendor"/));
    expect('empty evidence fails', has(/GL-06 lacks evidence/));
    expect('placeholder evidence fails', has(/GL-09 lacks evidence/));
    expect('an unknown status fails', has(/GL-07 has status "started"/));
    expect('a repeated id fails', has(/GL-07 repeats the id/));
    expect('a wrong cell count fails', has(/the row has 5 cells and the header has 6/));
    expect('a missing reason fails', has(/GL-09 lacks the reason/));
    expect('an id that is not GL-nn fails', has(/the id "GL-1" does not match/));
    expect('a checklist table without the six columns fails', has(/lacks the column\(s\) Why it matters, Who, Evidence$/));
    expect('a GL row in another table fails', has(/GL row outside a checklist table \(the table needs the columns/));
    expect('a GL line outside any table fails', has(/GL row outside a checklist table \(a blank line ends a table/));
    expect('a link to a missing file fails', has(/broken link missing\.md/));
    expect('a link to a missing heading fails', has(/broken link guide\.md#nope/));
    expect('a link outside the repository fails', has(/\.\.\/\.\.\/outside\.md points outside the repository/));
    expect('a same-file link to a missing heading fails', has(/broken link #nothing/));
    expect('a same-file link to an existing heading passes', !has(/#area/));
    expect('a broken reference definition fails', has(/broken link \.\/also-missing\.md/));

    writeFileSync(
      path.join(dir, 'docs', 'pipes.md'),
      '# Pipes\n\n## Area\n\n' + header +
        '| GL-01 | First | Reason | agent | cmd | done |\n' +
        'GL-02 | No leading pipe | Reason | owner | cmd | open\n' +
        '| GL-03 | Third | Reason | owner | cmd | done |\n\n' +
        'GL-04 | After a blank line | Reason | owner | cmd | open\n\n' +
        '## Pipeless\n\nID | Item | Why it matters | Who | Evidence | Status\n---|---|---|---|---|---\n' +
        'GL-05 | Pipeless table | Reason | agent | cmd | open\n\n' +
        '| ID | Item | Why it matters | Who | Evidence | Status |\n|---|---|---|---|---|\n' +
        '| GL-06 | Header and delimiter differ | Reason | owner | cmd | open |\n',
    );
    const pipes = (mode) => checkChecklist(path.join(dir, 'docs', 'pipes.md'), { mode });
    const pipesRun = pipes('default');
    const pipeIds = pipesRun.rows.map((row) => row.id).join(',');
    expect('a row without a leading pipe is read as a row of its table', pipeIds === 'GL-01,GL-02,GL-03,GL-05', pipeIds);
    expect('a GL line without pipes at the ends, after a blank line, fails', pipesRun.problems.some((p) => p.line === 11 && /GL row outside a checklist table/.test(p.message)), JSON.stringify(pipesRun.problems));
    expect('a header and delimiter with different cell counts are no table', pipesRun.problems.some((p) => p.line === 21 && /GL row outside a checklist table/.test(p.message)), JSON.stringify(pipesRun.problems));
    expect('only those two lines fail the default mode', pipesRun.problems.length === 2, JSON.stringify(pipesRun.problems));
    const pipesDone = pipes('require-done');
    expect('--require-done fails on an open row without a leading pipe', pipesDone.problems.some((p) => /GL-02 is open/.test(p.message)), JSON.stringify(pipesDone.problems));
    expect('--agent-items-done fails on an open agent row of a pipeless table', pipes('agent-items-done').problems.some((p) => /GL-05 is an open agent row/.test(p.message)));

    writeFileSync(path.join(dir, 'docs', 'empty.md'), '# Nothing here\n\n| A | B |\n|---|---|\n| 1 | 2 |\n');
    const empty = checkChecklist(path.join(dir, 'docs', 'empty.md'));
    expect('a file without a checklist table fails', empty.problems.some((p) => /no checklist table found/.test(p.message)));
    expect('heading slugs follow GitHub', headingSlug('K.7 Order of going live') === 'k7-order-of-going-live' && headingSlug('Data `subjects`: requests') === 'data-subjects-requests');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const result of results) {
    process.stdout.write(`${result.ok ? 'ok  ' : 'FAIL'} ${result.name}${result.ok || !result.detail ? '' : `: ${result.detail}`}\n`);
  }
  const failed = results.filter((result) => !result.ok).length;
  if (failed > 0) {
    process.stderr.write(`check-golive self-test: ${failed} of ${results.length} checks failed\n`);
    return 1;
  }
  process.stdout.write(`check-golive self-test: pass (${results.length} checks)\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
