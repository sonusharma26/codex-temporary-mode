import test from 'node:test';
import assert from 'node:assert/strict';
import { AcceleratorStore } from '../lib/accelerator/store.mjs';

function fixture(t) {
  const store = new AcceleratorStore(':memory:');
  const repositoryId = 'pipeline-repository';
  const sessionId = 'pipeline-session';
  const workspaceId = 'pipeline-workspace';
  store.ensureRepository({ repositoryId, realRoot: 'C:/pipeline-test' });
  store.createSession({ sessionId, repositoryId, ephemeral: true });
  store.recordWorkspace(repositoryId, {
    id: workspaceId,
    format: 1,
    headOid: 'head',
    indexHash: 'index',
    manifestHash: 'manifest',
    complete: true,
    entries: [],
  });
  t.after(() => store.close());

  const checkpoint = (checkpointId, overrides = {}) => ({
    checkpointId,
    sessionId,
    workspaceId,
    changedFiles: ['src/example.mjs'],
    reason: 'manual-checkpoint',
    validationProfile: 'targeted',
    validationPlanDigest: '75a1e9f9a31a7ba46094f1d3d5f1d8908fd0ea8404713402f8850b1d0f0b0b0c',
    commands: [{ executable: 'node', args: ['--test', 'test/example.test.mjs'] }],
    createdAt: 100,
    ...overrides,
  });
  return { store, repositoryId, sessionId, workspaceId, checkpoint };
}

test('checkpoints move through legal queue, run, finish, and cancellation transitions', t => {
  const { store, sessionId, checkpoint } = fixture(t);
  const created = store.createCheckpoint(checkpoint('checkpoint-pass'));
  assert.deepEqual(created.changedFiles, ['src/example.mjs']);
  assert.deepEqual(created.commands, [{ executable: 'node', args: ['--test', 'test/example.test.mjs'] }]);
  assert.equal(created.validationPlanDigest, '75a1e9f9a31a7ba46094f1d3d5f1d8908fd0ea8404713402f8850b1d0f0b0b0c');
  assert.equal(created.status, 'QUEUED');
  assert.equal(created.startedAt, null);
  assert.equal(created.compactResult, null);

  const claimed = store.claimOldestQueuedCheckpoint({ sessionId, checkpointRunId: 'run-pass', startedAt: 110 });
  assert.equal(claimed.checkpoint.checkpointId, 'checkpoint-pass');
  assert.equal(claimed.checkpoint.status, 'RUNNING');
  assert.equal(claimed.checkpoint.startedAt, 110);
  assert.equal(claimed.run.checkpointRunId, 'run-pass');
  assert.equal(claimed.run.workspaceId, created.workspaceId);
  assert.equal(claimed.run.validationPlanDigest, created.validationPlanDigest);
  assert.equal(claimed.run.status, 'RUNNING');

  const finished = store.finishCheckpoint({
    checkpointId: 'checkpoint-pass',
    checkpointRunId: 'run-pass',
    status: 'PASSED',
    compactResult: { summary: '1 command passed', newDiagnostics: 0 },
    finishedAt: 120,
  });
  assert.equal(finished.checkpoint.status, 'PASSED');
  assert.equal(finished.run.status, 'PASSED');
  assert.equal(finished.checkpoint.finishedAt, 120);
  assert.deepEqual(finished.checkpoint.compactResult, { summary: '1 command passed', newDiagnostics: 0 });
  assert.deepEqual(store.getCheckpoint('checkpoint-pass').result, { summary: '1 command passed', newDiagnostics: 0 });
  assert.deepEqual(store.getCheckpointRun('run-pass').compactResult, { summary: '1 command passed', newDiagnostics: 0 });

  store.createCheckpoint(checkpoint('checkpoint-cancel', { createdAt: 130 }));
  const cancelled = store.cancelQueuedCheckpoint({
    checkpointId: 'checkpoint-cancel',
    cancelledAt: 131,
    compactResult: { reason: 'manual cancellation' },
  });
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.finishedAt, 131);
  assert.deepEqual(cancelled.compactResult, { reason: 'manual cancellation' });

  store.createCheckpoint(checkpoint('checkpoint-active-cancel', { createdAt: 132 }));
  const activeCancellation = store.claimOldestQueuedCheckpoint({ sessionId, checkpointRunId: 'run-active-cancel', startedAt: 133 });
  const cancelledAfterClaim = store.finishCheckpoint({
    checkpointId: activeCancellation.checkpoint.checkpointId,
    checkpointRunId: activeCancellation.run.checkpointRunId,
    status: 'CANCELLED',
    compactResult: { reason: 'validator child stopped' },
    finishedAt: 134,
  });
  assert.equal(cancelledAfterClaim.checkpoint.status, 'CANCELLED');
  assert.equal(cancelledAfterClaim.run.status, 'CANCELLED');
});

test('new checkpoints atomically supersede only older queued work in the same session and profile', t => {
  const { store, sessionId, checkpoint } = fixture(t);
  store.createCheckpoint(checkpoint('checkpoint-running', { createdAt: 10 }));
  store.claimOldestQueuedCheckpoint({ sessionId, checkpointRunId: 'run-running', startedAt: 11 });
  store.createCheckpoint(checkpoint('checkpoint-queued-a', { createdAt: 20 }));
  store.createCheckpoint(checkpoint('checkpoint-queued-b', { createdAt: 30 }));
  store.createCheckpoint(checkpoint('checkpoint-final', { createdAt: 35, validationProfile: 'final' }));

  const replacement = store.createCheckpointAndSupersedeQueued(checkpoint('checkpoint-new', { createdAt: 40 }));
  assert.equal(replacement.checkpoint.status, 'QUEUED');
  assert.deepEqual(replacement.supersededCheckpointIds, ['checkpoint-queued-a', 'checkpoint-queued-b']);
  assert.deepEqual(replacement.superseded.map(item => item.checkpointId), ['checkpoint-queued-a', 'checkpoint-queued-b']);
  assert.equal(store.getCheckpoint('checkpoint-running').status, 'RUNNING');
  for (const checkpointId of replacement.supersededCheckpointIds) {
    const superseded = store.getCheckpoint(checkpointId);
    assert.equal(superseded.status, 'SUPERSEDED');
    assert.equal(superseded.supersededBy, 'checkpoint-new');
    assert.equal(superseded.finishedAt, 40);
  }
  assert.equal(store.getCheckpoint('checkpoint-final').status, 'QUEUED');
  assert.deepEqual(store.listCheckpoints({ sessionId, status: 'QUEUED' }).map(item => item.checkpointId), ['checkpoint-new', 'checkpoint-final']);
});

test('nonterminal dedupe matches the exact workspace and validation plan identity', t => {
  const { store, sessionId, workspaceId, checkpoint } = fixture(t);
  store.createCheckpoint(checkpoint('checkpoint-equivalent', { createdAt: 10 }));
  const identity = {
    sessionId,
    workspaceId,
    validationProfile: 'targeted',
    validationPlanDigest: '75a1e9f9a31a7ba46094f1d3d5f1d8908fd0ea8404713402f8850b1d0f0b0b0c',
  };
  assert.equal(store.findNonterminalEquivalentCheckpoint(identity).checkpointId, 'checkpoint-equivalent');
  assert.equal(store.findNonterminalEquivalentCheckpoint({ ...identity, validationProfile: 'final' }), null);
  assert.equal(store.findNonterminalEquivalentCheckpoint({ ...identity, validationPlanDigest: 'different-digest' }), null);

  const claimed = store.claimOldestQueuedCheckpoint({ sessionId, checkpointRunId: 'run-equivalent', startedAt: 11 });
  assert.equal(store.findNonterminalEquivalentCheckpoint(identity).checkpointId, claimed.checkpoint.checkpointId);
  store.finishCheckpoint({ checkpointId: claimed.checkpoint.checkpointId, checkpointRunId: claimed.run.checkpointRunId, status: 'PASSED', finishedAt: 12 });
  assert.equal(store.findNonterminalEquivalentCheckpoint(identity), null);
});

test('claims are session-scoped and use oldest creation time followed by checkpoint ID', t => {
  const { store, repositoryId, sessionId, workspaceId, checkpoint } = fixture(t);
  const otherSessionId = 'pipeline-session-other';
  store.createSession({ sessionId: otherSessionId, repositoryId, ephemeral: true });
  store.createCheckpoint(checkpoint('checkpoint-z', { createdAt: 30 }));
  store.createCheckpoint(checkpoint('checkpoint-b', { createdAt: 10 }));
  store.createCheckpoint(checkpoint('checkpoint-a', { createdAt: 10 }));
  store.createCheckpoint({ ...checkpoint('other-session-checkpoint', { createdAt: 1 }), sessionId: otherSessionId, workspaceId });

  assert.equal(store.claimOldestQueuedCheckpoint({ sessionId, checkpointRunId: 'run-a', startedAt: 40 }).checkpoint.checkpointId, 'checkpoint-a');
  assert.equal(store.claimOldestQueuedCheckpoint({ sessionId, checkpointRunId: 'run-b', startedAt: 41 }).checkpoint.checkpointId, 'checkpoint-b');
  assert.equal(store.claimOldestQueuedCheckpoint({ sessionId, checkpointRunId: 'run-z', startedAt: 42 }).checkpoint.checkpointId, 'checkpoint-z');
  assert.equal(store.claimOldestQueuedCheckpoint({ sessionId, checkpointRunId: 'run-none', startedAt: 43 }), null);
  assert.equal(store.claimOldestQueuedCheckpoint({ sessionId: otherSessionId, checkpointRunId: 'run-other', startedAt: 44 }).checkpoint.checkpointId, 'other-session-checkpoint');

  assert.deepEqual(store.listCheckpoints({ sessionId }).map(item => item.checkpointId), ['checkpoint-z', 'checkpoint-b', 'checkpoint-a']);
  assert.equal(store.latestCheckpoint({ sessionId }).checkpointId, 'checkpoint-z');
});

test('invalid pipeline transitions are rejected without changing checkpoint state', t => {
  const { store, sessionId, checkpoint } = fixture(t);
  store.createCheckpoint(checkpoint('checkpoint-invalid'));
  assert.throws(
    () => store.finishCheckpoint({ checkpointId: 'checkpoint-invalid', status: 'PASSED', finishedAt: 101 }),
    /not running/,
  );
  assert.equal(store.getCheckpoint('checkpoint-invalid').status, 'QUEUED');

  const claimed = store.claimOldestQueuedCheckpoint({ sessionId, checkpointRunId: 'run-invalid', startedAt: 102 });
  assert.throws(
    () => store.cancelQueuedCheckpoint({ checkpointId: claimed.checkpoint.checkpointId, cancelledAt: 103 }),
    /not queued/,
  );
  assert.throws(
    () => store.finishCheckpoint({ checkpointId: claimed.checkpoint.checkpointId, checkpointRunId: 'run-invalid', status: 'QUEUED', finishedAt: 103 }),
    /PASSED, FAILED, or CANCELLED/,
  );
  assert.equal(store.getCheckpoint(claimed.checkpoint.checkpointId).status, 'RUNNING');

  store.finishCheckpoint({ checkpointId: claimed.checkpoint.checkpointId, checkpointRunId: 'run-invalid', status: 'FAILED', finishedAt: 104 });
  assert.throws(
    () => store.finishCheckpoint({ checkpointId: claimed.checkpoint.checkpointId, checkpointRunId: 'run-invalid', status: 'PASSED', finishedAt: 105 }),
    /not running/,
  );
  assert.equal(store.getCheckpoint(claimed.checkpoint.checkpointId).status, 'FAILED');
});
