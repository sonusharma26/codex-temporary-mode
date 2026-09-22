import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './hashing.mjs';

export class PathSafetyError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function hasWindowsAbsolutePath(value) {
  return /^[a-zA-Z]:/.test(value) || /^\\\\/.test(value);
}

/** Convert a Git-style, root-relative path to its canonical stored form. */
export function canonicalRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new PathSafetyError('INVALID_PATH', 'A non-empty relative path is required.');
  if (path.isAbsolute(value) || hasWindowsAbsolutePath(value)) throw new PathSafetyError('PATH_ESCAPE', 'Absolute paths are not allowed.');
  const slashPath = value.replace(/\\/g, '/');
  const normalized = path.posix.normalize(slashPath);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) throw new PathSafetyError('PATH_ESCAPE', 'Path must remain inside the workspace.');
  const segments = normalized.split('/');
  if (segments.some(segment => segment.toLowerCase() === '.git')) throw new PathSafetyError('GIT_METADATA', 'The Git metadata directory cannot be read.');
  if (process.platform === 'win32' && segments.some(segment => segment.includes(':') || /[. ]$/.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    throw new PathSafetyError('INVALID_PATH', 'Windows device, alternate-stream, and ambiguous path names are not supported.');
  }
  return normalized;
}

export async function realWorkspaceRoot(root) {
  const resolved = await fs.realpath(root);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new PathSafetyError('INVALID_WORKSPACE', 'Workspace root must be a directory.');
  return resolved;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/**
 * Read only a regular in-workspace file.  Symlinks are rejected rather than
 * followed, so an apparently safe workspace path cannot disclose another path.
 */
export async function readStableRegularFile(root, requestedPath, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const canonicalPath = canonicalRelativePath(requestedPath);
  const realRoot = await realWorkspaceRoot(root);
  const candidate = path.resolve(realRoot, ...canonicalPath.split('/'));
  if (!isInside(realRoot, candidate)) throw new PathSafetyError('PATH_ESCAPE', 'Path must remain inside the workspace.');
  let linkStat;
  try { linkStat = await fs.lstat(candidate, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') throw new PathSafetyError('FILE_NOT_FOUND', `File not found: ${canonicalPath}`); throw error; }
  if (linkStat.isSymbolicLink()) throw new PathSafetyError('SYMLINK_NOT_SUPPORTED', 'Symlink source reads are not supported.');
  if (!linkStat.isFile()) throw new PathSafetyError('NOT_A_FILE', 'Only regular files can be read.');
  if (linkStat.size > BigInt(maxBytes)) throw new PathSafetyError('FILE_TOO_LARGE', `File exceeds the ${maxBytes}-byte Delta Mode limit.`);

  const realFile = await fs.realpath(candidate);
  if (!isInside(realRoot, realFile)) throw new PathSafetyError('PATH_ESCAPE', 'Resolved file escapes the workspace.');
  const handle = await fs.open(candidate, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new PathSafetyError('NOT_A_FILE', 'Only regular files can be read.');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const stable = before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && before.mode === after.mode;
    if (!stable) throw new PathSafetyError('FILE_CHANGED_DURING_READ', `File changed while being read: ${canonicalPath}`);
    if (bytes.includes(0)) throw new PathSafetyError('BINARY_FILE', 'Binary files do not have textual deltas.');
    // Preserve a UTF-8 BOM as U+FEFF so full reads and deltas remain byte-exact
    // when encoded back to UTF-8.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const endingKinds = new Set();
    if (/\r\n/.test(text)) endingKinds.add('crlf');
    if (/(^|[^\r])\n/.test(text)) endingKinds.add('lf');
    if (/\r(?!\n)/.test(text)) endingKinds.add('cr');
    const lineEndings = endingKinds.size > 1 ? 'mixed' : endingKinds.values().next().value || 'none';
    return { path: canonicalPath, bytes, text, contentHash: sha256(bytes), byteLength: bytes.length, lineEndings };
  } catch (error) {
    if (error instanceof TypeError && /utf-8/i.test(error.message)) throw new PathSafetyError('BINARY_FILE', 'File is not valid UTF-8 text.');
    throw error;
  } finally { await handle.close(); }
}
