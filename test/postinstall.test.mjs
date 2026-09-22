import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const script = fs.existsSync(fileURLToPath(new URL('postinstall.mjs', root))) ? '../postinstall.mjs' : '../build/postinstall.mjs';
const { postinstall } = await import(script);

test('postinstall safely skips the VS Code patch without an interactive terminal', async () => {
  let output = '';
  const result = await postinstall({
    input: { isTTY: false },
    output: { write: text => { output += text; } },
    run: () => { throw new Error('must not run'); },
    consoleFactory: () => null,
  });
  assert.equal(result, false);
  assert.match(output, /no interactive terminal/);
});
