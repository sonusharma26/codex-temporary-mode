import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { parseAcceleratorArgs } from '../lib/accelerator/cli.mjs';

const entry = fileURLToPath(new URL('../codex-accelerator.mjs', import.meta.url));

function repo(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'delta-mcp-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 'delta@example.test'); git('config', 'user.name', 'Delta Test');
  fs.writeFileSync(path.join(root, 'source.txt'), 'hello\n'); git('add', '.'); git('commit', '-qm', 'initial');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function client(t, workspace) {
  const child = spawn(process.execPath, [entry, 'mcp', '--workspace', workspace, '--ephemeral'], {
    cwd: path.dirname(entry), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let nextId = 1, buffer = '', stderr = '';
  const pending = new Map();
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch (error) { for (const item of pending.values()) item.reject(new Error(`Invalid MCP JSON: ${line}\n${stderr}`)); pending.clear(); return; }
      if (!Object.hasOwn(message, 'id')) continue;
      const item = pending.get(message.id); if (!item) continue;
      pending.delete(message.id); clearTimeout(item.timer);
      message.error ? item.reject(new Error(`${message.error.code}: ${message.error.message}`)) : item.resolve(message.result);
    }
  });
  child.once('error', error => { for (const item of pending.values()) item.reject(error); pending.clear(); });
  const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}\n${stderr}`)); }, 10_000);
      pending.set(id, { resolve, reject, timer }); send({ jsonrpc: '2.0', id, method, params });
    });
  };
  t.after(async () => {
    if (child.exitCode == null) child.stdin.end();
    await Promise.race([new Promise(resolve => child.once('close', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (child.exitCode == null) child.kill();
  });
  return { child, request, notify: (method, params = {}) => send({ jsonrpc: '2.0', method, params }), stderr: () => stderr };
}

test('CLI parses temporary-mode environment without changing normal defaults', () => {
  const normal = parseAcceleratorArgs(['mcp', '--workspace', '.'], {});
  const temporary = parseAcceleratorArgs(['mcp', '--workspace', '.'], { CODEX_ACCELERATOR_EPHEMERAL: '1' });
  assert.equal(normal.ephemeral, false); assert.equal(temporary.ephemeral, true);
  assert.throws(() => parseAcceleratorArgs(['pipeline']), /Only the mcp command/);
});

test('stdio MCP exposes Delta and Pipeline tools and rehydrates after reset', async t => {
  const workspace = repo(t), mcp = client(t, workspace);
  const initialized = await mcp.request('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'delta-test', version: '1.0.0' },
  });
  assert.equal(initialized.serverInfo.name, 'codex-accelerator');
  mcp.notify('notifications/initialized');
  const listed = await mcp.request('tools/list');
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [
    'cancel_checkpoint', 'create_checkpoint', 'get_latest_validation', 'get_pipeline_status',
    'get_raw_output', 'read_file_delta', 'reset_context_generation', 'run_command_delta', 'run_final_validation',
  ]);

  const first = await mcp.request('tools/call', { name: 'read_file_delta', arguments: { path: 'source.txt' } });
  assert.match(first.content[0].text, /MODE full/); assert.match(first.content[0].text, /hello/);
  assert.match(first.content[0].text, /FULL_SOURCE_BYTES 6\nDELIVERED_TEXT_BYTES 6\nSAVED_TEXT_BYTES 0/);
  const repeated = await mcp.request('tools/call', { name: 'read_file_delta', arguments: { path: 'source.txt' } });
  assert.match(repeated.content[0].text, /MODE unchanged/);
  assert.match(repeated.content[0].text, /FULL_SOURCE_BYTES 6\nDELIVERED_TEXT_BYTES 0\nSAVED_TEXT_BYTES 6/);
  await mcp.request('tools/call', { name: 'reset_context_generation', arguments: { reason: 'compaction' } });
  const rehydrated = await mcp.request('tools/call', { name: 'read_file_delta', arguments: { path: 'source.txt' } });
  assert.match(rehydrated.content[0].text, /MODE full/);

  const command = await mcp.request('tools/call', {
    name: 'run_command_delta',
    arguments: {
      executable: process.execPath,
      args: ['-e', "process.stderr.write('src/mcp.ts(4,5): error TS9000: mcp failure\\n'); process.exitCode=1"],
      parser: 'typescript',
      commandId: 'mcp-test',
    },
  });
  const commandResult = JSON.parse(command.content[0].text);
  assert.equal(commandResult.execution.status, 'failed'); assert.equal(commandResult.new[0].code, 'TS9000');
  const raw = await mcp.request('tools/call', { name: 'get_raw_output', arguments: { runId: commandResult.runId, stream: 'stderr' } });
  assert.match(raw.content[0].text, /TS9000: mcp failure/);
});
