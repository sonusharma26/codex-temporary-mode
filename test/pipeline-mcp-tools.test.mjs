import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPipelineTools } from '../lib/accelerator/pipeline/mcp-tools.mjs';

const WORKSPACE_ID = `ws_v1_${'a'.repeat(64)}`;

function registeredTools() {
  const tools = new Map();
  const server = {
    registerTool(name, definition, handler) {
      if (tools.has(name)) throw new Error(`Duplicate tool: ${name}`);
      tools.set(name, { definition, handler });
    },
  };
  return { server, tools };
}

test('Pipeline Mode registers exactly five strict tool schemas with safe annotations', () => {
  const { server, tools } = registeredTools();
  registerPipelineTools(server, {});

  assert.deepEqual([...tools.keys()].sort(), [
    'cancel_checkpoint',
    'create_checkpoint',
    'get_latest_validation',
    'get_pipeline_status',
    'run_final_validation',
  ]);
  assert.equal(tools.get('create_checkpoint').definition.annotations.destructiveHint, true);
  assert.equal(tools.get('run_final_validation').definition.annotations.destructiveHint, true);
  assert.equal(tools.get('get_pipeline_status').definition.annotations.readOnlyHint, true);
  assert.equal(tools.get('get_latest_validation').definition.annotations.readOnlyHint, true);
  assert.equal(tools.get('cancel_checkpoint').definition.annotations.readOnlyHint, false);

  const createSchema = tools.get('create_checkpoint').definition.inputSchema;
  assert.deepEqual(createSchema.parse({}), { validationProfile: 'targeted', reason: 'manual' });
  assert.equal(createSchema.safeParse({ executable: 'node' }).success, false);
  assert.equal(createSchema.safeParse({ args: ['--test'] }).success, false);
  assert.equal(createSchema.safeParse({ validationProfile: '../escape' }).success, false);
  assert.equal(createSchema.safeParse({ expectedWorkspaceId: 'not-a-workspace' }).success, false);

  assert.equal(tools.get('run_final_validation').definition.inputSchema.safeParse({ executable: 'node' }).success, false);
  assert.equal(tools.get('get_latest_validation').definition.inputSchema.safeParse({ args: [] }).success, false);
  assert.equal(tools.get('cancel_checkpoint').definition.inputSchema.safeParse({ checkpointId: '../checkpoint' }).success, false);
});

test('Pipeline Mode delegates only validated contract fields and returns compact JSON', async () => {
  const calls = [];
  const service = {
    async createCheckpoint(args) {
      calls.push(['createCheckpoint', args]);
      return { checkpointId: 'cp_123', workspaceId: WORKSPACE_ID, state: 'queued' };
    },
    async getStatus(args) {
      calls.push(['getStatus', args]);
      return { state: 'idle' };
    },
    async getLatestValidation(args) {
      calls.push(['getLatestValidation', args]);
      return { state: 'passed', freshness: 'current' };
    },
    async cancelCheckpoint(args) {
      calls.push(['cancelCheckpoint', args]);
      return { checkpointId: args.checkpointId, state: 'cancelled' };
    },
    async runFinalValidation(args) {
      calls.push(['runFinalValidation', args]);
      return { gate: 'pass', workspaceId: args.expectedWorkspaceId };
    },
  };
  const { server, tools } = registeredTools();
  registerPipelineTools(server, service);

  const created = await tools.get('create_checkpoint').handler({
    validationProfile: 'targeted', expectedWorkspaceId: WORKSPACE_ID, reason: 'before refactor',
  });
  assert.deepEqual(JSON.parse(created.content[0].text), { checkpointId: 'cp_123', workspaceId: WORKSPACE_ID, state: 'queued' });

  const status = await tools.get('get_pipeline_status').handler({ checkpointId: 'cp_123' });
  assert.deepEqual(JSON.parse(status.content[0].text), { state: 'idle' });

  const latest = await tools.get('get_latest_validation').handler({ validationProfile: 'targeted', workspaceId: WORKSPACE_ID });
  assert.deepEqual(JSON.parse(latest.content[0].text), { state: 'passed', freshness: 'current' });

  const cancelled = await tools.get('cancel_checkpoint').handler({ checkpointId: 'cp_123' });
  assert.deepEqual(JSON.parse(cancelled.content[0].text), { checkpointId: 'cp_123', state: 'cancelled' });

  const final = await tools.get('run_final_validation').handler({ expectedWorkspaceId: WORKSPACE_ID });
  assert.deepEqual(JSON.parse(final.content[0].text), { gate: 'pass', workspaceId: WORKSPACE_ID });

  assert.deepEqual(calls, [
    ['createCheckpoint', { validationProfile: 'targeted', expectedWorkspaceId: WORKSPACE_ID, reason: 'before refactor' }],
    ['getStatus', { checkpointId: 'cp_123' }],
    ['getLatestValidation', { validationProfile: 'targeted', workspaceId: WORKSPACE_ID }],
    ['cancelCheckpoint', { checkpointId: 'cp_123' }],
    ['runFinalValidation', { expectedWorkspaceId: WORKSPACE_ID }],
  ]);
});

test('Pipeline Mode maps service errors to MCP error results', async () => {
  const { server, tools } = registeredTools();
  registerPipelineTools(server, {
    async getStatus() {
      const error = new Error('The queue is unavailable.');
      error.code = 'PIPELINE_UNAVAILABLE';
      throw error;
    },
  });

  const result = await tools.get('get_pipeline_status').handler({});
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'PIPELINE_UNAVAILABLE: The queue is unavailable.');
});
