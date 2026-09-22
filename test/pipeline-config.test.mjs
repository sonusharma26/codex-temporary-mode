import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPipelineConfig, PipelineConfigError, resolveValidationProfile, validatePipelineConfig } from '../lib/accelerator/pipeline/config.mjs';

test('pipeline config validates profiles and resolves defensive command copies', () => {
  const config = validatePipelineConfig({ profiles: { targeted: [{ id: 'tests', executable: 'npm', args: ['test'], parser: 'vitest' }] } });
  const commands = resolveValidationProfile(config, 'targeted');
  assert.deepEqual(commands, [{ id: 'tests', executable: 'npm', args: ['test'], parser: 'vitest', timeoutMs: 120_000, continueOnFailure: false }]);
  commands[0].args.push('--changed');
  assert.deepEqual(config.profiles.targeted[0].args, ['test']);
});

test('pipeline config rejects unsafe or ambiguous command definitions', () => {
  assert.throws(() => validatePipelineConfig({ maxWorkers: 2 }), error => error instanceof PipelineConfigError && error.code === 'INVALID_PIPELINE_CONFIG');
  assert.throws(() => validatePipelineConfig({ profiles: { final: [{ id: 'same', executable: 'node' }, { id: 'same', executable: 'node' }] } }), /duplicate command ids/);
  assert.throws(() => resolveValidationProfile({ profiles: {} }, 'final'), error => error.code === 'PIPELINE_PROFILE_NOT_FOUND');
  assert.throws(() => validatePipelineConfig({ profiles: { custom: [{ id: 'bad id', executable: 'node' }] } }), /safe id/);
});

test('pipeline config loads the trusted repository file and treats a missing default as disabled', async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pipeline-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const missing = await loadPipelineConfig(root);
  assert.equal(missing.found, false); assert.deepEqual(missing.profiles, {});
  fs.mkdirSync(path.join(root, '.codex'));
  fs.writeFileSync(path.join(root, '.codex', 'accelerator.json'), JSON.stringify({ pipeline: { profiles: { fast: [{ id: 'syntax', executable: 'node', args: ['--check', 'index.js'] }] } } }));
  const loaded = await loadPipelineConfig(root);
  assert.equal(loaded.found, true); assert.equal(loaded.profiles.fast[0].id, 'syntax');
});
