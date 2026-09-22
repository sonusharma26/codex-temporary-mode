#!/usr/bin/env node
import { main } from './lib/accelerator/cli.mjs';

main().catch(error => {
  process.stderr.write(`[codex-accelerator] ${error?.message || String(error)}\n`);
  process.exitCode = 1;
});
