import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listChangedFiles } from '../lib/accelerator/pipeline/changed-files.mjs';

function repository(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pipeline-changes-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 'pipeline@example.test'); git('config', 'user.name', 'Pipeline Test');
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n');
  fs.writeFileSync(path.join(root, 'staged.txt'), 'old\n');
  fs.writeFileSync(path.join(root, 'modified.txt'), 'old\n');
  fs.writeFileSync(path.join(root, 'deleted.txt'), 'old\n');
  git('add', '.'); git('commit', '-qm', 'initial');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, git };
}

test('changed-file selection includes staged, unstaged, deleted, and nonignored untracked paths', t => {
  const { root, git } = repository(t);
  fs.writeFileSync(path.join(root, 'staged.txt'), 'new\n'); git('add', 'staged.txt');
  fs.writeFileSync(path.join(root, 'modified.txt'), 'new\n');
  fs.rmSync(path.join(root, 'deleted.txt'));
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'new\n');
  fs.writeFileSync(path.join(root, 'ignored.txt'), 'secret\n');
  assert.deepEqual(listChangedFiles(root), ['deleted.txt', 'modified.txt', 'staged.txt', 'untracked.txt']);
});
