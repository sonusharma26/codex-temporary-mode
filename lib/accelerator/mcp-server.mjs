import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

function errorResult(error) {
  const code = error?.code || 'INTERNAL_ERROR';
  return { isError: true, content: [{ type: 'text', text: `${code}: ${error?.message || String(error)}` }] };
}

async function invoke(operation, formatter = value => JSON.stringify(value)) {
  try {
    const value = await operation();
    return { content: [{ type: 'text', text: formatter(value) }] };
  } catch (error) { return errorResult(error); }
}

export function formatFileDelta(result) {
  const header = [
    `FILE ${result.path}`,
    `WORKSPACE ${result.workspace.id}`,
    `GENERATION ${result.generationId}`,
    `CONTENT_HASH ${result.contentHash}`,
    `FULL_SOURCE_BYTES ${result.delivery.fullSourceBytes}`,
    `DELIVERED_TEXT_BYTES ${result.delivery.deliveredTextBytes}`,
    `SAVED_TEXT_BYTES ${result.delivery.savedTextBytes}`,
  ];
  if (result.kind === 'unchanged') return [...header, 'MODE unchanged', `UNCHANGED_SINCE ${result.sinceWorkspaceId}`].join('\n');
  if (result.kind === 'delta') {
    return [...header, 'MODE delta', `PREVIOUS_WORKSPACE ${result.previousWorkspaceId}`, `CHANGED_REGIONS ${result.delta.hunks.length}`, '', result.delta.unified].join('\n');
  }
  return [...header, 'MODE full', `REASON ${result.reason}`, '', result.content].join('\n');
}

export function formatRawOutput(result) {
  const header = [
    `RUN ${result.runId}`,
    `STREAM ${result.stream}`,
    `BYTES ${result.offsetBytes}-${result.nextOffsetBytes} OF ${result.totalBytes}`,
    `EOF ${result.eof}`,
    `TRUNCATED ${result.truncated}`,
    `ENCODING ${result.encoding}`,
  ];
  return `${header.join('\n')}\n\n${result.data}`;
}

/** Register only the four tools that form the Delta Mode v0.1 contract. */
export function createAcceleratorMcpServer({ fileDeltaService, commandDeltaService, sessionManager, rawOutputStore, version = '0.1.0' }) {
  const server = new McpServer({ name: 'codex-accelerator', version });

  server.registerTool('read_file_delta', {
    title: 'Read file with exact deltas',
    description: 'Read a UTF-8 source file. Repeated reads return an exact textual delta or an unchanged marker; mode=full always returns all source text.',
    inputSchema: z.object({
      path: z.string().min(1).describe('Workspace-relative file path'),
      mode: z.enum(['auto', 'full', 'delta']).default('auto'),
      expectedWorkspaceId: z.string().min(1).optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => invoke(() => fileDeltaService.readFileDelta(args), formatFileDelta));

  server.registerTool('run_command_delta', {
    title: 'Run command with diagnostic deltas',
    description: 'Run one executable without a shell, retain raw output locally, and return only deterministic diagnostic changes from the compatible prior run.',
    inputSchema: z.object({
      executable: z.string().min(1),
      args: z.array(z.string()).max(256).default([]),
      parser: z.enum(['typescript', 'eslint', 'vitest', 'jest', 'pytest', 'dotnet', 'cargo', 'git', 'generic']).optional(),
      commandId: z.string().min(1).max(100).optional(),
      timeoutMs: z.number().int().min(100).max(1_800_000).optional(),
      expectedWorkspaceId: z.string().min(1).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, args => invoke(() => commandDeltaService.run(args)));

  server.registerTool('get_raw_output', {
    title: 'Retrieve retained command output',
    description: 'Retrieve exact retained stdout/stderr bytes in bounded pages. Use base64 when byte-perfect recovery matters.',
    inputSchema: z.object({
      runId: z.string().min(1),
      stream: z.enum(['stdout', 'stderr', 'combined']).default('combined'),
      offsetBytes: z.number().int().min(0).default(0),
      maxBytes: z.number().int().min(1).max(1_048_576).default(65_536),
      encoding: z.enum(['utf8', 'base64']).default('utf8'),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, args => invoke(() => rawOutputStore.read({ ...args, sessionId: sessionManager.sessionId }), formatRawOutput));

  server.registerTool('reset_context_generation', {
    title: 'Reset Delta context generation',
    description: 'Start a new context generation after compaction, resume, explicit reset, or another uncertain context boundary. Subsequent reads rehydrate source in full.',
    inputSchema: z.object({ reason: z.enum(['compaction', 'resume', 'explicit', 'transport-reset']).default('explicit') }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, ({ reason }) => invoke(() => fileDeltaService.resetContextGeneration(reason)));

  return server;
}
