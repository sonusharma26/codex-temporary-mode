import { execFileSync } from 'node:child_process';
import { canonicalRelativePath } from '../paths.mjs';

export class ChangedFilesError extends Error {
  constructor(code, message) { super(message); this.name = 'ChangedFilesError'; this.code = code; }
}

function git(workspaceRoot, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', ['--no-optional-locks', ...args], {
      cwd: workspaceRoot,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    if (allowFailure) return null;
    throw new ChangedFilesError('GIT_ERROR', `Could not list changed files: git ${args.join(' ')}`);
  }
}

function decodeNullPaths(output) {
  if (!output?.length) return [];
  const values = output.subarray(0, output.at(-1) === 0 ? -1 : undefined).toString('binary').split('\0');
  return values.filter(Boolean).map(value => {
    const bytes = Buffer.from(value, 'binary');
    const decoded = bytes.toString('utf8');
    if (!Buffer.from(decoded, 'utf8').equals(bytes)) throw new ChangedFilesError('UNSUPPORTED_PATH_ENCODING', 'Git returned a non-UTF-8 path.');
    return canonicalRelativePath(decoded);
  });
}

/** List the worktree paths whose current contents differ from HEAD, including nonignored untracked files. */
export function listChangedFiles(workspaceRoot) {
  let tracked = git(workspaceRoot, ['diff', '--name-only', '-z', '--diff-filter=ACDMRTUXB', 'HEAD', '--'], { allowFailure: true });
  if (tracked === null) {
    const staged = git(workspaceRoot, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACDMRTUXB', '--']);
    const unstaged = git(workspaceRoot, ['diff', '--name-only', '-z', '--diff-filter=ACDMRTUXB', '--']);
    tracked = Buffer.concat([staged, unstaged]);
  }
  const untracked = git(workspaceRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--']);
  return [...new Set([...decodeNullPaths(tracked), ...decodeNullPaths(untracked)])]
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}
