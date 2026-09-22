# codex-temporary-mode changelog

## 3.3.0

- Added Delta Mode with version-aware file reads, compact command diagnostics, raw-output retrieval and context rehydration.
- Added Pipeline Mode with isolated validation snapshots, asynchronous checkpoints, queue collapsing and exact-workspace final gates.
- Added `codex-temporary-mode setup` to configure Temporary, Delta and Pipeline Mode for a trusted Git repository.
- Added automatic starter Pipeline profiles for Node.js, Cargo and .NET projects.

## 3.2.3

- Added one-command uninstall for VS Code patches, Temporary settings and the terminal package.
- Updated Bash and PowerShell uninstall scripts; repeated cleanup is safe.
- Linked the npm package to its GitHub repository.

## 3.2.2

- Renamed the package and primary command to `codex-temporary-mode`; the `temp-codex` alias remains available.

- Publish minified build files instead of the original project source.
- Simplified the README for installation and everyday use.

## 3.2.1

- Renamed the project to **GhostThread — Temporary Mode for Codex**.
- Added `ghostthread` as the main command; `temp-codex` still works.
- Kept compatibility with existing VS Code installations.
- Simplified installation, usage and publishing documentation.

## 3.2.0

- Added temporary chats in the terminal.
- Added a verification command to check that a chat is not saved.
- Improved handling of errors, timeouts and closed sessions.
- Made terminal chats read-only by default, with an option to allow file edits.
- Added npm packaging and the MIT license.

## 3.1.0

- Added the Temporary switch in VS Code.
- Added a purple background to distinguish temporary chats.
- Improved switching between normal and temporary mode.

## 3.0.1

- Fixed temporary chats appearing in VS Code history.
- Added checks for supported extension versions and safer restoration.
- Removed desktop support.
- Made VS Code changes an explicit installation step.
