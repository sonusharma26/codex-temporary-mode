import { diagnostic, hasTestTotals, lines, namedTestTotals, result } from './common.mjs';

export function parsePytest(output, options = {}) {
  const found = [], input = lines(output);
  let testTotals = { passed: null, failed: null, skipped: null, ignored: null, total: null };
  for (const line of input) {
    const failed = line.match(/^FAILED\s+(.+?)(?:\s+-\s+(.+))?$/);
    if (failed) {
      const node = failed[1].trim();
      const path = node.split('::')[0];
      found.push(diagnostic({ tool: 'pytest', kind: 'test_failure', severity: 'failure', file: path, subject: node, message: failed[2] || 'Test failed' }, options));
      continue;
    }
    // Syntax/import collection errors often use this direct location format.
    const error = line.match(/^(.+?\.py):(\d+):\s*(.+)$/);
    if (error && /(?:error|Error|SyntaxError|ImportError|Exception)/.test(error[3])) {
      found.push(diagnostic({ tool: 'pytest', severity: 'error', file: error[1], line: Number(error[2]), message: error[3] }, options));
    }
    if (/^=+.*(?:passed|failed|skipped|error).*?=+\s*$/i.test(line)) {
      const summaryTotals = namedTestTotals(line);
      for (const [name, value] of Object.entries(summaryTotals)) if (value !== null) testTotals[name] = value;
    }
    const collected = line.match(/\bcollected\s+(\d+)\s+items?\b/i);
    if (collected) testTotals.total = Number(collected[1]);
  }
  return result('pytest', found, { testTotals: hasTestTotals(testTotals) ? testTotals : null });
}
