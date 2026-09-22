import { commandText } from './common.mjs';
import { parseCargo } from './cargo.mjs';
import { parseDotnet } from './dotnet.mjs';
import { parseEslint } from './eslint.mjs';
import { parseGeneric } from './generic.mjs';
import { parseGit } from './git.mjs';
import { parsePytest } from './pytest.mjs';
import { parseJest, parseVitest } from './runners.mjs';
import { parseTypeScript } from './typescript.mjs';

const parsers = {
  typescript: parseTypeScript,
  eslint: parseEslint,
  vitest: parseVitest,
  jest: parseJest,
  pytest: parsePytest,
  dotnet: parseDotnet,
  cargo: parseCargo,
  git: parseGit,
  generic: parseGeneric,
};

export function resolveParser({ parser, command } = {}) {
  if (parser) {
    const selected = parsers[String(parser).toLowerCase()];
    if (!selected) throw new Error(`Unknown diagnostic parser: ${parser}`);
    return { id: String(parser).toLowerCase(), parse: selected };
  }
  const text = commandText(command);
  const id = /\bvitest\b/.test(text) ? 'vitest'
    : /\bjest\b/.test(text) ? 'jest'
    : /\bpytest\b|\bpy\.test\b/.test(text) ? 'pytest'
    : /\bdotnet\b/.test(text) ? 'dotnet'
    : /\bcargo\b/.test(text) ? 'cargo'
    : /\bgit\b/.test(text) ? 'git'
    : /\beslint\b/.test(text) ? 'eslint'
    : /\btsc\b|\btypescript\b/.test(text) ? 'typescript'
    : 'generic';
  return { id, parse: parsers[id] };
}

/**
 * Parse command output without modelling or summarising it. `parser` should be
 * set by configuration when a command name is ambiguous (for example npm run).
 */
export function parseCommandOutput(output, options = {}) {
  const selected = resolveParser(options);
  return selected.parse(output, options);
}

export {
  parseTypeScript, parseEslint, parseVitest, parseJest, parsePytest,
  parseDotnet, parseCargo, parseGit, parseGeneric,
};
