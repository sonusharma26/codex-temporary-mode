import { diagnostic, firstMeaningful, hasTestTotals, lines, namedTestTotals, result } from './common.mjs';

export function parseDotnet(output, options = {}) {
  const input = lines(output), found = [];
  let testTotals = { passed: null, failed: null, skipped: null, ignored: null, total: null };
  for (let index = 0; index < input.length; index++) {
    const line = input[index];
    const compiler = line.match(/^(.+?)\((\d+)(?:,(\d+))?\):\s*(error|warning)\s+([A-Z]{2,}\d+):\s*(.*?)(?:\s+\[[^\]]+\])?$/i);
    if (compiler) {
      found.push(diagnostic({ tool: 'dotnet', severity: compiler[4].toLowerCase(), file: compiler[1], line: Number(compiler[2]), column: compiler[3] ? Number(compiler[3]) : null, code: compiler[5], message: compiler[6] }, options));
      continue;
    }
    // VSTest output is intentionally parsed only from its deterministic failure
    // headings; success/progress output is never returned as context.
    const test = line.match(/^\s*(?:Failed|\[xUnit\.net[^\]]*\]\s+\[FAIL\])\s+(.+?)(?:\s+\[[^\]]+\])?$/i);
    if (test) {
      const following = input.slice(index + 1, Math.min(input.length, index + 8));
      const stack = following.map(value => value.match(/\s+at .*? in (.+?):line (\d+)/)).find(Boolean);
      found.push(diagnostic({ tool: 'dotnet', kind: 'test_failure', severity: 'failure', subject: test[1], message: firstMeaningful(following) || 'Test failed', file: stack?.[1], line: stack ? Number(stack[2]) : null }, options));
    }
    if (/\b(?:Passed|Failed|Skipped|Total)\s*:/i.test(line)) testTotals = namedTestTotals(line);
  }
  return result('dotnet', found, { testTotals: hasTestTotals(testTotals) ? testTotals : null });
}
