import { addTestTotals, diagnostic, firstMeaningful, hasTestTotals, lines, namedTestTotals, result, textOutput } from './common.mjs';

function cargoJson(output, options) {
  const found = [];
  for (const line of textOutput(output).split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.reason !== 'compiler-message' || !event.message || event.message.level === 'note') continue;
    const message = event.message;
    const span = (message.spans || []).find(item => item.is_primary) || message.spans?.[0];
    found.push(diagnostic({
      tool: 'cargo', severity: message.level === 'warning' ? 'warning' : 'error', code: message.code?.code || null,
      message: message.message, file: span?.file_name, line: span?.line_start, column: span?.column_start,
      endLine: span?.line_end, endColumn: span?.column_end,
    }, options));
  }
  return found;
}

export function parseCargo(output, options = {}) {
  const input = lines(output), found = cargoJson(output, options);
  let testTotals = { passed: null, failed: null, skipped: null, ignored: null, total: null };
  for (let index = 0; index < input.length; index++) {
    const error = input[index].match(/^\s*(error|warning)(?:\[([^\]]+)\])?:\s*(.*)$/i);
    if (error) {
      if (error[1].toLowerCase() === 'error' && /^test failed\b/i.test(error[3])) continue;
      const location = input.slice(index + 1, index + 6).map(line => line.match(/^\s*--?>\s+(.+?):(\d+):(\d+)/)).find(Boolean);
      found.push(diagnostic({ tool: 'cargo', severity: error[1].toLowerCase(), code: error[2] || null, message: error[3], file: location?.[1], line: location ? Number(location[2]) : null, column: location ? Number(location[3]) : null }, options));
      continue;
    }
    const failed = input[index].match(/^----\s+(.+?)\s+stdout\s+----$/);
    if (failed) found.push(diagnostic({ tool: 'cargo', kind: 'test_failure', severity: 'failure', subject: failed[1], message: firstMeaningful(input.slice(index + 1, index + 6)) || 'Test failed' }, options));
    if (/^test result:\s+(?:ok|FAILED)\./i.test(input[index])) testTotals = addTestTotals(testTotals, namedTestTotals(input[index]));
  }
  return result('cargo', found, { testTotals: hasTestTotals(testTotals) ? testTotals : null });
}
