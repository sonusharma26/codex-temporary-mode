import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createAcceleratorRuntime } from '../lib/accelerator/cli.mjs';

async function waitForCheckpoint(service, checkpointId) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = await service.getStatus({ checkpointId });
    if (['PASSED', 'FAILED', 'CANCELLED', 'SUPERSEDED'].includes(status.requested.status)) return status.requested;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Checkpoint did not finish: ${checkpointId}`);
}

test('Pipeline Mode validates snapshots asynchronously, retains failures, and gates the exact final workspace', async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pipeline-service-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 'pipeline@example.test'); git('config', 'user.name', 'Pipeline Test');
  fs.writeFileSync(path.join(root, 'source.txt'), 'stable\n');
  fs.mkdirSync(path.join(root, '.codex'));
  fs.writeFileSync(path.join(root, '.codex', 'accelerator.json'), JSON.stringify({ pipeline: { profiles: {
    targeted: [{ id: 'types', executable: process.execPath, args: ['-e', "const fs=require('node:fs');if(fs.readFileSync('source.txt','utf8').includes('timeout'))setTimeout(()=>{},30000);else{process.stderr.write('src/file.ts(2,3): error TS9001: broken at '+process.cwd()+'\\n');process.exitCode=1}"], parser: 'typescript', timeoutMs: 1000 }],
    final: [{ id: 'final', executable: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(1100000))"], parser: 'generic' }],
  } } }));
  git('add', '.'); git('commit', '-qm', 'initial');
  const runtime = await createAcceleratorRuntime({ workspace: root, ephemeral: true, maxFileBytes: 2 * 1024 * 1024, maxOutputBytes: Number.POSITIVE_INFINITY });
  t.after(async () => { await runtime.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const created = await runtime.pipelineService.createCheckpoint({ validationProfile: 'targeted', reason: 'focused-check' });
  assert.equal(created.status, 'QUEUED');
  const failed = await waitForCheckpoint(runtime.pipelineService, created.checkpointId);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.result.diagnostics.new[0].code, 'TS9001');
  const raw = await runtime.rawOutputStore.read({ runId: failed.result.commands[0].runId, sessionId: runtime.sessionManager.sessionId, stream: 'stderr' });
  assert.match(raw.data, /TS9001: broken/);

  const repeated = await runtime.pipelineService.createCheckpoint({ validationProfile: 'targeted', reason: 'same-diagnostic' });
  const repeatedFailure = await waitForCheckpoint(runtime.pipelineService, repeated.checkpointId);
  assert.equal(repeatedFailure.result.comparison.remainingCount, 1);
  assert.equal(repeatedFailure.result.comparison.newCount, 0);

  fs.writeFileSync(path.join(root, 'source.txt'), 'timeout\n');
  const incomplete = await runtime.pipelineService.createCheckpoint({ validationProfile: 'targeted', reason: 'incomplete-diagnostics' });
  const incompleteFailure = await waitForCheckpoint(runtime.pipelineService, incomplete.checkpointId);
  assert.deepEqual(incompleteFailure.result.comparison, { status: 'UNAVAILABLE', reason: 'CURRENT_DIAGNOSTICS_INCOMPLETE' });
  assert.deepEqual(incompleteFailure.result.diagnostics.resolved, []);
  fs.writeFileSync(path.join(root, 'source.txt'), 'stable\n');

  const final = await runtime.pipelineService.runFinalValidation({ expectedWorkspaceId: created.workspaceId });
  assert.equal(final.gate, 'PASS');
  assert.equal(final.freshness, 'CURRENT');
  assert.equal(final.validation.result.executionAccepted, true);
  const finalRunId = final.validation.result.commands[0].runId;
  const firstPage = await runtime.rawOutputStore.read({ runId: finalRunId, sessionId: runtime.sessionManager.sessionId, stream: 'stdout', maxBytes: 1024 * 1024 });
  const secondPage = await runtime.rawOutputStore.read({ runId: finalRunId, sessionId: runtime.sessionManager.sessionId, stream: 'stdout', offsetBytes: firstPage.nextOffsetBytes });
  assert.equal(firstPage.totalBytes, 1_100_000);
  assert.equal(secondPage.eof, true);
  assert.equal(firstPage.data.length + secondPage.data.length, 1_100_000);
});
