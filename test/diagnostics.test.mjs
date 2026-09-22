import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDiagnostic, diffDiagnostics, normalizeFilePath, normalizeText,
  sortDiagnostics, stripAnsi,
} from '../lib/accelerator/diagnostics.mjs';

test('normalizes terminal decoration, Unicode and workspace paths before fingerprinting', () => {
  assert.equal(stripAnsi('\x1b[31merror\x1b[0m'), 'error');
  assert.equal(normalizeText('  caf\u0065\u0301\r\n failed  '), 'café failed');
  assert.equal(normalizeFilePath('C:\\repo\\src\\Auth.ts', { workspaceRoot: 'C:\\repo', platform: 'win32' }), 'src/auth.ts');
  const left = createDiagnostic({ tool: 'TypeScript', file: 'src\\Auth.ts', line: 4, column: 2, code: 'TS2322', message: '\x1b[31mType  mismatch\x1b[0m' }, { platform: 'win32' });
  const right = createDiagnostic({ tool: 'typescript', file: 'src/auth.ts', line: 4, column: 2, code: 'TS2322', message: 'Type mismatch' }, { platform: 'win32' });
  assert.equal(left.fingerprint, right.fingerprint);
});

test('diagnostic diff reports new, resolved and persistent records deterministically', () => {
  const same = createDiagnostic({ tool: 'ts', file: 'a.ts', line: 2, code: 'TS1', message: 'same' });
  const old = createDiagnostic({ tool: 'ts', file: 'old.ts', line: 1, message: 'old' });
  const next = createDiagnostic({ tool: 'ts', file: 'next.ts', line: 3, message: 'next' });
  const delta = diffDiagnostics([old, same], [next, same]);
  assert.deepEqual(delta.added, [next]);
  assert.deepEqual(delta.resolved, [old]);
  assert.deepEqual(delta.remaining, [same]);
  assert.deepEqual(sortDiagnostics([next, old, same]), [same, next, old]);
});

test('location or message changes intentionally receive a new identity', () => {
  const base = createDiagnostic({ tool: 'jest', kind: 'test_failure', subject: 'refreshes token', file: 'a.test.ts', line: 8, message: 'Expected 1, received 2' });
  const moved = createDiagnostic({ tool: 'jest', kind: 'test_failure', subject: 'refreshes token', file: 'a.test.ts', line: 9, message: 'Expected 1, received 2' });
  const changed = createDiagnostic({ tool: 'jest', kind: 'test_failure', subject: 'refreshes token', file: 'a.test.ts', line: 8, message: 'Expected 1, received 3' });
  assert.notEqual(base.fingerprint, moved.fingerprint);
  assert.notEqual(base.fingerprint, changed.fingerprint);
});
