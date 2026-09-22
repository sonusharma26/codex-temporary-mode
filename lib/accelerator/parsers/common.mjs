import { createDiagnostic, sortDiagnostics, summarizeDiagnostics, stripAnsi } from '../diagnostics.mjs';

export function textOutput({ stdout = '', stderr = '' } = {}) {
  return `${stdout || ''}${stdout && stderr ? '\n' : ''}${stderr || ''}`.replace(/\r\n?/g, '\n');
}

export function lines(output) {
  return stripAnsi(textOutput(output)).replace(/\r\n?/g, '\n').split('\n');
}

export function result(parserId, diagnostics = [], extra = {}) {
  const ordered = sortDiagnostics(diagnostics);
  return { parserId, diagnostics: ordered, summary: summarizeDiagnostics(ordered), ...extra };
}

export function diagnostic(input, options) {
  return createDiagnostic(input, options);
}

export function parseLocation(value) {
  if (!value) return {};
  // Prefer the final numeric components so Windows drive letters and colons in
  // paths do not confuse the parser.
  const match = String(value).trim().match(/^(.*?)(?:\((\d+)(?:,(\d+))?\)|:(\d+)(?::(\d+))?)$/);
  if (!match) return { file: value.trim() };
  return { file: match[1], line: Number(match[2] || match[4]), column: match[3] == null && match[5] == null ? null : Number(match[3] || match[5]) };
}

export function firstMeaningful(linesToSearch) {
  return linesToSearch.map(line => line.trim()).find(line => line && !/^(?:at |\^|[-=]{3,})/.test(line)) || '';
}

export function commandText(command = []) {
  return Array.isArray(command) ? command.join(' ').toLowerCase() : String(command || '').toLowerCase();
}

/**
 * Parses the count vocabulary shared by human-readable test runners. The
 * caller decides which summary lines are authoritative. Null means that a
 * runner did not print that count; zero means it explicitly did.
 */
export function namedTestTotals(text) {
  const totals = { passed: null, failed: null, skipped: null, ignored: null, total: null };
  const assign = (name, value) => { totals[name] = (totals[name] ?? 0) + Number(value); };
  for (const match of String(text).matchAll(/\b(\d+)\s+(passed|failed|skipped|ignored|total)\b/gi)) assign(match[2].toLowerCase(), match[1]);
  for (const match of String(text).matchAll(/\b(passed|failed|skipped|ignored|total)\s*:\s*(\d+)\b/gi)) assign(match[1].toLowerCase(), match[2]);
  return totals;
}

export function hasTestTotals(totals) {
  return Object.values(totals).some(value => value !== null);
}

export function addTestTotals(left, right) {
  const result = {};
  for (const name of ['passed', 'failed', 'skipped', 'ignored', 'total']) {
    result[name] = left[name] == null && right[name] == null ? null : (left[name] || 0) + (right[name] || 0);
  }
  return result;
}
