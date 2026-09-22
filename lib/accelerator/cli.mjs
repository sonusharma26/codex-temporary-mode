import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { sha256 } from './hashing.mjs';
import { realWorkspaceRoot } from './paths.mjs';
import { AcceleratorStore } from './store.mjs';
import { SessionManager } from './session-manager.mjs';
import { FileDeltaService } from './file-delta.mjs';
import { RawOutputStore } from './raw-output.mjs';
import { CommandDeltaService } from './command-delta.mjs';
import { createAcceleratorMcpServer } from './mcp-server.mjs';
import { PipelineService } from './pipeline/service.mjs';

export const ACCELERATOR_HELP = `codex-accelerator — local Delta and Pipeline Mode MCP server

Usage:
  codex-accelerator mcp [options]

Options:
  -C, --workspace <dir>       Git workspace (default: current directory)
      --database <file>       SQLite state path (default: OS-local app state)
      --ephemeral             In-memory SQLite and session-only raw output
      --max-file-bytes <n>    Maximum source file size (default: 2097152)
      --max-output-bytes <n>  Optional hard retention cap per output stream
      --pipeline-config <file> Trusted Pipeline Mode JSON config
  -h, --help                  Show help

The MCP protocol uses stdout. Runtime diagnostics are written only to stderr.
`;

function positiveInteger(value, flag) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${flag} must be a positive integer.`);
  return number;
}

export function parseAcceleratorArgs(args = process.argv.slice(2), env = process.env) {
  const options = {
    command: 'mcp', workspace: process.cwd(),
    ephemeral: env.CODEX_ACCELERATOR_EPHEMERAL === '1',
    maxFileBytes: 2 * 1024 * 1024,
    maxOutputBytes: Number.POSITIVE_INFINITY,
  };
  let cursor = 0;
  if (args[0] && !args[0].startsWith('-')) { options.command = args[0]; cursor++; }
  for (; cursor < args.length; cursor++) {
    const arg = args[cursor];
    if (arg === '-h' || arg === '--help') { options.help = true; continue; }
    if (arg === '--ephemeral') { options.ephemeral = true; continue; }
    const key = { '-C': 'workspace', '--workspace': 'workspace', '--database': 'database', '--pipeline-config': 'pipelineConfig', '--max-file-bytes': 'maxFileBytes', '--max-output-bytes': 'maxOutputBytes' }[arg];
    if (!key) throw new Error(`Unknown argument: ${arg}`);
    const value = args[++cursor];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
    options[key] = key.startsWith('max') ? positiveInteger(value, arg) : value;
  }
  if (options.command !== 'mcp') throw new Error('Only the mcp command is available in the local accelerator.');
  options.workspace = path.resolve(options.workspace);
  if (options.database && options.database !== ':memory:') options.database = path.resolve(options.database);
  if (options.pipelineConfig) options.pipelineConfig = path.resolve(options.pipelineConfig);
  if (options.database === ':memory:') options.ephemeral = true;
  return options;
}

function applicationStateRoot(env = process.env) {
  if (process.platform === 'win32') return env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
}

export async function createAcceleratorRuntime(options) {
  const workspaceRoot = await realWorkspaceRoot(options.workspace);
  const repositoryId = `repo_${sha256(workspaceRoot).slice(0, 32)}`;
  const stateDirectory = options.ephemeral ? await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-accelerator-state-'))
    : path.join(applicationStateRoot(), 'codex-accelerator', repositoryId);
  await fsp.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const database = options.ephemeral ? ':memory:' : (options.database || path.join(stateDirectory, 'state-v1.sqlite'));
  if (database !== ':memory:') await fsp.mkdir(path.dirname(database), { recursive: true, mode: 0o700 });
  const rawDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-accelerator-raw-'));
  const pipelineSnapshotRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-accelerator-pipeline-'));
  const store = new AcceleratorStore(database);
  store.ensureRepository({ repositoryId, realRoot: workspaceRoot });
  const sessionManager = new SessionManager({ store, repositoryId, ephemeral: options.ephemeral });
  sessionManager.start();
  const rawOutputStore = new RawOutputStore(rawDirectory, { maxBytesPerStream: options.maxOutputBytes });
  const fileDeltaService = new FileDeltaService({ store, sessionManager, workspaceRoot, maxFileBytes: options.maxFileBytes });
  const commandDeltaService = new CommandDeltaService({ workspaceRoot, repositoryId, sessionManager, store, rawOutputStore });
  const pipelineService = new PipelineService({
    workspaceRoot, repositoryId, sessionManager, store, rawOutputStore,
    snapshotRoot: pipelineSnapshotRoot, configPath: options.pipelineConfig,
  });
  let closed = false;
  return {
    workspaceRoot, repositoryId, store, sessionManager, rawOutputStore, fileDeltaService, commandDeltaService, pipelineService,
    createServer: () => createAcceleratorMcpServer({ fileDeltaService, commandDeltaService, pipelineService, sessionManager, rawOutputStore }),
    async close() {
      if (closed) return;
      closed = true;
      try {
        await pipelineService.close();
        await commandDeltaService.close();
        await rawOutputStore.close();
      }
      finally {
        try { sessionManager.close(); }
        finally {
          store.close();
          await fsp.rm(rawDirectory, { recursive: true, force: true });
          await fsp.rm(pipelineSnapshotRoot, { recursive: true, force: true });
          if (options.ephemeral) await fsp.rm(stateDirectory, { recursive: true, force: true });
        }
      }
    },
  };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseAcceleratorArgs(args);
  if (options.help) { process.stdout.write(ACCELERATOR_HELP); return; }
  const runtime = await createAcceleratorRuntime(options);
  const handle = serveStdio(runtime.createServer, { onerror: error => process.stderr.write(`[codex-accelerator] ${error.message}\n`) });
  let finish;
  const ended = new Promise(resolve => { finish = resolve; });
  const stop = () => finish();
  process.stdin.once('end', stop);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { await ended; }
  finally {
    process.stdin.off('end', stop);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await handle.close();
    await runtime.close();
  }
}
