import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AcceleratorStore } from '../lib/accelerator/store.mjs';
import { SessionManager } from '../lib/accelerator/session-manager.mjs';
import { FileDeltaService, DeltaError } from '../lib/accelerator/file-delta.mjs';
import { applyTextDelta, makeTextDelta } from '../lib/accelerator/diff.mjs';

function repo(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'delta-file-'));
  const run = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  run('init', '-q'); run('config', 'user.email', 'delta@example.test'); run('config', 'user.name', 'Delta Test');
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n');
  fs.writeFileSync(path.join(root, 'source.txt'), Array.from({ length: 40 }, (_, i) => `line-${i}\r\n`).join(''));
  run('add', '.'); run('commit', '-qm', 'initial');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function service(t, root) {
  const store = new AcceleratorStore(':memory:');
  store.ensureRepository({ repositoryId: 'repo-test', realRoot: root });
  const sessions = new SessionManager({ store, repositoryId: 'repo-test', ephemeral: true, sessionId: 'session-test' });
  sessions.start();
  t.after(() => { sessions.close(); store.close(); });
  return { sessions, service: new FileDeltaService({ store, sessionManager: sessions, workspaceRoot: root }) };
}

test('file delta sends full, unchanged, exact change, and rehydrates after a generation reset', async t => {
  const root = repo(t), { sessions, service: delta } = service(t, root);
  const first = await delta.readFileDelta({ path: 'source.txt' });
  assert.equal(first.kind, 'full'); assert.equal(first.reason, 'first-in-generation'); assert.match(first.content, /line-0\r\n/);
  assert.deepEqual(first.delivery, { fullSourceBytes: first.byteLength, deliveredTextBytes: first.byteLength, savedTextBytes: 0 });
  const unchanged = await delta.readFileDelta({ path: 'source.txt' });
  assert.equal(unchanged.kind, 'unchanged'); assert.equal(unchanged.content, undefined);
  assert.deepEqual(unchanged.delivery, { fullSourceBytes: first.byteLength, deliveredTextBytes: 0, savedTextBytes: first.byteLength });
  const original = fs.readFileSync(path.join(root, 'source.txt'), 'utf8');
  const changed = original.replace('line-20\r\n', 'changed-20\r\n'); fs.writeFileSync(path.join(root, 'source.txt'), changed);
  const result = await delta.readFileDelta({ path: 'source.txt', mode: 'delta' });
  assert.equal(result.kind, 'delta'); assert.equal(applyTextDelta(original, result.delta), changed);
  assert.deepEqual(result.delivery, {
    fullSourceBytes: result.byteLength,
    deliveredTextBytes: Buffer.byteLength(result.delta.unified, 'utf8'),
    savedTextBytes: result.byteLength - Buffer.byteLength(result.delta.unified, 'utf8'),
  });
  const changedAgain = changed.replace('line-30\r\n', 'changed-30\r\n'); fs.writeFileSync(path.join(root, 'source.txt'), changedAgain);
  const automatic = await delta.readFileDelta({ path: 'source.txt' });
  assert.equal(automatic.kind, 'delta'); assert.equal(applyTextDelta(changed, automatic.delta), changedAgain);
  const generation = sessions.resetContextGeneration('compaction');
  const rehydrated = await delta.readFileDelta({ path: 'source.txt' });
  assert.equal(rehydrated.kind, 'full'); assert.equal(rehydrated.generationId, generation.generationId);
});

test('full always returns source, stale workspace fails, and ignored source is denied', async t => {
  const root = repo(t), { service: delta } = service(t, root);
  const first = await delta.readFileDelta({ path: 'source.txt' });
  const forced = await delta.readFileDelta({ path: 'source.txt', mode: 'full' });
  assert.equal(forced.kind, 'full'); assert.equal(forced.content, first.content);
  await assert.rejects(delta.readFileDelta({ path: 'source.txt', expectedWorkspaceId: 'ws_v1_not-current' }), error => error instanceof DeltaError && error.code === 'STALE_WORKSPACE');
  fs.writeFileSync(path.join(root, 'ignored.txt'), 'ignored\n');
  await assert.rejects(delta.readFileDelta({ path: 'ignored.txt' }), error => error instanceof DeltaError && error.code === 'IGNORED_PATH');
});

test('text deltas preserve Unicode, mixed endings, and missing final newline exactly', () => {
  const oldText = 'alpha\r\nβeta\nlast';
  const newText = 'alpha\r\nγamma\nlast\n';
  const delta = makeTextDelta(oldText, newText, { path: 'unicode.txt' });
  assert.equal(applyTextDelta(oldText, delta), newText);
  assert.match(delta.unified, /No newline at end of file/);
});

test('UTF-8 BOM is preserved in full delivery and exact deltas', async t => {
  const root = repo(t), { service: delta } = service(t, root);
  const filename = path.join(root, 'bom.txt');
  fs.writeFileSync(filename, Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a]));
  const first = await delta.readFileDelta({ path: 'bom.txt' });
  assert.equal(first.kind, 'full'); assert.equal(first.content.charCodeAt(0), 0xfeff); assert.equal(Buffer.from(first.content).equals(fs.readFileSync(filename)), true);
  fs.writeFileSync(filename, Buffer.from([0xef, 0xbb, 0xbf, 0x62, 0x0a]));
  const changed = await delta.readFileDelta({ path: 'bom.txt', mode: 'delta' });
  assert.equal(changed.kind, 'delta'); assert.equal(changed.delta.oldHash, first.contentHash); assert.equal(changed.delta.newHash, changed.contentHash);
  assert.equal(Buffer.from(applyTextDelta(first.content, changed.delta)).equals(fs.readFileSync(filename)), true);
});
