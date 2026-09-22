import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fingerprintWorkspace } from '../lib/accelerator/workspace.mjs';
import {
  createWorkspaceSnapshot,
  verifyPipelineSnapshotIntegrity,
  verifyPipelineSnapshotSource,
} from '../lib/accelerator/pipeline/snapshot.mjs';
import { PipelineRunner } from '../lib/accelerator/pipeline/runner.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pipeline-runner-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'pipeline@example.test');
  git('config', 'user.name', 'Pipeline Test');
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\nnode_modules/\n');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
  fs.writeFileSync(path.join(root, 'deleted.txt'), 'delete me\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'pipeline-fixture', private: true }));
  fs.mkdirSync(path.join(root, 'node_modules', 'snapshot-dependency'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'snapshot-dependency', 'index.js'), "module.exports = 'snapshot dependency';\n");
  if (process.platform !== 'win32') {
    fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
    fs.symlinkSync('../snapshot-dependency/index.js', path.join(root, 'node_modules', '.bin', 'snapshot-dependency'));
  }
  git('add', '.');
  git('commit', '-qm', 'initial');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, git };
}

async function waitForFile(filename, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filename)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filename}`);
}

test('snapshot captures modified, deleted, and nonignored untracked worktree state without touching source', async t => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'modified\n');
  fs.rmSync(path.join(root, 'deleted.txt'));
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'include me\n');
  fs.writeFileSync(path.join(root, 'ignored.txt'), 'do not include\n');
  const fingerprint = await fingerprintWorkspace(root);
  const snapshot = await createWorkspaceSnapshot({ workspaceRoot: root, workspaceFingerprint: fingerprint });
  t.after(() => snapshot.cleanup());

  assert.equal(snapshot.workspaceId, fingerprint.id);
  assert.equal(snapshot.nodeDependencies.status, 'copied');
  assert.equal(fs.readFileSync(path.join(snapshot.root, 'tracked.txt'), 'utf8'), 'modified\n');
  assert.equal(fs.readFileSync(path.join(snapshot.root, 'untracked.txt'), 'utf8'), 'include me\n');
  assert.equal(fs.existsSync(path.join(snapshot.root, 'deleted.txt')), false);
  assert.equal(fs.existsSync(path.join(snapshot.root, 'ignored.txt')), false);
  assert.equal(fs.readFileSync(path.join(snapshot.root, 'node_modules', 'snapshot-dependency', 'index.js'), 'utf8'), "module.exports = 'snapshot dependency';\n");
  if (process.platform !== 'win32') {
    const linked = path.join(snapshot.root, 'node_modules', '.bin', 'snapshot-dependency');
    assert.equal(fs.lstatSync(linked).isSymbolicLink(), true);
    assert.equal(fs.realpathSync(linked).startsWith(snapshot.root), true);
  }
  assert.equal((await verifyPipelineSnapshotIntegrity(snapshot)).matches, true);
  assert.equal((await verifyPipelineSnapshotSource(snapshot)).matches, true);

  fs.writeFileSync(path.join(snapshot.root, 'tracked.txt'), 'snapshot-only\n');
  assert.equal(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'modified\n');
  assert.equal((await verifyPipelineSnapshotIntegrity(snapshot)).matches, false);
  await assert.rejects(
    createWorkspaceSnapshot({ workspaceRoot: root, expectedWorkspaceId: 'ws_v1_not_the_current_workspace', copyNodeModules: false }),
    error => error.code === 'STALE_WORKSPACE',
  );

  const firstCleanup = await snapshot.cleanup();
  const secondCleanup = await snapshot.cleanup();
  assert.equal(firstCleanup.removed, true);
  assert.equal(secondCleanup.alreadyCleaned, true);
  assert.equal(fs.existsSync(snapshot.root), false);
});

test('runner executes ordered direct commands only in the snapshot and returns bounded raw buffers', async t => {
  const { root } = fixture(t);
  const checkpoint = await fingerprintWorkspace(root);
  const snapshot = await createWorkspaceSnapshot({ workspaceRoot: root, workspaceFingerprint: checkpoint });
  t.after(() => snapshot.cleanup());
  const runner = new PipelineRunner({ maxOutputBytesPerStream: 64, defaultTimeoutMs: 2_000 });
  t.after(() => runner.close());

  const result = await runner.run({
    snapshot,
    expectedWorkspaceId: checkpoint.id,
    commands: [
      {
        id: 'dependency-check',
        executable: process.execPath,
        args: ['-e', "const fs = require('node:fs'); const value = require('snapshot-dependency'); fs.writeFileSync('validation-proof.txt', value); fs.writeFileSync('tracked.txt', 'mutated in snapshot\\n'); process.stdout.write('a'.repeat(80));"],
        parser: 'generic',
      },
      {
        id: 'typed-failure',
        executable: process.execPath,
        args: ['-e', "process.stderr.write('src/broken.ts(3,4): error TS9999: broken\\n'); process.exitCode = 1;"],
        parser: 'typescript',
        continueOnFailure: true,
      },
      {
        id: 'continued',
        executable: process.execPath,
        args: ['-e', "process.stdout.write('continued');"],
        parser: 'generic',
      },
      {
        id: 'stop-here',
        executable: process.execPath,
        args: ['-e', 'process.exitCode = 1;'],
        parser: 'generic',
      },
      {
        id: 'skipped-after-failure',
        executable: process.execPath,
        args: ['-e', "process.stdout.write('must not run');"],
        parser: 'generic',
      },
    ],
  });

  assert.equal(result.aggregate.status, 'FAILED');
  assert.equal(result.aggregate.accepted, false);
  assert.equal(result.aggregate.rejection, 'SNAPSHOT_TAINTED');
  assert.deepEqual(result.commands.map(item => item.id), ['dependency-check', 'typed-failure', 'continued', 'stop-here', 'skipped-after-failure']);
  assert.equal(result.commands[0].execution.status, 'PASSED');
  assert.equal(Buffer.isBuffer(result.commands[0].raw.stdout), true);
  assert.equal(result.commands[0].raw.stdout.toString(), 'a'.repeat(64));
  assert.equal(result.commands[0].raw.stdoutBytes, 80);
  assert.equal(result.commands[0].raw.truncated.stdout, true);
  assert.equal(result.commands[1].execution.status, 'FAILED');
  assert.equal(result.commands[1].diagnostics[0].code, 'TS9999');
  assert.equal(result.commands[2].execution.status, 'PASSED');
  assert.equal(result.commands[3].execution.status, 'FAILED');
  assert.equal(result.commands[4].execution.status, 'SKIPPED');
  assert.equal(fs.readFileSync(path.join(snapshot.root, 'validation-proof.txt'), 'utf8'), 'snapshot dependency');
  assert.equal(fs.existsSync(path.join(root, 'validation-proof.txt')), false);

  const historicalCheckpoint = await fingerprintWorkspace(root);
  const historicalSnapshot = await createWorkspaceSnapshot({ workspaceRoot: root, workspaceFingerprint: historicalCheckpoint, copyNodeModules: false });
  t.after(() => historicalSnapshot.cleanup());
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'workspace W18\n');
  const historical = await runner.run({
    snapshot: historicalSnapshot,
    expectedWorkspaceId: historicalCheckpoint.id,
    commands: [{
      id: 'historical-checkpoint',
      executable: process.execPath,
      args: ['-e', "process.stdout.write('validated W17');"],
      parser: 'generic',
    }],
  });
  assert.equal(historical.commands[0].execution.status, 'PASSED');
  assert.equal(historical.aggregate.status, 'PASSED');
  assert.equal(historical.workspace.sourceAtStart.matches, false);
  assert.equal(historical.aggregate.accepted, false);
  assert.equal(historical.aggregate.rejection, 'STALE_WORKSPACE');
});

test('runner reports timeout and external cancellation without running a shell', async t => {
  const { root } = fixture(t);
  const snapshot = await createWorkspaceSnapshot({ workspaceRoot: root });
  t.after(() => snapshot.cleanup());
  const runner = new PipelineRunner({ defaultTimeoutMs: 2_000 });
  t.after(() => runner.close());

  const timedOut = await runner.run({
    snapshot,
    commands: [{
      id: 'timeout',
      executable: process.execPath,
      args: ['-e', "setTimeout(() => process.stdout.write('late'), 30000);"],
      parser: 'generic',
      timeoutMs: 100,
    }],
  });
  assert.equal(timedOut.commands[0].execution.status, 'TIMED_OUT');
  assert.equal(timedOut.aggregate.status, 'FAILED');

  const controller = new AbortController();
  const started = path.join(snapshot.root, 'node_modules', 'cancel-started.txt');
  const running = runner.run({
    snapshot,
    signal: controller.signal,
    commands: [{
      id: 'cancel',
      executable: process.execPath,
      args: ['-e', "const fs = require('node:fs'); fs.writeFileSync('node_modules/cancel-started.txt', 'started'); setTimeout(() => process.stdout.write('late'), 30000);"],
      parser: 'generic',
    }],
  });
  await waitForFile(started);
  controller.abort('test cancellation');
  const cancelled = await running;
  assert.equal(cancelled.commands[0].execution.status, 'CANCELLED');
  assert.equal(cancelled.aggregate.cancelled, true);
  assert.equal(cancelled.aggregate.status, 'FAILED');
});
