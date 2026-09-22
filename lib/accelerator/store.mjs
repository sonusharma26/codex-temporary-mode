import { DatabaseSync } from 'node:sqlite';

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
`;

const now = () => Date.now();

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
