import { randomUUID } from 'node:crypto';

/** Binds one MCP transport to one session and a conservative context generation. */
export class SessionManager {
  constructor({ store, repositoryId, ephemeral = false, sessionId = randomUUID() }) {
    this.store = store; this.repositoryId = repositoryId; this.ephemeral = ephemeral; this.sessionId = sessionId;
    this.ordinal = 0; this.generationId = null; this.closed = false;
  }
  start() {
    if (this.closed) throw new Error('Session is closed.');
    this.store.createSession({ sessionId: this.sessionId, repositoryId: this.repositoryId, ephemeral: this.ephemeral });
    return this.resetContextGeneration('session-start');
  }
  resetContextGeneration(reason = 'explicit') {
    if (this.closed) throw new Error('Session is closed.');
    if (this.generationId) this.store.closeGeneration(this.generationId);
    this.ordinal++;
    this.generationId = randomUUID();
    this.store.startGeneration({ generationId: this.generationId, sessionId: this.sessionId, ordinal: this.ordinal, reason });
    return { generationId: this.generationId, ordinal: this.ordinal, reason };
  }
  close() {
    if (this.closed) return;
    this.store.closeSession(this.sessionId); this.closed = true;
  }
}
