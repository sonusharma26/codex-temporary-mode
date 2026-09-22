import crypto from 'node:crypto';
import path from 'node:path';

const ANSI = /\x1B\][^\x07]*(?:\x07|\x1B\\)|\x1B\[[0-?]*[ -/]*[@-~]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Remove terminal decoration without changing the text a diagnostic describes. */
export function stripAnsi(value = '') {
  return String(value).replace(ANSI, '');
}

/** A stable, single-line representation suitable for an identity key. */
export function normalizeText(value = '') {
  return stripAnsi(value).normalize('NFC').replace(/\r\n?/g, '\n').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Converts a path emitted by a tool into a workspace-relative, slash-separated
 * path. It deliberately does not call realpath: diagnostics may refer to a
 * deleted file or a snapshot path that no longer exists.
 */
export function normalizeFilePath(file, { workspaceRoot, platform = process.platform } = {}) {
  if (file == null || file === '') return null;
  let result = stripAnsi(file).trim().replace(/^file:\/\//i, '').replace(/\\/g, '/');
  const root = workspaceRoot ? String(workspaceRoot).replace(/\\/g, '/').replace(/\/+$/, '') : null;
  if (root && (result === root || result.startsWith(`${root}/`))) result = result.slice(root.length).replace(/^\/+/, '');
  // `path.relative` safely handles native absolute paths that were not textual
  // children of the normalized root above.
  if (workspaceRoot && path.isAbsolute(file)) {
    const relative = path.relative(workspaceRoot, file).replace(/\\/g, '/');
    if (relative && relative !== '..' && !relative.startsWith('../')) result = relative;
  }
  result = result.replace(/^\.\//, '').replace(/\/+/g, '/');
  return platform === 'win32' ? result.toLowerCase() : result;
}

function integerOrNull(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function fingerprintDiagnostic(diagnostic) {
  const fields = [
    diagnostic.tool || 'generic',
    diagnostic.kind || 'diagnostic',
    diagnostic.file || '',
    diagnostic.code || '',
    diagnostic.message || '',
    diagnostic.subject || '',
    diagnostic.line ?? '',
    diagnostic.column ?? '',
    diagnostic.endLine ?? '',
    diagnostic.endColumn ?? '',
  ];
  const encoded = fields.map(field => `${Buffer.byteLength(String(field), 'utf8')}:${field}`).join('|');
  return crypto.createHash('sha256').update(encoded, 'utf8').digest('hex');
}

/**
 * Builds the common output of every deterministic parser. Parser-specific
 * metadata must live in `details`; it is intentionally excluded from the key.
 */
export function createDiagnostic(input, options = {}) {
  const diagnostic = {
    kind: input.kind || 'diagnostic',
    tool: normalizeText(input.tool || options.tool || 'generic').toLowerCase() || 'generic',
    severity: input.severity || 'error',
    file: normalizeFilePath(input.file, options),
    line: integerOrNull(input.line),
    column: integerOrNull(input.column),
    endLine: integerOrNull(input.endLine),
    endColumn: integerOrNull(input.endColumn),
    code: input.code == null ? null : normalizeText(input.code),
    message: normalizeText(input.message || ''),
    subject: input.subject == null ? null : normalizeText(input.subject),
  };
  if (!diagnostic.message) diagnostic.message = diagnostic.code || diagnostic.kind;
  if (input.details !== undefined) diagnostic.details = input.details;
  diagnostic.fingerprint = fingerprintDiagnostic(diagnostic);
  return diagnostic;
}

export function sortDiagnostics(diagnostics) {
  return [...diagnostics].sort((left, right) =>
    String(left.file || '').localeCompare(String(right.file || '')) ||
    (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER) ||
    (left.column ?? Number.MAX_SAFE_INTEGER) - (right.column ?? Number.MAX_SAFE_INTEGER) ||
    String(left.tool).localeCompare(String(right.tool)) ||
    String(left.fingerprint).localeCompare(String(right.fingerprint))
  );
}

/** Compare fully parsed runs. Duplicate identities are retained deterministically. */
export function diffDiagnostics(previous = [], current = []) {
  const previousByKey = new Map();
  for (const item of previous) {
    const bucket = previousByKey.get(item.fingerprint) || [];
    bucket.push(item); previousByKey.set(item.fingerprint, bucket);
  }
  const added = [], remaining = [];
  for (const item of current) {
    const bucket = previousByKey.get(item.fingerprint);
    if (bucket?.length) { bucket.pop(); remaining.push(item); }
    else added.push(item);
  }
  const resolved = [];
  for (const bucket of previousByKey.values()) resolved.push(...bucket);
  return { added: sortDiagnostics(added), resolved: sortDiagnostics(resolved), remaining: sortDiagnostics(remaining) };
}

export function summarizeDiagnostics(diagnostics = []) {
  const summary = { errors: 0, warnings: 0, failures: 0, total: diagnostics.length };
  for (const diagnostic of diagnostics) {
    if (diagnostic.kind === 'test_failure' || diagnostic.severity === 'failure') summary.failures++;
    else if (diagnostic.severity === 'warning') summary.warnings++;
    else summary.errors++;
  }
  return summary;
}
