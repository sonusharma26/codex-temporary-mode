import { spawn } from 'node:child_process';
import { parseCommandOutput, resolveParser } from '../parsers/index.mjs';
import { resolveCommand } from '../command-delta.mjs';
import { fingerprintDiagnostic } from '../diagnostics.mjs';
import {
  PipelineSnapshotError,
  resolvePipelineSnapshotRoot,
  verifyPipelineSnapshotIntegrity,
  verifyPipelineSnapshotSource,
} from './snapshot.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES_PER_STREAM = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES_PER_STREAM = 64 * 1024 * 1024;
const MAX_COMMANDS = 64;
const TERMINATION_GRACE_MS = 3_000;

export class PipelineRunnerError extends Error {
  constructor(code, message, details = []) {
    super(message);
    this.name = 'PipelineRunnerError';
    this.code = code;
    this.details = details;
  }
}

function validateTimeout(timeoutMs, name = 'timeoutMs') {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new PipelineRunnerError('INVALID_TIMEOUT', `${name} must be an integer between 100 and ${MAX_TIMEOUT_MS}.`);
  }
}

function validateOutputLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_OUTPUT_BYTES_PER_STREAM) {
    throw new PipelineRunnerError('INVALID_OUTPUT_LIMIT', `maxOutputBytesPerStream must be an integer between 1 and ${MAX_OUTPUT_BYTES_PER_STREAM}.`);
  }
}

function assertNoControlCharacters(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new PipelineRunnerError('INVALID_COMMAND', `${name} must be a non-empty single-line string.`);
  }
}

function commandId(value, index) {
  if (value == null) return `command-${index + 1}`;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value)) {
    throw new PipelineRunnerError('INVALID_COMMAND_ID', 'Command ids must contain only letters, digits, dot, underscore, colon, or hyphen.');
  }
  return value;
}

function validateCommands(commands, defaultTimeoutMs) {
  if (!Array.isArray(commands) || !commands.length || commands.length > MAX_COMMANDS) {
    throw new PipelineRunnerError('INVALID_COMMANDS', `commands must contain between 1 and ${MAX_COMMANDS} command objects.`);
  }
  const ids = new Set();
  return commands.map((input, index) => {
    if (input == null || typeof input !== 'object' || Array.isArray(input)) {
      throw new PipelineRunnerError('INVALID_COMMAND', `commands[${index}] must be an object.`);
    }
    if (input.cwd !== undefined || input.shell !== undefined || input.env !== undefined) {
      throw new PipelineRunnerError('UNSUPPORTED_COMMAND_OPTION', 'Pipeline commands always run in the isolated snapshot with a fixed environment and no shell.');
    }
    assertNoControlCharacters(input.executable, `commands[${index}].executable`);
    if (Buffer.byteLength(input.executable) > 4096) throw new PipelineRunnerError('INVALID_COMMAND', 'Command executable exceeds the safety limit.');
    const args = input.args === undefined ? [] : input.args;
    if (!Array.isArray(args) || args.length > 256 || args.some(value => typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 64 * 1024)) {
      throw new PipelineRunnerError('INVALID_ARGUMENTS', `commands[${index}].args must be an array of at most 256 safe strings.`);
    }
    const id = commandId(input.id, index);
    if (ids.has(id)) throw new PipelineRunnerError('DUPLICATE_COMMAND_ID', `Command id is repeated: ${id}`);
    ids.add(id);
    const timeoutMs = input.timeoutMs === undefined ? defaultTimeoutMs : input.timeoutMs;
    validateTimeout(timeoutMs, `commands[${index}].timeoutMs`);
    if (input.parser !== undefined && (typeof input.parser !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.parser))) {
      throw new PipelineRunnerError('INVALID_PARSER', `commands[${index}].parser must be a supported parser identifier.`);
    }
    let selected;
    try {
      selected = resolveParser({ parser: input.parser, command: [input.executable, ...args] });
    } catch (error) {
      throw new PipelineRunnerError('INVALID_PARSER', error?.message || 'Could not select a diagnostics parser.');
    }
    let resolved;
    try {
      resolved = resolveCommand(input.executable, args);
    } catch (error) {
      throw new PipelineRunnerError(error?.code || 'INVALID_COMMAND', error?.message || 'Could not resolve command without a shell.');
    }
    if (input.continueOnFailure !== undefined && typeof input.continueOnFailure !== 'boolean') {
      throw new PipelineRunnerError('INVALID_COMMAND', `commands[${index}].continueOnFailure must be boolean.`);
    }
    return { id, args: [...args], timeoutMs, parser: selected.id, resolved, continueOnFailure: input.continueOnFailure === true };
  });
}

function fingerprintId(value, name) {
  if (value == null) return null;
  const id = typeof value === 'string' ? value : value?.id ?? value?.workspaceId;
  if (typeof id !== 'string' || !id || id.includes('\0') || id.length > 256) {
    throw new PipelineRunnerError('INVALID_WORKSPACE_FINGERPRINT', `${name} must be a workspace identifier or fingerprint object.`);
  }
  return id;
}

function expectedWorkspaceId(options) {
  const direct = fingerprintId(options.expectedWorkspaceId, 'expectedWorkspaceId');
  const fingerprint = fingerprintId(options.workspaceFingerprint, 'workspaceFingerprint');
  if (direct && fingerprint && direct !== fingerprint) {
    throw new PipelineRunnerError('CONFLICTING_WORKSPACE_FINGERPRINT', 'expectedWorkspaceId and workspaceFingerprint identify different workspaces.');
  }
  return direct || fingerprint;
}

function compactDiagnostic(item, snapshotRoot) {
  const redact = value => redactSnapshotPath(value, snapshotRoot);
  const compact = {
    kind: item.kind,
    severity: item.severity,
    tool: item.tool,
    ...(item.file ? { file: redact(item.file) } : {}),
    ...(item.line != null ? { line: item.line } : {}),
    ...(item.column != null ? { column: item.column } : {}),
    ...(item.endLine != null ? { endLine: item.endLine } : {}),
    ...(item.endColumn != null ? { endColumn: item.endColumn } : {}),
    ...(item.code ? { code: item.code } : {}),
    message: redact(item.message),
    ...(item.subject ? { subject: redact(item.subject) } : {}),
  };
  return { ...compact, fingerprint: fingerprintDiagnostic(compact) };
}

function redactSnapshotPath(value, snapshotRoot) {
  return String(value ?? '').replaceAll(snapshotRoot, '<snapshot>').replaceAll(snapshotRoot.replaceAll('\\', '/'), '<snapshot>');
}

function safeError(error, snapshotRoot) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'RUNNER_ERROR',
    message: redactSnapshotPath(error?.message || String(error), snapshotRoot),
  };
}

function emptyRaw() {
  return {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stdoutBytes: 0,
    stderrBytes: 0,
    retainedBytes: { stdout: 0, stderr: 0 },
    truncated: { stdout: false, stderr: false },
    chunks: [],
  };
}

function skippedCommand(spec, reason) {
  return {
    id: spec.id,
    command: { executable: spec.resolved.displayExecutable, parser: spec.parser },
    execution: { status: 'SKIPPED', exitCode: null, signal: null, durationMs: 0, reason },
    summary: { errors: 0, warnings: 0, failures: 0, total: 0 },
    diagnostics: [],
    diagnosticsComplete: false,
    raw: emptyRaw(),
  };
}

function terminateProcess(child) {
  if (!child?.pid || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      const fallback = () => { try { child.kill(); } catch {} };
      killer.on('error', fallback);
      killer.on('close', exitCode => { if (exitCode !== 0) fallback(); });
      killer.unref();
    } catch {
      try { child.kill(); } catch {}
    }
    const hardStop = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) { try { child.kill(); } catch {} }
    }, 1500);
    hardStop.unref?.();
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); }
  catch { try { child.kill('SIGTERM'); } catch {} }
  const hardStop = setTimeout(() => {
    if (child.exitCode != null || child.signalCode != null) return;
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { try { child.kill('SIGKILL'); } catch {} }
  }, 1500);
  hardStop.unref?.();
}

function captureOutput(maxBytesPerStream) {
  const state = {
    stdout: [], stderr: [],
    chunks: [],
    bytes: { stdout: 0, stderr: 0 },
    retained: { stdout: 0, stderr: 0 },
    truncated: { stdout: false, stderr: false },
  };
  return {
    append(stream, chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      state.bytes[stream] = Math.min(Number.MAX_SAFE_INTEGER, state.bytes[stream] + bytes.length);
      const remaining = Math.max(0, maxBytesPerStream - state.retained[stream]);
      const retained = bytes.subarray(0, remaining);
      if (retained.length) {
        const copy = Buffer.from(retained);
        state[stream].push(copy);
        state.chunks.push({ stream, bytes: copy });
        state.retained[stream] += retained.length;
      }
      if (retained.length !== bytes.length) state.truncated[stream] = true;
    },
    finish() {
      return {
        stdout: Buffer.concat(state.stdout),
        stderr: Buffer.concat(state.stderr),
        stdoutBytes: state.bytes.stdout,
        stderrBytes: state.bytes.stderr,
        retainedBytes: { ...state.retained },
        truncated: { ...state.truncated },
        chunks: state.chunks,
      };
    },
  };
}

async function executeCommand(spec, { snapshotRoot, signal, maxOutputBytesPerStream, onOutput }) {
  const startedAt = Date.now();
  if (signal.aborted) return skippedCommand(spec, 'cancelled-before-launch');
  const output = captureOutput(maxOutputBytesPerStream);
  let child;
  let launchError = null;
  let timedOut = false;
  let cancelled = false;
  let outputWriteError = null;
  let completion = { exitCode: null, signal: null };
  try {
    child = spawn(spec.resolved.executable, spec.resolved.args, {
      cwd: snapshotRoot,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
  } catch (error) {
    launchError = error;
  }

  if (child) {
    let pendingWrites = 0;
    let writeChain = Promise.resolve();
    let requestProcessTermination = () => terminateProcess(child);
    const retain = (stream, chunk) => {
      const bytes = Buffer.from(chunk);
      output.append(stream, bytes);
      if (!onOutput) return;
      pendingWrites++;
      child.stdout?.pause();
      child.stderr?.pause();
      writeChain = writeChain.then(() => onOutput({ commandId: spec.id, stream, bytes })).catch(error => {
        outputWriteError ||= error;
        requestProcessTermination();
      }).finally(() => {
        pendingWrites--;
        if (!pendingWrites && !outputWriteError && child.exitCode == null && child.signalCode == null) {
          child.stdout?.resume();
          child.stderr?.resume();
        }
      });
    };
    child.stdout?.on('data', chunk => retain('stdout', chunk));
    child.stderr?.on('data', chunk => retain('stderr', chunk));
    await new Promise(resolve => {
      let settled = false;
      let timer = null;
      let forcedFinish = null;
      const requestTermination = () => {
        terminateProcess(child);
        if (!forcedFinish) {
          forcedFinish = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            finish(null, 'FORCED');
          }, TERMINATION_GRACE_MS);
          forcedFinish.unref?.();
        }
      };
      requestProcessTermination = requestTermination;
      const onAbort = () => {
        cancelled = true;
        requestTermination();
      };
      const finish = (exitCode, processSignal) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (forcedFinish) clearTimeout(forcedFinish);
        signal.removeEventListener('abort', onAbort);
        completion = { exitCode, signal: processSignal };
        resolve();
      };
      child.once('error', error => { launchError ||= error; finish(null, null); });
      child.once('close', finish);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        timedOut = true;
        requestTermination();
      }, spec.timeoutMs);
      timer.unref?.();
    });
    await writeChain;
  }

  const raw = output.finish();
  const durationMs = Date.now() - startedAt;
  const status = outputWriteError ? 'OUTPUT_FAILED'
    : launchError ? 'LAUNCH_FAILED'
    : cancelled ? 'CANCELLED'
      : timedOut ? 'TIMED_OUT'
        : completion.exitCode === 0 && !completion.signal ? 'PASSED'
          : 'FAILED';
  let parsed = { parserId: spec.parser, diagnostics: [], summary: { errors: 0, warnings: 0, failures: 0, total: 0 } };
  let parseError = null;
  try {
    parsed = parseCommandOutput({ stdout: raw.stdout.toString('utf8'), stderr: raw.stderr.toString('utf8') }, {
      parser: spec.parser,
      command: [spec.resolved.displayExecutable, ...spec.args],
      workspaceRoot: snapshotRoot,
    });
  } catch (error) {
    parseError = error;
  }
  const diagnosticsComplete = !outputWriteError && !launchError && !cancelled && !timedOut && !raw.truncated.stdout && !raw.truncated.stderr && !parseError;
  return {
    id: spec.id,
    command: { executable: spec.resolved.displayExecutable, parser: spec.parser },
    execution: {
      status,
      exitCode: completion.exitCode,
      signal: completion.signal,
      durationMs,
      ...(launchError ? { error: safeError(launchError, snapshotRoot) } : {}),
      ...(outputWriteError ? { error: safeError(outputWriteError, snapshotRoot) } : {}),
    },
    summary: { ...parsed.summary, ...(parsed.testTotals ? { tests: parsed.testTotals } : {}) },
    diagnostics: parsed.diagnostics.map(item => compactDiagnostic(item, snapshotRoot)),
    diagnosticsComplete,
    ...(parseError ? { parseError: safeError(parseError, snapshotRoot) } : {}),
    raw,
  };
}

function assertRunOptions(options) {
  if (options == null || typeof options !== 'object' || Array.isArray(options)) {
    throw new PipelineRunnerError('INVALID_OPTIONS', 'Runner options must be an object.');
  }
  if (options.stopOnFailure !== undefined && typeof options.stopOnFailure !== 'boolean') {
    throw new PipelineRunnerError('INVALID_STOP_ON_FAILURE', 'stopOnFailure must be a boolean when supplied.');
  }
  if (options.signal !== undefined && (!options.signal || typeof options.signal.aborted !== 'boolean' || typeof options.signal.addEventListener !== 'function')) {
    throw new PipelineRunnerError('INVALID_ABORT_SIGNAL', 'signal must be an AbortSignal when supplied.');
  }
  if (options.onOutput !== undefined && typeof options.onOutput !== 'function') {
    throw new PipelineRunnerError('INVALID_OUTPUT_SINK', 'onOutput must be a function when supplied.');
  }
}

function preflightFailure(error) {
  if (error instanceof PipelineSnapshotError) {
    throw new PipelineRunnerError(error.code, error.message, error.details);
  }
  throw error;
}

/** Runs deterministic validation commands only inside a materialized snapshot. */
export class PipelineRunner {
  constructor({ defaultTimeoutMs = DEFAULT_TIMEOUT_MS, maxOutputBytesPerStream = DEFAULT_MAX_OUTPUT_BYTES_PER_STREAM } = {}) {
    validateTimeout(defaultTimeoutMs, 'defaultTimeoutMs');
    validateOutputLimit(maxOutputBytesPerStream);
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.maxOutputBytesPerStream = maxOutputBytesPerStream;
    this.active = new Set();
    this.closing = false;
  }

  run(options = {}) {
    if (this.closing) throw new PipelineRunnerError('RUNNER_CLOSING', 'The pipeline runner is shutting down.');
    const controller = new AbortController();
    const operation = this.#run(options, controller);
    const state = { controller, operation };
    this.active.add(state);
    operation.then(() => this.active.delete(state), () => this.active.delete(state));
    return operation;
  }

  cancel(reason = 'cancelled-by-runner') {
    let cancelled = 0;
    for (const state of this.active) {
      if (!state.controller.signal.aborted) {
        state.controller.abort(reason);
        cancelled++;
      }
    }
    return cancelled;
  }

  async close() {
    this.closing = true;
    this.cancel('runner-closing');
    await Promise.allSettled([...this.active].map(state => state.operation));
  }

  async #run(options, controller) {
    assertRunOptions(options);
    const commands = validateCommands(options.commands, this.defaultTimeoutMs);
    const removeExternalSignal = this.#linkExternalSignal(options.signal, controller);
    try {
      const expectedId = expectedWorkspaceId(options);
      let snapshotRoot;
      let snapshotAtStart;
      let sourceAtStart;
      try {
        snapshotRoot = await resolvePipelineSnapshotRoot(options.snapshot);
        if (expectedId && options.snapshot.workspaceId !== expectedId) {
          throw new PipelineRunnerError('CHECKPOINT_MISMATCH', `Snapshot is ${options.snapshot.workspaceId}, not requested checkpoint ${expectedId}.`);
        }
        if (controller.signal.aborted) return this.#cancelledBeforeStart(options.snapshot.workspaceId, commands);
        snapshotAtStart = await verifyPipelineSnapshotIntegrity(options.snapshot);
        if (!snapshotAtStart.matches) throw new PipelineRunnerError('SNAPSHOT_TAINTED', 'The isolated snapshot changed before validation began.');
        // A queued validation is intentionally allowed to finish against its
        // immutable historical checkpoint even if development has advanced.
        // The postflight acceptance flag tells the scheduler whether the
        // result can still satisfy the current-workspace gate.
        sourceAtStart = await verifyPipelineSnapshotSource(options.snapshot);
      } catch (error) {
        preflightFailure(error);
      }

      const results = [];
      for (let index = 0; index < commands.length; index++) {
        const command = commands[index];
        if (controller.signal.aborted) {
          results.push(...commands.slice(index).map(spec => skippedCommand(spec, 'cancelled-before-launch')));
          break;
        }
        const result = await executeCommand(command, {
          snapshotRoot,
          signal: controller.signal,
          maxOutputBytesPerStream: this.maxOutputBytesPerStream,
          onOutput: options.onOutput,
        });
        results.push(result);
        if (result.execution.status === 'CANCELLED') {
          results.push(...commands.slice(index + 1).map(spec => skippedCommand(spec, 'cancelled-before-launch')));
          break;
        }
        if (result.execution.status !== 'PASSED' && (options.stopOnFailure || !command.continueOnFailure)) {
          results.push(...commands.slice(index + 1).map(spec => skippedCommand(spec, 'prior-command-failed')));
          break;
        }
      }

      const postflight = await this.#postflight(options.snapshot, snapshotRoot, { snapshotAtStart, sourceAtStart });
      const allPassed = results.length === commands.length && results.every(result => result.execution.status === 'PASSED');
      const cancelled = results.some(result => result.execution.status === 'CANCELLED' || result.execution.reason === 'cancelled-before-launch');
      return {
        schemaVersion: 1,
        workspace: {
          id: options.snapshot.workspaceId,
          sourceAtStart: postflight.sourceAtStart,
          sourceAtFinish: postflight.sourceAtFinish,
          snapshotAtStart: postflight.snapshotAtStart,
          snapshotAtFinish: postflight.snapshotAtFinish,
        },
        commands: results,
        aggregate: {
          status: allPassed ? 'PASSED' : 'FAILED',
          cancelled,
          accepted: allPassed && postflight.snapshotAtFinish?.matches === true && postflight.sourceAtFinish?.matches === true,
          ...(postflight.snapshotAtFinish?.matches === false ? { rejection: 'SNAPSHOT_TAINTED' } : postflight.sourceAtFinish?.matches === false ? { rejection: 'STALE_WORKSPACE' } : postflight.error ? { rejection: 'POSTFLIGHT_UNKNOWN' } : {}),
        },
      };
    } finally {
      removeExternalSignal();
    }
  }

  #linkExternalSignal(signal, controller) {
    if (!signal) return () => {};
    const abort = () => controller.abort(signal.reason || 'cancelled-by-caller');
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    return () => signal.removeEventListener('abort', abort);
  }

  #cancelledBeforeStart(workspaceId, commands) {
    return {
      schemaVersion: 1,
      workspace: { id: workspaceId, sourceAtStart: null, sourceAtFinish: null, snapshotAtStart: null, snapshotAtFinish: null },
      commands: commands.map(spec => skippedCommand(spec, 'cancelled-before-preflight')),
      aggregate: { status: 'FAILED', cancelled: true, accepted: false, rejection: 'CANCELLED' },
    };
  }

  async #postflight(snapshot, snapshotRoot, { snapshotAtStart, sourceAtStart }) {
    let snapshotAtFinish = null;
    let sourceAtFinish = null;
    let error = null;
    try { snapshotAtFinish = await verifyPipelineSnapshotIntegrity(snapshot); }
    catch (caught) { error ||= safeError(caught, snapshotRoot); }
    try { sourceAtFinish = await verifyPipelineSnapshotSource(snapshot); }
    catch (caught) { error ||= safeError(caught, snapshotRoot); }
    return {
      snapshotAtStart,
      sourceAtStart,
      snapshotAtFinish,
      sourceAtFinish,
      ...(error ? { error } : {}),
    };
  }
}

/** Convenience entry point for callers that do not need a reusable runner. */
export async function runPipelineValidation(options = {}, runnerOptions = {}) {
  const runner = new PipelineRunner(runnerOptions);
  try { return await runner.run(options); }
  finally { await runner.close(); }
}
