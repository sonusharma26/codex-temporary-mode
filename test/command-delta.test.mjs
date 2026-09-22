import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AcceleratorStore } from '../lib/accelerator/store.mjs';
import { SessionManager } from '../lib/accelerator/session-manager.mjs';
import { RawOutputStore } from '../lib/accelerator/raw-output.mjs';
import { CommandDeltaService } from '../lib/accelerator/command-delta.mjs';

function fixture(t, serviceOptions = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'delta-command-'));
  const rawRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'delta-command-raw-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 'delta@example.test'); git('config', 'user.name', 'Delta Test');
  const script = path.join(root, 'emit.mjs');
  fs.writeFileSync(script, "process.stderr.write('src/a.ts(1,2): error TS1000: first\\n'); process.exitCode=1;\n");
  git('add', '.'); git('commit', '-qm', 'initial');
  const store = new AcceleratorStore(':memory:');
  store.ensureRepository({ repositoryId: 'repo-command', realRoot: root });
  const session = new SessionManager({ store, repositoryId: 'repo-command', ephemeral: true, sessionId: 'session-command' });
  session.start();
  const raw = new RawOutputStore(rawRoot);
  const service = new CommandDeltaService({ workspaceRoot: root, repositoryId: 'repo-command', sessionManager: session, store, rawOutputStore: raw, ...serviceOptions });
  t.after(async () => { await service.close(); await raw.close(); session.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(rawRoot, { recursive: true, force: true }); });
  return { root, script, session, raw, service, git };
}

test('command delta reports new/remaining diagnostics and preserves raw output', async t => {
  const { script, session, raw, service } = fixture(t);
  const command = { executable: process.execPath, args: ['emit.mjs'], parser: 'typescript', commandId: 'typecheck' };
  const first = await service.run(command);
  assert.equal(first.execution.status, 'failed');
  assert.equal(first.comparison.status, 'unavailable');
  assert.equal(first.new.length, 1); assert.equal(first.new[0].code, 'TS1000');

  fs.writeFileSync(script, "process.stderr.write('src/a.ts(1,2): error TS1000: first\\nsrc/b.ts(3,4): error TS2000: second\\n'); process.exitCode=1;\n");
  const second = await service.run(command);
  assert.equal(second.comparison.status, 'compared');
  assert.equal(second.comparison.newCount, 1); assert.equal(second.comparison.remainingCount, 1); assert.equal(second.comparison.resolvedCount, 0);
  assert.equal(second.new[0].code, 'TS2000');
  assert.deepEqual(second.remaining, []); assert.equal(second.omitted.remaining, 0);
  const rawPage = await raw.read({ runId: second.runId, sessionId: session.sessionId, stream: 'stderr' });
  assert.match(rawPage.data, /TS1000/); assert.match(rawPage.data, /TS2000/); assert.equal(rawPage.eof, true);

  const identical = await service.run(command);
  assert.equal(identical.comparison.newCount, 0); assert.equal(identical.comparison.resolvedCount, 0); assert.equal(identical.comparison.remainingCount, 2);
  assert.deepEqual(identical.new, []); assert.deepEqual(identical.resolved, []); assert.deepEqual(identical.remaining, []); assert.equal(identical.omitted.remaining, 0);

  session.resetContextGeneration('compaction');
  const rehydrated = await service.run(command);
  assert.deepEqual(rehydrated.comparison, { status: 'unavailable', reason: 'no-compatible-prior-run' });
  assert.equal(rehydrated.new.length, 2);
});

test('parser memory limit never truncates retained raw output or kills the command', async t => {
  const { script, session, raw, service } = fixture(t, { maxParseBytesPerStream: 8 });
  fs.writeFileSync(script, "process.stdout.write('abcdefghijklmnopqrstuvwxyz');\n");
  const result = await service.run({ executable: process.execPath, args: ['emit.mjs'], parser: 'generic', commandId: 'large-output' });
  assert.equal(result.execution.status, 'passed');
  assert.deepEqual(result.comparison, { status: 'unavailable', reason: 'parse-output-limit-exceeded' });
  assert.equal(result.raw.truncated, false); assert.equal(result.raw.stdoutBytes, 26);
  const output = await raw.read({ runId: result.runId, sessionId: session.sessionId, stream: 'stdout' });
  assert.equal(output.data, 'abcdefghijklmnopqrstuvwxyz'); assert.equal(output.eof, true); assert.equal(output.truncated, false);
});

test('diagnostics omitted by the response limit are delivered on later runs', async t => {
  const { script, service } = fixture(t, { maxReturnedDiagnostics: 2 });
  const messages = Array.from({ length: 5 }, (_, index) => `src/${index}.ts(1,1): error TS${1000 + index}: issue ${index}`).join('\n');
  fs.writeFileSync(script, `process.stderr.write(${JSON.stringify(`${messages}\n`)}); process.exitCode=1;\n`);
  const command = { executable: process.execPath, args: ['emit.mjs'], parser: 'typescript', commandId: 'limited' };

  const first = await service.run(command);
  assert.equal(first.new.length, 2); assert.equal(first.omitted.new, 3);
  const second = await service.run(command);
  assert.equal(second.new.length, 0); assert.equal(second.remaining.length, 2); assert.equal(second.omitted.remaining, 1);
  const third = await service.run(command);
  assert.equal(third.remaining.length, 1); assert.equal(third.omitted.remaining, 0);
  const fourth = await service.run(command);
  assert.deepEqual(fourth.remaining, []); assert.equal(fourth.comparison.undeliveredRemainingCount, 0);
});

test('completed command remains retrievable when final workspace capture fails', async t => {
  const { root, raw, session, service, git } = fixture(t);
  fs.writeFileSync(path.join(root, 'conflict.txt'), 'base\n'); git('add', 'conflict.txt'); git('commit', '-qm', 'base');
  git('switch', '-qc', 'side'); fs.writeFileSync(path.join(root, 'conflict.txt'), 'side\n'); git('commit', '-qam', 'side');
  git('switch', '-q', '-'); fs.writeFileSync(path.join(root, 'conflict.txt'), 'main\n'); git('commit', '-qam', 'main');

  const result = await service.run({ executable: 'git', args: ['merge', 'side'], parser: 'git', commandId: 'conflict' });
  assert.equal(result.execution.status, 'failed');
  assert.equal(result.workspace.finishedId, null);
  assert.equal(result.workspace.finalizationError.code, 'UNMERGED_INDEX');
  const output = await raw.read({ runId: result.runId, sessionId: session.sessionId, stream: 'combined' });
  assert.match(output.data, /conflict/i);
});

test('closing the service terminates and awaits an active command', async t => {
  const { script, service } = fixture(t);
  fs.writeFileSync(script, "setTimeout(() => process.stdout.write('late'), 30000);\n");
  const running = service.run({ executable: process.execPath, args: ['emit.mjs'], parser: 'generic', commandId: 'long-running', timeoutMs: 60000 });
  const deadline = Date.now() + 5000;
  while (!service.activeChildren.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(service.activeChildren.size, 1);
  await service.close();
  const result = await running;
  assert.notEqual(result.execution.status, 'passed');
  assert.equal(service.activeOperations.size, 0);
  assert.equal(service.activeChildren.size, 0);
});
