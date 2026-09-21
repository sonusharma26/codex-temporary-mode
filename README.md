# codex-temporary-mode

Use Codex without saving one-off conversations to your chat history.

Works with:

* **VS Code Codex** — adds a **Temporary** mode to new chats.
* **Codex CLI** — starts temporary terminal chats.

> **Unofficial project. Not affiliated with or endorsed by OpenAI.**

## Install

Requirements:

* Node.js 22+
* Codex installed and signed in
* VS Code Codex extension `26.908.40401` and above for VS Code support

Install globally:

```sh
npm i -g codex-temporary-mode
```

During installation, you can choose to enable Temporary Mode in VS Code.

After installation, **reload VS Code once**.

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
* Cloud chats, remote connections, ChatGPT web, and ChatGPT desktop are not supported.
* VS Code integration currently supports Codex extension `26.908.40401`. A Codex extension update may require a new `codex-temporary-mode` release.

## License

[MIT](LICENSE)
