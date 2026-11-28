# OMO Native for Tern

[Back to the Tern plugin collection](../README.md)

OMO Native opens a local OmO session as a native chat tab in Tern. It streams replies, renders assistant Markdown, and shows tool activity in expandable cards. The tab runs its own `omo` process over standard input and output rather than embedding the OmO terminal UI.

## Setup

Use a local Tern session with **Native program surfaces** enabled. Install Bun and the `omo` executable. The launcher looks for Bun on `PATH` and falls back to `~/.bun/bin/bun`. The plugin looks for `omo` on `PATH`, next to the running Bun executable, then at `~/.bun/bin/omo`.

With `git` on your `PATH`, install the plugin from GitHub. You don't need a local checkout. If you previously linked OMO Native from a checkout, run `tern plugin unlink omo-native` first. Leave any link for the separate `omo` plugin in place.

```sh
tern plugin install github.com/rhdtl78/tern-plugins/omo-native
tern plugin list
```

Look for `omo-native` in the list.

### Mobile setup (Android and iOS)

Install OMO Native in two places if you want to use its commands from the
mobile Tern palette:

- **On the connected computer:** follow [Setup](#setup) above. The computer
  runs the chat and needs Bun, OmO, and the `omo-native` launcher available to
  the Tern host. You do not need to install Bun or OmO on the phone.
- **In the mobile Tern app:** install the plugin folder so that the mobile
  window registers its own palette commands. Installing it on the computer
  alone does not add those commands to the phone.

1. Copy the entire `omo-native` package folder from the computer's Tern plugins
   folder (`tern plugin dir`). If the computer uses a linked plugin, copy the
   folder the link points to. Copy the package folder itself, not the `.path`
   file, the whole repository, or a ZIP file. The destination should contain
   `Documents/Plugins/omo-native/plugin.toml` inside Tern's app storage.
2. Put the package in the mobile app's plugin folder:
   - **Android:** in Tern, open **Settings → Plugins → Open plugins folder**.
     If your build makes that folder writable through a file manager, copy
     `omo-native` into it. Use Tern's own folder, not the phone's shared
     `Documents` directory. On Tern 0.9.33, the copy was verified using debug
     ADB on a disposable Android 15 emulator; a file-manager install on a
     regular phone has not been verified. If Tern does not expose the folder,
     this guide has no verified installation method for that device.
   - **iPhone or iPad:** in Files, go to **On My iPhone** or **On My iPad →
     Tern → Plugins** and copy `omo-native` there. This is the documented
     [Tern iOS installation path](https://docs.stencil.so/tern/guides/distribution.html#ios);
     this plugin has not been verified on an iOS TestFlight build.
3. In the mobile app's **Plugins** settings, enable **Load plugins**, enable
   **OMO Native**, and tap **Reload**. Check that the mobile copy says
   **Ready**. Then search for `OMO` in the palette's **All** scope. If none of
   the OMO commands appear, check the mobile copy's load status first.
4. Connect the mobile app to the computer running OmO. If the palette
   commands appear but cannot launch a chat, check that `command -v omo-native`
   resolves in a terminal on that host. In an already open OMO Native chat,
   `/new` and `/resume` are separate from the palette: the chat handles those
   commands on the connected computer.

On the Android 15 emulator, Tern 0.9.33 with OMO Native 0.2.0 showed
**OMO: New Session**, **OMO: Resume Session**, and **OMO: Toggle Workflow**
with the mobile plugin enabled. Turning it off removed all three. In a
host-connected chat, `/new` and `/resume` worked; launching those actions from
the paired palette and restoring a transcript containing messages were not
verified.

### Update OMO Native

If OMO Native is already installed from GitHub, run:

```sh
tern plugin install github.com/rhdtl78/tern-plugins/omo-native --force
tern plugin list
```

Tern replaces the installed copy and prints the Git commit it installed. If OMO Native is still linked from a local checkout, follow the unlink and install steps above instead. To use the updated code in an existing OMO Native chat, close and reopen the chat. If you sourced `shell-integration.sh`, start a fresh shell and source it again to pick up changes to the shell function itself.

### Remove OMO Native

To remove only the installed OMO Native plugin:

```sh
tern plugin remove omo-native
```

### Use the current shell pane instead of opening a tab

After installing the plugin, opt in for **this interactive Bash or Zsh shell only**:

```sh
source "$(tern plugin dir)/omo-native/shell-integration.sh"
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

Installing the plugin does not automatically enable the shell function.
If you sourced the function and it was installed, undo just that opt-in with
`unset -f omo; unset _omo_native_dir`, or start a fresh shell. No shell profile
or OmO session files need changing. Remove the plugin separately if desired.

## Start and control a session

Open the command palette, search for `OMO`, and select **OMO: New Session**. The command opens a fresh chat in a new tab. It uses the focused terminal or agent pane's working directory when available. Otherwise, Tern uses its normal new-tab directory.

- **Enter** sends the draft. **Shift+Enter** inserts a newline. Pasting text doesn't send it.
- Paste a copied local file or clipboard image into the composer on a Tern host with rich clipboard paste. A typed or plain-text path stays text. PNG, JPEG, GIF and WebP images show thumbnails and are sent as image data when the selected model accepts images. Other files appear by name, type and size but cannot be sent by OmO's image-only attachment RPC. Remove them with **×** before sending; nothing is run or unpacked. The composer accepts up to six items and 4 MiB of images per message. Thumbnails require Bun's image API and are limited to source images of at most 16 megapixels.
- At the start of an idle draft, type `/` and part of a name. Use the arrow keys and Enter, or tap a command. OmO extension commands and prompt templates are inserted for editing; native session commands run locally without sending a model prompt. Escape closes the list without clearing the draft.
- The native session commands are `/new`, `/resume` (also `/sessions`), `/rename` (also `/name`), `/session`, `/tree`, `/fork`, and `/clone`. `/resume`, `/tree`, and `/fork` open pickers. Use `/rename My session` to supply a name directly. Export, import, and sharing from the terminal UI are not provided by this plugin.
- The saved OmO session name supplies the default Tern title when the chat pane is active. A name set directly on the Tern tab stays local and is never written back to OmO.
- An unnamed new session can get a title from its first accepted prompt, including after `/new`. The plugin uses OmO's effective Quick model only when it resolves to OpenCode Go's Anthropic Messages adapter. It sends up to 600 characters of the typed prompt and a short title instruction in one guarded, tool-free request. It does not send attachments, session history, or workspace context. Unsupported routes or failed requests leave the title unchanged, with no alternate model or retry. A saved OmO name always takes precedence.
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

### Choose model settings

When the session is idle, open **Model settings** from the footer or press **Ctrl+S**. The button shows the model name in uppercase, followed by the reported Thinking level. Fast adds one bolt, Ultrafast adds two overlapping bolts, and Standard has no bolt. The popover opens above the button and shows the confirmed Thinking level. Move the stepped slider to choose a supported level, or use **←** and **→** and press **Enter** to apply.

Click the model name to open a scrollable list in the same popover. Type part of a model name, provider, or model ID to filter the list. Click a model, or highlight it with **↑**, **↓**, or **Tab** and press **Enter**. **Speed** appears at the top left only when OmO confirms switchable variants; the bolt marks Fast. Hover or click it to see the available tiers and the checked current tier, or press **Ctrl+S** again to enter Speed with the keyboard. **Back** returns to Thinking without applying a change.

Press **Escape**, click **Close**, or click outside to dismiss the popover. Changes affect the current session, not the device default, and leave your draft and attachments intact and unsent. The footer reflects OmO's confirmed session state, not just what you selected. An engine without session-scoped model switching shows an error instead.

When OmO reports current subscription quota for the account this session uses, a provider ring appears beside Model settings. The ring shows the remaining share of the most depleted reported base window. Its tooltip gives the window and both percentages. The ring stays hidden when a matching, current report isn't available.

## Reopen a saved session

From a terminal or agent pane in the original project, choose **OMO: Resume Session** in the palette. It opens the picker in a separate tab. No OmO session starts while you browse. The picker lists saved local sessions whose recorded working directory resolves to this project, newest first. Worker sessions and files without any saved entries are excluded.

On mobile, see [Mobile setup](#mobile-setup-android-and-ios) for palette
installation. To switch within an existing chat, use `/resume`; cancelling
leaves the existing chat and draft unchanged.

Type to filter by title, filename, or displayed date. Use the same row controls as the model picker, then press **Enter** or click **Resume**. The plugin rechecks the file and working directory before opening the transcript. If the file is gone, click **Reload** to refresh the list. **Escape** or **Cancel** exits this launcher without opening a session.

You can also launch the picker directly from a local Tern terminal:

```sh
cd "/absolute/path/to/saved-working-directory" &&
  bun run "$(tern plugin dir)/omo-native/main.ts" --resume
```

To bypass the picker, pass an absolute path:

```sh
cd "/absolute/path/to/saved-working-directory" &&
  bun run "$(tern plugin dir)/omo-native/main.ts" \
    --session "/absolute/path/to/session.jsonl"
```

Replace the working directory and JSONL path with the actual paths for your saved session. The plugin rejects a relative session path or a working directory that doesn't match the saved one. A successful reopen shows the saved transcript before you send another message.

## Verification

**Workflow.** Use the composer’s **Workflow** button to open one read-only split in the current tab. The DAG page shows the selected run, node states, and dependencies. It keeps the dependency list when the pane is narrow or image support is unavailable. The Plan page shows the current session’s structured Todo, including Todo restored with the transcript.

Plan reads the workspace's Boulder v2 registry (`.omo/boulder.json`) for an exact match to the durable OmO session ID. A plain Todo does not create a link. A registered worktree may supply a copy under `.omo/plans/`; if that copy is absent, Plan can use the original. An unverified worktree or unsafe file path hides the link. A lost RPC connection marks the last data disconnected. Closing the chat closes the split; resume the chat to reconnect.

Run `bun test ./omo-native` from the repository root. To exercise the native pickers in an isolated Tern profile:

1. Open **OMO: New Session**, type a draft, then click `[data-id="model"]`. In `.sf-picker[data-role="omo.models"]`, type a query and inspect `.pk-search .q` and `.pk-row.sel`. Cancel and check that `[data-id="draft"]` still contains the unsent text.
2. Reopen the picker and select another provider/model pair. Click `[data-pk="act"][data-v="use"]`. Check that the footer changes without a new transcript entry. Send the draft explicitly and check the selected model in the isolated engine log.
3. In a project with saved history, open **OMO: Resume Session**. In `.sf-picker[data-role="omo.sessions"]`, confirm that another project's sessions are absent. Filter, select a `[role="option"]`, and press **Enter**. Check for a message unique to that saved transcript and verify that the original tab is unchanged.
4. Open **Resume Session** in an empty project and cancel. Check that the engine received no `open_session` request from that tab. To check stale files, remove a disposable saved fixture after the picker lists it and before activating its row. Check for an error rather than a fresh chat.
