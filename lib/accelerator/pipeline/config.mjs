import fs from 'node:fs/promises';
import path from 'node:path';

const PARSERS = new Set(['typescript', 'eslint', 'vitest', 'jest', 'pytest', 'dotnet', 'cargo', 'git', 'generic']);
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const COMMAND_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

export class PipelineConfigError extends Error {
  constructor(code, message) { super(message); this.name = 'PipelineConfigError'; this.code = code; }
}

function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function validateValidationCommand(command, index = 0) {
  if (!plainObject(command)) throw new PipelineConfigError('INVALID_PIPELINE_COMMAND', `Validation command ${index + 1} must be an object.`);
  const allowed = new Set(['id', 'executable', 'args', 'parser', 'timeoutMs', 'continueOnFailure']);
  const unknown = Object.keys(command).filter(key => !allowed.has(key));
  if (unknown.length) throw new PipelineConfigError('INVALID_PIPELINE_COMMAND', `Validation command ${index + 1} has unknown fields: ${unknown.join(', ')}.`);
  if (typeof command.id !== 'string' || !COMMAND_ID.test(command.id)) throw new PipelineConfigError('INVALID_PIPELINE_COMMAND', `Validation command ${index + 1} requires a safe id.`);
  if (typeof command.executable !== 'string' || !command.executable.trim() || command.executable.includes('\0')) throw new PipelineConfigError('INVALID_PIPELINE_COMMAND', `Validation command ${command.id} requires a non-empty executable.`);
  const args = command.args ?? [];
  if (!Array.isArray(args) || args.length > 256 || args.some(arg => typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > 64 * 1024)) {
    throw new PipelineConfigError('INVALID_PIPELINE_COMMAND', `Validation command ${command.id} has invalid arguments.`);
  }
  if (command.parser !== undefined && !PARSERS.has(command.parser)) throw new PipelineConfigError('INVALID_PIPELINE_COMMAND', `Validation command ${command.id} has an unsupported parser.`);
  const timeoutMs = command.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 1_800_000) throw new PipelineConfigError('INVALID_PIPELINE_COMMAND', `Validation command ${command.id} timeoutMs must be between 100 and 1800000.`);
  if (command.continueOnFailure !== undefined && typeof command.continueOnFailure !== 'boolean') throw new PipelineConfigError('INVALID_PIPELINE_COMMAND', `Validation command ${command.id} continueOnFailure must be boolean.`);
  return {
    id: command.id,
    executable: command.executable,
    args: [...args],
    ...(command.parser ? { parser: command.parser } : {}),
    timeoutMs,
    continueOnFailure: command.continueOnFailure === true,
  };
}

export function validatePipelineConfig(value = {}) {
  if (!plainObject(value)) throw new PipelineConfigError('INVALID_PIPELINE_CONFIG', 'Pipeline configuration must be an object.');
  const allowed = new Set(['maxWorkers', 'profiles']);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) throw new PipelineConfigError('INVALID_PIPELINE_CONFIG', `Unknown pipeline configuration fields: ${unknown.join(', ')}.`);
  const maxWorkers = value.maxWorkers ?? 1;
  if (maxWorkers !== 1) throw new PipelineConfigError('INVALID_PIPELINE_CONFIG', 'Pipeline Mode v0.2 supports exactly one worker.');
  const inputProfiles = value.profiles ?? {};
  if (!plainObject(inputProfiles)) throw new PipelineConfigError('INVALID_PIPELINE_CONFIG', 'profiles must be an object.');
  const profiles = {};
  for (const [name, commands] of Object.entries(inputProfiles)) {
    if (!PROFILE_NAME.test(name)) throw new PipelineConfigError('INVALID_PIPELINE_PROFILE', `Invalid validation profile name: ${name}`);
    if (!Array.isArray(commands) || commands.length < 1 || commands.length > 32) throw new PipelineConfigError('INVALID_PIPELINE_PROFILE', `Validation profile ${name} must contain 1 to 32 commands.`);
    const validated = commands.map(validateValidationCommand);
    if (new Set(validated.map(command => command.id)).size !== validated.length) throw new PipelineConfigError('INVALID_PIPELINE_PROFILE', `Validation profile ${name} contains duplicate command ids.`);
    profiles[name] = validated;
  }
  return { maxWorkers, profiles };
}

export async function loadPipelineConfig(workspaceRoot, filename = undefined) {
  const configPath = path.resolve(filename || path.join(workspaceRoot, '.codex', 'accelerator.json'));
  let text;
  try { text = await fs.readFile(configPath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT' && filename === undefined) return { configPath, found: false, ...validatePipelineConfig() };
    throw new PipelineConfigError('PIPELINE_CONFIG_READ_FAILED', `Could not read pipeline configuration: ${configPath}`);
  }
  let document;
  try { document = JSON.parse(text); }
  catch { throw new PipelineConfigError('INVALID_PIPELINE_CONFIG', `Pipeline configuration is not valid JSON: ${configPath}`); }
  const pipeline = Object.hasOwn(document, 'pipeline') ? document.pipeline : document;
  return { configPath, found: true, ...validatePipelineConfig(pipeline) };
}

export function resolveValidationProfile(config, name) {
  if (typeof name !== 'string' || !PROFILE_NAME.test(name)) throw new PipelineConfigError('INVALID_PIPELINE_PROFILE', 'A valid validationProfile is required.');
  const commands = config.profiles[name];
  if (!commands) throw new PipelineConfigError('PIPELINE_PROFILE_NOT_FOUND', `Validation profile is not configured: ${name}`);
  return commands.map(command => ({ ...command, args: [...command.args] }));
}
