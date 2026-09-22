import * as z from 'zod/v4';

const WORKSPACE_ID = /^ws_v1_[a-f0-9]{64}$/;
const CHECKPOINT_ID = /^cp_[a-f0-9]{32}$/;
const VALIDATION_PROFILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function errorResult(error) {
  const code = error?.code || 'INTERNAL_ERROR';
  const message = error?.message || String(error);
  return { isError: true, content: [{ type: 'text', text: `${code}: ${message}` }] };
}

async function invoke(operation) {
  try {
    const value = await operation();
    return { content: [{ type: 'text', text: JSON.stringify(value) }] };
  } catch (error) {
    return errorResult(error);
  }
}

const workspaceIdSchema = z.string().regex(WORKSPACE_ID, 'Expected a Delta Mode workspace id.');
const checkpointIdSchema = z.string().regex(CHECKPOINT_ID, 'Expected a safe checkpoint id.');
const validationProfileSchema = z.string().regex(VALIDATION_PROFILE, 'Expected a safe validation profile name.');

/**
 * Register the five Pipeline Mode v0.2 tools. Commands are deliberately not
 * part of the MCP boundary: the local, trusted project configuration owns the
 * deterministic validation plan.
 */
export function registerPipelineTools(server, pipelineService) {
  server.registerTool('create_checkpoint', {
    title: 'Create a validation checkpoint',
    description: 'Capture the current exact workspace and queue its configured validation profile. Commands come only from trusted project configuration.',
    inputSchema: z.object({
      validationProfile: validationProfileSchema.default('targeted'),
      expectedWorkspaceId: workspaceIdSchema.optional(),
      reason: z.string().trim().min(1).max(240).default('manual'),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, ({ validationProfile, expectedWorkspaceId, reason }) => invoke(() => pipelineService.createCheckpoint({
    validationProfile, expectedWorkspaceId, reason,
  })));

  server.registerTool('get_pipeline_status', {
    title: 'Get Pipeline Mode status',
    description: 'Read the current worker, queue, and optionally one checkpoint status without launching validation.',
    inputSchema: z.object({ checkpointId: checkpointIdSchema.optional() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ checkpointId }) => invoke(() => pipelineService.getStatus({ checkpointId })));

  server.registerTool('get_latest_validation', {
    title: 'Get latest validation result',
    description: 'Return the compact result for the latest matching validation, including whether it still matches the live workspace.',
    inputSchema: z.object({
      validationProfile: validationProfileSchema.optional(),
      workspaceId: workspaceIdSchema.optional(),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ validationProfile, workspaceId }) => invoke(() => pipelineService.getLatestValidation({ validationProfile, workspaceId })));

  server.registerTool('cancel_checkpoint', {
    title: 'Cancel a validation checkpoint',
    description: 'Cancel a queued checkpoint or request cancellation of an active validation; this never modifies the source workspace.',
    inputSchema: z.object({ checkpointId: checkpointIdSchema }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ checkpointId }) => invoke(() => pipelineService.cancelCheckpoint({ checkpointId })));

  server.registerTool('run_final_validation', {
    title: 'Run final validation gate',
    description: 'Queue and await the configured final profile. It passes only when that exact workspace remains current.',
    inputSchema: z.object({ expectedWorkspaceId: workspaceIdSchema.optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, ({ expectedWorkspaceId }) => invoke(() => pipelineService.runFinalValidation({ expectedWorkspaceId })));
}
