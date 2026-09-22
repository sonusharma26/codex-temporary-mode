import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalRelativePath, realWorkspaceRoot } from '../paths.mjs';
import { hashParts } from '../hashing.mjs';
import { fingerprintWorkspace } from '../workspace.mjs';

const execFileAsync = promisify(execFile);
const SNAPSHOT_BRAND = Symbol('codex-pipeline-snapshot');
const SNAPSHOT_STATE = new WeakMap();
const MAX_GIT_LIST_BYTES = 64 * 1024 * 1024;

export class PipelineSnapshotError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.name = 'PipelineSnapshotError';
    this.code = code;
    this.details = details;
  }
}

function isInside(root, candidate, { allowSame = false } = {}) {
  const relative = path.relative(root, candidate);
  return (allowSame && relative === '') || (relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function statSignature(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].map(value => String(value)).join(':');
}

function assertOptions(options) {
  if (options == null || typeof options !== 'object' || Array.isArray(options)) {
    throw new PipelineSnapshotError('INVALID_OPTIONS', 'Snapshot options must be an object.');
  }
  if (typeof options.workspaceRoot !== 'string' || !options.workspaceRoot.trim() || options.workspaceRoot.includes('\0')) {
    throw new PipelineSnapshotError('INVALID_WORKSPACE', 'workspaceRoot must be a non-empty path.');
  }
  if (options.tempRoot !== undefined && (typeof options.tempRoot !== 'string' || !options.tempRoot.trim() || options.tempRoot.includes('\0'))) {
    throw new PipelineSnapshotError('INVALID_TEMP_ROOT', 'tempRoot must be a non-empty path when supplied.');
  }
  if (options.copyNodeModules !== undefined && typeof options.copyNodeModules !== 'boolean') {
    throw new PipelineSnapshotError('INVALID_NODE_MODULES_OPTION', 'copyNodeModules must be a boolean when supplied.');
  }
}

function fingerprintId(value, name) {
  if (value == null) return null;
  const id = typeof value === 'string' ? value : value?.id ?? value?.workspaceId;
  if (typeof id !== 'string' || !id || id.includes('\0') || id.length > 256) {
    throw new PipelineSnapshotError('INVALID_WORKSPACE_FINGERPRINT', `${name} must be a workspace fingerprint or workspace identifier.`);
  }
  return id;
}

function expectedWorkspaceId(options) {
  const direct = fingerprintId(options.expectedWorkspaceId, 'expectedWorkspaceId');
  const fingerprint = fingerprintId(options.workspaceFingerprint, 'workspaceFingerprint');
  if (direct && fingerprint && direct !== fingerprint) {
    throw new PipelineSnapshotError('CONFLICTING_WORKSPACE_FINGERPRINT', 'expectedWorkspaceId and workspaceFingerprint identify different workspaces.');
  }
  return direct || fingerprint;
}

function asSnapshotError(error, fallbackCode = 'SNAPSHOT_FAILED') {
  if (error instanceof PipelineSnapshotError) return error;
  const code = typeof error?.code === 'string' ? error.code : fallbackCode;
  return new PipelineSnapshotError(code, error?.message || 'Could not create an isolated validation snapshot.');
}

function decodeGitPath(bytes) {
  const value = bytes.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(bytes)) {
    throw new PipelineSnapshotError('UNSUPPORTED_PATH_ENCODING', 'Git returned a non-UTF-8 workspace path.');
  }
  return canonicalRelativePath(value);
}

async function listSnapshotPaths(root) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync('git', [
      '--no-optional-locks', 'ls-files', '--cached', '--others', '--exclude-standard', '-z',
    ], {
      cwd: root,
      encoding: 'buffer',
      maxBuffer: MAX_GIT_LIST_BYTES,
      windowsHide: true,
    }));
  } catch (error) {
    throw new PipelineSnapshotError('GIT_ERROR', 'Could not enumerate the current Git worktree.', [String(error?.stderr || error?.message || error)]);
  }
  const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '');
  const result = new Set();
  for (const part of buffer.toString('binary').split('\0').slice(0, -1)) {
    if (!part) continue;
    result.add(decodeGitPath(Buffer.from(part, 'binary')));
  }
  return [...result].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function safeSourcePath(root, relativePath) {
  const canonical = canonicalRelativePath(relativePath);
  const candidate = path.resolve(root, ...canonical.split('/'));
  if (!isInside(root, candidate)) throw new PipelineSnapshotError('PATH_ESCAPE', `Workspace path escaped its root: ${canonical}`);
  return { canonical, candidate };
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) throw new PipelineSnapshotError('SNAPSHOT_WRITE_FAILED', 'Snapshot storage accepted zero bytes.');
    offset += bytesWritten;
  }
}

async function copyRegularFile(source, target) {
  const sourceHandle = await fs.open(source, 'r');
  let targetHandle;
  try {
    const beforePath = await fs.lstat(source, { bigint: true });
    const beforeHandle = await sourceHandle.stat({ bigint: true });
    if (!beforePath.isFile() || !beforeHandle.isFile() || statSignature(beforePath) !== statSignature(beforeHandle)) {
      throw new PipelineSnapshotError('WORKSPACE_CHANGED', `File changed while preparing the snapshot: ${source}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    targetHandle = await fs.open(target, 'wx', Number(beforeHandle.mode & 0o777n));
    const buffer = Buffer.allocUnsafe(128 * 1024);
    const hash = createHash('sha256');
    let copiedBytes = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const chunk = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
      await writeAll(targetHandle, chunk);
      hash.update(chunk);
      copiedBytes += bytesRead;
    }
    await targetHandle.sync();
    const afterHandle = await sourceHandle.stat({ bigint: true });
    const afterPath = await fs.lstat(source, { bigint: true });
    if (copiedBytes !== Number(beforeHandle.size) || statSignature(beforePath) !== statSignature(afterPath) || statSignature(beforeHandle) !== statSignature(afterHandle)) {
      throw new PipelineSnapshotError('WORKSPACE_CHANGED', `File changed while copying the snapshot: ${source}`);
    }
    await fs.chmod(target, Number(beforeHandle.mode & 0o777n));
    return {
      kind: 'file',
      mode: Number(beforeHandle.mode & 0o777n),
      byteLength: copiedBytes,
      contentHash: hash.digest('hex'),
    };
  } finally {
    await Promise.allSettled([targetHandle?.close(), sourceHandle.close()]);
  }
}

async function copyWorktreeFiles(sourceRoot, snapshotRoot, paths) {
  let copiedFiles = 0;
  let omittedDeletedFiles = 0;
  const entries = [];
  for (const relativePath of paths) {
    const { candidate } = safeSourcePath(sourceRoot, relativePath);
    let sourceStat;
    try {
      sourceStat = await fs.lstat(candidate, { bigint: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        // `git ls-files --cached` includes paths deleted from the worktree.
        // Leaving them absent is exactly how a filesystem snapshot represents
        // the deletion.
        omittedDeletedFiles++;
        continue;
      }
      throw error;
    }
    if (sourceStat.isSymbolicLink()) {
      // Following a link could make validation read or mutate the moving source
      // tree (or any unrelated path). A fail-closed error is safer than a
      // snapshot which silently stops being isolated.
      throw new PipelineSnapshotError('SYMLINK_NOT_SUPPORTED', `Workspace symlinks cannot be included in an isolated snapshot: ${relativePath}`);
    }
    if (!sourceStat.isFile()) {
      throw new PipelineSnapshotError('UNSUPPORTED_FILE_TYPE', `Only regular files can be included in a snapshot: ${relativePath}`);
    }
    const target = path.resolve(snapshotRoot, ...relativePath.split('/'));
    if (!isInside(snapshotRoot, target)) throw new PipelineSnapshotError('PATH_ESCAPE', `Snapshot path escaped its root: ${relativePath}`);
    const copied = await copyRegularFile(candidate, target);
    entries.push({ path: relativePath, ...copied });
    copiedFiles++;
  }
  return { copiedFiles, omittedDeletedFiles, entries };
}

function treeHash(entries) {
  const ordered = [...entries].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return hashParts([
    'codex-pipeline-snapshot-tree-v1',
    ...ordered.flatMap(entry => [entry.path, entry.kind, String(entry.mode), String(entry.byteLength), entry.contentHash]),
  ]);
}

async function hashSnapshotFile(absolutePath, relativePath) {
  const before = await fs.lstat(absolutePath, { bigint: true });
  if (before.isSymbolicLink()) throw new PipelineSnapshotError('SNAPSHOT_TAMPERED', `Snapshot contains a symlink: ${relativePath}`);
  if (!before.isFile()) throw new PipelineSnapshotError('SNAPSHOT_TAMPERED', `Snapshot contains an unsupported entry: ${relativePath}`);
  const bytes = await fs.readFile(absolutePath);
  const after = await fs.lstat(absolutePath, { bigint: true });
  if (statSignature(before) !== statSignature(after)) throw new PipelineSnapshotError('SNAPSHOT_BUSY', `Snapshot changed while being checked: ${relativePath}`);
  return {
    path: relativePath,
    kind: 'file',
    mode: Number(before.mode & 0o777n),
    byteLength: bytes.length,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function snapshotTreeEntries(root, relativeDirectory = '') {
  const directory = relativeDirectory ? path.join(root, ...relativeDirectory.split('/')) : root;
  const names = await fs.readdir(directory, { withFileTypes: true });
  const entries = [];
  for (const item of names.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))) {
    // node_modules is copied solely to make Node validation executable. It is
    // deliberately outside the source-tree integrity identity.
    if (!relativeDirectory && item.name === 'node_modules') continue;
    const relativePath = relativeDirectory ? `${relativeDirectory}/${item.name}` : item.name;
    const canonical = canonicalRelativePath(relativePath);
    const absolute = path.resolve(root, ...canonical.split('/'));
    if (!isInside(root, absolute)) throw new PipelineSnapshotError('SNAPSHOT_TAMPERED', `Snapshot path escaped its root: ${canonical}`);
    const stat = await fs.lstat(absolute, { bigint: true });
    if (stat.isDirectory()) {
      entries.push(...await snapshotTreeEntries(root, canonical));
      continue;
    }
    entries.push(await hashSnapshotFile(absolute, canonical));
  }
  return entries;
}

async function copyNodeModules(sourceRoot, snapshotRoot, requested) {
  if (!requested) return { requested: false, status: 'not-requested' };
  const source = path.join(sourceRoot, 'node_modules');
  let sourceStat;
  try {
    sourceStat = await fs.lstat(source, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { requested: true, status: 'absent' };
    throw error;
  }
  if (sourceStat.isSymbolicLink()) {
    throw new PipelineSnapshotError('NODE_MODULES_SYMLINK_NOT_SUPPORTED', 'node_modules must be a real directory to preserve snapshot isolation.');
  }
  if (!sourceStat.isDirectory()) throw new PipelineSnapshotError('INVALID_NODE_MODULES', 'node_modules exists but is not a directory.');
  const target = path.join(snapshotRoot, 'node_modules');
  try {
    await fs.cp(source, target, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
      verbatimSymlinks: true,
      preserveTimestamps: false,
    });
    await assertDependencyTreeIsolated(target, snapshotRoot);
  } catch (error) {
    if (error instanceof PipelineSnapshotError) throw error;
    throw new PipelineSnapshotError('NODE_MODULES_COPY_FAILED', 'Could not copy node_modules into the isolated snapshot.', [error?.message || String(error)]);
  }
  return { requested: true, status: 'copied' };
}

async function assertDependencyTreeIsolated(directory, snapshotRoot) {
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) {
        let resolved;
        try { resolved = await fs.realpath(candidate); }
        catch (error) {
          throw new PipelineSnapshotError('BROKEN_NODE_MODULES_LINK', 'node_modules contains a broken dependency link.', [error?.message || String(error)]);
        }
        if (!isInside(snapshotRoot, resolved)) {
          throw new PipelineSnapshotError('NODE_MODULES_LINK_ESCAPE', 'A dependency link escapes the isolated validation snapshot.');
        }
        const targetStat = await fs.stat(resolved);
        if (!targetStat.isFile() && !targetStat.isDirectory()) {
          throw new PipelineSnapshotError('INVALID_NODE_MODULES', 'A dependency link targets an unsupported filesystem entry.');
        }
        continue;
      }
      if (stat.isDirectory()) pending.push(candidate);
      else if (!stat.isFile()) throw new PipelineSnapshotError('INVALID_NODE_MODULES', 'node_modules contains an unsupported filesystem entry.');
    }
  }
}

async function createSnapshotDirectory(sourceRoot, requestedTempRoot) {
  const tempRoot = requestedTempRoot ? path.resolve(requestedTempRoot) : await fs.realpath(os.tmpdir());
  let tempStat;
  try {
    tempStat = await fs.stat(tempRoot);
  } catch (error) {
    throw new PipelineSnapshotError('INVALID_TEMP_ROOT', `Snapshot temp root is unavailable: ${tempRoot}`, [error?.message || String(error)]);
  }
  if (!tempStat.isDirectory()) throw new PipelineSnapshotError('INVALID_TEMP_ROOT', 'Snapshot temp root must be a directory.');
  const root = await fs.mkdtemp(path.join(tempRoot, 'codex-pipeline-'));
  const realRoot = await fs.realpath(root);
  if (isInside(sourceRoot, realRoot, { allowSame: true })) {
    await fs.rm(realRoot, { recursive: true, force: true });
    throw new PipelineSnapshotError('UNSAFE_SNAPSHOT_ROOT', 'Snapshot storage must be outside the source workspace.');
  }
  return { root: realRoot, tempRoot: await fs.realpath(tempRoot) };
}

function defineSnapshot({ root, tempRoot, sourceRoot, fingerprint, files, nodeDependencies, integrity, sourceEntries }) {
  let cleaned = false;
  const snapshot = {
    schemaVersion: 1,
    root,
    workspaceId: fingerprint.id,
    fingerprint: {
      id: fingerprint.id,
      format: fingerprint.format,
      headOid: fingerprint.headOid,
      indexHash: fingerprint.indexHash,
      manifestHash: fingerprint.manifestHash,
    },
    files,
    nodeDependencies,
    integrity,
  };
  const state = { root, tempRoot, sourceRoot, cleaned, integrity: { ...integrity, sourceEntries } };
  SNAPSHOT_STATE.set(snapshot, state);
  Object.defineProperty(snapshot, SNAPSHOT_BRAND, { value: true });
  Object.defineProperty(snapshot, 'cleanup', {
    enumerable: false,
    value: () => cleanupWorkspaceSnapshot(snapshot),
  });
  return snapshot;
}

/** Compare a supplied checkpoint fingerprint with the source workspace now. */
export async function verifyWorkspaceFingerprint(workspaceRoot, expected) {
  const expectedId = fingerprintId(expected, 'workspace fingerprint');
  const root = await realWorkspaceRoot(workspaceRoot);
  let current;
  try {
    current = await fingerprintWorkspace(root);
  } catch (error) {
    throw asSnapshotError(error, 'WORKSPACE_FINGERPRINT_FAILED');
  }
  if (expectedId && current.id !== expectedId) {
    throw new PipelineSnapshotError('STALE_WORKSPACE', `Expected workspace ${expectedId}, but the current workspace is ${current.id}.`);
  }
  return current;
}

/**
 * Materialize an isolated filesystem view of a Git worktree. It intentionally
 * excludes .git and ignored files; tracked files, tracked modifications and
 * deletions, and nonignored untracked files are all represented exactly as
 * they exist in the worktree at the verified fingerprint.
 */
export async function createWorkspaceSnapshot(options = {}) {
  assertOptions(options);
  const sourceRoot = await realWorkspaceRoot(options.workspaceRoot);
  const expectedId = expectedWorkspaceId(options);
  const copyDependencies = options.copyNodeModules !== false;
  let snapshotRoot = null;
  try {
    const fingerprint = await verifyWorkspaceFingerprint(sourceRoot, expectedId);
    const directory = await createSnapshotDirectory(sourceRoot, options.tempRoot);
    snapshotRoot = directory.root;
    const paths = await listSnapshotPaths(sourceRoot);
    const copiedFiles = await copyWorktreeFiles(sourceRoot, snapshotRoot, paths);
    const nodeDependencies = await copyNodeModules(sourceRoot, snapshotRoot, copyDependencies);
    const expectedTreeHash = treeHash(copiedFiles.entries);
    const materializedEntries = await snapshotTreeEntries(snapshotRoot);
    const materializedTreeHash = treeHash(materializedEntries);
    if (expectedTreeHash !== materializedTreeHash) {
      throw new PipelineSnapshotError('SNAPSHOT_TAMPERED', 'The materialized snapshot does not match the copied workspace tree.');
    }
    const verifiedFingerprint = await verifyWorkspaceFingerprint(sourceRoot, fingerprint.id);
    return defineSnapshot({
      root: snapshotRoot,
      tempRoot: directory.tempRoot,
      sourceRoot,
      fingerprint: verifiedFingerprint,
      files: { listed: paths.length, copiedFiles: copiedFiles.copiedFiles, omittedDeletedFiles: copiedFiles.omittedDeletedFiles },
      nodeDependencies,
      integrity: { format: 1, treeHash: expectedTreeHash, sourceFileCount: copiedFiles.entries.length },
      sourceEntries: copiedFiles.entries,
    });
  } catch (error) {
    if (snapshotRoot) await fs.rm(snapshotRoot, { recursive: true, force: true }).catch(() => {});
    throw asSnapshotError(error);
  }
}

/** True only for snapshots created by this module in the current process. */
export function isPipelineSnapshot(snapshot) {
  return Boolean(snapshot && typeof snapshot === 'object' && snapshot[SNAPSHOT_BRAND] === true && SNAPSHOT_STATE.has(snapshot));
}

/** Validate a live snapshot before a runner uses it. */
export async function resolvePipelineSnapshotRoot(snapshot) {
  if (!isPipelineSnapshot(snapshot)) throw new PipelineSnapshotError('UNTRUSTED_SNAPSHOT', 'Validation requires a snapshot created by createWorkspaceSnapshot.');
  const state = SNAPSHOT_STATE.get(snapshot);
  if (state.cleaned) throw new PipelineSnapshotError('SNAPSHOT_CLEANED', 'The snapshot has already been cleaned up.');
  let root;
  try {
    root = await fs.realpath(snapshot.root);
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw new PipelineSnapshotError('SNAPSHOT_MISSING', 'The validation snapshot is no longer available.', [error?.message || String(error)]);
  }
  if (root !== state.root || isInside(state.sourceRoot, root, { allowSame: true })) {
    throw new PipelineSnapshotError('SNAPSHOT_TAMPERED', 'Validation snapshot no longer has a safe isolated root.');
  }
  return root;
}

/**
 * Compare every source file materialized at the checkpoint with its original
 * bytes. New build/test artifacts are allowed because they exist only inside
 * the disposable snapshot; modifying or deleting checkpoint source is not.
 */
export async function verifyPipelineSnapshotIntegrity(snapshot) {
  const root = await resolvePipelineSnapshotRoot(snapshot);
  const state = SNAPSHOT_STATE.get(snapshot);
  const entries = [];
  let missing = 0;
  for (const expected of state.integrity.sourceEntries) {
    const absolute = path.resolve(root, ...expected.path.split('/'));
    if (!isInside(root, absolute)) throw new PipelineSnapshotError('SNAPSHOT_TAMPERED', `Snapshot path escaped its root: ${expected.path}`);
    try { entries.push(await hashSnapshotFile(absolute, expected.path)); }
    catch (error) {
      if (error?.code === 'ENOENT') { missing++; continue; }
      throw error;
    }
  }
  const actualTreeHash = treeHash(entries);
  return {
    matches: missing === 0 && actualTreeHash === state.integrity.treeHash,
    expectedTreeHash: state.integrity.treeHash,
    actualTreeHash,
    expectedFileCount: state.integrity.sourceFileCount,
    actualFileCount: entries.length,
    missingFileCount: missing,
  };
}

/** Re-fingerprint the live source without exposing its filesystem path. */
export async function verifyPipelineSnapshotSource(snapshot) {
  if (!isPipelineSnapshot(snapshot)) throw new PipelineSnapshotError('UNTRUSTED_SNAPSHOT', 'Validation requires a snapshot created by createWorkspaceSnapshot.');
  const state = SNAPSHOT_STATE.get(snapshot);
  if (state.cleaned) throw new PipelineSnapshotError('SNAPSHOT_CLEANED', 'The snapshot has already been cleaned up.');
  const current = await verifyWorkspaceFingerprint(state.sourceRoot);
  return {
    matches: current.id === snapshot.workspaceId,
    expectedWorkspaceId: snapshot.workspaceId,
    workspaceId: current.id,
  };
}

/** Remove only the temporary directory created for this snapshot. Safe to call repeatedly. */
export async function cleanupWorkspaceSnapshot(snapshot) {
  if (!isPipelineSnapshot(snapshot)) throw new PipelineSnapshotError('UNTRUSTED_SNAPSHOT', 'Only snapshots created by createWorkspaceSnapshot can be cleaned up.');
  const state = SNAPSHOT_STATE.get(snapshot);
  if (state.cleaned) return { root: snapshot.root, removed: false, alreadyCleaned: true };
  if (!isInside(state.tempRoot, state.root)) {
    throw new PipelineSnapshotError('UNSAFE_SNAPSHOT_ROOT', 'Refusing to clean a snapshot outside its temporary directory.');
  }
  if (isInside(state.sourceRoot, state.root, { allowSame: true })) {
    throw new PipelineSnapshotError('UNSAFE_SNAPSHOT_ROOT', 'Refusing to clean a path inside the source workspace.');
  }
  await fs.rm(state.root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  state.cleaned = true;
  return { root: snapshot.root, removed: true, alreadyCleaned: false };
}
