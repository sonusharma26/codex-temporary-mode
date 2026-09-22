# codex-temporary-mode

Use Codex without saving one-off conversations to your chat history.

Works with:

* **VS Code Codex** — adds a **Temporary** mode to new chats.
* **Codex CLI** — starts temporary terminal chats.

* **Codex MCP clients** — expose an optional local Delta Mode accelerator.

> **Unofficial project. Not affiliated with or endorsed by OpenAI.**

## Install

Requirements:

* Node.js 22.13+
* Codex installed and signed in
* VS Code Codex extension `26.908.40401` and above for VS Code support

Install globally:

```sh
npm i -g codex-temporary-mode
cd /path/to/your/repository
codex-temporary-mode setup
```

`setup` performs the three local steps:

* Enables Temporary Mode in the installed VS Code Codex extension.
* Adds the Delta and Pipeline MCP server to the trusted project's `.codex/config.toml`.
* Generates `.codex/accelerator.json` when standard Node.js, Cargo, or .NET validation commands can be detected.

Run `setup` once in each repository where you want Delta and Pipeline Mode, then restart Codex or reload VS Code once. The generated MCP configuration uses the exact repository path, so validation cannot silently move to another workspace.

> On Windows, use `npm.cmd` if PowerShell blocks `npm`.

## VS Code

If you enabled VS Code support during installation, start a new Codex chat and turn on **Temporary**.

Temporary chats have:

* A purple chat input
* A **Temporary chat** label
* No saved conversation after VS Code is restarted

Existing chats are not affected.

If you skipped VS Code setup during installation, run:

```sh
codex-temporary-mode vscode install
```

Then reload VS Code once.

If you change Temporary Mode from the status bar or Command Palette, reload VS Code before starting the next chat.

## Terminal

Start a temporary Codex chat:

```sh
codex-temporary-mode
```

Useful commands:

```text
/new    Start a new temporary chat
/exit   Exit
```

By default, Codex cannot modify your files.

To allow file changes:

```sh
codex-temporary-mode --workspace-write
```

See all options:

```sh
codex-temporary-mode --help
```

## Delta Mode (v0.1)

Delta Mode is a separate local MCP process. It does not patch Codex and it does not intercept native tools. It exposes four tools:

* `read_file_delta` — exact full text on first read, then unchanged markers or textual diffs
* `run_command_delta` — compact, deterministic diagnostic changes between compatible runs
* `get_raw_output` — paged access to retained stdout/stderr when compact output is insufficient
* `reset_context_generation` — forces full source rehydration after compaction, resume, or uncertainty

File responses report exact full-source, delivered-text, and saved-text byte counts. These measure transmitted source or diff text, not estimated model tokens.

The recommended setup command adds the STDIO server automatically:

```sh
codex-temporary-mode setup
```

Use `codex-temporary-mode setup --skip-vscode` when you only want Delta and Pipeline Mode. For manual setup, use a trusted project's `.codex/config.toml`:

```toml
[mcp_servers.codex_accelerator]
command = "codex-accelerator"
args = ["mcp", "--workspace", "."]
cwd = "/absolute/path/to/repository"
default_tools_approval_mode = "writes"
tool_timeout_sec = 1800
env_vars = ["CODEX_ACCELERATOR_EPHEMERAL"]
```

The ChatGPT desktop app, Codex CLI, and Codex IDE extension share local MCP configuration. Restart the relevant client after adding the server, then use `/mcp` where available to verify the accelerator tools.

By default, SQLite state is stored in the OS-local application data directory, never inside the repository. Complete raw command output is retained outside the repository and removed when the MCP session ends. Pass `--ephemeral` to keep SQLite in memory as well. The `codex-temporary-mode` terminal client marks configured accelerator children ephemeral; the `env_vars` entry above allows Codex to forward that marker.

Commands are launched directly with an argument array and no shell. Delta Mode v0.1 rejects batch and PowerShell scripts; on Windows it resolves `npm` and `npx` through their JavaScript entry points.

`--max-output-bytes` is an explicit safety override: when set and exceeded, the command is stopped and the raw result is marked truncated. Without that option, raw output is retained in full for the session.

## Pipeline Mode (v0.2)

Pipeline Mode runs deliberately requested validation checkpoints against isolated workspace snapshots. Codex can continue editing while the single local worker validates the captured workspace. Results always identify the exact workspace tested; a stale pass never validates newer code.

It adds five MCP tools:

* `create_checkpoint` — capture and queue the current workspace
* `get_pipeline_status` — inspect the active worker and collapsed queue
* `get_latest_validation` — retrieve a compact result with current/stale freshness
* `cancel_checkpoint` — cancel queued or active work
* `run_final_validation` — block until the configured final profile validates the current workspace

Validation commands come only from the trusted repository configuration `.codex/accelerator.json`; MCP calls cannot supply arbitrary commands:

```json
{
  "pipeline": {
    "maxWorkers": 1,
    "profiles": {
      "targeted": [
        { "id": "tests", "executable": "npm", "args": ["test"], "parser": "vitest" }
      ],
      "final": [
        { "id": "tests", "executable": "npm", "args": ["test"], "parser": "vitest" }
      ]
    }
  }
}
```

Checkpointing is manual in v0.2. Queued checkpoints for the same profile collapse to the newest workspace, while a running validation is allowed to finish and is reported as historical if the live workspace changed. Raw command output remains available through `get_raw_output`.

Commands in a profile run in order and stop after a failure. Set `"continueOnFailure": true` on a command when later checks are independent and should still run.

## Uninstall

Run:

```sh
codex-temporary-mode uninstall
```

This:

* Restores supported VS Code Codex installations
* Removes the Temporary Mode setting
* Uninstalls `codex-temporary-mode`

Then reload VS Code once.

Your normal Codex installation, saved chats, project files, and unrelated VS Code settings are not removed.

## Limitations

* Temporary chats cannot be reopened later.
* Files changed during a temporary chat are **not** reverted.
* Temporary Mode does not guarantee zero retention by OpenAI.
* Terminal mode currently supports text chat only.
* VS Code support currently works with local chats only.
* Temporary-chat patching does not support cloud chats, remote connections, ChatGPT web, or ChatGPT desktop; Delta Mode uses the separate shared local MCP configuration.
* VS Code integration currently supports Codex extension `26.908.40401`. A Codex extension update may require a new `codex-temporary-mode` release.

## License

[MIT](LICENSE)
