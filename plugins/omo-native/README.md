# OMO Native for Tern

[Back to the Tern plugin collection](../../README.md)

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

Confirmation requests require an explicit choice. Enter doesn't approve them.

### View the workflow

Click **Workflow** or press **Ctrl+G** to open a read-only split to the right of the chat. You can also choose **OMO: Toggle Workflow** from the command palette when a local chat launched by the plugin has focus. The split starts closed and follows only the chat that opened it. Click **Close** or press **Escape** in the split to dismiss it without sending or clearing your draft.

- **DAG** lists this session's OmO runs. Select a run to see its status and dependencies. When the pane has room, arrows connect task cards from top to bottom. Select a node from the dependency list to see its predecessors and any available failure or blocked reason. The list remains available if the pane is narrow or Tern cannot draw the graph.
- **Plan** shows the current session's Todo. If OmO associates a `/ulw-execute` plan with this session, **Open** opens that Markdown file in a Tern tab. The link appears again when you resume the same session. There is no manual link setup.

### Choose a model

When the session is idle, click the model name in the footer. Type part of a model name, provider, or model ID to filter the list. Use **↑** and **↓** to select a row. Press **Enter** or click **Use model** to apply it. You can also click a row to select it, then click the selected row to apply it.

**Escape** or **Cancel** dismisses the picker without changing the model. Neither selecting a model nor cancelling sends your draft. The footer updates after OmO confirms the switch. The switch affects this session, not the device default. An engine without the `session_model_scope` capability shows an error instead.

## Reopen a saved session

From a terminal or agent pane in the original project, choose **OMO: Resume Session** in the palette. It opens the picker in a separate tab. No OmO session starts while you browse. The picker lists saved local sessions whose recorded working directory resolves to this project, newest first. Worker sessions and files without any saved entries are excluded.

Type to filter by title, filename, or displayed date. Use the same row controls as the model picker, then press **Enter** or click **Resume**. The plugin rechecks the file and working directory before opening the transcript. If the file is gone, click **Reload** to refresh the list. **Escape** or **Cancel** exits this launcher without opening a session.

You can also launch the picker directly from a local Tern terminal:

```sh
cd "/absolute/path/to/saved-working-directory" &&
  bun run "/absolute/path/to/tern-plugins/plugins/omo-native/main.ts" --resume
```

To bypass the picker, pass an absolute path:

```sh
cd "/absolute/path/to/saved-working-directory" &&
  bun run "/absolute/path/to/tern-plugins/plugins/omo-native/main.ts" \
    --session "/absolute/path/to/session.jsonl"
```

Replace both file paths with the actual paths to the plugin entry and the saved JSONL file. The plugin rejects a relative session path or a working directory that doesn't match the saved one. A successful reopen shows the saved transcript before you send another message.

## Verification

**Workflow.** Use the composer’s **Workflow** button to open one read-only split in the current tab. The DAG page shows the selected run, node states, and dependencies. It keeps the dependency list when the pane is narrow or image support is unavailable. The Plan page shows the current session’s structured Todo, including Todo restored with the transcript.

Plan reads the workspace's Boulder v2 registry (`.omo/boulder.json`) for an exact match to the durable OmO session ID. A plain Todo does not create a link. A registered worktree may supply a copy under `.omo/plans/`; if that copy is absent, Plan can use the original. An unverified worktree or unsafe file path hides the link. A lost RPC connection marks the last data disconnected. Closing the chat closes the split; resume the chat to reconnect.

Run `bun test ./plugins/omo-native` from the repository root. To exercise the native pickers in an isolated Tern profile:

1. Open **OMO: New Session**, type a draft, then click `[data-id="model"]`. In `.sf-picker[data-role="omo.models"]`, type a query and inspect `.pk-search .q` and `.pk-row.sel`. Cancel and check that `[data-id="draft"]` still contains the unsent text.
2. Reopen the picker and select another provider/model pair. Click `[data-pk="act"][data-v="use"]`. Check that the footer changes without a new transcript entry. Send the draft explicitly and check the selected model in the isolated engine log.
3. In a project with saved history, open **OMO: Resume Session**. In `.sf-picker[data-role="omo.sessions"]`, confirm that another project's sessions are absent. Filter, select a `[role="option"]`, and press **Enter**. Check for a message unique to that saved transcript and verify that the original tab is unchanged.
4. Open **Resume Session** in an empty project and cancel. Check that the engine received no `open_session` request from that tab. To check stale files, remove a disposable saved fixture after the picker lists it and before activating its row. Check for an error rather than a fresh chat.
