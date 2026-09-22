import { diagnostic, firstMeaningful, lines, namedTestTotals, result } from './common.mjs';

function locationFromLines(input, start, end) {
  for (let index = start; index < end; index++) {
    const line = input[index];
    const stack = line.match(/(?:\u276f\s*|.*?\()(.+?\.(?:[cm]?[jt]sx?|tsx?|jsx?)):(\d+):(\d+)/) ||
      line.match(/\bat\s+(.+?\.(?:[cm]?[jt]sx?|tsx?|jsx?)):(\d+):(\d+)/);
    if (stack) return { file: stack[1], line: Number(stack[2]), column: Number(stack[3]) };
  }
  return {};
}

function parseFailures(output, options, { parserId, header, bullet, tool, testTotals }) {
  const input = lines(output), found = [];
  const headers = [];
  for (let index = 0; index < input.length; index++) if (header.test(input[index])) headers.push(index);
  for (const start of headers) {
    const end = headers.find(index => index > start) ?? input.length;
    const bullets = [];
    for (let index = start + 1; index < end; index++) {
      // Vitest uses the same arrow glyph for test names and code-frame source
      // locations. Only the former represents a failed test.
      if (bullet.test(input[index]) && !/^\s*\u276f\s+.+\.(?:[cm]?[jt]sx?|tsx?|jsx?):\d+:\d+\s*$/.test(input[index])) bullets.push(index);
    }
    const starts = bullets.length ? bullets : [start];
    for (let position = 0; position < starts.length; position++) {
      const failureStart = starts[position];
      const failureEnd = starts[position + 1] ?? end;
      const failureLine = input[failureStart];
      const subject = failureStart === start ? failureLine.replace(header, '').trim() : failureLine.replace(bullet, '').trim();
      const message = firstMeaningful(input.slice(failureStart + 1, failureEnd));
      const location = locationFromLines(input, failureStart, failureEnd);
      found.push(diagnostic({ tool, kind: 'test_failure', severity: 'failure', subject, message: message || subject || 'Test failed', ...location }, options));
    }
  }
  return result(parserId, found, { testTotals: testTotals(input) });
}

function vitestTotals(input) {
  const line = input.find(value => /^\s*Tests\b/i.test(value));
  const totals = namedTestTotals(line || '');
  const total = line?.match(/\((\d+)\)\s*$/);
  if (total) totals.total = Number(total[1]);
  return totals;
}

function jestTotals(input) {
  return namedTestTotals(input.find(value => /^\s*Tests\s*:/i.test(value)) || '');
}

export function parseVitest(output, options = {}) {
  // Vitest starts a failed-file block with "FAIL path" and test failures with
  // an AssertionError/code-frame below it.
  return parseFailures(output, options, { parserId: 'vitest', tool: 'vitest', header: /^\s*FAIL\s+/, bullet: /^\s*(?:\u276f|\u00d7)\s*/, testTotals: vitestTotals });
}

export function parseJest(output, options = {}) {
  return parseFailures(output, options, { parserId: 'jest', tool: 'jest', header: /^\s*FAIL\s+/, bullet: /^\s*\u25cf\s*/, testTotals: jestTotals });
}
