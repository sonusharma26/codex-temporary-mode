import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installVSCode, restoreVSCode } from '../lib/installers.mjs';
import { adaptVSCodeSource, adaptRendererSource, RENDERER_PATH, COMPOSER_PATH, SUPPORTED_VSCODE_VERSION } from '../lib/vscode-adapter.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const helper = fs.readFileSync(path.join(repo, 'src/inject/vscode-inject.cjs'), 'utf8');
const pkg = { publisher: 'openai', name: 'chatgpt', version: SUPPORTED_VSCODE_VERSION, main: 'out/extension.js', contributes: { configuration: [] } };
const hostSource = `const endpoints={"get-settings":()=>this.settings.readAll(),}; const ES='ui'; class Host {
sendProviderRequest(e,r,n,o,i,s){this.sent={id:e+':'+r,method:n,params:o};}
routeIncomingMessage(e,r=e){const n=e.method,i=e.params?.thread,s=i?.id||e.params?.threadId;
if(n==="thread/started"&&i!=null&&Eyt(i))return this.markEphemeralThreadId(i.id);
if(s&&this.ephemeralThreadTimeouts.has(s))return 'dropped';
this.delivered.push(e);return 'delivered';}
teardownProcess(){this.sent=null;}}
function Eyt(t){return t.ephemeral===true;} module.exports=Host;`;
const rendererSource = 'function create(v,d){return {ephemeral:d.ephemeral,sideConversation:d.ephemeral};}' +
  'function n6t(e,{conversationId:t,forkResponse:n,hostMode:r,threadRecognition:i,params:a,product:o,sourceConversation:s}){return a;}';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'temp-codex-test-'));
  t.after(() => {
    // Only this test's freshly-created directory may be removed.
    const resolved = fs.realpathSync(dir);
    assert.equal(resolved, dir);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert(path.basename(resolved).startsWith('temp-codex-test-'));
    fs.rmSync(resolved, { recursive: true });
  });
  return dir;
}
function extension(t, source = hostSource, metadata = pkg) {
  const dir = fixture(t);
  fs.mkdirSync(path.join(dir, 'out'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(metadata));
  fs.writeFileSync(path.join(dir, 'out/extension.js'), source);
  fs.mkdirSync(path.dirname(path.join(dir, RENDERER_PATH)), { recursive: true });
  fs.writeFileSync(path.join(dir, RENDERER_PATH), rendererSource);
  fs.writeFileSync(path.join(dir, COMPOSER_PATH), 'function zKn(e){return e;}');
  return dir;
}
function runtime(source = hostSource) {
  let on = true;
  const context = vm.createContext({ module: { exports: {} }, queueMicrotask() {}, require(name) {
    if (name === 'fs') return fs;
    if (name === 'path') return path;
    if (name === 'vscode') return { workspace: { getConfiguration: () => ({ get: () => on }) } };
    if (name === './temp-codex-inject.cjs') return context.__TEMP_CODEX_V3__;
    throw new Error('Unexpected dependency ' + name);
  } });
  vm.runInContext(helper, context);
  vm.runInContext(adaptVSCodeSource(source, pkg), context);
  const host = new context.module.exports();
  host.providers = new Map([['ui', { onResult: m => host.delivered.push(m) }]]);
  host.ephemeralThreadTimeouts = new Map();
  host.markEphemeralThreadId = id => { host.ephemeralThreadTimeouts.set(id, true); return 'internal'; };
  host.delivered = [];
  return { host, api: context.__TEMP_CODEX_V3__, toggle: value => { on = value; } };
}

test('user ephemeral replies and completion reach the UI; internal threads remain hidden', () => {
  const { host, toggle } = runtime();
  const original = { cwd: '/project', ephemeral: false };
  host.sendProviderRequest('ui', '1', 'thread/start', original);
  assert.equal(host.sent.params.ephemeral, true);
  assert.equal(original.ephemeral, false);
  host.routeIncomingMessage({ id: 'ui:1', result: { thread: { id: 'temp', ephemeral: true } } });
  assert.equal(host.routeIncomingMessage({ method: 'thread/started', params: { thread: { id: 'temp', ephemeral: true } } }), 'delivered');
  toggle(false);
  for (const method of ['item/agentMessage/delta', 'turn/completed']) assert.equal(host.routeIncomingMessage({ method, params: { threadId: 'temp' } }), 'delivered');
  assert.equal(host.routeIncomingMessage({ method: 'thread/started', params: { thread: { id: 'internal', ephemeral: true } } }), 'internal');
  assert.equal(host.routeIncomingMessage({ method: 'turn/completed', params: { threadId: 'internal' } }), 'dropped');
});

test('OFF, internal requests and existing turns preserve their original parameters', () => {
  const { host, toggle } = runtime();
  const params = { ephemeral: false };
  host.sendProviderRequest('internal', '1', 'thread/start', params);
  assert.equal(host.sent.params, params);
  host.sendProviderRequest('ui', '2', 'turn/start', params);
  assert.equal(host.sent.params, params);
  toggle(false);
  host.sendProviderRequest('ui', '3', 'thread/start', params);
  assert.equal(host.sent.params, params);
});

test('forks are temporary; unconfirmed responses and unsupported thread types fail closed', () => {
  const { host } = runtime();
  host.sendProviderRequest('ui', '1', 'thread/fork', { threadId: 'original' });
  assert.equal(host.sent.params.ephemeral, true);
  host.routeIncomingMessage({ id: 'ui:1', result: { thread: { id: 'persisted', ephemeral: false } } });
  assert(host.delivered.at(-1).error);
  const sent = host.sent;
  host.sendProviderRequest('ui', '2', 'thread/startAeon', {});
  assert.equal(host.sent, sent);
  assert(host.delivered.at(-1).error);
});

test('prewarmed chats cannot send in the wrong mode after toggling', () => {
  const { host, toggle } = runtime();
  toggle(false);
  host.sendProviderRequest('ui', '1', 'thread/start', {}, true);
  host.routeIncomingMessage({ id: 'ui:1', result: { thread: { id: 'prewarm', ephemeral: false } } });
  toggle(true);
  const sent = host.sent;
  host.sendProviderRequest('ui', '2', 'turn/start', { threadId: 'prewarm' });
  assert.equal(host.sent, sent);
  assert.match(host.delivered.at(-1).error.message, /prewarmed/);
});

test('native and WSL serialization carry the same rewritten structured request', () => {
  for (const launcher of ['codex.exe', 'wsl.exe']) {
    const { host } = runtime();
    host.sendProviderRequest('ui', '1', 'thread/start', {});
    const wire = JSON.stringify(host.sent) + '\n';
    // Serialization and arbitrary chunking occur after the adapter.
    const chunks = [wire.slice(0, 7), wire.slice(7, 23), wire.slice(23)];
    assert.equal(JSON.parse(chunks.join('')).params.ephemeral, true, launcher);
  }
});

test('connection teardown discards visible and pending thread state', () => {
  const { host, api } = runtime();
  host.sendProviderRequest('ui', '1', 'thread/start', {});
  host.routeIncomingMessage({ id: 'ui:1', result: { thread: { id: 'temp', ephemeral: true } } });
  assert(api.visible(host, 'temp'));
  host.teardownProcess();
  assert(!api.visible(host, 'temp'));
});

test('renderer retains server ephemeral mode without turning a normal chat into a side conversation', () => {
  const context = vm.createContext({});
  vm.runInContext(adaptRendererSource(rendererSource), context);
  const temporary = context.create({ thread: { ephemeral: true } }, { ephemeral: false });
  assert.equal(temporary.ephemeral, true);
  assert.equal(temporary.sideConversation, false);
  const normal = context.create({ thread: { ephemeral: false } }, { ephemeral: false });
  assert.equal(normal.ephemeral, false);
  // The host already excludes ephemeral metadata from its saved history.
  assert.deepEqual([temporary, normal].filter(e => e.ephemeral !== true), [normal]);
  const fork = context.n6t(null, { forkResponse: { thread: { ephemeral: true } }, params: { ephemeral: false } });
  assert.equal(fork.ephemeral, true);
});

test('ephemeral queue stays in memory and starts the next turn without server queue storage', () => {
  const { host } = runtime();
  host.sendProviderRequest('ui', '1', 'thread/start', {});
  host.routeIncomingMessage({ id: 'ui:1', result: { thread: { id: 'temp', ephemeral: true } } });
  const sent = host.sent;
  host.sendProviderRequest('ui', '2', 'thread/queue/list', { threadId: 'temp' });
  assert.equal(host.sent, sent);
  assert.equal(host.delivered.at(-1).result.data.length, 0);
  assert.equal(host.delivered.at(-1).result.nextCursor, null);
  const input = [{ type: 'text', text: 'next message', text_elements: [] }];
  host.sendProviderRequest('ui', '3', 'thread/queue/add', { threadId: 'temp', input, clientUserMessageId: 'message-2' });
  assert.equal(host.sent, sent);
  const queued = host.delivered.at(-1).result.queuedSubmission;
  assert.equal(queued.input, input);
  host.sendProviderRequest('ui', '4', 'thread/queue/list', { threadId: 'temp' });
  assert.equal(JSON.stringify(host.delivered.at(-1).result.data), JSON.stringify([queued]));
  host.sendProviderRequest('ui', '5', 'thread/queue/start', { threadId: 'temp', queuedSubmissionId: queued.id });
  assert.equal(host.sent.method, 'turn/start');
  assert.equal(JSON.stringify(host.sent.params), JSON.stringify({ threadId: 'temp', input }));
  host.sendProviderRequest('ui', '6', 'thread/queue/list', { threadId: 'temp' });
  assert.equal(JSON.stringify(host.delivered.at(-1).result.data), '[]');
  host.sendProviderRequest('ui', '7', 'thread/queue/list', { threadId: 'normal' });
  assert.equal(host.sent.method, 'thread/queue/list');
});

test('VS Code install is idempotent and restore is byte-exact', t => {
  const root = extension(t);
  const before = fs.readFileSync(path.join(root, 'package.json'));
  installVSCode(root, helper);
  assert(!fs.existsSync(path.join(root, '.temp-codex-reload-once')));
  assert.match(installVSCode(root, helper), /Already patched/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).contributes.configuration.length, 1);
  restoreVSCode(root);
  assert.deepEqual(fs.readFileSync(path.join(root, 'package.json')), before);
  assert.equal(fs.readFileSync(path.join(root, pkg.main), 'utf8'), hostSource);
  assert.equal(fs.readFileSync(path.join(root, RENDERER_PATH), 'utf8'), rendererSource);
  assert(!fs.existsSync(path.join(root, 'out/temp-codex-inject.cjs')));
  assert(!fs.existsSync(path.join(root, '.temp-codex-reload-once')));
  installVSCode(root, helper); // restore cleaned stale backups
});

test('a verified v3 patch upgrades to the current patch version', t => {
  const root = extension(t);
  installVSCode(root, helper);
  const manifestPath = path.join(root, '.temp-codex-v3.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.version = 3;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.match(installVSCode(root, helper), /Reload VS Code once/);
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version, 6);
  assert(!fs.existsSync(path.join(root, '.temp-codex-reload-once')));
});

test('unsupported versions and changed source layouts are rejected before writing', t => {
  const root = extension(t, hostSource, { ...pkg, version: 'unknown' });
  assert.throws(() => installVSCode(root, helper), /Unsupported/);
  assert.equal(fs.readFileSync(path.join(root, pkg.main), 'utf8'), hostSource);
  assert(!fs.existsSync(path.join(root, pkg.main + '.temp-codex.bak')));
  assert.throws(() => adaptVSCodeSource('module.exports={};', pkg), /layout/);
});

test('installer rolls back an interrupted write and removes only its own new files', t => {
  const root = extension(t);
  const main = path.join(root, pkg.main);
  const packagePath = path.join(root, 'package.json');
  const originalPackage = fs.readFileSync(packagePath);
  const write = fs.writeFileSync;
  let failed = false;
  try {
    fs.writeFileSync = (file, ...args) => {
      if (file === packagePath && !failed) {
        failed = true;
        write(file, 'partial write');
        throw new Error('simulated write failure');
      }
      return write(file, ...args);
    };
    assert.throws(() => installVSCode(root, helper), /simulated/);
  } finally { fs.writeFileSync = write; }
  assert.equal(fs.readFileSync(main, 'utf8'), hostSource);
  assert.deepEqual(fs.readFileSync(packagePath), originalPackage);
  assert.deepEqual(fs.readdirSync(path.join(root, 'out')), ['extension.js']);
  assert.deepEqual(fs.readdirSync(root).sort(), ['out', 'package.json', 'webview']);
});

test('installer rejects entry points outside the supplied application', t => {
  const root = extension(t, hostSource, { ...pkg, main: '../outside.js' });
  assert.throws(() => installVSCode(root, helper), /outside application/);
  assert(!fs.existsSync(path.join(root, '.temp-codex-v3.json')));
});

test('restore refuses changed app files and changed backups', t => {
  const root = extension(t);
  installVSCode(root, helper);
  fs.writeFileSync(path.join(root, pkg.main), 'updated app');
  assert.throws(() => restoreVSCode(root), /changed/);
  assert.equal(fs.readFileSync(path.join(root, pkg.main), 'utf8'), 'updated app');
  const other = extension(t);
  installVSCode(other, helper);
  fs.writeFileSync(path.join(other, pkg.main + '.temp-codex.bak'), 'changed backup');
  assert.throws(() => restoreVSCode(other), /changed/);
});

test('removed desktop options are rejected without modifying VS Code', t => {
  const root = extension(t);
  for (const option of ['--desktop', '--all', '--desktop-path']) {
    const result = spawnSync(process.execPath, [path.join(repo, 'patch.mjs'), '--vscode', '--vscode-path', root, option], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown argument/);
    assert.equal(fs.readFileSync(path.join(root, pkg.main), 'utf8'), hostSource);
  }
});

test('npm asks to patch VS Code during installation', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'))).scripts;
  assert.equal(scripts.postinstall, 'node build/postinstall.mjs');
  for (const name of ['preinstall', 'install', 'prepare', 'uninstall']) assert.equal(scripts[name], undefined);
});
