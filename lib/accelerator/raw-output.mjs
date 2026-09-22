import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const RUN_ID = /^[A-Za-z0-9_-]{1,100}$/;
const STREAMS = new Set(['stdout', 'stderr', 'combined']);

export class RawOutputError extends Error {
  constructor(code, message) { super(message); this.name = 'RawOutputError'; this.code = code; }
}

function assertRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new RawOutputError('INVALID_RUN_ID', 'Invalid command run identifier.');
}

function assertInside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new RawOutputError('RAW_PATH_ESCAPE', 'Raw-output path escaped its private store.');
  }
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) throw new RawOutputError('RAW_WRITE_FAILED', 'Raw-output storage accepted zero bytes.');
    offset += bytesWritten;
  }
}

/** Session-private, paged storage for exact stdout/stderr bytes. */
export class RawOutputStore {
  constructor(root, { maxBytesPerStream = Number.POSITIVE_INFINITY } = {}) {
    this.root = path.resolve(root);
    this.maxBytesPerStream = maxBytesPerStream;
    this.runs = new Map();
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  async createRun(runId, sessionId) {
    assertRunId(runId);
    const directory = path.join(this.root, runId);
    assertInside(this.root, directory);
    await fsp.mkdir(directory, { mode: 0o700 });
    const handles = {};
    try {
      for (const stream of STREAMS) handles[stream] = await fsp.open(path.join(directory, `${stream}.bin`), 'wx', 0o600);
    } catch (error) {
      await Promise.allSettled(Object.values(handles).map(handle => handle.close()));
      await fsp.rm(directory, { recursive: true, force: true });
      throw error;
    }
    const state = {
      runId, sessionId, directory, handles,
      bytes: { stdout: 0, stderr: 0, combined: 0 },
      truncated: { stdout: false, stderr: false, combined: false },
      closed: false,
    };
    this.runs.set(runId, state);
    return {
      append: (stream, chunk) => this.#append(state, stream, chunk),
      close: () => this.#closeRun(state),
      metadata: () => ({ bytes: { ...state.bytes }, truncated: { ...state.truncated } }),
    };
  }

  async #appendOne(state, stream, bytes) {
    if (state.closed) throw new RawOutputError('RAW_RUN_CLOSED', 'Cannot append to a closed raw-output run.');
    const remaining = Math.max(0, this.maxBytesPerStream - state.bytes[stream]);
    const retained = bytes.subarray(0, remaining);
    if (retained.length) {
      await writeAll(state.handles[stream], retained);
      state.bytes[stream] += retained.length;
    }
    if (retained.length !== bytes.length) state.truncated[stream] = true;
    return retained.length === bytes.length;
  }

  async #append(state, stream, chunk) {
    if (stream !== 'stdout' && stream !== 'stderr') throw new RawOutputError('INVALID_STREAM', 'Only stdout and stderr can be appended.');
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const keptStream = await this.#appendOne(state, stream, bytes);
    const keptCombined = await this.#appendOne(state, 'combined', bytes);
    return keptStream && keptCombined;
  }

  async #closeRun(state) {
    if (state.closed) return { bytes: { ...state.bytes }, truncated: { ...state.truncated } };
    state.closed = true;
    await Promise.all(Object.values(state.handles).map(handle => handle.close()));
    return { bytes: { ...state.bytes }, truncated: { ...state.truncated } };
  }

  async read({ runId, sessionId, stream = 'combined', offsetBytes = 0, maxBytes = 64 * 1024, encoding = 'utf8' }) {
    assertRunId(runId);
    if (!STREAMS.has(stream)) throw new RawOutputError('INVALID_STREAM', 'stream must be stdout, stderr, or combined.');
    if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0) throw new RawOutputError('INVALID_OFFSET', 'offsetBytes must be a non-negative integer.');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new RawOutputError('INVALID_PAGE_SIZE', 'maxBytes must be between 1 and 1048576.');
    if (encoding !== 'utf8' && encoding !== 'base64') throw new RawOutputError('INVALID_ENCODING', 'encoding must be utf8 or base64.');
    const state = this.runs.get(runId);
    if (!state || state.sessionId !== sessionId) throw new RawOutputError('RAW_OUTPUT_NOT_FOUND', 'Raw output was not found for this session.');
    if (!state.closed) throw new RawOutputError('RUN_NOT_FINISHED', 'Raw output is available after the command finishes.');
    const filename = path.resolve(state.directory, `${stream}.bin`);
    assertInside(this.root, filename);
    const totalBytes = state.bytes[stream];
    const length = Math.max(0, Math.min(maxBytes, totalBytes - offsetBytes));
    const buffer = Buffer.alloc(length);
    if (length) {
      const handle = await fsp.open(filename, 'r');
      try { await handle.read(buffer, 0, length, offsetBytes); }
      finally { await handle.close(); }
    }
    const nextOffsetBytes = offsetBytes + length;
    return {
      runId, stream, offsetBytes, nextOffsetBytes, totalBytes,
      eof: nextOffsetBytes >= totalBytes,
      truncated: state.truncated[stream], encoding,
      data: encoding === 'base64' ? buffer.toString('base64') : buffer.toString('utf8'),
    };
  }

  async removeRun(runId) {
    assertRunId(runId);
    const state = this.runs.get(runId);
    if (!state) return;
    if (!state.closed) await this.#closeRun(state);
    this.runs.delete(runId);
    await fsp.rm(state.directory, { recursive: true, force: true });
  }

  async close() {
    for (const runId of [...this.runs.keys()]) await this.removeRun(runId);
  }
}
