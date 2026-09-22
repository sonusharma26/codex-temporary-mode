import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { transform, build } from 'esbuild';

const root = new URL('../', import.meta.url);
const output = new URL('build/', root);
// This fixed directory contains generated files only.
await fs.rm(output, { recursive: true, force: true });
const files = ['codex-temporary-mode.mjs', 'temp-codex.mjs', 'codex-accelerator.mjs', 'patch.mjs', 'postinstall.mjs', 'uninstall.mjs',
  'lib/app-server.mjs', 'lib/terminal.mjs', 'lib/setup.mjs', 'lib/installers.mjs', 'lib/vscode-adapter.mjs',
  'lib/accelerator/cli.mjs', 'lib/accelerator/command-delta.mjs', 'lib/accelerator/diagnostics.mjs',
  'lib/accelerator/diff.mjs', 'lib/accelerator/file-delta.mjs', 'lib/accelerator/hashing.mjs',
  'lib/accelerator/mcp-server.mjs', 'lib/accelerator/paths.mjs', 'lib/accelerator/raw-output.mjs',
  'lib/accelerator/session-manager.mjs', 'lib/accelerator/store.mjs', 'lib/accelerator/workspace.mjs',
  'lib/accelerator/pipeline/changed-files.mjs', 'lib/accelerator/pipeline/config.mjs',
  'lib/accelerator/pipeline/mcp-tools.mjs', 'lib/accelerator/pipeline/runner.mjs',
  'lib/accelerator/pipeline/service.mjs', 'lib/accelerator/pipeline/snapshot.mjs',
  'lib/accelerator/parsers/cargo.mjs', 'lib/accelerator/parsers/common.mjs',
  'lib/accelerator/parsers/dotnet.mjs', 'lib/accelerator/parsers/eslint.mjs',
  'lib/accelerator/parsers/generic.mjs', 'lib/accelerator/parsers/git.mjs',
  'lib/accelerator/parsers/index.mjs', 'lib/accelerator/parsers/pytest.mjs',
  'lib/accelerator/parsers/runners.mjs', 'lib/accelerator/parsers/typescript.mjs',
  'src/inject/composer-ui.js', 'src/inject/vscode-inject.cjs'];
for (const file of files) {
  const source = await fs.readFile(new URL(file, root), 'utf8');
  const { code } = await transform(source, {
    loader: 'js', target: 'es2022', minify: true, sourcemap: false,
    legalComments: 'none',
    // Preserve top-level names in scripts injected into another JavaScript context.
    ...(file.endsWith('.mjs') ? { format: 'esm' } : {}),
  });
  const destination = new URL(file, output);
  await fs.mkdir(new URL('./', destination), { recursive: true });
  await fs.writeFile(destination, code);
}
for (const file of ['codex-temporary-mode.mjs', 'temp-codex.mjs', 'codex-accelerator.mjs', 'patch.mjs', 'postinstall.mjs']) {
  await fs.chmod(new URL(file, output), 0o755);
}
console.log('Built minified release files (no source maps).');

await build({ entryPoints: [fileURLToPath(new URL('lib/uninstall.mjs', root))], outfile: fileURLToPath(new URL('lib/uninstall.mjs', output)), bundle: true, mainFields: ['module', 'main'], platform: 'node', format: 'esm', target: 'node22', minify: true, sourcemap: false, external: ['./installers.mjs', './vscode-adapter.mjs'], legalComments: 'eof' });

await fs.copyFile(new URL('node_modules/jsonc-parser/LICENSE.md', root), new URL('THIRD-PARTY-LICENSES.txt', output));
