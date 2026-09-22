import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realWorkspaceRoot } from './accelerator/paths.mjs';

const MANAGED_BEGIN = '# codex-temporary-mode: accelerator begin';
const MANAGED_END = '# codex-temporary-mode: accelerator end';
const GENERATED_BY = 'codex-temporary-mode';

function tomlString(value) { return JSON.stringify(String(value)); }

function assertRegularOrMissing(filename) {
  if (!fs.existsSync(filename)) return;
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing to replace a non-regular file: ${filename}`);
}

function ensureConfigDirectory(workspaceRoot) {
  const directory = path.join(workspaceRoot, '.codex');
  if (fs.existsSync(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`.codex must be a real directory: ${directory}`);
  } else {
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  return directory;
}

function managedBlock({ workspaceRoot, acceleratorEntry }) {
  const args = ['mcp', '--workspace', workspaceRoot];
  return [
    MANAGED_BEGIN,
    '[mcp_servers.codex_accelerator]',
    `command = ${tomlString(process.execPath)}`,
    `args = [${[acceleratorEntry, ...args].map(tomlString).join(', ')}]`,
    `cwd = ${tomlString(workspaceRoot)}`,
    'default_tools_approval_mode = "writes"',
    'tool_timeout_sec = 1800',
    'env_vars = ["CODEX_ACCELERATOR_EPHEMERAL"]',
    MANAGED_END,
  ].join('\n');
}

/** Add or refresh only this package's project-scoped MCP block. */
export function configureProjectMcp({ workspaceRoot, acceleratorEntry }) {
  const directory = ensureConfigDirectory(workspaceRoot);
  const filename = path.join(directory, 'config.toml');
  assertRegularOrMissing(filename);
  const original = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : '';
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const begin = original.indexOf(MANAGED_BEGIN);
  const end = original.indexOf(MANAGED_END);
  if ((begin < 0) !== (end < 0) || (begin >= 0 && end < begin)) throw new Error(`Managed accelerator block is incomplete: ${filename}`);
  if (begin < 0 && /^\s*\[mcp_servers\.(?:codex_accelerator|"codex_accelerator")\]\s*(?:#.*)?$/m.test(original)) {
    throw new Error(`An unmanaged codex_accelerator server already exists in ${filename}. Rename or remove it before setup.`);
  }
  const block = managedBlock({ workspaceRoot, acceleratorEntry }).replaceAll('\n', newline);
  let updated;
  if (begin >= 0) {
    const after = end + MANAGED_END.length;
    updated = `${original.slice(0, begin)}${block}${original.slice(after)}`;
  } else {
    updated = `${original.trimEnd()}${original.trim() ? newline.repeat(2) : ''}${block}${newline}`;
  }
  if (updated === original) return { filename, changed: false };
  if (fs.existsSync(filename) && fs.readFileSync(filename, 'utf8') !== original) throw new Error(`Codex configuration changed during setup: ${filename}`);
  fs.writeFileSync(filename, updated, { encoding: 'utf8', mode: 0o600 });
  return { filename, changed: true };
}

function npmCommand(id, script, parser = 'generic') {
  return { id, executable: 'npm', args: ['run', script], parser, timeoutMs: 1_800_000 };
}

function nodePipelineCommands(workspaceRoot) {
  const filename = path.join(workspaceRoot, 'package.json');
  if (!fs.existsSync(filename)) return null;
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { throw new Error(`Cannot generate Pipeline configuration from invalid JSON: ${filename}`); }
  const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const candidates = [];
  if (typeof scripts.typecheck === 'string') candidates.push(npmCommand('typecheck', 'typecheck', 'typescript'));
  if (typeof scripts.test === 'string' && !/no test specified/i.test(scripts.test)) candidates.push(npmCommand('tests', 'test'));
  if (typeof scripts.lint === 'string') candidates.push(npmCommand('lint', 'lint', 'eslint'));
  if (typeof scripts.build === 'string') candidates.push(npmCommand('build', 'build'));
  if (!candidates.length) return null;
  const targeted = candidates.find(item => item.id === 'typecheck') || candidates.find(item => item.id === 'tests') || candidates[0];
  const final = candidates.map((item, index) => ({ ...item, continueOnFailure: index < candidates.length - 1 }));
  return { targeted: [targeted], final };
}

function otherPipelineCommands(workspaceRoot) {
  const names = fs.readdirSync(workspaceRoot);
  if (names.includes('Cargo.toml')) return {
    targeted: [{ id: 'check', executable: 'cargo', args: ['check'], parser: 'cargo', timeoutMs: 1_800_000 }],
    final: [{ id: 'tests', executable: 'cargo', args: ['test'], parser: 'cargo', timeoutMs: 1_800_000 }],
  };
  if (names.some(name => name.endsWith('.sln') || name.endsWith('.csproj'))) return {
    targeted: [{ id: 'build', executable: 'dotnet', args: ['build', '--nologo'], parser: 'dotnet', timeoutMs: 1_800_000 }],
    final: [{ id: 'tests', executable: 'dotnet', args: ['test', '--nologo'], parser: 'dotnet', timeoutMs: 1_800_000 }],
  };
  return null;
}

/** Create a conservative starter Pipeline config without overwriting project choices. */
export function configurePipeline({ workspaceRoot }) {
  const directory = ensureConfigDirectory(workspaceRoot);
  const filename = path.join(directory, 'accelerator.json');
  assertRegularOrMissing(filename);
  if (fs.existsSync(filename)) return { filename, changed: false, detected: true };
  const profiles = nodePipelineCommands(workspaceRoot) || otherPipelineCommands(workspaceRoot);
  if (!profiles) return { filename, changed: false, detected: false };
  const document = { generatedBy: GENERATED_BY, pipeline: { maxWorkers: 1, profiles } };
  fs.writeFileSync(filename, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { filename, changed: true, detected: true };
}

function parseSetupArgs(args, cwd) {
  const options = { workspace: cwd, vscode: true, pipeline: true };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--skip-vscode') { options.vscode = false; continue; }
    if (arg === '--skip-pipeline-config') { options.pipeline = false; continue; }
    const key = { '-C': 'workspace', '--workspace': 'workspace', '--vscode-path': 'vscodePath' }[arg];
    if (!key) throw new Error(`Unknown setup option: ${arg}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
    options[key] = value;
  }
  options.workspace = path.resolve(options.workspace);
  if (options.vscodePath) options.vscodePath = path.resolve(options.vscodePath);
  return options;
}

function patchVSCode(vscodePath, run) {
  const patchEntry = fileURLToPath(new URL('../patch.mjs', import.meta.url));
  const args = [patchEntry, '--vscode', ...(vscodePath ? ['--vscode-path', vscodePath] : [])];
  const result = run(process.execPath, args, { encoding: 'utf8', shell: false, windowsHide: true });
  if (result.error || result.status !== 0) return { status: 'unavailable', message: String(result.stderr || result.error?.message || 'VS Code extension was not found.').trim() };
  return { status: 'configured', message: String(result.stdout || '').trim() };
}

async function resolveGitWorkspace(requestedPath) {
  const requested = await realWorkspaceRoot(requestedPath);
  let topLevel;
  try {
    topLevel = execFileSync('git', ['--no-optional-locks', 'rev-parse', '--show-toplevel'], {
      cwd: requested,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
  } catch {
    throw new Error(`Setup requires a Git repository: ${requested}`);
  }
  return realWorkspaceRoot(topLevel);
}

export async function setup(args = [], { cwd = process.cwd(), run = spawnSync, log = console.log } = {}) {
  const options = parseSetupArgs(args, cwd);
  const workspaceRoot = await resolveGitWorkspace(options.workspace);
  const acceleratorEntry = fileURLToPath(new URL('../codex-accelerator.mjs', import.meta.url));
  if (!fs.existsSync(acceleratorEntry)) throw new Error(`Accelerator entry point is missing: ${acceleratorEntry}`);

  const mcp = configureProjectMcp({ workspaceRoot, acceleratorEntry });
  const pipeline = options.pipeline ? configurePipeline({ workspaceRoot }) : { changed: false, detected: false, skipped: true };
  const vscode = options.vscode ? patchVSCode(options.vscodePath, run) : { status: 'skipped', message: 'Skipped by option.' };

  log(`[setup] Delta and Pipeline MCP: ${mcp.changed ? 'configured' : 'already configured'} (${mcp.filename})`);
  if (pipeline.skipped) log('[setup] Pipeline profile generation: skipped.');
  else if (pipeline.detected) log(`[setup] Pipeline profiles: ${pipeline.changed ? 'generated' : 'already configured'} (${pipeline.filename})`);
  else log(`[setup] Pipeline profiles: no standard Node, Cargo, or .NET commands detected. Add ${pipeline.filename} before using checkpoints.`);
  log(`[setup] VS Code Temporary Mode: ${vscode.status}${vscode.message ? ` (${vscode.message})` : ''}`);
  log('[setup] Restart Codex or VS Code, trust this project, then use /mcp to verify codex_accelerator.');
  return { workspaceRoot, mcp, pipeline, vscode };
}
