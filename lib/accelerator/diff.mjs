import { sha256 } from './hashing.mjs';

/** Split text without normalising CRLF, CR, LF, or the absence of final EOL. */
export function splitLinesExact(text) {
  if (!text) return [];
  const lines = []; let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r') { if (text[i + 1] === '\n') i++; lines.push(text.slice(start, i + 1)); start = i + 1; }
    else if (text[i] === '\n') { lines.push(text.slice(start, i + 1)); start = i + 1; }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function pushOperation(operations, kind, line) {
  const previous = operations.at(-1);
  if (previous?.kind === kind) previous.lines.push(line);
  else operations.push({ kind, lines: [line] });
}

/**
 * Exact, deterministic line diff.  The bounded LCS branch is compact; for
 * very large files its prefix/suffix fallback remains exact and applyable.
 */
export function lineOperations(oldLines, newLines, { maxMatrixCells = 4_000_000 } = {}) {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let oldEnd = oldLines.length, newEnd = newLines.length;
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
  const a = oldLines.slice(prefix, oldEnd), b = newLines.slice(prefix, newEnd), operations = [];
  for (const line of oldLines.slice(0, prefix)) pushOperation(operations, 'equal', line);
  if (a.length * b.length > maxMatrixCells) {
    for (const line of a) pushOperation(operations, 'delete', line);
    for (const line of b) pushOperation(operations, 'insert', line);
  } else {
    const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    let i = 0, j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) { pushOperation(operations, 'equal', a[i]); i++; j++; }
      else if (j < b.length && (i === a.length || table[i][j + 1] >= table[i + 1][j])) { pushOperation(operations, 'insert', b[j++]); }
      else pushOperation(operations, 'delete', a[i++]);
    }
  }
  for (const line of oldLines.slice(oldEnd)) pushOperation(operations, 'equal', line);
  return operations;
}

function flatten(operations) {
  const rows = []; let oldLine = 1, newLine = 1;
  for (const operation of operations) for (const text of operation.lines) {
    rows.push({ kind: operation.kind, text, oldLine, newLine });
    if (operation.kind !== 'insert') oldLine++;
    if (operation.kind !== 'delete') newLine++;
  }
  return rows;
}

function hunkGroups(rows, contextLines) {
  const changes = rows.map((row, index) => row.kind !== 'equal' ? index : -1).filter(index => index >= 0);
  if (!changes.length) return [];
  const groups = [];
  for (const index of changes) {
    const start = Math.max(0, index - contextLines), end = Math.min(rows.length, index + contextLines + 1);
    const previous = groups.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else groups.push({ start, end });
  }
  return groups.map(group => {
    const lines = rows.slice(group.start, group.end);
    return {
      oldStart: lines[0].oldLine,
      oldCount: lines.filter(line => line.kind !== 'insert').length,
      newStart: lines[0].newLine,
      newCount: lines.filter(line => line.kind !== 'delete').length,
      lines: lines.map(({ kind, text }) => ({ kind, text })),
    };
  });
}

function printableLine(prefix, text) {
  const terminated = /(?:\r\n|\r|\n)$/.test(text);
  return `${prefix}${text}${terminated ? '' : '\n\\ No newline at end of file\n'}`;
}

export function makeTextDelta(oldText, newText, { path = 'file', contextLines = 3 } = {}) {
  const oldLines = splitLinesExact(oldText), newLines = splitLinesExact(newText);
  const operations = lineOperations(oldLines, newLines);
  const hunks = hunkGroups(flatten(operations), contextLines);
  const oldHash = sha256(Buffer.from(oldText, 'utf8')), newHash = sha256(Buffer.from(newText, 'utf8'));
  let unified = `--- ${path} (${oldHash})\n+++ ${path} (${newHash})\n`;
  for (const hunk of hunks) {
    unified += `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@\n`;
    for (const line of hunk.lines) unified += printableLine(line.kind === 'equal' ? ' ' : line.kind === 'delete' ? '-' : '+', line.text);
  }
  return { format: 'text-hunks-v1', oldHash, newHash, operations, hunks, unified };
}

/** Apply the canonical operations and reject an operation against the wrong base. */
export function applyTextDelta(oldText, delta) {
  const source = splitLinesExact(oldText); let offset = 0; const result = [];
  for (const operation of delta.operations) for (const line of operation.lines) {
    if (operation.kind === 'insert') result.push(line);
    else {
      if (source[offset] !== line) throw new Error('Delta does not apply to the supplied base text.');
      if (operation.kind === 'equal') result.push(line);
      offset++;
    }
  }
  if (offset !== source.length) throw new Error('Delta did not consume the supplied base text.');
  return result.join('');
}
