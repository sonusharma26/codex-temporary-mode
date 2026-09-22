#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const QUESTION = '[codex-temporary-mode] Add Temporary Mode to the installed VS Code Codex extension? [Y/n] ';

function accepted(answer) {
  return !/^n(?:o)?$/i.test(String(answer ?? '').trim());
}

export function askToPatch(input = process.stdin, output = process.stdout) {
  return new Promise(resolve => {
    const prompt = createInterface({ input, output });
    prompt.question(QUESTION, answer => {
      prompt.close();
      resolve(accepted(answer));
    });
  });
}

function writeAll(fd, text, fsModule = fs) {
  const data = Buffer.from(String(text));
  let offset = 0;
  while (offset < data.length) {
    offset += fsModule.writeSync(fd, data, offset, data.length - offset, null);
  }
}

function readLine(fd, fsModule = fs) {
  const bytes = [];
  const byte = Buffer.allocUnsafe(1);
  while (bytes.length < 256) {
    const read = fsModule.readSync(fd, byte, 0, 1, null);
    if (!read || byte[0] === 10 || byte[0] === 13) break;
    bytes.push(byte[0]);
  }
  return Buffer.from(bytes).toString('utf8');
}

export function openInstallConsole({ platform = process.platform, fsModule = fs } = {}) {
  const inputDevice = platform === 'win32' ? '\\\\.\\CONIN$' : '/dev/tty';
  const outputDevice = platform === 'win32' ? '\\\\.\\CONOUT$' : '/dev/tty';
  let inputFd;
  let outputFd;
  try {
    inputFd = fsModule.openSync(inputDevice, 'r');
    outputFd = fsModule.openSync(outputDevice, 'w');
    return {
      ask() {
        writeAll(outputFd, QUESTION, fsModule);
        return accepted(readLine(inputFd, fsModule));
      },
      write(text) {
        writeAll(outputFd, text, fsModule);
      },
      close() {
        try { fsModule.closeSync(inputFd); } finally { fsModule.closeSync(outputFd); }
      },
    };
  } catch {
    if (inputFd !== undefined) try { fsModule.closeSync(inputFd); } catch {}
    if (outputFd !== undefined) try { fsModule.closeSync(outputFd); } catch {}
    return null;
  }
}

export async function postinstall({
  input = process.stdin,
  output = process.stdout,
  run = spawnSync,
  consoleFactory = openInstallConsole,
} = {}) {
  let terminal;
  let shouldPatch;

  if (input.isTTY && output.isTTY) {
    terminal = { write: text => output.write(text) };
    shouldPatch = await askToPatch(input, output);
  } else {
    terminal = consoleFactory();
    if (!terminal) {
      output.write('[codex-temporary-mode] Interactive setup was skipped because npm has no interactive terminal. Run "codex-temporary-mode setup" inside your repository to enable Temporary, Delta, and Pipeline Mode.\n');
      return false;
    }
    shouldPatch = terminal.ask();
  }

  try {
    if (!shouldPatch) {
      terminal.write('[codex-temporary-mode] VS Code patch skipped. Run "codex-temporary-mode setup" inside your repository when ready.\n');
      return false;
    }

    const result = run(process.execPath, [path.join(here, 'patch.mjs'), '--vscode'], { encoding: 'utf8' });
    if (result.stdout) terminal.write(result.stdout);
    if (result.stderr) terminal.write(result.stderr);
    if (result.error || result.status !== 0) {
      terminal.write('[codex-temporary-mode] VS Code was not patched. The terminal client remains installed.\n');
      return false;
    }
    terminal.write('[codex-temporary-mode] Run "codex-temporary-mode setup" inside each repository to enable Delta and Pipeline Mode, then reload VS Code once.\n');
    return true;
  } finally {
    terminal.close?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  postinstall().catch(error => {
    console.error(`[codex-temporary-mode] VS Code patch skipped: ${error.message}`);
  });
}
