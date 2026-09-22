import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalRelativePath, realWorkspaceRoot } from './paths.mjs';
import { hashParts, sha256, workspaceId } from './hashing.mjs';

export class WorkspaceSnapshotError extends Error {
  constructor(code, message, details = []) { super(message); this.code = code; this.details = details; }
}

function git(root, args, { allowFailure = false } = {}) {
  const result = execFileSync('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return Buffer.isBuffer(result) ? result : Buffer.from(result || '');
}

function gitSafe(root, args) {
  try { return git(root, args); }
  catch (error) { throw new WorkspaceSnapshotError('GIT_ERROR', `Git command failed: git ${args.join(' ')}`, [String(error.stderr || error.message)]); }
}

function decodePath(buffer) {
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) throw new WorkspaceSnapshotError('UNSUPPORTED_PATH_ENCODING', 'Git returned a non-UTF-8 path.');
  return canonicalRelativePath(text);
}

function parseStatus(root, output) {
  const fields = output.length ? output.toString('binary').split('\0').slice(0, -1).map(value => Buffer.from(value, 'binary')) : [];
  const entries = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]; if (!field.length) continue;
    const lead = String.fromCharCode(field[0]);
    if (lead === '#') continue;
    const text = field.toString('utf8');
    if (lead === '?') { entries.push({ path: decodePath(field.subarray(2)), status: 'untracked', worktreeChanged: true }); continue; }
    if (lead === '!') continue;
    if (lead === 'u') throw new WorkspaceSnapshotError('UNMERGED_INDEX', 'Cannot fingerprint a workspace with unmerged index entries.');
    if (lead !== '1' && lead !== '2') throw new WorkspaceSnapshotError('UNKNOWN_GIT_STATUS', `Unsupported Git status record: ${lead}`);
    const firstSpace = field.indexOf(0x20), secondSpace = field.indexOf(0x20, firstSpace + 1);
    const xy = field.subarray(firstSpace + 1, secondSpace).toString('ascii');
    // The pathname is after seven fixed space-delimited fields for type 1 and eight for type 2.
    let spaces = 0, cursor = 0;
    const requiredSpaces = lead === '1' ? 8 : 9;
    while (cursor < field.length && spaces < requiredSpaces) { if (field[cursor++] === 0x20) spaces++; }
    if (spaces !== requiredSpaces) throw new WorkspaceSnapshotError('MALFORMED_GIT_STATUS', 'Git returned a malformed porcelain status record.');
    const statusPath = decodePath(field.subarray(cursor));
    if (lead === '2') index++; // rename/copy source path follows as the next NUL field; target state is sufficient.
    entries.push({ path: statusPath, status: 'tracked', worktreeChanged: xy[1] !== '.', xy, submodule: text.split(' ')[2] !== 'N...' });
  }
  return entries;
}

async function stableEntry(root, relativePath) {
  const absolute = path.resolve(root, ...relativePath.split('/'));
  const before = await fs.lstat(absolute, { bigint: true }).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!before) return { path: relativePath, kind: 'deleted', mode: 0, contentHash: null, byteLength: 0 };
  if (before.isDirectory()) throw new WorkspaceSnapshotError('UNSUPPORTED_DIRTY_SUBMODULE', `Dirty directory/submodule cannot be fingerprinted: ${relativePath}`);
  let contentHash, byteLength;
  if (before.isSymbolicLink()) {
    const content = Buffer.from(await fs.readlink(absolute), 'utf8');
    contentHash = sha256(content); byteLength = content.length;
  } else if (before.isFile()) {
    const hash = createHash('sha256'); let length = 0;
    try {
      for await (const chunk of createReadStream(absolute)) { hash.update(chunk); length += chunk.length; }
    } catch (error) {
      throw new WorkspaceSnapshotError('WORKSPACE_CHANGED', `File changed during workspace fingerprint: ${relativePath}`, [error.message]);
    }
    contentHash = hash.digest('hex'); byteLength = length;
  }
  else throw new WorkspaceSnapshotError('UNSUPPORTED_FILE_TYPE', `Unsupported file type: ${relativePath}`);
  const after = await fs.lstat(absolute, { bigint: true }).catch(error => {
    if (error.code === 'ENOENT') throw new WorkspaceSnapshotError('WORKSPACE_CHANGED', `File changed during workspace fingerprint: ${relativePath}`);
    throw error;
  });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.mode !== after.mode) throw new WorkspaceSnapshotError('WORKSPACE_CHANGED', `File changed during workspace fingerprint: ${relativePath}`);
  const kind = before.isSymbolicLink() ? 'symlink' : 'file';
  const mode = Number(before.mode & 0o777n);
  return { path: relativePath, kind, mode, contentHash, byteLength, entryHash: hashParts([kind, String(mode), contentHash]) };
}

async function gitState(root) {
  const head = (() => { try { return git(root, ['rev-parse', '--verify', 'HEAD']).toString('utf8').trim(); } catch { return 'UNBORN'; } })();
  // Hash canonical staged entries, not raw .git/index bytes. The latter carry
  // mutable stat-cache metadata and can change after update-index --refresh
  // even when repository content is identical.
  const indexEntries = gitSafe(root, ['ls-files', '--stage', '-z']);
  return { head, indexHash: sha256(indexEntries) };
}

async function gitSnapshot(root) {
  const state = await gitState(root);
  const status = gitSafe(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=none']);
  return { ...state, status, statusHash: sha256(status) };
}

function assertSameGitSnapshot(before, after) {
  if (before.head !== after.head || before.indexHash !== after.indexHash || before.statusHash !== after.statusHash) {
    throw new WorkspaceSnapshotError('WORKSPACE_CHANGED', 'Git HEAD, index, or worktree status changed during workspace fingerprint.');
  }
}

function assertSameEntry(before, after) {
  if (before.path !== after.path || before.kind !== after.kind || before.mode !== after.mode || before.contentHash !== after.contentHash || before.byteLength !== after.byteLength) {
    throw new WorkspaceSnapshotError('WORKSPACE_CHANGED', `File changed during workspace fingerprint: ${before.path}`);
  }
}

async function fingerprintOnce(root, includeIgnoredPaths) {
  const before = await gitSnapshot(root);
  const statuses = parseStatus(root, before.status);
  const selected = new Map();
  for (const status of statuses) {
    if (status.submodule) throw new WorkspaceSnapshotError('UNSUPPORTED_DIRTY_SUBMODULE', `Dirty submodule cannot be fingerprinted: ${status.path}`);
    if (status.worktreeChanged) selected.set(status.path, status);
  }
  // Ignored inputs are opt-in exact paths. They are only useful when callers
  // also want them included in the workspace identity.
  for (const input of includeIgnoredPaths) selected.set(canonicalRelativePath(input), { path: canonicalRelativePath(input), status: 'included-ignored', worktreeChanged: true });
  const entries = [];
  for (const item of [...selected.values()].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))) entries.push(await stableEntry(root, item.path));
  const afterHashing = await gitSnapshot(root);
  assertSameGitSnapshot(before, afterHashing);
  for (const entry of entries) assertSameEntry(entry, await stableEntry(root, entry.path));
  const afterVerification = await gitSnapshot(root);
  assertSameGitSnapshot(before, afterVerification);
  const manifestHash = hashParts(['codex-accelerator-workspace-v1', before.head, before.indexHash, ...entries.flatMap(entry => [entry.path, entry.kind, String(entry.mode), entry.contentHash || 'DELETED'])]);
  return { id: workspaceId(manifestHash), format: 1, root, headOid: before.head, indexHash: before.indexHash, manifestHash, complete: true, entries };
}

/** Build an optimistic, content-addressed identity for the current Git workspace. */
export async function fingerprintWorkspace(workspaceRoot, { attempts = 3, includeIgnoredPaths = [] } = {}) {
  const root = await realWorkspaceRoot(workspaceRoot);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await fingerprintOnce(root, includeIgnoredPaths); }
    catch (error) {
      lastError = error;
      if (!(error instanceof WorkspaceSnapshotError) || error.code !== 'WORKSPACE_CHANGED') throw error;
    }
  }
  throw new WorkspaceSnapshotError('WORKSPACE_BUSY', 'Workspace changed repeatedly while its fingerprint was being captured.', [lastError?.message].filter(Boolean));
}

/** True only when Git considers this path ignored. */
export function isIgnoredByGit(workspaceRoot, relativePath) {
  const canonical = canonicalRelativePath(relativePath);
  try { git(workspaceRoot, ['check-ignore', '--quiet', '--', canonical]); return true; }
  catch (error) {
    // `check-ignore --quiet` exits 1 for a non-ignored path; all other failures
    // should be surfaced rather than turning a Git error into permission.
    if (error.status === 1) return false;
    throw new WorkspaceSnapshotError('GIT_ERROR', `Could not determine ignored status for ${canonical}.`);
  }
}
