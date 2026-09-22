import { diagnostic, lines, result, textOutput } from './common.mjs';

function severity(value) { return Number(value) === 1 || String(value).toLowerCase() === 'warning' ? 'warning' : 'error'; }

function jsonDiagnostics(output, options) {
  try {
    const parsed = JSON.parse(textOutput(output).trim());
    if (!Array.isArray(parsed)) return null;
    return parsed.flatMap(file => (file.messages || []).map(message => diagnostic({
      tool: 'eslint', severity: severity(message.severity), file: file.filePath, line: message.line, column: message.column,
      endLine: message.endLine, endColumn: message.endColumn, code: message.ruleId || (message.fatal ? 'eslint' : null), message: message.message,
    }, options)));
  } catch { return null; }
}

export function parseEslint(output, options = {}) {
  const asJson = jsonDiagnostics(output, options);
  if (asJson) return result('eslint', asJson);
  const found = [];
  let file = null;
  for (const line of lines(output)) {
    if (/^\S.*\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(line.trim())) { file = line.trim(); continue; }
    const match = line.match(/^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}([@\w./-]+))?\s*$/i);
    if (!match) continue;
    found.push(diagnostic({ tool: 'eslint', severity: match[3].toLowerCase(), file, line: Number(match[1]), column: Number(match[2]), code: match[5] || null, message: match[4] }, options));
  }
  return result('eslint', found);
}
