import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseCargo, parseCommandOutput, parseDotnet, parseEslint, parseGeneric,
  parseGit, parseJest, parsePytest, parseTypeScript, parseVitest, resolveParser,
} from '../lib/accelerator/parsers/index.mjs';

const options = { workspaceRoot: '/repo' };

test('TypeScript extracts error codes, locations and continuation text', () => {
  const parsed = parseTypeScript({ stdout: 'src/auth.ts(12,5): error TS2322: Type \'number\' is not assignable\n  to type \'string\'.\nsrc/a.ts:3:2 - warning TS6133: unused.' }, options);
  assert.equal(parsed.diagnostics.length, 2);
  assert.deepEqual(parsed.diagnostics[0], { ...parsed.diagnostics[0], tool: 'typescript', file: 'src/a.ts', line: 3, column: 2, code: 'TS6133', severity: 'warning', message: 'unused.' });
  assert.match(parsed.diagnostics[1].message, /assignable to type 'string'/);
});

test('ESLint supports stylish and JSON output', () => {
  const stylish = parseEslint({ stdout: '/repo/src/a.ts\n  2:4  error  no unused vars  @typescript-eslint/no-unused-vars' }, options);
  assert.equal(stylish.diagnostics[0].file, 'src/a.ts');
  assert.equal(stylish.diagnostics[0].code, '@typescript-eslint/no-unused-vars');
  const json = parseEslint({ stdout: JSON.stringify([{ filePath: '/repo/src/b.ts', messages: [{ line: 4, column: 1, severity: 1, ruleId: 'semi', message: 'Missing semicolon.' }] }]) }, options);
  assert.equal(json.diagnostics[0].severity, 'warning');
  assert.equal(json.diagnostics[0].file, 'src/b.ts');
});

test('Vitest reports test totals separately from test failure diagnostics', () => {
  const vitest = parseVitest({ stderr: ' FAIL  src/a.test.ts\n \u276f refreshes token\nAssertionError: expected 1 to be 2\n \u276f src/a.test.ts:14:3\n \u00d7 rejects expired token\nAssertionError: expected false to be true\n\n Tests  2 failed | 7 passed | 1 skipped (10)' }, options);
  assert.equal(vitest.diagnostics.length, 2);
  assert.equal(vitest.diagnostics.find(item => item.subject === 'refreshes token')?.line, 14);
  assert.deepEqual(vitest.testTotals, { passed: 7, failed: 2, skipped: 1, ignored: null, total: 10 });
  assert.equal(vitest.summary.failures, 2);
});

test('Jest reports test totals separately from test failure diagnostics', () => {
  const jest = parseJest({ stdout: 'FAIL src/b.test.ts\n  \u25cf refreshes a session\n\n    Expected: 2\n      at Object.<anonymous> (src/b.test.ts:8:2)\n\nTests:       1 failed, 2 skipped, 3 passed, 6 total' }, options);
  assert.equal(jest.diagnostics[0].subject, 'refreshes a session');
  assert.equal(jest.diagnostics[0].file, 'src/b.test.ts');
  assert.deepEqual(jest.testTotals, { passed: 3, failed: 1, skipped: 2, ignored: null, total: 6 });
  assert.equal(jest.summary.failures, 1);
});

test('pytest reports test summary counts and collected total without changing failures', () => {
  const pytest = parsePytest({ stdout: 'collected 7 items\nFAILED tests/test_auth.py::test_refresh - AssertionError: expected token\n=== 1 failed, 3 passed, 2 skipped, 1 deselected in 0.2s ===' }, options);
  assert.equal(pytest.diagnostics[0].file, 'tests/test_auth.py');
  assert.equal(pytest.diagnostics[0].kind, 'test_failure');
  assert.deepEqual(pytest.testTotals, { passed: 3, failed: 1, skipped: 2, ignored: null, total: 7 });
  assert.equal(pytest.summary.failures, 1);
});

test('dotnet reports test summary counts without changing compiler diagnostics', () => {
  const dotnet = parseDotnet({ stdout: '/repo/Service.cs(10,4): error CS1002: ; expected [project]\n  Failed AuthTests.Refresh [12 ms]\n    Assert.Equal() Failure\n    at AuthTests.Refresh() in /repo/AuthTests.cs:line 22\n\nFailed!  - Failed: 1, Passed: 3, Skipped: 2, Total: 6, Duration: 4 ms' }, options);
  assert.equal(dotnet.diagnostics.length, 2);
  assert.equal(dotnet.diagnostics.find(item => item.code === 'CS1002')?.file, process.platform === 'win32' ? 'service.cs' : 'Service.cs');
  assert.equal(dotnet.diagnostics.find(item => item.kind === 'test_failure')?.subject, 'AuthTests.Refresh');
  assert.deepEqual(dotnet.testTotals, { passed: 3, failed: 1, skipped: 2, ignored: null, total: 6 });
  assert.equal(dotnet.summary.errors, 1);
  assert.equal(dotnet.summary.failures, 1);
});

test('Cargo text/JSON and Git checks are structured without replaying noise', () => {
  const cargo = parseCargo({ stderr: 'error[E0308]: mismatched types\n --> src/main.rs:4:5\n\n---- auth::refresh stdout ----\npanic: stale lock\ntest result: FAILED. 2 passed; 1 failed; 3 ignored; 0 measured; 0 filtered out; finished in 0.00s\nerror: test failed' }, options);
  assert.equal(cargo.diagnostics.length, 2);
  assert.equal(cargo.diagnostics[0].file, null);
  assert.equal(cargo.diagnostics[1].file, 'src/main.rs');
  assert.deepEqual(cargo.testTotals, { passed: 2, failed: 1, skipped: null, ignored: 3, total: null });
  assert.equal(cargo.summary.errors, 1);
  assert.equal(cargo.summary.failures, 1);
  const cargoJson = parseCargo({ stdout: JSON.stringify({ reason: 'compiler-message', message: { level: 'error', message: 'borrowed value', code: { code: 'E0502' }, spans: [{ is_primary: true, file_name: 'src/lib.rs', line_start: 9, column_start: 3 }] } }) }, options);
  assert.equal(cargoJson.diagnostics[0].code, 'E0502');
  const git = parseGit({ stderr: 'src/a.ts:4: trailing whitespace.\nfatal: not a git repository' }, options);
  assert.equal(git.diagnostics.length, 2);
  assert.equal(git.diagnostics[0].code, 'fatal');
  assert.equal(git.diagnostics[1].code, 'diff-check');
});

test('generic fallback and explicit/automatic parser selection are deterministic', () => {
  const generic = parseGeneric({ stderr: 'src/a.txt:2:7: error: bad thing\nprogress 50%' }, options);
  assert.equal(generic.diagnostics.length, 1);
  assert.equal(resolveParser({ command: ['npm', 'run', 'lint', '--', 'eslint'] }).id, 'eslint');
  assert.equal(resolveParser({ parser: 'pytest' }).id, 'pytest');
  assert.throws(() => resolveParser({ parser: 'made-up' }), /Unknown/);
  const parsed = parseCommandOutput({ stderr: 'fatal: failed' }, { command: ['unknown'] });
  assert.equal(parsed.parserId, 'generic');
});
