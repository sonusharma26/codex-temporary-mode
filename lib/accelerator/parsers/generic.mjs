import { diagnostic, lines, result } from './common.mjs';

/**
 * Last-resort deterministic extraction. This deliberately returns only lines
 * that the program explicitly marks as an error/fatal condition; it does not
 * summarize arbitrary command output.
 */
export function parseGeneric(output, options = {}) {
  const found = [];
  for (const line of lines(output)) {
    const located = line.match(/^(.+?):(\d+)(?::(\d+))?:\s*(?:error|fatal)\b[:\s-]*(.*)$/i);
    if (located) {
      found.push(diagnostic({ tool: 'generic', severity: 'error', file: located[1], line: Number(located[2]), column: located[3] ? Number(located[3]) : null, message: located[4] || 'Command error' }, options));
      continue;
    }
    const plain = line.match(/^\s*(?:fatal|error)\s*:\s*(.+)$/i);
    if (plain) found.push(diagnostic({ tool: 'generic', severity: 'error', message: plain[1] }, options));
  }
  return result('generic', found);
}
