import { makeTextDelta } from './diff.mjs';
import { PathSafetyError, canonicalRelativePath, readStableRegularFile } from './paths.mjs';
import { fingerprintWorkspace, isIgnoredByGit, WorkspaceSnapshotError } from './workspace.mjs';

export class DeltaError extends Error {
  constructor(code, message, details = undefined) { super(message); this.code = code; this.details = details; }
}

function toDeltaError(error) {
  if (error instanceof DeltaError) return error;
  if (error instanceof PathSafetyError || error instanceof WorkspaceSnapshotError) return new DeltaError(error.code, error.message, error.details);
  return error;
}

function deliveryAccounting(fullSourceBytes, deliveredTextBytes) {
  return {
    fullSourceBytes,
    deliveredTextBytes,
    savedTextBytes: fullSourceBytes - deliveredTextBytes,
  };
}

/** Version-aware UTF-8 file delivery for the active context generation. */
export class FileDeltaService {
  constructor({ store, sessionManager, workspaceRoot, maxFileBytes = 2 * 1024 * 1024, includeIgnoredPaths = [] }) {
    this.store = store; this.sessionManager = sessionManager; this.workspaceRoot = workspaceRoot;
    this.maxFileBytes = maxFileBytes; this.includeIgnoredPaths = new Set(includeIgnoredPaths.map(canonicalRelativePath));
  }

  resetContextGeneration(reason = 'explicit') { return this.sessionManager.resetContextGeneration(reason); }

  async readFileDelta({ path, mode = 'auto', expectedWorkspaceId = undefined } = {}) {
    if (!['auto', 'full', 'delta'].includes(mode)) throw new DeltaError('INVALID_MODE', 'mode must be auto, full, or delta.');
    const filePath = canonicalRelativePath(path);
    const generationId = this.sessionManager.generationId;
    try {
      if (isIgnoredByGit(this.workspaceRoot, filePath) && !this.includeIgnoredPaths.has(filePath)) throw new DeltaError('IGNORED_PATH', 'Ignored files require an explicit includeIgnoredPaths allowlist entry.');
      // The pre/post fingerprint comparison prevents returning file text paired
      // with a workspace identity from before or after a concurrent edit.
      let workspace, source;
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await fingerprintWorkspace(this.workspaceRoot, { includeIgnoredPaths: [...this.includeIgnoredPaths] });
        source = await readStableRegularFile(this.workspaceRoot, filePath, { maxBytes: this.maxFileBytes });
        const after = await fingerprintWorkspace(this.workspaceRoot, { includeIgnoredPaths: [...this.includeIgnoredPaths] });
        if (before.id === after.id) { workspace = after; break; }
      }
      if (!workspace) throw new DeltaError('WORKSPACE_BUSY', 'Workspace changed while the file was being read.');
      if (generationId !== this.sessionManager.generationId) throw new DeltaError('CONTEXT_GENERATION_CHANGED', 'Context generation changed while the file was being read; retry to rehydrate it safely.');
      if (expectedWorkspaceId && expectedWorkspaceId !== workspace.id) throw new DeltaError('STALE_WORKSPACE', `Expected workspace ${expectedWorkspaceId}, current workspace is ${workspace.id}.`, { expectedWorkspaceId, currentWorkspaceId: workspace.id });
      this.store.recordWorkspace(this.sessionManager.repositoryId, workspace);
      const previous = this.store.latestDelivery(this.sessionManager.sessionId, generationId, source.path);
      const common = { workspace: { id: workspace.id, complete: workspace.complete }, generationId, path: source.path, contentHash: source.contentHash, encoding: 'utf-8', byteLength: source.byteLength, lineEndings: source.lineEndings };
      if (mode !== 'full' && previous?.contentHash === source.contentHash) {
        return {
          kind: 'unchanged',
          ...common,
          delivery: deliveryAccounting(source.byteLength, 0),
          sinceWorkspaceId: previous.workspaceId,
          deliveredAt: previous.deliveredAt,
        };
      }
      const full = reason => {
        this.store.recordDelivery({ sessionId: this.sessionManager.sessionId, generationId, path: source.path, workspaceId: workspace.id, contentHash: source.contentHash, bytes: source.bytes, deliveryKind: 'full' });
        return {
          kind: 'full',
          ...common,
          delivery: deliveryAccounting(source.byteLength, source.byteLength),
          reason,
          content: source.text,
        };
      };
      if (mode === 'full') return full('forced-full');
      if (!previous) return full('first-in-generation');
      const oldText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(previous.bytes);
      const delta = makeTextDelta(oldText, source.text, { path: source.path });
      const deltaBytes = Buffer.byteLength(delta.unified, 'utf8');
      // The MCP formatter transmits the exact unified patch, not the internal
      // applyable operation list. Compare the actual wire payload with source.
      if (mode === 'auto' && deltaBytes >= source.bytes.length) return full('delta-larger-than-full');
      this.store.recordDelivery({ sessionId: this.sessionManager.sessionId, generationId, path: source.path, workspaceId: workspace.id, contentHash: source.contentHash, bytes: source.bytes, deliveryKind: 'delta' });
      return {
        kind: 'delta',
        ...common,
        delivery: deliveryAccounting(source.byteLength, deltaBytes),
        previousContentHash: previous.contentHash,
        previousWorkspaceId: previous.workspaceId,
        delta,
      };
    } catch (error) { throw toDeltaError(error); }
  }
}
