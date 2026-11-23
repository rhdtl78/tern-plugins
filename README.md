# OMO Native for Tern

OMO Native opens a local OmO session as a native chat tab in Tern. It streams replies, renders assistant Markdown, and shows tool activity in expandable cards. The tab runs its own `omo` process over standard input and output rather than embedding the OmO terminal UI.

## Setup

Use a local Tern session with **Native program surfaces** enabled. Install Bun and the `omo` executable. The launcher looks for Bun on `PATH` and falls back to `~/.bun/bin/bun`. The plugin looks for `omo` on `PATH`, next to the running Bun executable, then at `~/.bun/bin/omo`.

From the repository root, link and check the plugin:

```sh
tern plugin link "$PWD/plugins/omo-native"
tern plugin list
```

Look for `omo-native` in the list. Tern links the package where it is, so keep that directory in place while the link is active. The existing `omo` plugin has a separate ID. Leave its link in place.

To unlink only OMO Native:

```sh
tern plugin unlink omo-native
```

## Start and control a session

Open the command palette, search for `OMO`, and select **OMO: New Session**. The command opens a fresh chat in a new tab. It uses the focused terminal or agent pane's working directory when available. Otherwise, Tern uses its normal new-tab directory.

- **Enter** sends the draft. **Shift+Enter** inserts a newline. Pasting text doesn't send it.
- Click a tool card's header to expand or collapse it. **Ctrl+O** toggles the tool cards as a group.
- Click **Stop** to cancel a running turn and return to the composer. Escape didn't stop the turn reliably in Tern 0.9.31. Use the button.
- Press **Ctrl+D** to close the OmO session gracefully and restore the terminal's input settings.

Confirmation requests require an explicit choice. Enter doesn't approve them. The footer shows the model reported by OmO. There is no model picker.

## Reopen a saved session

There is no resume picker or Resume palette command. In a local Tern terminal pane, change to the working directory recorded in the saved session's JSONL header, then run:

```sh
cd "/absolute/path/to/saved-working-directory" &&
  bun run "/absolute/path/to/tern-plugins/plugins/omo-native/main.ts" \
    --session "/absolute/path/to/session.jsonl"
```

Replace both file paths with the actual paths to the plugin entry and the saved JSONL file. The plugin rejects a relative session path or a working directory that doesn't match the saved one. A successful reopen shows the saved transcript before you send another message.

## Verification

The recorded checks used the real Tern 0.9.31 renderer, `omo` 5.1.81, and Bun 1.4.2. The conversation checks ran in an isolated profile against a deterministic synthetic model on localhost. The tool check only read a scratch fixture file.

The checks covered the palette launch, multiline input, streaming replies, tool disclosure, **Stop**, and reopening a saved transcript. The package's Bun suite recorded 10 passing tests and no failures. These checks did not cover external provider authentication.
