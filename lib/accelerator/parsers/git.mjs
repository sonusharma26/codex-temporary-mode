import { diagnostic, lines, result, textOutput } from './common.mjs';

export function parseGit(output, options = {}) {
  const found = [];
  const raw = textOutput(output);
  // A porcelain-v1 -z response describes state, not a compiler failure. Keep
  // this deterministic metadata compact rather than inventing diagnostics.
  const statusCount = raw.includes('\0') ? raw.split('\0').filter(Boolean).length : 0;
  for (const line of lines(output)) {
    const whitespace = line.match(/^(.+?):(\d+):\s*(.+)$/);
    if (whitespace && /(?:trailing whitespace|space before tab|new blank line)/i.test(whitespace[3])) {
      found.push(diagnostic({ tool: 'git', kind: 'git_issue', severity: 'error', file: whitespace[1], line: Number(whitespace[2]), code: 'diff-check', message: whitespace[3] }, options));
      continue;
    }
    const fatal = line.match(/^(fatal|error):\s*(.+)$/i);
    if (fatal) found.push(diagnostic({ tool: 'git', kind: 'git_issue', severity: 'error', code: fatal[1].toLowerCase(), message: fatal[2] }, options));
  }
  return result('git', found, statusCount ? { state: { changedFiles: statusCount } } : {});
}
