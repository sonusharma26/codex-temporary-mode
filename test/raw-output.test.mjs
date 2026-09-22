import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RawOutputStore } from '../lib/accelerator/raw-output.mjs';

test('raw output remains exact, paged, session-scoped, and removable', async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'delta-raw-'));
  const store = new RawOutputStore(root, { maxBytesPerStream: 1024 });
  t.after(async () => { await store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const run = await store.createRun('run_exact', 'session-a');
  assert.equal(await run.append('stdout', Buffer.from('alpha\n')), true);
  assert.equal(await run.append('stderr', Buffer.from('beta\r\n')), true);
  await run.close();

  const first = await store.read({ runId: 'run_exact', sessionId: 'session-a', stream: 'combined', maxBytes: 6 });
  assert.equal(first.data, 'alpha\n'); assert.equal(first.eof, false); assert.equal(first.nextOffsetBytes, 6);
  const second = await store.read({ runId: 'run_exact', sessionId: 'session-a', stream: 'combined', offsetBytes: first.nextOffsetBytes });
  assert.equal(second.data, 'beta\r\n'); assert.equal(second.eof, true);
  await assert.rejects(store.read({ runId: 'run_exact', sessionId: 'session-b' }), error => error.code === 'RAW_OUTPUT_NOT_FOUND');

  await store.removeRun('run_exact');
  assert.equal(fs.existsSync(path.join(root, 'run_exact')), false);
});

test('raw output reports an explicit retention limit instead of silent completeness', async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'delta-raw-limit-'));
  const store = new RawOutputStore(root, { maxBytesPerStream: 4 });
  t.after(async () => { await store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const run = await store.createRun('run_limit', 'session-a');
  assert.equal(await run.append('stdout', Buffer.from('abcdef')), false);
  await run.close();
  const output = await store.read({ runId: 'run_limit', sessionId: 'session-a', stream: 'stdout' });
  assert.equal(output.data, 'abcd'); assert.equal(output.truncated, true); assert.equal(output.totalBytes, 4);
});
