import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const schema = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS repositories (
  repository_id TEXT PRIMARY KEY,
  real_root TEXT NOT NULL UNIQUE,
  git_dir TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(repository_id),
  ephemeral INTEGER NOT NULL CHECK(ephemeral IN (0,1)),
  created_at INTEGER NOT NULL,
  closed_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS context_generations (
  generation_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  reason TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  closed_at INTEGER,
  UNIQUE(session_id, ordinal)
) STRICT;
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES repositories(repository_id),
  format INTEGER NOT NULL,
  head_oid TEXT NOT NULL,
  index_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  complete INTEGER NOT NULL CHECK(complete IN (0,1)),
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS workspace_entries (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  entry_kind TEXT NOT NULL,
  mode INTEGER NOT NULL,
  content_hash TEXT,
  byte_length INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, path)
) STRICT;
CREATE TABLE IF NOT EXISTS content_blobs (
  content_hash TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  byte_length INTEGER NOT NULL,
  encoding TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS delivered_file_versions (
  delivery_id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL REFERENCES context_generations(generation_id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  content_hash TEXT NOT NULL REFERENCES content_blobs(content_hash),
  delivery_kind TEXT NOT NULL,
  delivered_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS delivered_file_versions_lookup ON delivered_file_versions(session_id, generation_id, path, delivery_id DESC);
CREATE TABLE IF NOT EXISTS command_runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  generation_id TEXT NOT NULL REFERENCES context_generations(generation_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  finished_workspace_id TEXT REFERENCES workspaces(workspace_id),
  scope_key TEXT NOT NULL,
  parser_id TEXT NOT NULL,
  parser_version INTEGER NOT NULL,
  executable TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  cwd TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  signal TEXT,
  parse_complete INTEGER NOT NULL CHECK(parse_complete IN (0,1)),
  stdout_bytes INTEGER NOT NULL,
  stderr_bytes INTEGER NOT NULL,
  raw_truncated INTEGER NOT NULL CHECK(raw_truncated IN (0,1)),
  started_at INTEGER NOT NULL,
  finished_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS command_runs_comparison ON command_runs(session_id,generation_id,scope_key,parser_id,parser_version,parse_complete,finished_at DESC);
CREATE TABLE IF NOT EXISTS diagnostics (
  diagnostic_id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES command_runs(run_id) ON DELETE CASCADE,
  identity_hash TEXT NOT NULL,
  tool TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  file_path TEXT,
  error_code TEXT,
  normalized_message TEXT NOT NULL,
  subject TEXT,
  line INTEGER,
  column_number INTEGER,
  end_line INTEGER,
  end_column INTEGER,
  delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0,1)),
  UNIQUE(run_id, identity_hash)
) STRICT;
CREATE TABLE IF NOT EXISTS checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  changed_files_json TEXT NOT NULL CHECK(json_valid(changed_files_json)),
  reason TEXT NOT NULL,
  validation_profile TEXT NOT NULL,
  validation_plan_digest TEXT NOT NULL,
  commands_json TEXT NOT NULL CHECK(json_valid(commands_json)),
  status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','PASSED','FAILED','SUPERSEDED','CANCELLED')),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  superseded_by TEXT REFERENCES checkpoints(checkpoint_id),
  compact_result_json TEXT CHECK(compact_result_json IS NULL OR json_valid(compact_result_json))
) STRICT;
CREATE INDEX IF NOT EXISTS checkpoints_queue ON checkpoints(session_id,status,created_at,checkpoint_id);
CREATE INDEX IF NOT EXISTS checkpoints_latest ON checkpoints(session_id,created_at DESC,checkpoint_id DESC);
CREATE TABLE IF NOT EXISTS checkpoint_runs (
  checkpoint_run_id TEXT PRIMARY KEY,
  checkpoint_id TEXT NOT NULL REFERENCES checkpoints(checkpoint_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  validation_profile TEXT NOT NULL,
  validation_plan_digest TEXT NOT NULL,
  commands_json TEXT NOT NULL CHECK(json_valid(commands_json)),
  status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','PASSED','FAILED','SUPERSEDED','CANCELLED')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  compact_result_json TEXT CHECK(compact_result_json IS NULL OR json_valid(compact_result_json))
) STRICT;
CREATE INDEX IF NOT EXISTS checkpoint_runs_by_checkpoint ON checkpoint_runs(checkpoint_id,started_at DESC);
`;

const now = () => Date.now();
const CHECKPOINT_STATUSES = new Set(['QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'SUPERSEDED', 'CANCELLED']);
const FINISHED_CHECKPOINT_STATUSES = new Set(['PASSED', 'FAILED', 'CANCELLED']);

function requireText(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function requireTimestamp(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative integer`);
  return value;
}

function encodeRequiredJson(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string') throw new TypeError(`${field} must be JSON serializable`);
  return encoded;
}

function encodeOptionalJson(value, field) {
  if (value === undefined || value === null) return null;
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string') throw new TypeError(`${field} must be JSON serializable`);
  return encoded;
}

function decodeJson(value) {
  return value === null || value === undefined ? null : JSON.parse(value);
}

function checkpointFromRow(row) {
  if (!row) return null;
  const compactResult = decodeJson(row.compact_result_json);
  return {
    checkpointId: row.checkpoint_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    changedFiles: decodeJson(row.changed_files_json),
    reason: row.reason,
    validationProfile: row.validation_profile,
    validationPlanDigest: row.validation_plan_digest,
    commands: decodeJson(row.commands_json),
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    supersededBy: row.superseded_by,
    compactResult,
    result: compactResult,
  };
}

function checkpointRunFromRow(row) {
  if (!row) return null;
  const compactResult = decodeJson(row.compact_result_json);
  return {
    checkpointRunId: row.checkpoint_run_id,
    checkpointId: row.checkpoint_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    validationProfile: row.validation_profile,
    validationPlanDigest: row.validation_plan_digest,
    commands: decodeJson(row.commands_json),
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    compactResult,
    result: compactResult,
  };
}

/** Small synchronous SQLite store; all public mutations are transaction-bound. */
export class AcceleratorStore {
  constructor(filename = ':memory:') {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    this.db.exec(schema);
    const diagnosticColumns = this.db.prepare('PRAGMA table_info(diagnostics)').all();
    if (!diagnosticColumns.some(column => column.name === 'delivered')) {
      this.db.exec('ALTER TABLE diagnostics ADD COLUMN delivered INTEGER NOT NULL DEFAULT 1 CHECK(delivered IN (0,1))');
    }
  }

  close() { try { this.db.close(); } catch (error) { if (!/closed/i.test(error.message)) throw error; } }
  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = operation(); this.db.exec('COMMIT'); return value; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }

  ensureRepository({ repositoryId, realRoot, gitDir = null }) {
    this.db.prepare('INSERT INTO repositories(repository_id, real_root, git_dir, created_at) VALUES(?,?,?,?) ON CONFLICT(repository_id) DO UPDATE SET real_root=excluded.real_root, git_dir=excluded.git_dir').run(repositoryId, realRoot, gitDir, now());
  }
  createSession({ sessionId, repositoryId, ephemeral }) {
    this.db.prepare('INSERT INTO sessions(session_id,repository_id,ephemeral,created_at) VALUES(?,?,?,?)').run(sessionId, repositoryId, ephemeral ? 1 : 0, now());
  }
  closeSession(sessionId) {
    return this.transaction(() => {
      this.db.prepare('UPDATE sessions SET closed_at=? WHERE session_id=?').run(now(), sessionId);
      this.db.prepare('UPDATE context_generations SET closed_at=COALESCE(closed_at,?) WHERE session_id=?').run(now(), sessionId);
      this.db.prepare('DELETE FROM delivered_file_versions WHERE session_id=?').run(sessionId);
      this.db.prepare('DELETE FROM content_blobs WHERE content_hash NOT IN (SELECT content_hash FROM delivered_file_versions)').run();
    });
  }
  startGeneration({ generationId, sessionId, ordinal, reason }) {
    this.db.prepare('INSERT INTO context_generations(generation_id,session_id,ordinal,reason,started_at) VALUES(?,?,?,?,?)').run(generationId, sessionId, ordinal, reason, now());
  }
  closeGeneration(generationId) { this.db.prepare('UPDATE context_generations SET closed_at=COALESCE(closed_at,?) WHERE generation_id=?').run(now(), generationId); }

  recordWorkspace(repositoryId, workspace) {
    return this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO workspaces(workspace_id,repository_id,format,head_oid,index_hash,manifest_hash,complete,created_at) VALUES(?,?,?,?,?,?,?,?)').run(workspace.id, repositoryId, workspace.format, workspace.headOid, workspace.indexHash, workspace.manifestHash, workspace.complete ? 1 : 0, now());
      const insert = this.db.prepare('INSERT OR IGNORE INTO workspace_entries(workspace_id,path,entry_kind,mode,content_hash,byte_length) VALUES(?,?,?,?,?,?)');
      for (const entry of workspace.entries) insert.run(workspace.id, entry.path, entry.kind, entry.mode, entry.contentHash, entry.byteLength);
    });
  }

  _normalizeCheckpointInput({
    checkpointId = randomUUID(),
    sessionId,
    workspaceId,
    changedFiles = [],
    reason,
    validationProfile,
    validationPlanDigest,
    commands = [],
    createdAt = now(),
  }) {
    return {
      checkpointId: requireText(checkpointId, 'checkpointId'),
      sessionId: requireText(sessionId, 'sessionId'),
      workspaceId: requireText(workspaceId, 'workspaceId'),
      changedFilesJson: encodeRequiredJson(changedFiles, 'changedFiles'),
      reason: requireText(reason, 'reason'),
      validationProfile: requireText(validationProfile, 'validationProfile'),
      validationPlanDigest: requireText(validationPlanDigest, 'validationPlanDigest'),
      commandsJson: encodeRequiredJson(commands, 'commands'),
      createdAt: requireTimestamp(createdAt, 'createdAt'),
    };
  }

  _insertCheckpoint(checkpoint) {
    this.db.prepare(`INSERT INTO checkpoints(
      checkpoint_id,session_id,workspace_id,changed_files_json,reason,validation_profile,validation_plan_digest,commands_json,status,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      checkpoint.checkpointId, checkpoint.sessionId, checkpoint.workspaceId, checkpoint.changedFilesJson,
      checkpoint.reason, checkpoint.validationProfile, checkpoint.validationPlanDigest, checkpoint.commandsJson, 'QUEUED', checkpoint.createdAt,
    );
  }

  _checkpointRow(checkpointId) {
    return this.db.prepare('SELECT * FROM checkpoints WHERE checkpoint_id=?').get(checkpointId) || null;
  }

  _checkpointRunRow(checkpointRunId) {
    return this.db.prepare('SELECT * FROM checkpoint_runs WHERE checkpoint_run_id=?').get(checkpointRunId) || null;
  }

  /** Add a manually-created validation checkpoint without affecting an existing queue. */
  createCheckpoint(input) {
    const checkpoint = this._normalizeCheckpointInput(input);
    return this.transaction(() => {
      this._insertCheckpoint(checkpoint);
      return checkpointFromRow(this._checkpointRow(checkpoint.checkpointId));
    });
  }

  /**
   * Add a checkpoint and replace every older, still-queued checkpoint for its
   * session and validation profile in one transaction. Running, completed, and
   * differently-profiled checkpoints are intentionally left alone.
   */
  createCheckpointAndSupersedeQueued(input) {
    const checkpoint = this._normalizeCheckpointInput(input);
    const supersededAt = requireTimestamp(input.supersededAt ?? checkpoint.createdAt, 'supersededAt');
    return this.transaction(() => {
      this._insertCheckpoint(checkpoint);
      this.db.prepare(`UPDATE checkpoints
        SET status='SUPERSEDED', superseded_by=?, finished_at=?
        WHERE session_id=? AND validation_profile=? AND status='QUEUED' AND checkpoint_id<>?`).run(
        checkpoint.checkpointId, supersededAt, checkpoint.sessionId, checkpoint.validationProfile, checkpoint.checkpointId,
      );
      const superseded = this.db.prepare(`SELECT * FROM checkpoints
        WHERE session_id=? AND status='SUPERSEDED' AND superseded_by=?
        ORDER BY created_at ASC,checkpoint_id ASC`).all(checkpoint.sessionId, checkpoint.checkpointId).map(checkpointFromRow);
      return {
        checkpoint: checkpointFromRow(this._checkpointRow(checkpoint.checkpointId)),
        superseded,
        supersededCheckpointIds: superseded.map(item => item.checkpointId),
      };
    });
  }

  /** Claim the oldest queued checkpoint for one session and create its execution record. */
  claimOldestQueuedCheckpoint({ sessionId, checkpointRunId = randomUUID(), startedAt = now() }) {
    const normalizedSessionId = requireText(sessionId, 'sessionId');
    const normalizedCheckpointRunId = requireText(checkpointRunId, 'checkpointRunId');
    const normalizedStartedAt = requireTimestamp(startedAt, 'startedAt');
    return this.transaction(() => {
      const queued = this.db.prepare(`SELECT * FROM checkpoints
        WHERE session_id=? AND status='QUEUED'
        ORDER BY created_at ASC,checkpoint_id ASC LIMIT 1`).get(normalizedSessionId);
      if (!queued) return null;
      const claimed = this.db.prepare(`UPDATE checkpoints
        SET status='RUNNING', started_at=?
        WHERE checkpoint_id=? AND status='QUEUED'`).run(normalizedStartedAt, queued.checkpoint_id);
      if (Number(claimed.changes) !== 1) throw new Error(`Checkpoint could not be claimed: ${queued.checkpoint_id}`);
      this.db.prepare(`INSERT INTO checkpoint_runs(
        checkpoint_run_id,checkpoint_id,session_id,workspace_id,validation_profile,validation_plan_digest,commands_json,status,started_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
        normalizedCheckpointRunId, queued.checkpoint_id, queued.session_id, queued.workspace_id,
        queued.validation_profile, queued.validation_plan_digest, queued.commands_json, 'RUNNING', normalizedStartedAt,
      );
      return {
        checkpoint: checkpointFromRow(this._checkpointRow(queued.checkpoint_id)),
        run: checkpointRunFromRow(this._checkpointRunRow(normalizedCheckpointRunId)),
      };
    });
  }

  /** Finish the active run for a checkpoint. Only terminal validator outcomes are accepted. */
  finishCheckpoint({
    checkpointId,
    checkpointRunId,
    status,
    compactResult,
    result,
    finishedAt = now(),
  }) {
    const normalizedCheckpointId = requireText(checkpointId, 'checkpointId');
    if (!FINISHED_CHECKPOINT_STATUSES.has(status)) throw new TypeError(`status must be PASSED, FAILED, or CANCELLED, received ${String(status)}`);
    const normalizedFinishedAt = requireTimestamp(finishedAt, 'finishedAt');
    const resultJson = encodeOptionalJson(compactResult === undefined ? result : compactResult, 'compactResult');
    return this.transaction(() => {
      const checkpoint = this._checkpointRow(normalizedCheckpointId);
      if (!checkpoint) throw new Error(`Checkpoint not found: ${normalizedCheckpointId}`);
      if (checkpoint.status !== 'RUNNING') throw new Error(`Checkpoint is not running: ${normalizedCheckpointId}`);
      const run = checkpointRunId === undefined
        ? this.db.prepare(`SELECT * FROM checkpoint_runs
          WHERE checkpoint_id=? AND status='RUNNING'
          ORDER BY started_at DESC,checkpoint_run_id DESC LIMIT 1`).get(normalizedCheckpointId)
        : this._checkpointRunRow(requireText(checkpointRunId, 'checkpointRunId'));
      if (!run || run.checkpoint_id !== normalizedCheckpointId || run.status !== 'RUNNING') {
        throw new Error(`Checkpoint run is not active: ${checkpointRunId ?? normalizedCheckpointId}`);
      }
      const runUpdated = this.db.prepare(`UPDATE checkpoint_runs
        SET status=?, finished_at=?, compact_result_json=?
        WHERE checkpoint_run_id=? AND checkpoint_id=? AND status='RUNNING'`).run(
        status, normalizedFinishedAt, resultJson, run.checkpoint_run_id, normalizedCheckpointId,
      );
      if (Number(runUpdated.changes) !== 1) throw new Error(`Checkpoint run is not active: ${run.checkpoint_run_id}`);
      const checkpointUpdated = this.db.prepare(`UPDATE checkpoints
        SET status=?, finished_at=?, compact_result_json=?
        WHERE checkpoint_id=? AND status='RUNNING'`).run(
        status, normalizedFinishedAt, resultJson, normalizedCheckpointId,
      );
      if (Number(checkpointUpdated.changes) !== 1) throw new Error(`Checkpoint is not running: ${normalizedCheckpointId}`);
      return {
        checkpoint: checkpointFromRow(this._checkpointRow(normalizedCheckpointId)),
        run: checkpointRunFromRow(this._checkpointRunRow(run.checkpoint_run_id)),
      };
    });
  }

  /** Cancel a checkpoint before a worker has claimed it. */
  cancelQueuedCheckpoint({ checkpointId, compactResult, result, cancelledAt = now() }) {
    const normalizedCheckpointId = requireText(checkpointId, 'checkpointId');
    const normalizedCancelledAt = requireTimestamp(cancelledAt, 'cancelledAt');
    const resultJson = encodeOptionalJson(compactResult === undefined ? result : compactResult, 'compactResult');
    return this.transaction(() => {
      const checkpoint = this._checkpointRow(normalizedCheckpointId);
      if (!checkpoint) throw new Error(`Checkpoint not found: ${normalizedCheckpointId}`);
      if (checkpoint.status !== 'QUEUED') throw new Error(`Checkpoint is not queued: ${normalizedCheckpointId}`);
      const cancelled = this.db.prepare(`UPDATE checkpoints
        SET status='CANCELLED', finished_at=?, compact_result_json=?
        WHERE checkpoint_id=? AND status='QUEUED'`).run(
        normalizedCancelledAt, resultJson, normalizedCheckpointId,
      );
      if (Number(cancelled.changes) !== 1) throw new Error(`Checkpoint is not queued: ${normalizedCheckpointId}`);
      return checkpointFromRow(this._checkpointRow(normalizedCheckpointId));
    });
  }

  getCheckpoint(checkpointId) {
    return checkpointFromRow(this._checkpointRow(requireText(checkpointId, 'checkpointId')));
  }

  getCheckpointRun(checkpointRunId) {
    return checkpointRunFromRow(this._checkpointRunRow(requireText(checkpointRunId, 'checkpointRunId')));
  }

  /**
   * Return the newest queued or running checkpoint with the exact validation
   * identity. A scheduler can use this to collapse duplicate work safely.
   */
  findNonterminalEquivalentCheckpoint({ sessionId, workspaceId, validationProfile, validationPlanDigest }) {
    const row = this.db.prepare(`SELECT * FROM checkpoints
      WHERE session_id=? AND workspace_id=? AND validation_profile=? AND validation_plan_digest=?
        AND status IN ('QUEUED','RUNNING')
      ORDER BY created_at DESC,checkpoint_id DESC LIMIT 1`).get(
      requireText(sessionId, 'sessionId'),
      requireText(workspaceId, 'workspaceId'),
      requireText(validationProfile, 'validationProfile'),
      requireText(validationPlanDigest, 'validationPlanDigest'),
    );
    return checkpointFromRow(row);
  }

  listCheckpoints({ sessionId, status, limit = 50 }) {
    const normalizedSessionId = requireText(sessionId, 'sessionId');
    if (status !== undefined && !CHECKPOINT_STATUSES.has(status)) throw new TypeError(`Unknown checkpoint status: ${String(status)}`);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit must be an integer between 1 and 1000');
    const rows = status === undefined
      ? this.db.prepare(`SELECT * FROM checkpoints WHERE session_id=?
        ORDER BY created_at DESC,checkpoint_id DESC LIMIT ?`).all(normalizedSessionId, limit)
      : this.db.prepare(`SELECT * FROM checkpoints WHERE session_id=? AND status=?
        ORDER BY created_at DESC,checkpoint_id DESC LIMIT ?`).all(normalizedSessionId, status, limit);
    return rows.map(checkpointFromRow);
  }

  latestCheckpoint({ sessionId, status } = {}) {
    return this.listCheckpoints({ sessionId, status, limit: 1 })[0] || null;
  }

  listCheckpointRuns({ checkpointId, limit = 50 }) {
    const normalizedCheckpointId = requireText(checkpointId, 'checkpointId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit must be an integer between 1 and 1000');
    return this.db.prepare(`SELECT * FROM checkpoint_runs WHERE checkpoint_id=?
      ORDER BY started_at DESC,checkpoint_run_id DESC LIMIT ?`).all(normalizedCheckpointId, limit).map(checkpointRunFromRow);
  }

  latestDelivery(sessionId, generationId, filePath) {
    return this.db.prepare(`SELECT d.workspace_id AS workspaceId,d.content_hash AS contentHash,d.delivery_kind AS deliveryKind,d.delivered_at AS deliveredAt,b.bytes AS bytes,b.encoding AS encoding
      FROM delivered_file_versions d JOIN content_blobs b ON b.content_hash=d.content_hash
      WHERE d.session_id=? AND d.generation_id=? AND d.path=? ORDER BY d.delivery_id DESC LIMIT 1`).get(sessionId, generationId, filePath) || null;
  }
  recordDelivery({ sessionId, generationId, path, workspaceId, contentHash, bytes, encoding = 'utf-8', deliveryKind }) {
    return this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO content_blobs(content_hash,bytes,byte_length,encoding,created_at) VALUES(?,?,?,?,?)').run(contentHash, bytes, bytes.length, encoding, now());
      this.db.prepare('INSERT INTO delivered_file_versions(session_id,generation_id,path,workspace_id,content_hash,delivery_kind,delivered_at) VALUES(?,?,?,?,?,?,?)').run(sessionId, generationId, path, workspaceId, contentHash, deliveryKind, now());
    });
  }

  createCommandRun({ runId, sessionId, generationId, workspaceId, scopeKey, parserId, parserVersion, executable, args, cwd, startedAt }) {
    this.db.prepare(`INSERT INTO command_runs(
      run_id,session_id,generation_id,workspace_id,scope_key,parser_id,parser_version,executable,arguments_json,cwd,status,
      parse_complete,stdout_bytes,stderr_bytes,raw_truncated,started_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,0,0,0,?)`).run(
      runId, sessionId, generationId, workspaceId, scopeKey, parserId, parserVersion,
      executable, JSON.stringify(args), cwd, 'running', startedAt,
    );
  }

  finishCommandRun({ runId, status, exitCode, signal, finishedAt, finishedWorkspaceId, parseComplete, stdoutBytes, stderrBytes, rawTruncated, diagnostics, deliveredFingerprints = [] }) {
    return this.transaction(() => {
      const updated = this.db.prepare(`UPDATE command_runs SET
        status=?,exit_code=?,signal=?,finished_at=?,finished_workspace_id=?,parse_complete=?,stdout_bytes=?,stderr_bytes=?,raw_truncated=?
        WHERE run_id=? AND status='running'`).run(
        status, exitCode, signal, finishedAt, finishedWorkspaceId, parseComplete ? 1 : 0,
        stdoutBytes, stderrBytes, rawTruncated ? 1 : 0, runId,
      );
      if (Number(updated.changes) !== 1) throw new Error(`Command run is not active: ${runId}`);
      const delivered = new Set(deliveredFingerprints);
      const insert = this.db.prepare(`INSERT INTO diagnostics(
        run_id,identity_hash,tool,kind,severity,file_path,error_code,normalized_message,subject,line,column_number,end_line,end_column,delivered
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const item of diagnostics) insert.run(
        runId, item.fingerprint, item.tool, item.kind, item.severity, item.file, item.code,
        item.message, item.subject, item.line, item.column, item.endLine, item.endColumn,
        delivered.has(item.fingerprint) ? 1 : 0,
      );
    });
  }

  diagnosticsForRun(runId) {
    return this.db.prepare(`SELECT
      identity_hash AS fingerprint,tool,kind,severity,file_path AS file,error_code AS code,
      normalized_message AS message,subject,line,column_number AS column,end_line AS endLine,end_column AS endColumn,delivered
      FROM diagnostics WHERE run_id=? ORDER BY file_path,line,column_number,identity_hash`).all(runId);
  }

  latestComparableCommandRun({ sessionId, generationId, scopeKey, parserId, parserVersion, beforeRunId }) {
    const row = this.db.prepare(`SELECT run_id AS runId,workspace_id AS workspaceId
      FROM command_runs
      WHERE session_id=? AND generation_id=? AND scope_key=? AND parser_id=? AND parser_version=?
        AND parse_complete=1 AND finished_at IS NOT NULL AND run_id<>?
      ORDER BY finished_at DESC,run_id DESC LIMIT 1`).get(sessionId, generationId, scopeKey, parserId, parserVersion, beforeRunId);
    return row ? { ...row, diagnostics: this.diagnosticsForRun(row.runId) } : null;
  }
}

export { schema as ACCELERATOR_SCHEMA };
