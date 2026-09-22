import { diagnostic, lines, result } from './common.mjs';

// tsc's two normal human-readable forms. Continuations are appended only when
// they belong to the immediately preceding compiler message.
export function parseTypeScript(output, options = {}) {
  const found = [];
  const input = lines(output);
  for (let index = 0; index < input.length; index++) {
    const line = input[index];
    const match = line.match(/^(.+?)(?:\((\d+),(\d+)\)|:(\d+):(\d+))\s*(?:-|:)\s*(error|warning)\s+(TS\d+):\s*(.*)$/i);
    if (!match) continue;
    const continuation = [];
    for (let cursor = index + 1; cursor < input.length; cursor++) {
      const next = input[cursor];
      if (/^.+?(?:\(\d+,\d+\)|:\d+:\d+)\s*(?:-|:)\s*(?:error|warning)\s+TS\d+:/i.test(next)) break;
      if (!next.trim() || /^\s{2,}/.test(next)) continuation.push(next.trim());
      else break;
    }
    found.push(diagnostic({
      tool: 'typescript', severity: match[6].toLowerCase(), file: match[1], line: Number(match[2] || match[4]), column: Number(match[3] || match[5]), code: match[7],
      message: [match[8], ...continuation].filter(Boolean).join(' '),
    }, options));
  }
  return result('typescript', found);
}
