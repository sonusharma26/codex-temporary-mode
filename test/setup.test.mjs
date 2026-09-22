import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setup } from '../lib/setup.mjs';
import { loadPipelineConfig } from '../lib/accelerator/pipeline/config.mjs';

test('setup configures all modes per repository without replacing existing project configuration', async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'codex-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.mkdirSync(path.join(root, '.codex'));
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, '.codex', 'config.toml'), '[features]\nexample = true\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'node --test' } }));

  const calls = [], messages = [];
  const run = (command, args) => { calls.push({ command, args }); return { status: 0, stdout: 'Temporary Mode configured.' }; };
  const first = await setup([], { cwd: path.join(root, 'nested'), run, log: message => messages.push(message) });
  const second = await setup(['--skip-vscode'], { cwd: root, run, log() {} });

  const codexConfig = fs.readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8');
  assert.match(codexConfig, /\[features\]\nexample = true/);
  assert.equal(codexConfig.match(/\[mcp_servers\.codex_accelerator\]/g)?.length, 1);
  assert.match(codexConfig, /CODEX_ACCELERATOR_EPHEMERAL/);
  const pipeline = JSON.parse(fs.readFileSync(path.join(root, '.codex', 'accelerator.json'), 'utf8'));
  const loadedPipeline = await loadPipelineConfig(root);
  assert.equal(pipeline.generatedBy, 'codex-temporary-mode');
  assert.equal(loadedPipeline.found, true);
  assert.deepEqual(pipeline.pipeline.profiles.targeted.map(item => item.id), ['typecheck']);
  assert.deepEqual(pipeline.pipeline.profiles.final.map(item => item.id), ['typecheck', 'tests']);
  assert.equal(first.mcp.changed, true);
  assert.equal(first.workspaceRoot, fs.realpathSync(root));
  assert.equal(second.mcp.changed, false);
  assert.equal(calls.length, 1);
  assert(calls[0].args.includes('--vscode'));
  assert(messages.some(message => message.includes('Restart Codex')));
});
