# OMO Native for Tern

[Back to the Tern plugin collection](../README.md)

OMO Native opens a local OmO session as a native chat tab in Tern. It streams replies, renders assistant Markdown, and shows tool activity in expandable cards. The tab runs its own `omo` process over standard input and output rather than embedding the OmO terminal UI.

## Setup

Use a local Tern session with **Native program surfaces** enabled. Install Bun and the `omo` executable. The launcher looks for Bun on `PATH` and falls back to `~/.bun/bin/bun`. The plugin looks for `omo` on `PATH`, next to the running Bun executable, then at `~/.bun/bin/omo`.

From the repository root, link and check the plugin:

```sh
tern plugin link "$PWD/omo-native"
tern plugin list
```

Look for `omo-native` in the list. Tern links the package where it is, so keep that directory in place while the link is active. The existing `omo` plugin has a separate ID. Leave its link in place.

To unlink only OMO Native:

```sh
tern plugin unlink omo-native
```

### Use the current shell pane instead of opening a tab

From the checkout root, opt in for **this interactive Bash or Zsh shell only**:

```sh
source "$PWD/omo-native/shell-integration.sh"
cd "/path/to/your/project"
omo
```

`omo` negotiates an inline chat with the terminal. `omo --resume` and `omo -r`
open the saved-session picker for the directory you are in when you run them.
Press **Ctrl+D** to return to the same shell, or **Escape** to cancel the picker.
The shell waits while the chat is open. Workflow can still open its own split.

The function never replaces the installed executable or an existing `omo`
alias/function. Without a TSP reply (including when **Native program surfaces**
is off), it runs the ordinary CLI once with the original arguments. Other
arguments, pipes, redirections, noninteractive shells and terminal multiplexers
use the ordinary CLI. After TSP accepts the session, an error is shown in place;
it does not start a second TUI. To bypass the function once, use `command omo`.

Linking the palette plugin and sourcing the shell function are independent.
If you sourced the function and it was installed, undo just that opt-in with
`unset -f omo; unset _omo_native_dir`, or start a fresh shell. No shell profile
or OmO session files need changing. Unlink the plugin separately if desired.

## Start and control a session

Open the command palette, search for `OMO`, and select **OMO: New Session**. The command opens a fresh chat in a new tab. It uses the focused terminal or agent pane's working directory when available. Otherwise, Tern uses its normal new-tab directory.

- **Enter** sends the draft. **Shift+Enter** inserts a newline. Pasting text doesn't send it.
- Paste a copied local file or clipboard image into the composer on a Tern host with rich clipboard paste. A typed or plain-text path stays text. PNG, JPEG, GIF and WebP images show thumbnails and are sent as image data when the selected model accepts images. Other files appear by name, type and size but cannot be sent by OmO's image-only attachment RPC. Remove them with **×** before sending; nothing is run or unpacked. The composer accepts up to six items and 4 MiB of images per message. Thumbnails require Bun's image API and are limited to source images of at most 16 megapixels.
- At the start of an idle draft, type `/` and part of a name to find commands from this session. Use the arrow keys and Enter, or click a command, to insert it. Edit its arguments, then press Enter to send. Escape closes the list without clearing the draft. The list does not add terminal-only commands or dollar-syntax skills. If the engine does not provide a list, type and send as usual.
- During a running turn, **Cmd+Enter** steers the turn and **Ctrl+Enter** queues the draft as a follow-up. Plain **Enter** leaves the draft in place while a turn is running.
- Click a tool card's header to expand or collapse it. **Ctrl+O** toggles the tool cards as a group.
- Press **Escape** in the chat or click the square **Stop turn** icon to stop the current turn. Stopping preserves an unsent draft and does not cancel the session's background jobs. Status badges and the spinner appear above the composer without moving the editor. The spinner stays visible while the main turn or session-owned background work is running.
- Press **Ctrl+D** to close the OmO session gracefully and restore the terminal's input settings.

Confirmation requests require an explicit choice. Enter doesn't approve them.

### Edit a draft

Editing shortcuts apply in the focused composer. Tern handles selection,
clipboard operations, and IME composition; the plugin applies the resulting
edits and keeps draft undo/redo history. Typing, pasting, or deleting replaces a
selection. Selecting or moving the caret does not create an undo step.

| Action | macOS | Windows/Linux |
| --- | --- | --- |
| Select all | Cmd+A | Ctrl+A |
| Cut / copy / paste | Cmd+X / Cmd+C / Cmd+V | Ctrl+X / Ctrl+C / Ctrl+V |
| Undo / redo | Cmd+Z / Cmd+Shift+Z | Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y |
| Move by character or line | Arrow keys | Arrow keys |
| Move by word | Option+Left/Right | Ctrl+Left/Right |
| Move to line start/end | Cmd+Left/Right | Home/End |
| Move to draft start/end | Cmd+Up/Down | Ctrl+Home/End |
| Extend selection | Shift with the movement shortcut | Shift with the movement shortcut |
| Delete backward/forward | Delete / Fn+Delete | Backspace / Delete |
| Delete by word | Option+Delete / Option+Fn+Delete | Ctrl+Backspace / Ctrl+Delete |

Selection and clipboard bindings follow the host Tern editor and its platform
keymap. The composer edits plain text: type Markdown for bold (`**text**`),
italic (`*text*`), or links (`[label](url)`). It does not take over app shortcuts
such as Cmd+B, Cmd+I, or Cmd+K. When the slash menu is open, unmodified Up/Down
still navigate the menu.

### View the workflow

Click **Workflow** or press **Ctrl+G** to open a read-only split to the right of the chat. You can also choose **OMO: Toggle Workflow** from the command palette when a local chat launched by the plugin has focus. The split starts closed and follows only the chat that opened it. When the window has room, Workflow targets an initial width of 420 px. Drag the divider to change its width. Switch pages with the top **DAG** and **Plan** tabs. Use the top **×** or press **Escape** in the split to dismiss it without sending or clearing your draft.

- **DAG** groups each dependent node with its prerequisites. If the session has multiple runs, choose one from the dropdown. Click a card to inspect its state, attempts, measured runtime, routing, and any safe blocking reason. A successful node can show a short plain-text result. An agent's configured model does not identify which model ran. Click the selected card again or use **×** to close its details. Use **Predecessor** or **Successor** to follow an edge, or **←** and **→** to move in list order. A narrow pane or renderer without graph support shows all nodes as selectable rows. The **Background activity** section lists supported session-owned agents, shell jobs, and monitors separately from the DAG.
- **Plan** shows the current session's Todo. If OmO associates a `/ulw-execute` plan with this session, **Open** opens that Markdown file in a Tern tab. The link appears again when you resume the same session. There is no manual link setup.

### Choose a model

When the session is idle, click the model name in the footer. Type part of a model name, provider, or model ID to filter the list. Use **↑** and **↓** to select a row. Press **Enter** or click **Use model** to apply it. You can also click a row to select it, then click the selected row to apply it.

**Escape** or **Cancel** dismisses the picker without changing the model. Neither selecting a model nor cancelling sends your draft. The footer updates after OmO confirms the switch. The switch affects this session, not the device default. An engine without the `session_model_scope` capability shows an error instead.

When OmO reports current subscription quota for the account this session uses, a provider ring appears beside the model. The ring shows the remaining share of the most depleted reported base window. Its tooltip gives the window and both percentages. The ring stays hidden when a matching, current report isn't available.

## Reopen a saved session

From a terminal or agent pane in the original project, choose **OMO: Resume Session** in the palette. It opens the picker in a separate tab. No OmO session starts while you browse. The picker lists saved local sessions whose recorded working directory resolves to this project, newest first. Worker sessions and files without any saved entries are excluded.

Type to filter by title, filename, or displayed date. Use the same row controls as the model picker, then press **Enter** or click **Resume**. The plugin rechecks the file and working directory before opening the transcript. If the file is gone, click **Reload** to refresh the list. **Escape** or **Cancel** exits this launcher without opening a session.

You can also launch the picker directly from a local Tern terminal:

```sh
cd "/absolute/path/to/saved-working-directory" &&
  bun run "/absolute/path/to/tern-plugins/omo-native/main.ts" --resume
```

To bypass the picker, pass an absolute path:

```sh
cd "/absolute/path/to/saved-working-directory" &&
  bun run "/absolute/path/to/tern-plugins/omo-native/main.ts" \
    --session "/absolute/path/to/session.jsonl"
```

Replace both file paths with the actual paths to the plugin entry and the saved JSONL file. The plugin rejects a relative session path or a working directory that doesn't match the saved one. A successful reopen shows the saved transcript before you send another message.

## Verification

**Workflow.** Use the composer’s **Workflow** button to open one read-only split in the current tab. The DAG page shows the selected run, node states, and dependencies. It keeps the dependency list when the pane is narrow or image support is unavailable. The Plan page shows the current session’s structured Todo, including Todo restored with the transcript.

Plan reads the workspace's Boulder v2 registry (`.omo/boulder.json`) for an exact match to the durable OmO session ID. A plain Todo does not create a link. A registered worktree may supply a copy under `.omo/plans/`; if that copy is absent, Plan can use the original. An unverified worktree or unsafe file path hides the link. A lost RPC connection marks the last data disconnected. Closing the chat closes the split; resume the chat to reconnect.

Run `bun test ./omo-native` from the repository root. To exercise the native pickers in an isolated Tern profile:

1. Open **OMO: New Session**, type a draft, then click `[data-id="model"]`. In `.sf-picker[data-role="omo.models"]`, type a query and inspect `.pk-search .q` and `.pk-row.sel`. Cancel and check that `[data-id="draft"]` still contains the unsent text.
2. Reopen the picker and select another provider/model pair. Click `[data-pk="act"][data-v="use"]`. Check that the footer changes without a new transcript entry. Send the draft explicitly and check the selected model in the isolated engine log.
3. In a project with saved history, open **OMO: Resume Session**. In `.sf-picker[data-role="omo.sessions"]`, confirm that another project's sessions are absent. Filter, select a `[role="option"]`, and press **Enter**. Check for a message unique to that saved transcript and verify that the original tab is unchanged.
4. Open **Resume Session** in an empty project and cancel. Check that the engine received no `open_session` request from that tab. To check stale files, remove a disposable saved fixture after the picker lists it and before activating its row. Check for an error rather than a fresh chat.
