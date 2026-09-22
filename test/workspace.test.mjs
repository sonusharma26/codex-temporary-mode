import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fingerprintWorkspace, isIgnoredByGit } from '../lib/accelerator/workspace.mjs';
import { readStableRegularFile, PathSafetyError } from '../lib/accelerator/paths.mjs';

function repo(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'delta-workspace-'));
  const run = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  run('init', '-q'); run('config', 'user.email', 'delta@example.test'); run('config', 'user.name', 'Delta Test');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\n'); fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n');
  run('add', '.'); run('commit', '-qm', 'initial');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, run };
}

test('workspace identity includes index, tracked worktree, and nonignored untracked state', async t => {
  const { root, run } = repo(t);
  const initial = await fingerprintWorkspace(root);
  assert.equal((await fingerprintWorkspace(root)).id, initial.id);
  run('update-index', '--refresh');
  assert.equal((await fingerprintWorkspace(root)).id, initial.id);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'two\n');
  const modified = await fingerprintWorkspace(root);
  assert.notEqual(modified.id, initial.id);
  run('add', 'tracked.txt');
  const staged = await fingerprintWorkspace(root);
  assert.notEqual(staged.id, modified.id);
  fs.writeFileSync(path.join(root, 'new.txt'), 'new\n');
  const untracked = await fingerprintWorkspace(root);
  assert.notEqual(untracked.id, staged.id);
  fs.writeFileSync(path.join(root, 'ignored.txt'), 'secret\n');
  assert.equal((await fingerprintWorkspace(root)).id, untracked.id);
  assert.equal(isIgnoredByGit(root, 'ignored.txt'), true);
  assert.notEqual((await fingerprintWorkspace(root, { includeIgnoredPaths: ['ignored.txt'] })).id, untracked.id);
});

test('safe reader rejects escapes, metadata, symlinks, and binary data', async t => {
  const { root } = repo(t);
  await assert.rejects(readStableRegularFile(root, '../outside.txt'), error => error instanceof PathSafetyError && error.code === 'PATH_ESCAPE');
  await assert.rejects(readStableRegularFile(root, '.git/HEAD'), error => error instanceof PathSafetyError && error.code === 'GIT_METADATA');
  await assert.rejects(readStableRegularFile(root, '.GIT/HEAD'), error => error instanceof PathSafetyError && error.code === 'GIT_METADATA');
  await assert.rejects(readStableRegularFile(root, 'C:outside.txt'), error => error instanceof PathSafetyError && error.code === 'PATH_ESCAPE');
  if (process.platform === 'win32') {
    await assert.rejects(readStableRegularFile(root, 'tracked.txt:secret'), error => error instanceof PathSafetyError && error.code === 'INVALID_PATH');
    await assert.rejects(readStableRegularFile(root, '.git /HEAD'), error => error instanceof PathSafetyError && error.code === 'INVALID_PATH');
    await assert.rejects(readStableRegularFile(root, 'NUL'), error => error instanceof PathSafetyError && error.code === 'INVALID_PATH');
  }
  fs.writeFileSync(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2]));
  await assert.rejects(readStableRegularFile(root, 'binary.dat'), error => error.code === 'BINARY_FILE');
  const link = path.join(root, 'escape-link');
  try {
    fs.symlinkSync(path.join(root, 'tracked.txt'), link);
    await assert.rejects(readStableRegularFile(root, 'escape-link'), error => error.code === 'SYMLINK_NOT_SUPPORTED');
  } catch (error) {
    if (error?.code !== 'EPERM') throw error; // Windows without symlink permission.
  }
});
