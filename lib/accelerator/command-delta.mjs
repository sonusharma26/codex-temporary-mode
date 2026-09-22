import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { diffDiagnostics } from './diagnostics.mjs';
import { parseCommandOutput, resolveParser } from './parsers/index.mjs';
import { fingerprintWorkspace } from './workspace.mjs';

const PARSER_VERSION = 1;

export class CommandDeltaError extends Error {
  constructor(code, message) { super(message); this.name = 'CommandDeltaError'; this.code = code; }
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function validateCommand(executable, args) {
  if (typeof executable !== 'string' || !executable.trim() || executable.includes('\0')) throw new CommandDeltaError('INVALID_COMMAND', 'executable must be a non-empty string.');
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string' || value.includes('\0'))) throw new CommandDeltaError('INVALID_ARGUMENTS', 'args must be an array of strings.');
  if (args.length > 256 || args.some(value => Buffer.byteLength(value) > 64 * 1024)) throw new CommandDeltaError('ARGUMENT_LIMIT', 'Command arguments exceed the Delta Mode safety limit.');
}

function npmCli(name) {
  const bin = name === 'npx' ? 'npx-cli.js' : 'npm-cli.js';
  const candidate = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', bin);
  return fs.existsSync(candidate) ? candidate : null;
}

/** Resolve Windows npm shims without enabling a command shell. */
export function resolveCommand(executable, args = [], platform = process.platform) {
  validateCommand(executable, args);
  if (platform === 'win32') {
    const extension = path.extname(executable).toLowerCase();
    const base = path.basename(executable, extension).toLowerCase();
    if ((base === 'npm' || base === 'npx') && (!extension || extension === '.cmd')) {
      const cli = npmCli(base);
      if (!cli) throw new CommandDeltaError('COMMAND_NOT_FOUND', `Could not resolve ${base} without a shell.`);
      return { executable: process.execPath, args: [cli, ...args], displayExecutable: base };
    }
    if (['.cmd', '.bat', '.ps1'].includes(extension)) throw new CommandDeltaError('SHELL_SCRIPT_NOT_SUPPORTED', 'Batch and PowerShell scripts are not supported by run_command_delta v0.1.');
  }
  return { executable, args, displayExecutable: executable };
}

function commandScopeKey({ commandId, executable, args, parserId }) {
  // A caller-provided label improves readability but never replaces the exact
  // executable/argument identity; otherwise reusing a label could compare two
  // different commands and manufacture a misleading diagnostic delta.
  const identity = ['id', commandId || '', 'exec', executable, ...args];
  return sha256(JSON.stringify([...identity, parserId, PARSER_VERSION]));
}

function terminateProcess(child) {
  if (!child?.pid || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => { try { child.kill(); } catch {} });
    killer.unref();
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); }
    catch { try { child.kill('SIGTERM'); } catch {} }
  }
  const hardStop = setTimeout(() => {
    if (child.exitCode != null || child.signalCode != null) return;
    if (process.platform === 'win32') { try { child.kill(); } catch {} }
    else {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { try { child.kill('SIGKILL'); } catch {} }
    }
  }, 1500);
  hardStop.unref?.();
}

function compactDiagnostic(item) {
  return {
    kind: item.kind, severity: item.severity, tool: item.tool,
    ...(item.file ? { file: item.file } : {}),
    ...(item.line != null ? { line: item.line } : {}),
    ...(item.column != null ? { column: item.column } : {}),
    ...(item.code ? { code: item.code } : {}),
    message: item.message,
    ...(item.subject ? { subject: item.subject } : {}),
    fingerprint: item.fingerprint,
  };
}

export class CommandDeltaService {
  constructor({ workspaceRoot, repositoryId, sessionManager, store, rawOutputStore, timeoutMs = 120_000, maxReturnedDiagnostics = 20, maxParseBytesPerStream = 32 * 1024 * 1024 }) {
    this.workspaceRoot = workspaceRoot;
    this.repositoryId = repositoryId;
    this.session = sessionManager;
    this.store = store;
    this.raw = rawOutputStore;
    this.defaultTimeoutMs = timeoutMs;
    this.maxReturnedDiagnostics = maxReturnedDiagnostics;
    this.maxParseBytesPerStream = maxParseBytesPerStream;
    this.activeChildren = new Set();
    this.activeOperations = new Set();
    this.closing = false;
  }

  run(options = {}) {
    if (this.closing) throw new CommandDeltaError('SERVICE_CLOSING', 'The command runner is shutting down.');
    const operation = this.#run(options);
    this.activeOperations.add(operation);
    operation.then(
      () => this.activeOperations.delete(operation),
      () => this.activeOperations.delete(operation),
    );
    return operation;
  }

  async close() {
    if (this.closing) {
      await Promise.allSettled([...this.activeOperations]);
      return;
    }
    this.closing = true;
    for (const child of this.activeChildren) terminateProcess(child);
    await Promise.allSettled([...this.activeOperations]);
  }

  async #run({ executable, args = [], parser, commandId, timeoutMs = this.defaultTimeoutMs, expectedWorkspaceId } = {}) {
    validateCommand(executable, args);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30 * 60 * 1000) throw new CommandDeltaError('INVALID_TIMEOUT', 'timeoutMs must be between 100 and 1800000.');
    const selected = resolveParser({ parser, command: [executable, ...args] });
    const resolved = resolveCommand(executable, args);
    const generationId = this.session.generationId;
    const workspace = await fingerprintWorkspace(this.workspaceRoot);
    if (this.closing) throw new CommandDeltaError('SERVICE_CLOSING', 'The command runner shut down before command launch.');
    if (!workspace.complete) throw new CommandDeltaError('WORKSPACE_INCOMPLETE', 'A complete workspace version could not be created.');
    if (expectedWorkspaceId && expectedWorkspaceId !== workspace.id) throw new CommandDeltaError('STALE_WORKSPACE', `Expected ${expectedWorkspaceId}, but the current workspace is ${workspace.id}.`);
    this.store.recordWorkspace(this.repositoryId, workspace);

    const runId = `run_${crypto.randomUUID().replaceAll('-', '')}`;
    const scopeKey = commandScopeKey({ commandId, executable: resolved.displayExecutable, args, parserId: selected.id });
    const rawRun = await this.raw.createRun(runId, this.session.sessionId);
    if (this.closing) {
      await rawRun.close();
      await this.raw.removeRun(runId);
      throw new CommandDeltaError('SERVICE_CLOSING', 'The command runner shut down before command launch.');
    }
    const startedAt = Date.now();
    this.store.createCommandRun({
      runId, sessionId: this.session.sessionId, generationId,
      workspaceId: workspace.id, scopeKey, parserId: selected.id, parserVersion: PARSER_VERSION,
      executable: resolved.displayExecutable, args, cwd: this.workspaceRoot, startedAt,
    });

    const stdout = [], stderr = [], parsedBytes = { stdout: 0, stderr: 0 };
    let outputLimitExceeded = false, parseOutputLimitExceeded = false, timedOut = false, launchError = null, rawWriteError = null;
    const child = spawn(resolved.executable, resolved.args, {
      cwd: this.workspaceRoot, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
    });
    this.activeChildren.add(child);
    let queuedWrites = 0;
    let writeChain = Promise.resolve();
    const pauseOutputs = () => { child.stdout?.pause(); child.stderr?.pause(); };
    const resumeOutputs = () => { child.stdout?.resume(); child.stderr?.resume(); };
    const retain = (stream, chunk) => {
      queuedWrites++;
      pauseOutputs();
      writeChain = writeChain.then(async () => {
        if (rawWriteError) return;
        const bytes = Buffer.from(chunk);
        if (!await rawRun.append(stream, bytes)) { outputLimitExceeded = true; terminateProcess(child); return; }
        const remaining = Math.max(0, this.maxParseBytesPerStream - parsedBytes[stream]);
        if (remaining) {
          const retained = bytes.subarray(0, remaining);
          (stream === 'stdout' ? stdout : stderr).push(retained);
          parsedBytes[stream] += retained.length;
        }
        if (bytes.length > remaining) parseOutputLimitExceeded = true;
      }).catch(error => {
        rawWriteError ||= error;
        terminateProcess(child);
      }).finally(() => {
        queuedWrites--;
        if (!queuedWrites && !rawWriteError && !outputLimitExceeded && child.exitCode == null && child.signalCode == null) resumeOutputs();
      });
    };
    child.stdout?.on('data', chunk => retain('stdout', chunk));
    child.stderr?.on('data', chunk => retain('stderr', chunk));
    const timer = setTimeout(() => { timedOut = true; terminateProcess(child); }, timeoutMs);
    timer.unref?.();
    const completion = await new Promise(resolve => {
      let done = false;
      const finish = value => { if (!done) { done = true; resolve(value); } };
      child.once('error', error => { launchError = error; finish({ exitCode: null, signal: null }); });
      child.once('close', (exitCode, signal) => finish({ exitCode, signal }));
    });
    clearTimeout(timer);
    this.activeChildren.delete(child);
    await writeChain;
    const rawMetadata = await rawRun.close();
    const finishedAt = Date.now();
    const stdoutText = Buffer.concat(stdout).toString('utf8');
    const stderrText = Buffer.concat(stderr).toString('utf8');
    const parseComplete = !timedOut && !outputLimitExceeded && !parseOutputLimitExceeded && !launchError && !rawWriteError;
    const parsed = parseComplete
      ? parseCommandOutput({ stdout: stdoutText, stderr: stderrText }, { parser: selected.id, command: [executable, ...args], workspaceRoot: this.workspaceRoot })
      : { parserId: selected.id, diagnostics: [], summary: { errors: 0, warnings: 0, failures: 0, total: 0 } };
    const status = launchError ? 'launch_failed' : rawWriteError ? 'raw_output_failed' : timedOut ? 'timed_out' : outputLimitExceeded ? 'output_limit_exceeded' : completion.exitCode === 0 ? 'passed' : 'failed';
    let finishedWorkspace = null, finishedWorkspaceError = null;
    try {
      finishedWorkspace = await fingerprintWorkspace(this.workspaceRoot);
      this.store.recordWorkspace(this.repositoryId, finishedWorkspace);
    } catch (error) {
      finishedWorkspaceError = { code: error?.code || 'WORKSPACE_FINGERPRINT_FAILED', message: error?.message || String(error) };
    }

    const generationStillCurrent = this.session.generationId === generationId;
    const previous = parseComplete && generationStillCurrent ? this.store.latestComparableCommandRun({
      sessionId: this.session.sessionId, generationId,
      scopeKey, parserId: selected.id, parserVersion: PARSER_VERSION, beforeRunId: runId,
    }) : null;
    const difference = previous ? diffDiagnostics(previous.diagnostics, parsed.diagnostics) : { added: parsed.diagnostics, resolved: [], remaining: [] };
    const previousByFingerprint = new Map((previous?.diagnostics || []).map(item => [item.fingerprint, item]));
    const pendingRemaining = difference.remaining.filter(item => !previousByFingerprint.get(item.fingerprint)?.delivered);
    const visibleNew = difference.added.slice(0, this.maxReturnedDiagnostics);
    const visibleRemaining = pendingRemaining.slice(0, this.maxReturnedDiagnostics);
    const deliverableResolved = difference.resolved.filter(item => previousByFingerprint.get(item.fingerprint)?.delivered);
    const visibleResolved = deliverableResolved.slice(0, this.maxReturnedDiagnostics);
    const deliveredFingerprints = new Set(
      parsed.diagnostics
        .filter(item => previousByFingerprint.get(item.fingerprint)?.delivered)
        .map(item => item.fingerprint),
    );
    for (const item of [...visibleNew, ...visibleRemaining]) deliveredFingerprints.add(item.fingerprint);
    this.store.finishCommandRun({
      runId, status, exitCode: completion.exitCode, signal: completion.signal,
      finishedAt, finishedWorkspaceId: finishedWorkspace?.id || null, parseComplete,
      stdoutBytes: rawMetadata.bytes.stdout, stderrBytes: rawMetadata.bytes.stderr,
      rawTruncated: Object.values(rawMetadata.truncated).some(Boolean), diagnostics: parsed.diagnostics,
      deliveredFingerprints: [...deliveredFingerprints],
    });

    return {
      schemaVersion: 1,
      runId,
      generationId,
      workspace: {
        id: workspace.id,
        finishedId: finishedWorkspace?.id || null,
        changedDuringRun: finishedWorkspace ? workspace.id !== finishedWorkspace.id : null,
        ...(finishedWorkspaceError ? { finalizationError: finishedWorkspaceError } : {}),
      },
      command: { ...(commandId ? { id: commandId } : {}), executable: resolved.displayExecutable, args, parser: selected.id },
      execution: {
        status, exitCode: completion.exitCode, signal: completion.signal,
        durationMs: finishedAt - startedAt,
        ...(launchError ? { error: launchError.message } : rawWriteError ? { error: rawWriteError.message } : {}),
      },
      summary: { ...parsed.summary, ...(parsed.testTotals ? { tests: parsed.testTotals } : {}) },
      comparison: previous ? {
        status: 'compared', previousRunId: previous.runId, previousWorkspaceId: previous.workspaceId,
        newCount: difference.added.length, resolvedCount: difference.resolved.length, remainingCount: difference.remaining.length,
        undeliveredRemainingCount: pendingRemaining.length,
      } : { status: 'unavailable', reason: !parseComplete ? (parseOutputLimitExceeded ? 'parse-output-limit-exceeded' : status) : !generationStillCurrent ? 'context-generation-changed' : 'no-compatible-prior-run' },
      new: visibleNew.map(compactDiagnostic),
      resolved: visibleResolved.map(compactDiagnostic),
      // Only persistent diagnostics that have not yet reached the client are
      // returned. Delivered diagnostics remain represented by the counts.
      remaining: visibleRemaining.map(compactDiagnostic),
      omitted: {
        new: Math.max(0, difference.added.length - visibleNew.length),
        resolved: Math.max(0, deliverableResolved.length - visibleResolved.length),
        remaining: Math.max(0, pendingRemaining.length - visibleRemaining.length),
      },
      raw: {
        retention: 'session', stdoutBytes: rawMetadata.bytes.stdout, stderrBytes: rawMetadata.bytes.stderr,
        truncated: Object.values(rawMetadata.truncated).some(Boolean),
        retrieval: 'get_raw_output',
      },
    };
  }
}

export { PARSER_VERSION };
