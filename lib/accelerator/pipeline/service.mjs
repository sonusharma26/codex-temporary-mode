import { randomUUID } from 'node:crypto';
import { diffDiagnostics } from '../diagnostics.mjs';
import { fingerprintWorkspace } from '../workspace.mjs';
import { hashParts, sha256 } from '../hashing.mjs';
import { listChangedFiles } from './changed-files.mjs';
import { loadPipelineConfig, resolveValidationProfile } from './config.mjs';
import { PipelineRunner } from './runner.mjs';
import { cleanupWorkspaceSnapshot, createWorkspaceSnapshot } from './snapshot.mjs';

const TERMINAL = new Set(['PASSED', 'FAILED', 'SUPERSEDED', 'CANCELLED']);
const VALIDATION_RESULTS = new Set(['PASSED', 'FAILED']);
const MAX_VISIBLE_DIAGNOSTICS = 20;
const MAX_VISIBLE_CHANGED_FILES = 20;

export class PipelineServiceError extends Error {
  constructor(code, message, details = undefined) { super(message); this.name = 'PipelineServiceError'; this.code = code; this.details = details; }
}

function safeError(error) {
  return { code: error?.code || 'PIPELINE_ERROR', message: error?.message || String(error) };
}

function checkpointSummary(checkpoint) {
  if (!checkpoint) return null;
  return {
    checkpointId: checkpoint.checkpointId,
    workspaceId: checkpoint.workspaceId,
    changedFileCount: checkpoint.changedFiles.length,
    changedFiles: checkpoint.changedFiles.slice(0, MAX_VISIBLE_CHANGED_FILES),
    omittedChangedFiles: Math.max(0, checkpoint.changedFiles.length - MAX_VISIBLE_CHANGED_FILES),
    reason: checkpoint.reason,
    validationProfile: checkpoint.validationProfile,
    validationPlanDigest: checkpoint.validationPlanDigest,
    status: checkpoint.status,
    createdAt: checkpoint.createdAt,
    startedAt: checkpoint.startedAt,
    finishedAt: checkpoint.finishedAt,
    supersededBy: checkpoint.supersededBy,
    ...(checkpoint.compactResult ? { result: publicResult(checkpoint.compactResult) } : {}),
  };
}

function publicResult(result) {
  if (!result || typeof result !== 'object') return result;
  const { diagnosticState: _diagnosticState, ...visible } = result;
  return visible;
}

function normalizeDiagnostic(commandId, diagnostic) {
  return {
    ...diagnostic,
    commandId,
    fingerprint: hashParts(['pipeline-diagnostic-v1', commandId, diagnostic.fingerprint]),
  };
}

function summarizeCommands(commands) {
  const summary = { errors: 0, warnings: 0, failures: 0, total: 0 };
  for (const command of commands) {
    for (const key of Object.keys(summary)) summary[key] += Number(command.summary?.[key] || 0);
  }
  return summary;
}

/** Single-worker validation scheduler for immutable workspace snapshots. */
export class PipelineService {
  constructor({ workspaceRoot, repositoryId, sessionManager, store, rawOutputStore, snapshotRoot, configPath, runner = new PipelineRunner(), snapshotFactory = createWorkspaceSnapshot, configLoader = loadPipelineConfig }) {
    this.workspaceRoot = workspaceRoot;
    this.repositoryId = repositoryId;
    this.session = sessionManager;
    this.store = store;
    this.raw = rawOutputStore;
    this.snapshotRoot = snapshotRoot;
    this.configPath = configPath;
    this.runner = runner;
    this.snapshotFactory = snapshotFactory;
    this.configLoader = configLoader;
    this.snapshots = new Map();
    this.active = null;
    this.pumpPromise = null;
    this.waiters = new Map();
    this.preparation = Promise.resolve();
    this.closing = false;
  }

  async #profile(validationProfile) {
    const config = await this.configLoader(this.workspaceRoot, this.configPath);
    const commands = resolveValidationProfile(config, validationProfile);
    return { commands, validationPlanDigest: sha256(JSON.stringify(commands)), configPath: config.configPath };
  }

  async createCheckpoint({ validationProfile = 'targeted', expectedWorkspaceId, reason = 'manual' } = {}) {
    let release;
    const previous = this.preparation;
    this.preparation = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await this.#createCheckpoint({ validationProfile, expectedWorkspaceId, reason }); }
    finally { release(); }
  }

  async #createCheckpoint({ validationProfile, expectedWorkspaceId, reason }) {
    if (this.closing) throw new PipelineServiceError('PIPELINE_CLOSING', 'Pipeline Mode is shutting down.');
    const plan = await this.#profile(validationProfile);
    const workspace = await fingerprintWorkspace(this.workspaceRoot);
    if (this.closing) throw new PipelineServiceError('PIPELINE_CLOSING', 'Pipeline Mode shut down while the checkpoint was being prepared.');
    if (expectedWorkspaceId && expectedWorkspaceId !== workspace.id) throw new PipelineServiceError('STALE_WORKSPACE', `Expected workspace ${expectedWorkspaceId}, current workspace is ${workspace.id}.`);
    this.store.recordWorkspace(this.repositoryId, workspace);
    const equivalent = this.store.findNonterminalEquivalentCheckpoint({
      sessionId: this.session.sessionId,
      workspaceId: workspace.id,
      validationProfile,
      validationPlanDigest: plan.validationPlanDigest,
    });
    if (equivalent) return { ...checkpointSummary(equivalent), deduplicated: true, supersededCheckpointIds: [] };

    const snapshot = await this.snapshotFactory({
      workspaceRoot: this.workspaceRoot,
      workspaceFingerprint: workspace,
      tempRoot: this.snapshotRoot,
    });
    if (this.closing) {
      await cleanupWorkspaceSnapshot(snapshot).catch(() => {});
      throw new PipelineServiceError('PIPELINE_CLOSING', 'Pipeline Mode shut down while the checkpoint snapshot was being prepared.');
    }
    let changedFiles;
    try {
      changedFiles = listChangedFiles(this.workspaceRoot);
      const current = await fingerprintWorkspace(this.workspaceRoot);
      if (current.id !== workspace.id) throw new PipelineServiceError('WORKSPACE_CHANGED', 'Workspace changed while the checkpoint was being prepared.');
      if (this.closing) throw new PipelineServiceError('PIPELINE_CLOSING', 'Pipeline Mode shut down while the checkpoint was being prepared.');
    } catch (error) {
      await cleanupWorkspaceSnapshot(snapshot).catch(() => {});
      throw error;
    }

    const checkpointId = `cp_${randomUUID().replaceAll('-', '')}`;
    let created;
    try {
      created = this.store.createCheckpointAndSupersedeQueued({
        checkpointId,
        sessionId: this.session.sessionId,
        workspaceId: workspace.id,
        changedFiles,
        reason,
        validationProfile,
        validationPlanDigest: plan.validationPlanDigest,
        commands: plan.commands,
      });
    } catch (error) {
      await cleanupWorkspaceSnapshot(snapshot).catch(() => {});
      throw error;
    }
    this.snapshots.set(checkpointId, snapshot);
    for (const supersededId of created.supersededCheckpointIds) {
      await this.#removeSnapshot(supersededId);
      const superseded = this.store.getCheckpoint(supersededId);
      if (superseded) this.#settle(superseded);
    }
    this.#kick();
    const queued = this.store.listCheckpoints({ sessionId: this.session.sessionId, status: 'QUEUED', limit: 100 }).reverse();
    return {
      ...checkpointSummary(created.checkpoint),
      deduplicated: false,
      queuePosition: queued.findIndex(item => item.checkpointId === checkpointId) + 1,
      supersededCheckpointIds: created.supersededCheckpointIds,
    };
  }

  async getStatus({ checkpointId } = {}) {
    const checkpoints = this.store.listCheckpoints({ sessionId: this.session.sessionId, limit: 50 });
    let currentWorkspaceId = null, workspaceError = null;
    try { currentWorkspaceId = (await fingerprintWorkspace(this.workspaceRoot)).id; }
    catch (error) { workspaceError = safeError(error); }
    const requested = checkpointId ? this.store.getCheckpoint(checkpointId) : null;
    if (checkpointId && (!requested || requested.sessionId !== this.session.sessionId)) throw new PipelineServiceError('CHECKPOINT_NOT_FOUND', `Checkpoint was not found in this session: ${checkpointId}`);
    return {
      schemaVersion: 1,
      currentWorkspaceId,
      ...(workspaceError ? { workspaceError } : {}),
      active: checkpointSummary(checkpoints.find(item => item.status === 'RUNNING')),
      queue: checkpoints.filter(item => item.status === 'QUEUED').reverse().slice(0, 10).map(checkpointSummary),
      latest: checkpointSummary(checkpoints[0]),
      ...(requested ? { requested: checkpointSummary(requested) } : {}),
    };
  }

  async getLatestValidation({ validationProfile, workspaceId } = {}) {
    let currentWorkspaceId = null, workspaceError = null;
    try { currentWorkspaceId = (await fingerprintWorkspace(this.workspaceRoot)).id; }
    catch (error) { workspaceError = safeError(error); }
    const targetWorkspaceId = workspaceId || currentWorkspaceId;
    const latest = targetWorkspaceId ? this.store.listCheckpoints({ sessionId: this.session.sessionId, limit: 1000 })
      .find(item => VALIDATION_RESULTS.has(item.status) && item.compactResult && (!validationProfile || item.validationProfile === validationProfile) && item.workspaceId === targetWorkspaceId) : null;
    let currentPlanDigest = null, configError = null;
    if (latest) {
      try { currentPlanDigest = (await this.#profile(latest.validationProfile)).validationPlanDigest; }
      catch (error) { configError = safeError(error); }
    }
    const workspaceCurrent = Boolean(latest && currentWorkspaceId && latest.workspaceId === currentWorkspaceId);
    const planCurrent = Boolean(latest && currentPlanDigest && latest.validationPlanDigest === currentPlanDigest);
    return {
      schemaVersion: 1,
      currentWorkspaceId,
      ...(workspaceError ? { workspaceError } : {}),
      ...(configError ? { configError } : {}),
      freshness: !latest || !currentWorkspaceId || configError ? 'UNKNOWN' : workspaceCurrent && planCurrent ? 'CURRENT' : 'STALE',
      planCurrent,
      gateEligible: Boolean(latest?.status === 'PASSED' && latest?.compactResult?.executionAccepted && workspaceCurrent && planCurrent),
      validation: checkpointSummary(latest),
    };
  }

  async cancelCheckpoint({ checkpointId }) {
    const checkpoint = this.store.getCheckpoint(checkpointId);
    if (!checkpoint || checkpoint.sessionId !== this.session.sessionId) throw new PipelineServiceError('CHECKPOINT_NOT_FOUND', `Checkpoint was not found in this session: ${checkpointId}`);
    if (checkpoint.status === 'QUEUED') {
      const cancelled = this.store.cancelQueuedCheckpoint({ checkpointId, compactResult: { schemaVersion: 1, checkpointId, status: 'CANCELLED', reason: 'cancelled-before-start' } });
      await this.#removeSnapshot(checkpointId);
      this.#settle(cancelled);
      return { ...checkpointSummary(cancelled), cancellation: 'CANCELLED' };
    }
    if (checkpoint.status === 'RUNNING' && this.active?.checkpointId === checkpointId) {
      this.active.controller.abort('cancelled-by-user');
      const completed = await this.#waitForCheckpoint(checkpointId);
      return { ...checkpointSummary(completed), cancellation: 'CANCELLED' };
    }
    return { ...checkpointSummary(checkpoint), cancellation: TERMINAL.has(checkpoint.status) ? 'ALREADY_TERMINAL' : 'NOT_ACTIVE' };
  }

  async runFinalValidation({ expectedWorkspaceId } = {}) {
    const created = await this.createCheckpoint({ validationProfile: 'final', expectedWorkspaceId, reason: 'final-validation' });
    const completed = TERMINAL.has(created.status) ? this.store.getCheckpoint(created.checkpointId) : await this.#waitForCheckpoint(created.checkpointId);
    let currentWorkspace = null, workspaceError = null;
    try { currentWorkspace = await fingerprintWorkspace(this.workspaceRoot); }
    catch (error) { workspaceError = safeError(error); }
    let currentPlanDigest = null, configError = null;
    try { currentPlanDigest = (await this.#profile('final')).validationPlanDigest; }
    catch (error) { configError = safeError(error); }
    const result = completed.compactResult;
    const current = currentWorkspace?.id === completed.workspaceId;
    const planCurrent = currentPlanDigest === completed.validationPlanDigest;
    const accepted = completed.status === 'PASSED' && result?.executionAccepted === true && current && planCurrent;
    return {
      schemaVersion: 1,
      gate: accepted ? 'PASS' : 'BLOCKED',
      freshness: !currentWorkspace ? 'UNKNOWN' : current ? 'CURRENT' : 'STALE',
      planCurrent,
      currentWorkspaceId: currentWorkspace?.id || null,
      ...(workspaceError ? { workspaceError } : {}),
      ...(configError ? { configError } : {}),
      validation: checkpointSummary(completed),
    };
  }

  #kick() {
    if (this.pumpPromise || this.closing) return;
    this.pumpPromise = Promise.resolve().then(() => this.#pump()).finally(() => {
      this.pumpPromise = null;
      if (!this.closing && this.store.listCheckpoints({ sessionId: this.session.sessionId, status: 'QUEUED', limit: 1 }).length) this.#kick();
    });
  }

  async #pump() {
    while (!this.closing) {
      const claimed = this.store.claimOldestQueuedCheckpoint({ sessionId: this.session.sessionId, checkpointRunId: `cpr_${randomUUID().replaceAll('-', '')}` });
      if (!claimed) return;
      const checkpoint = claimed.checkpoint;
      const snapshot = this.snapshots.get(checkpoint.checkpointId);
      const controller = new AbortController();
      this.active = { checkpointId: checkpoint.checkpointId, controller };
      let status = 'FAILED', compactResult;
      let rawOutputs = null;
      try {
        if (!snapshot) throw new PipelineServiceError('SNAPSHOT_NOT_FOUND', 'Checkpoint snapshot is no longer available.');
        rawOutputs = await this.#openRawOutputs(checkpoint.commands);
        const run = await this.runner.run({
          snapshot,
          commands: checkpoint.commands,
          expectedWorkspaceId: checkpoint.workspaceId,
          signal: controller.signal,
          stopOnFailure: false,
          onOutput: ({ commandId, stream, bytes }) => this.#appendRawOutput(rawOutputs, commandId, stream, bytes),
        });
        await this.#closeRawOutputs(rawOutputs);
        status = run.aggregate.cancelled ? 'CANCELLED' : run.aggregate.status;
        compactResult = await this.#compactRun(checkpoint, run, rawOutputs);
      } catch (error) {
        status = controller.signal.aborted ? 'CANCELLED' : 'FAILED';
        compactResult = { schemaVersion: 1, checkpointId: checkpoint.checkpointId, workspaceId: checkpoint.workspaceId, status, executionAccepted: false, error: safeError(error) };
      } finally {
        if (rawOutputs) await this.#closeRawOutputs(rawOutputs).catch(error => {
          compactResult = { ...compactResult, rawOutputError: safeError(error), executionAccepted: false };
          status = 'FAILED';
        });
        const cleanupError = await this.#removeSnapshot(checkpoint.checkpointId);
        if (cleanupError) compactResult = { ...compactResult, snapshotCleanupError: cleanupError };
      }
      const finished = this.store.finishCheckpoint({ checkpointId: checkpoint.checkpointId, checkpointRunId: claimed.run.checkpointRunId, status, compactResult });
      this.active = null;
      this.#settle(finished.checkpoint);
    }
  }

  async #openRawOutputs(commands) {
    const outputs = new Map();
    try {
      for (const command of commands) {
        const runId = `pipe_${randomUUID().replaceAll('-', '')}`;
        outputs.set(command.id, {
          runId,
          writer: await this.raw.createRun(runId, this.session.sessionId),
          metadata: null,
        });
      }
      return outputs;
    } catch (error) {
      await Promise.allSettled([...outputs.values()].map(async output => {
        await output.writer.close();
        await this.raw.removeRun(output.runId);
      }));
      throw error;
    }
  }

  async #appendRawOutput(outputs, commandId, stream, bytes) {
    const output = outputs.get(commandId);
    if (!output) throw new PipelineServiceError('RAW_OUTPUT_NOT_FOUND', `Raw-output writer is missing for command: ${commandId}`);
    if (!await output.writer.append(stream, bytes)) {
      throw new PipelineServiceError('RAW_OUTPUT_LIMIT', `Raw-output retention limit was exceeded by command: ${commandId}`);
    }
  }

  async #closeRawOutputs(outputs) {
    for (const output of outputs.values()) output.metadata ||= await output.writer.close();
  }

  async #compactRun(checkpoint, run, rawOutputs) {
    const commandResults = [];
    const diagnostics = [];
    let diagnosticsComplete = true;
    for (const command of run.commands) {
      const rawOutput = rawOutputs.get(command.id);
      if (!rawOutput?.metadata) throw new PipelineServiceError('RAW_OUTPUT_NOT_CLOSED', `Raw output was not finalized for command: ${command.id}`);
      const rawTruncated = Object.values(rawOutput.metadata.truncated).some(Boolean);
      diagnosticsComplete &&= command.diagnosticsComplete && !rawTruncated;
      diagnostics.push(...command.diagnostics.map(item => normalizeDiagnostic(command.id, item)));
      commandResults.push({
        id: command.id,
        runId: rawOutput.runId,
        command: command.command,
        execution: command.execution,
        summary: command.summary,
        diagnosticsComplete: command.diagnosticsComplete,
        raw: {
          stdoutBytes: command.raw.stdoutBytes,
          stderrBytes: command.raw.stderrBytes,
          retainedBytes: rawOutput.metadata.bytes,
          truncated: rawTruncated,
          parseTruncated: command.raw.truncated.stdout || command.raw.truncated.stderr,
          retrieval: 'get_raw_output',
        },
      });
    }
    const previous = diagnosticsComplete ? this.store.listCheckpoints({ sessionId: this.session.sessionId, limit: 1000 }).find(item =>
      item.checkpointId !== checkpoint.checkpointId && item.validationProfile === checkpoint.validationProfile
      && item.validationPlanDigest === checkpoint.validationPlanDigest && item.compactResult?.diagnosticsComplete,
    ) : null;
    const priorDiagnostics = previous?.compactResult?.diagnosticState || [];
    const difference = previous ? diffDiagnostics(priorDiagnostics, diagnostics) : { added: diagnostics, resolved: [], remaining: [] };
    return {
      schemaVersion: 1,
      checkpointId: checkpoint.checkpointId,
      workspaceId: checkpoint.workspaceId,
      validationProfile: checkpoint.validationProfile,
      validationPlanDigest: checkpoint.validationPlanDigest,
      status: run.aggregate.cancelled ? 'CANCELLED' : run.aggregate.status,
      executionAccepted: run.aggregate.accepted,
      rejection: run.aggregate.rejection || null,
      workspace: run.workspace,
      execution: {
        commands: commandResults.length,
        passed: commandResults.filter(item => item.execution.status === 'PASSED').length,
        failed: commandResults.filter(item => item.execution.status !== 'PASSED').length,
        durationMs: commandResults.reduce((total, item) => total + item.execution.durationMs, 0),
      },
      summary: summarizeCommands(run.commands),
      comparison: !diagnosticsComplete ? { status: 'UNAVAILABLE', reason: 'CURRENT_DIAGNOSTICS_INCOMPLETE' } : previous ? {
        status: 'COMPARED', previousCheckpointId: previous.checkpointId,
        newCount: difference.added.length, resolvedCount: difference.resolved.length, remainingCount: difference.remaining.length,
      } : { status: 'UNAVAILABLE', reason: 'NO_COMPATIBLE_PRIOR_VALIDATION' },
      diagnostics: {
        new: difference.added.slice(0, MAX_VISIBLE_DIAGNOSTICS),
        resolved: difference.resolved.slice(0, MAX_VISIBLE_DIAGNOSTICS),
        remaining: difference.remaining.slice(0, MAX_VISIBLE_DIAGNOSTICS),
        omitted: {
          new: Math.max(0, difference.added.length - MAX_VISIBLE_DIAGNOSTICS),
          resolved: Math.max(0, difference.resolved.length - MAX_VISIBLE_DIAGNOSTICS),
          remaining: Math.max(0, difference.remaining.length - MAX_VISIBLE_DIAGNOSTICS),
        },
      },
      commands: commandResults,
      diagnosticsComplete,
      diagnosticState: diagnostics,
    };
  }

  #waitForCheckpoint(checkpointId) {
    const existing = this.store.getCheckpoint(checkpointId);
    if (existing && TERMINAL.has(existing.status)) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const items = this.waiters.get(checkpointId) || [];
      items.push({ resolve, reject }); this.waiters.set(checkpointId, items);
    });
  }

  #settle(checkpoint) {
    const items = this.waiters.get(checkpoint.checkpointId) || [];
    this.waiters.delete(checkpoint.checkpointId);
    for (const item of items) item.resolve(checkpoint);
  }

  async #removeSnapshot(checkpointId) {
    const snapshot = this.snapshots.get(checkpointId);
    if (!snapshot) return null;
    try {
      await cleanupWorkspaceSnapshot(snapshot);
      this.snapshots.delete(checkpointId);
      return null;
    } catch (error) {
      return safeError(error);
    }
  }

  async close() {
    if (this.closing) { if (this.pumpPromise) await this.pumpPromise; return; }
    this.closing = true;
    await this.preparation;
    while (true) {
      const queued = this.store.listCheckpoints({ sessionId: this.session.sessionId, status: 'QUEUED', limit: 1000 });
      if (!queued.length) break;
      for (const checkpoint of queued) {
        const cancelled = this.store.cancelQueuedCheckpoint({ checkpointId: checkpoint.checkpointId, compactResult: { schemaVersion: 1, checkpointId: checkpoint.checkpointId, status: 'CANCELLED', reason: 'pipeline-shutdown' } });
        await this.#removeSnapshot(checkpoint.checkpointId);
        this.#settle(cancelled);
      }
    }
    if (this.active) this.active.controller.abort('pipeline-shutdown');
    if (this.pumpPromise) await this.pumpPromise;
    await this.runner.close();
    for (const checkpointId of [...this.snapshots.keys()]) await this.#removeSnapshot(checkpointId);
    for (const [checkpointId, items] of this.waiters) {
      const error = new PipelineServiceError('PIPELINE_CLOSED', `Pipeline closed before checkpoint completed: ${checkpointId}`);
      for (const item of items) item.reject(error);
    }
    this.waiters.clear();
  }
}
