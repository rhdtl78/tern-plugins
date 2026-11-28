import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { OmoRpc, RpcCommandError, type RpcRecord } from "./rpc";
import { add, InputStream, node, plain, record, string, Surface, surface, type Input, type Op } from "./surface";
import { SlashMenu } from "./slash";
import { Editor, isStopKey, type SubmitMode } from "./editor";
import { Transcript } from "./transcript";
import omoIcon from "./omo-icon.svg" with { type: "text" };
import { dialog } from "./dialog";
import { resumeFields, sessionActivity } from "./session";
import { entryRows, sessionCommand } from "./session-commands";
import { listSavedSessions } from "./history";
import { Picker, savedRows, selectedSession } from "./picker";
import { modelSettingsKey, SessionSettings, settingsCss, settingsNode } from "./model-settings";
import { SettingsPicker } from "./settings-picker";
import { settingsPanelCss } from "./settings-panel-style";
import { supportsWorkflow, Workflow } from "./workflow";
import { launchWorkflowPane, workflowCompanion } from "./workflow-pane";
import { ActivityProjection } from "./activity";
import { renderUsage, supportsUsage, UsageMeter, usageCss } from "./usage";
import { ComposerMode } from "./composer-mode";
import { composerCss } from "./composer-style";
import { PaneTerminal } from "./pane-terminal";
import { SessionTitle } from "./session-title";
import { QuickTitleClient } from "./quick-title-client";
import { Clipboard, clipboardTimeoutNotice } from "./clipboard";
import { attachmentCard, attachmentCount, clipboardFile, clipboardImage, fileEntries, sendBlock, type Attachment } from "./attachments";

const screen = new Surface(), draft = new Editor();
const sessionTitle = new SessionTitle(sequence => process.stdout.write(sequence));
const input = new InputStream(() => { if (!clipboard.pending) clipboardError(clipboardTimeoutNotice); });
const composerMode = new ComposerMode();
let editor = draft;
const workflowIntent = "workflow-open-intent";
const frame = (...ops: Op[]) => screen.frame(...ops);
const slash = new SlashMenu(frame);
let workflowFrame: ((...ops: Op[]) => void) | undefined;
let workflowLaunch: AbortController | undefined;
let workflowLifetime: Promise<void> | undefined;
const workflow = new Workflow((...ops) => workflowFrame?.(...ops));
let transcript: Transcript;
let authorIcon: string | undefined;
const transcriptNodes = new Set<string>();
const cwd = process.cwd();
let rpc: OmoRpc | undefined, unsubscribe: (() => void) | undefined;
let quickTitle: QuickTitleClient | undefined;
let background: ActivityProjection | undefined, quota: UsageMeter | undefined;
let quotaAvailable = false;
let live = false, ready = false, closing = false, busy = false, welcome = true;
let submitting = false, stopping = false, activity = 0;
let status: "" | "Opening session…" | "Stopping…" = "Opening session…";
let seq = 0, answering = false, failureShown = false;
let ask: ReturnType<typeof dialog> | undefined;
let picker: Picker | undefined;
const settings = new SessionSettings((model, ops) => {
  void quota?.setModel(model);
  frame(...ops);
  refresh();
});
let workflowAvailable = false;
let toastId: string | undefined;
const attachments = new Map<string, Attachment>();
let attachmentError = "", previews = false, pasting = false, pasteEpoch = 0;
const clipboard = new Clipboard(packet => process.stdout.write(packet), (mime, bytes) => {
  if (canPaste() || (mime === "text/plain" && (ask?.typed || picker))) void paste(mime, bytes);
}, (reason, cause) => {
  if (cause === "timeout") input.expireClipboardFrame("transfer");
  clipboardError(reason);
});
const pendingRows = new Set<string>();
const fromShell = process.argv[2] === "--from-shell", args = process.argv.slice(fromShell ? 3 : 2);
const resume = args.length === 1 && (args[0] === "--resume" || args[0] === "-r");
const terminal = new PaneTerminal(input, fromShell);
const waiting = new Map<string, RpcRecord>();
const why = (e: unknown) => plain(e instanceof Error ? e.message : String(e));
const canPaste = () => ready && !closing && !picker && !ask;
function clipboardError(reason: string) { if (canPaste()) { attachmentError = reason; refresh(); } }

async function paste(mime: string, bytes: Buffer) {
  if (mime === "text/plain") {
    handle({ kind: "paste", value: bytes.toString("utf8").replace(/\r\n?/g, "\n") });
    return;
  }
  if (pasting || submitting) { notify("Try pasting again after the current operation finishes."); return; }
  const room = attachmentCount - attachments.size;
  const entries = mime === "text/uri-list" ? fileEntries(bytes) : undefined;
  attachmentError = !room || (entries?.length ?? 0) > room
    ? `Attach up to ${attachmentCount} items at a time.` : entries?.length === 0 ? "No local files in this paste." : "";
  if (!room) { refresh(); return; }
  const epoch = pasteEpoch;
  pasting = true; refresh();
  try {
    const files = entries
      ? await Promise.all(entries.slice(0, room).map(uri => clipboardFile(uri, previews)))
      : [await clipboardImage(mime, bytes, previews)];
    if (!canPaste() || epoch !== pasteEpoch) return;
    for (const file of files) {
      const id = `attachment${++seq}`;
      attachments.set(id, file);
      const blob = file.preview && screen.blob("image/png", file.preview);
      frame(attachmentCard(id, file, blob));
    }
  } finally {
    pasting = false;
    if (!closing) refresh();
  }
}

function cancelPaste() { pasteEpoch++; clipboard.cancel(); }

function refresh() {
  const canSend = ready && !busy && !submitting && !stopping && !ask && !picker && !settings.applying;
  const reason = attachmentError || (!attachments.size ? undefined : sendBlock([...attachments.values()], settings.input));
  if (!canSend) slash.close();
  const backgroundView = background?.view;
  const { agents, jobs, jobsMayBeHigher } = backgroundView?.running ?? { agents: 0, jobs: 0 };
  const running = [agents ? `${agents} agent${agents === 1 ? "" : "s"}` : "",
    jobs ? jobsMayBeHigher ? `${jobs}+ jobs` : `${jobs} job${jobs === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  const border = ready ? composerMode.border(!ask && !picker ? draft.text : undefined) : undefined;
  frame(["set", "draft", { text: editor.text, cursor: editor.cursor, readonly: !!picker || !ready || (!!ask && !ask.typed),
    placeholder: ask?.typed ? "Type your answer" : "Message OMO", sendable: canSend,
    aria: ask?.typed ? "Type your answer" : border === "ulw-running" ? "Message OMO · ULW running"
      : border === "ulw-preview" ? "Message OMO · ULW preview"
      : border === "research-preview" ? "Message OMO · Research preview" : "Message OMO" }],
    ["set", "composer-mode", { role: border ?? "normal" }],
    ["set", "attachments", { hidden: !!ask || !attachments.size }],
    ["set", "attachment-error", { hidden: !!ask || !reason, text: reason ?? "" }],
    ["set", "send", { hidden: !canSend && !ask?.typed }],
    ["set", "model", { attrs: {
      "aria-disabled": String(!canSend && !(picker instanceof SettingsPicker && !picker.applying)),
    } }],
    ["set", "stop", { hidden: !busy || !!ask || !!picker, disabled: stopping }],
    ["set", "session-status", { text: status, hidden: !status }],
    ["set", "session-activity", { hidden: !busy && !backgroundView?.active }],
    ["set", "session-ulw", { hidden: border !== "ulw-running" }],
    ["set", "session-background-counts", { text: running, hidden: !running }]);
  if (welcome && transcript.populated) { welcome = false; frame(["del", "welcome"]); }
}
function showStatus(text: typeof status) { status = text; refresh(); }
function showPending(ordered: unknown) {
  if (!Array.isArray(ordered)) return;
  const ops: Op[] = [];
  for (const id of pendingRows) ops.push(["del", id]);
  pendingRows.clear();
  // The engine provides submission order and a distinct id even for identical text.
  for (const entry of ordered) {
    const { queuedId, mode, text } = record(entry);
    const label = mode === "steer" ? "Steering" : mode === "followUp" ? "Queue" : undefined;
    if (!label || typeof queuedId !== "string" || !queuedId || typeof text !== "string") continue;
    const id = `pending.${queuedId}`;
    if (pendingRows.has(id)) continue;
    pendingRows.add(id);
    ops.push(add("pending-messages", node(id, "text", { text: `${label}: ${plain(text)}` })));
  }
  frame(["set", "pending-messages", { hidden: pendingRows.size === 0 }], ...ops);
}
function notify(text: string, tone: "info" | "error" = "info") {
  const message = plain(text).trim();
  if (!message) return;
  const nextId = `toast${++seq}`;
  // A fresh node replays identical messages; keep only the latest in the surface.
  frame(...(toastId ? [["del", toastId]] : []),
    add("layer", node(nextId, "toast", { text: message, tone })));
  toastId = nextId;
}
function fail(e: unknown) {
  quickTitle?.invalidate();
  sessionTitle.observe(undefined);
  ready = false; busy = false; settings.invalidate();
  composerMode.clear();
  showPending([]);
  quota?.close(); quota = undefined;
  background = undefined;
  unsubscribe?.(); workflow.disconnect();
  if (!workflow.open) workflowLaunch?.abort();
  removePicker();
  if (welcome) { welcome = false; frame(["del", "welcome"]); }
  const text = `${why(e)}. Close this pane or press Ctrl+D.`;
  if (failureShown) frame(["set", "failure-detail", { text }]);
  else {
    failureShown = true;
    frame(add("main", node("session-error", "card", { head: "OMO unavailable", tone: "error" }, [
      node("failure-detail", "text", { text }),
    ])));
  }
  showStatus("");
}
async function close() {
  if (closing) return;
  quickTitle?.invalidate();
  sessionTitle.close();
  closing = true; settings.invalidate(); terminal.closing(); unsubscribe?.();
  transcript?.retire();
  cancelPaste(); input.expireClipboardFrame();
  quota?.close();
  workflow.disconnect();
  workflowLaunch?.abort();
  try { await Promise.all([rpc?.close(), workflowLifetime]); }
  finally {
    if (live) screen.send("x", { id: surface, keep: !resume || ready });
    await terminal.restore();
    process.exit(process.exitCode ?? 0);
  }
}
function nextDialog() {
  if (ask || !rpc) return;
  const first = waiting.entries().next().value;
  if (!first) return;
  const [id, req] = first;
  removePicker();
  waiting.delete(id);
  ask = dialog(req, ++seq);
  cancelPaste();
  editor = new Editor();
  if (!ask.supported) {
    notify(`Cannot display ${string(req.method)} in this surface; cancelling.`, "error");
    void answer({ cancelled: true }); return;
  }
  frame(add("dialogs", ask.view), ["focus", ask.typed ? "draft" : null]); refresh();
}
function dismiss(id: string) {
  waiting.delete(id);
  if (ask?.requestId !== id) return;
  if (ask.supported) frame(["del", ask.id]);
  ask = undefined; answering = false;
  editor = draft; frame(["focus", "draft"]); nextDialog(); refresh();
}
async function answer(fields: RpcRecord) {
  if (!ask || answering || !rpc) return;
  const current = ask; answering = true;
  try {
    await rpc.respondToUi(current.requestId, { ...fields, answerId: crypto.randomUUID() });
    dismiss(current.requestId);
  } catch (e) {
    if (ask === current) answering = false;
    if (e instanceof RpcCommandError && /already_resolved|unknown_extension_ui_request/.test(e.message)) dismiss(current.requestId);
    notify(`Answer not accepted: ${why(e)}`, "error");
  }
}
function onRpc(e: RpcRecord) {
  if (closing) return;
  if (e.type === "session_info_changed") { sessionTitle.observe(e.name); return; }
  if (e.type === "session_replaced") {
    quickTitle?.invalidate();
    sessionTitle.observe(e.sessionName);
  }
  if (e.type === "commands_changed") { slash.changed(e.sessionId, e.commands); return; }
  if (e.type === "session_closed") { fail("OmO session closed"); return; }
  if (e.type === "queue_update") { showPending(e.ordered); return; }
  void quota?.event(e);
  if (ready && rpc && !settings.applying &&
      (e.type === "model_changed" || e.type === "thinking_level_changed" || e.type === "service_tier_changed")) {
    if (picker instanceof SettingsPicker) {
      removePicker(); refresh();
    }
    void settings.observed(rpc, e);
  }
  if (background?.observe(e)) {
    workflow.background(background.view);
    refresh();
  }
  workflow.event(e);
  composerMode.observe(e);
  const active = sessionActivity(e.type);
  if (active !== undefined) {
    activity++;
    if (!active) { void workflow.refreshPlan(); void workflow.refreshUsage(); }
    if (active) removePicker();
    if (active !== busy || active) { busy = active; showStatus(stopping ? "Stopping…" : ""); }
    return;
  }
  switch (e.type) {
    case "question_resolved": dismiss(string(e.id)); return;
    case "extension_ui_request": {
      if (e.method === "notify") {
        notify(string(e.message), e.notifyType === "error" || e.notifyType === "warning" ? "error" : "info");
        return;
      }
      if (["setTitle","setStatus","setSubagentCost","setWidget","set_editor_text"].includes(string(e.method))) return;
      const id = string(e.id);
      if (id && ask?.requestId !== id) waiting.set(id, e);
      nextDialog(); return;
    }
    default: transcript.event(e);
  }
  if (welcome && transcript.populated) refresh();
}
const welcomeCard = () => node("welcome", "card", { role: "omp.welcome" }, [
  node("wordmark", "text", { role: "omp.welcome.wordmark", spans: [{ t: "OMO", s: "strong" }] }),
  node("hint", "text", { role: "omp.welcome.tip-text", text: "Enter to send · Shift+Enter for a new line" }),
]);
function makeTranscript() {
  return new Transcript((...ops) => {
    for (const [verb, id, parent] of ops)
      if (verb === "add" && parent === "main" && typeof id === "string") transcriptNodes.add(id);
    frame(...ops);
  }, phases => workflow.todo(phases), authorIcon, previews ? (mime, bytes) => screen.blob(mime, bytes) : undefined);
}
async function start(hello: RpcRecord) {
  live = true; screen.negotiate(hello);
  quotaAvailable = supportsUsage(hello);
  workflowAvailable = supportsWorkflow(hello) && !!process.env.TERN_PANE && !!Bun.which("tern");
  // omp.session is Tern's built-in chat stylesheet, not the program's identity.
  screen.send("o", { id: surface, mode: "inline", title: "OMO", role: "omp.session" });
  previews = Array.isArray(hello.features) && hello.features.includes("blobs") &&
    Array.isArray(hello.kinds) && hello.kinds.includes("image");
  if (previews) {
    authorIcon = screen.blob("image/svg+xml", Buffer.from(omoIcon));
  }
  transcript = makeTranscript();
  screen.send("s", { sf: surface, name: "omo-composer", css: `
    ${composerCss}
    ${settingsCss}
    ${settingsPanelCss}
  ` });
  if (quotaAvailable) screen.send("s", { sf: surface, name: "omo-subscription-usage", css: usageCss });
  frame(add(surface, node("main", "col", {}, [welcomeCard()])), add(surface, node("dock", "col", {}, [
    node("dialogs", "col"),
    node("pending-messages", "scroll", { hidden: true, max: { h: "6lines" } }),
    node("composer", "col", { role: "omp.editor" }, [
      node("composer-mode", "text", { role: "normal", hidden: true }),
      node("session-feedback", "row", { align: "center", gap: "sm" }, [
        node("session-activity", "spinner", { style: "orbit", title: "Session work in progress", hidden: true }),
        node("session-status", "badge", { text: status, tone: "muted", hidden: !status }),
        node("session-ulw", "badge", { text: "ULW 실행 중", tone: "muted", hidden: true }),
        node("session-background-counts", "text", { hidden: true }),
      ]),
      node("attachments", "col", { hidden: true }),
      node("attachment-error", "text", { hidden: true, role: "omp.attachment.meta" }),
      node("line", "row", { role: "omp.composer.line", align: "start", gap: "sm" }, [
        node("draft", "editor", { aria: "Message OMO", placeholder: "Message OMO", maxLines: 8, readonly: true, grow: 1 }),
      ]), node("footer", "row", { role: "omp.composer.bar", align: "center", gap: "sm" }, [
        settingsNode(quotaAvailable), node("gap", "row", { grow: 1 }),
        ...(workflowAvailable ? [node("workflow-toggle", "button", { text: "Workflow", variant: "quiet",
          title: "Toggle workflow (Ctrl+G)", actions: { click: "workflow" } })] : []),
        node("stop", "button", { role: "omp.composer.stop", title: "Stop turn", aria: "Stop turn",
          actions: { click: "stop" }, hidden: true }),
        node("send", "button", { icon: "arrow-up", title: "Send message (Enter)", aria: "Send message",
          actions: { click: "submit" }, hidden: true }),
      ]),
    ]),
  ])), add(surface, node("layer", "col", {}, [node(workflowIntent, "text", { hidden: true })])),
  ["focus", resume ? null : "draft"]);
  if (resume) { status = ""; openPicker("sessions"); return; }
  try {
    await openSession(await resumeFields(args, cwd));
  } catch (e) { if (!closing) fail(e); await rpc?.close(); }
}
async function openSession(fields: RpcRecord, verify?: () => Promise<unknown>) {
    if (closing) return;
    quickTitle?.invalidate();
    const command = Bun.which("omo") ?? Bun.which(join(dirname(process.execPath), "omo")) ?? Bun.which(join(homedir(), ".bun/bin/omo"));
    if (!command) throw new Error("Could not find the omo executable");
    const client = rpc = new OmoRpc({ cwd, argv: [command, "--mode", "rpc", "--listen", "stdio://",
        "--extension", join(import.meta.dir, "quick-title-extension.ts")],
      env: { PATH: [process.env.PATH, dirname(process.execPath)].filter(Boolean).join(":"),
        TERN_QUICK_TITLE_FRESH: typeof fields.sessionPath === "string" ? "0" : "1",
        // Task activity also feeds the composer when Workflow is unavailable.
        SENPI_RPC_CLIENT_CAPABILITIES: "extension_events" },
      capabilities: ["interactive_user","question","extension_events"] });
    const titles = quickTitle = new QuickTitleClient(client);
    const pending: RpcRecord[] = [];
    const events = client.onEvent(e => {
        if (e.type === "extension_event" && e.name === "tern.quickTitle") {
          if (!closing && rpc === client)
            void titles.offer(record(e.data)).catch(error => console.error("Quick title:", why(error)));
        } else if (ready) onRpc(e);
        else pending.push(e);
    });
    const limits = client.onSubscriptionLimits(e => { void quota?.event(e); });
    unsubscribe = () => { events(); limits(); };
    const { state, sessionId } = await client.openSession({ auto_title: false, ...fields });
    await verify?.();
    if (closing) return;
    const history = await client.getMessages();
    if (closing) return;
    sessionTitle.observe(state.sessionName);
    ownSession(client, sessionId, state, history);
    if (Array.isArray(state.pendingQuestions)) for (const q of state.pendingQuestions) onRpc({ ...record(q), type: "extension_ui_request", method: "question" });
    pending.forEach(onRpc);
    void client.exited.then(exit => {
        titles.invalidate();
        if (!closing && rpc === client) fail(`RPC exited (${exit.signal ?? exit.code})`);
    });
    await slash.bind(client);
}
function ownSession(client: OmoRpc, sessionId: string, state: RpcRecord, history: readonly RpcRecord[]) {
    const owner = string(state.sessionId);
    if (workflowAvailable) workflow.bind(client, owner, string(state.cwd) || cwd);
    if (owner) {
      const projection = background = new ActivityProjection(sessionId, owner);
      projection.restore(state);
      workflow.background(projection.view);
      const accept = projection.beginTaskList();
      void client.request("extension_request", { name: "omo.task.list", data: { parent_session_id: owner } })
        .then(reply => {
          if (background === projection && !closing && accept(reply)) {
            workflow.background(projection.view);
            refresh();
          }
        }, () => { /* Older hosts may not ship the OmO task extension. */ });
    }
    if (quotaAvailable) quota = new UsageMeter(client, renderUsage(screen));
    for (const message of history) transcript.message(message);
    busy = state.isStreaming === true; ready = true; status = "";
    showPending(state.ordered ?? []);
    settings.show(state);
    frame(["focus", "draft"]);
}
async function reloadSession(client: OmoRpc, text: string, replaced: boolean) {
  const titleRevision = sessionTitle.revision;
  const state = await client.getState(), history = await client.getMessages();
  if (closing || !ready || !client.sessionId) return;
  transcript.retire();
  frame(...[...transcriptNodes].map(id => ["del", id]));
  transcriptNodes.clear();
  if (!welcome) frame(add("main", welcomeCard()));
  welcome = true;
  transcript = makeTranscript();
  draft.reset(text);
  composerMode.clear();
  if (replaced) {
    sessionTitle.restore(state.sessionName, titleRevision);
    background = undefined;
    quota?.close(); quota = undefined;
    workflow.disconnect();
    settings.invalidate();
    ownSession(client, client.sessionId, state, history);
    if (Array.isArray(state.pendingQuestions)) for (const q of state.pendingQuestions) onRpc({ ...record(q), type: "extension_ui_request", method: "question" });
    void slash.bind(client).catch(error => notify(why(error), "error"));
  } else {
    workflow.todo([]);
    for (const message of history) transcript.message(message);
    refresh();
  }
}
// After a committed engine change, don't let the old transcript keep driving
// the new session if validation or reconstruction fails.
async function restoreAfterChange(client: OmoRpc, text: string, replaced: boolean, verify?: () => Promise<unknown>) {
  try {
    await verify?.();
    await reloadSession(client, text, replaced);
  } catch (error) {
    if (!closing) fail(error);
    await client.close();
  }
}
function removePicker() {
  if (!picker) return;
  frame(...(picker instanceof SettingsPicker ? picker.remove() : [["del", picker.id]]),
    ["focus", ready ? "draft" : null]);
  picker = undefined; cancelPaste();
}
function openPicker(kind: Picker["kind"]) {
  if (picker || ask || (kind !== "sessions" && (!ready || busy || submitting || stopping || settings.applying))) return;
  const id = `pick${++seq}`;
  const p = picker = kind === "settings" ? new SettingsPicker(id) : new Picker(kind, id);
  cancelPaste();
  if (p instanceof SettingsPicker) frame(...p.mount(), ["focus", null]);
  else frame(add("layer", node(p.id, "picker", p.props(true))), ["focus", null]);
  refresh(); void loadPicker(p);
}
async function loadPicker(p: Picker) {
  if (p instanceof SettingsPicker && rpc)
    return p.reload({ settings, client: rpc, live: () => picker === p && !closing,
      draw: () => frame(...p.draw()) });
  p.state = "loading"; p.message = "";
  frame(["set", p.id, p.props()]);
  try {
    if (p.kind === "sessions") p.load(savedRows(await listSavedSessions(cwd)));
    else if (p.kind === "rename") p.load([]);
    else if (rpc) {
      const kind = p.kind;
      switch (kind) {
        case "fork": case "tree":
          p.load(entryRows(kind, (await rpc.request(kind === "fork" ? "get_fork_messages" : "get_tree")).data));
          break;
      }
    }
  } catch (e) { p.state = "error"; p.message = why(e); }
  if (picker === p && !closing) frame(["set", p.id, p.props(true)]);
}
async function choose(p: Picker) {
  const target = p.choice?.target;
  if (!p.usable || p.applying) return;
  const client = rpc;
  if (ready ? !client || busy || submitting || stopping || ask || settings.applying : p.kind !== "sessions") {
    removePicker(); refresh(); return;
  }
  if (p instanceof SettingsPicker && p.choice?.current) { removePicker(); refresh(); return; }
  p.applying = true; p.state = "loading";
  drawPicker(p);
  try {
    if (target && "path" in target) {
      const { fields, verify } = await selectedSession(target, cwd);
      if (closing || picker !== p) return;
      if (ready && client) {
        const { data } = await client.request("switch_session", { sessionPath: fields.sessionPath });
        if (record(data).cancelled !== true) await restoreAfterChange(client, "", true, verify);
        if (p === picker) { removePicker(); refresh(); }
        return;
      }
      removePicker(); showStatus("Opening session…");
      try { await openSession(fields, verify); }
      catch (e) { if (!closing) fail(e); await rpc?.close(); }
      return;
    }
    if (!client) throw new Error("No active OmO session");
    if (p.kind === "rename") {
      await client.request("set_session_name", { name: p.query.trim() });
      draft.reset(""); notify("Session renamed.");
    } else if (target && "entryId" in target) {
      const fork = p.kind === "fork";
      const reply = record((await client.request(fork ? "fork" : "navigate_tree", target)).data);
      if (reply.cancelled !== true && reply.outcome !== "cancelled")
        await restoreAfterChange(client, string(fork ? reply.text : reply.editorText), fork);
    } else if (target && !p.choice?.current) {
      await settings.apply(client, target);
    }
    if (closing || !ready) return;
    if (p === picker) removePicker();
    refresh();
  } catch (e) {
    if (p !== picker || closing) { if (!closing) refresh(); return; }
    if (p instanceof SettingsPicker) p.writeFailed(why(e));
    else { p.applying = false; p.state = "error"; p.message = why(e); }
    drawPicker(p);
  }
}
function drawPicker(p: Picker) {
  if (p instanceof SettingsPicker) frame(...p.draw());
  else frame(["set", p.id, p.props()]);
}
function pickerInput(p: Picker, i: Input) {
  if (p instanceof SettingsPicker) {
    switch (p.input(i)) {
      case "draw": drawPicker(p); break;
      case "select": frame(["set", "sp-list", { selected: `sp-${p.selected}` }]); break;
      case "retry": void loadPicker(p); break;
      case "back": {
        const reload = p.state === "error";
        p.page("settings");
        if (reload) void loadPicker(p);
        else drawPicker(p);
        break;
      }
      case "use": void choose(p); break;
      case "close": removePicker(); refresh(); break;
    }
    return;
  }
  const effect = p.input(i);
  switch (effect) {
    case "use": void choose(p); break;
    case "draw": frame(["set", p.id, p.props()]); break;
    case "retry": void loadPicker(p); break;
    case "close":
      removePicker();
      if (p.kind === "sessions" && !ready) void close(); else refresh();
      break;
  }
}
async function runSessionCommand(command: NonNullable<ReturnType<typeof sessionCommand>>, draftRevision: number | undefined) {
  if (!rpc || !ready || ask || picker || busy || stopping || submitting || settings.applying) return;
  if (pasting || clipboard.pending) { notify("Wait for the paste to finish."); return; }
  if (attachments.size) { notify("Send attachments with a message, not a slash command.", "error"); return; }
  const client = rpc;
  const { name, argument } = command;
  if (name === "resume" || name === "sessions") { openPicker("sessions"); return; }
  if (name === "fork" || name === "tree") { openPicker(name); return; }
  if ((name === "rename" || name === "name") && !argument) { openPicker("rename"); return; }
  submitting = true; refresh();
  try {
    if (name === "session") {
      const stats = record((await client.request("get_session_stats")).data);
      notify(`Session ${string(stats.sessionId)} · ${Number(stats.totalMessages) || 0} messages · ${Number(record(stats.tokens).total) || 0} tokens`);
      if (draft.revision === draftRevision) draft.reset("");
    } else if (name === "name" || name === "rename") {
      await client.request("set_session_name", { name: argument });
      notify("Session renamed."); if (draft.revision === draftRevision) draft.reset("");
    } else {
      const { data } = await client.request(name === "new" ? "new_session" : "clone");
      if (record(data).cancelled !== true) await restoreAfterChange(client, "", true);
    }
  } catch (error) { notify(why(error), "error"); }
  finally { submitting = false; if (!closing) refresh(); }
}
async function submit(mode: SubmitMode, supplied?: string) {
  const text = supplied ?? editor.text;
  if (ask) { if (mode === "prompt" && ask.typed && text.trim()) await answer(ask.typed(text)); return; }
  if (!ready || !rpc || picker || submitting || stopping || settings.applying || (!text.trim() && !attachments.size)) return;
  if (pasting || clipboard.pending) { notify("Wait for the paste to finish."); return; }
  const command = sessionCommand(text);
  if (command) {
    if (mode === "prompt" && !busy) await runSessionCommand(command, text === draft.text ? draft.revision : undefined);
    return;
  }
  if (mode === "prompt" && busy) {
    if (supplied === undefined) notify("Turn running. Use ⌘+Enter to steer or Ctrl+Enter to queue.");
    return;
  }
  if (mode !== "prompt" && !busy) return;
  const reason = sendBlock([...attachments.values()], settings.input);
  if (reason) { notify(`${reason} Remove unsupported attachments before sending.`, "error"); return; }
  if (attachments.size && /^\/[\p{L}\p{N}_:-][\p{L}\p{N}_.:-]*(?:\s|$)/u.test(text.trimStart())) {
    notify("Send attachments with a message, not a slash command.", "error"); return;
  }
  const images = [...attachments.values()].flatMap(file => file.image ? [file.image] : []);
  const fields = images.length ? { images } : {};
  const startedAt = activity, cursor = supplied === undefined ? editor.cursor : text.length;
  submitting = true;
  if (supplied === undefined || supplied === editor.text) editor.reset("");
  if (mode === "prompt") { busy = true; showStatus(""); }
  else refresh();
  try {
    if (mode === "prompt") {
      const reply = await (quickTitle?.prompt(text, fields) ?? rpc.prompt(text, fields));
      // A slash command may finish inside an extension without any agent_idle.
      if (record(reply.data).disposition === "handled") {
        void workflow.refreshPlan();
        if (startedAt === activity) { busy = false; status = ""; composerMode.clear(); }
      }
    } else {
      // Without a turn fence, these RPCs can queue on an idle or replacement turn.
      const state = await rpc.getState();
      const expectedTurnId = string(state.currentTurnId);
      if (startedAt !== activity || !expectedTurnId || state.isStreaming !== true || stopping || closing)
        throw new Error("The active turn changed before the message could be sent.");
      await rpc.request(mode, { message: text, expectedTurnId, ...fields });
    }
    for (const id of attachments.keys()) frame(["del", id]);
    attachments.clear(); attachmentError = "";
  } catch (e) {
    if (mode === "prompt" && startedAt === activity) { busy = false; status = ""; composerMode.clear(); }
    // A dialog may have taken the editor while admission was pending.
    const newer = draft.text;
    const prefix = text + (newer ? "\n" : "");
    draft.reset(prefix + newer, newer ? prefix.length + draft.cursor : cursor);
    notify(`Prompt not sent or not acknowledged: ${why(e)}`, "error");
  } finally {
    submitting = false;
    if (!closing) refresh();
  }
}
async function stop() {
  if (ask) return answer({ cancelled: true });
  if (!rpc || !busy || stopping) return;
  quickTitle?.invalidate();
  const startedAt = activity;
  stopping = true;
  showStatus("Stopping…");
  try {
    const reply = await rpc.abort({ intent: "stop", awaitIdle: true });
    if (record(reply.data).idle === true) {
      if (startedAt === activity) { busy = false; composerMode.clear(); }
      if (!busy) notify("Stopped");
    } else if (busy) notify("Stop requested. The turn is still running.");
  } catch (e) {
    notify(`Stop failed: ${why(e)}`, "error");
  } finally {
    stopping = false;
    if (!closing) showStatus("");
  }
}
function toggleWorkflow() {
  if (!workflowAvailable || picker || ask) return;
  slash.close();
  if (workflowLaunch) { frame(["set", workflowIntent, { text: "" }]); workflowLaunch.abort(); return; }
  const pane = process.env.TERN_PANE, tern = Bun.which("tern");
  if (!ready || !pane || !tern) return;
  const controller = workflowLaunch = new AbortController();
  const token = crypto.randomUUID().replaceAll("-", "");
  frame(["set", workflowIntent, { text: token }]);
  const closed = () => {
    if (workflowLaunch !== controller) return;
    if (workflow.open) workflow.toggle();
    workflowLaunch = undefined; workflowFrame = undefined;
    if (!closing) frame(["set", workflowIntent, { text: "" }], ["set", "workflow-toggle", { text: "Workflow" }]);
  };
  workflowLifetime = launchWorkflowPane(tern, pane, token, controller.signal, workflowInput, send => {
    if (workflowLaunch !== controller || controller.signal.aborted || closing || !ready) { controller.abort(); return; }
    workflowFrame = send; workflow.toggle();
    send(["focus", "workflow"]);
    frame(["set", workflowIntent, { text: "" }], ["set", "workflow-toggle", { text: "Hide Workflow" }]);
  }, closed).catch(error => {
    closed();
    if (!closing) notify(`Could not open workflow: ${why(error)}`, "error");
  });
}
function workflowInput(i: Input) {
  if (closing || workflowLaunch?.signal.aborted || !workflow.open) return;
  if (i.kind === "event" && i.value.ev === "theme" && typeof i.value.dark === "boolean") {
    workflow.theme(i.value.dark); return;
  }
  if (i.kind === "event" && i.value.ev === "action") {
    const { id, act } = i.value;
    if (id === "workflow-close" && act === "close") { workflowLaunch?.abort(); return; }
    if (id === "workflow-file" && act === "open-file" && !ask && !picker) {
      const launch = workflowLaunch;
      const tern = Bun.which("tern"), pane = process.env.TERN_PANE;
      if (tern && pane && launch) void workflow.refreshPlan(path => {
        if (closing || ask || picker || workflowLaunch !== launch || launch.signal.aborted) return;
        const opener = Bun.spawn([tern, "open", "--tab", path], { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 4000 });
        void opener.exited.then(code => {
          if (code !== 0 && !closing && workflowLaunch === launch && !launch.signal.aborted) notify("Tern could not open the selected Markdown file.", "error");
        });
      });
      return;
    }
    workflow.action(i.value);
    return;
  }
  if (i.kind !== "key") return;
  if (["\x1b", "\x1b[27u", "\x07", "\x1b[103;5u"].includes(i.value)) workflowLaunch?.abort();
  else workflow.key(i.value);
}
function insertCommand(id?: unknown) {
  if (!ready || busy || stopping || submitting || ask || picker) return;
  const text = slash.pick(id);
  if (!text) return;
  const local = sessionCommand(text);
  if (local) { void runSessionCommand(local, draft.revision); return; }
  draft.replaceDraft(text);
  frame(["focus", "draft"]); refresh();
}
function handle(i: Input) {
  if (closing) return;
  if (i.kind === "key" && (i.value === "\x04" || i.value === "\x1b[100;5u")) { void close(); return; }
  if (i.kind === "clipboard") {
    if (canPaste() || picker || ask?.typed) clipboard.receive(i.value, !canPaste());
    return;
  }
  if (i.kind === "event") {
    const e = i.value;
    if (!live || e.sf !== surface) return;
    switch (e.ev) {
      case "ack": screen.ack(e.s); return;
      case "gone": if (Array.isArray(e.ids) && e.ids.includes(surface)) void close(); return;
      case "error": fail(`Tern: ${string(e.msg)}`); return;
    }
    if (picker) { pickerInput(picker, i); return; }
    switch (e.ev) {
      case "toggle":
        transcript.fold(string(e.id), e.collapsed === true);
        return;
      case "focus": if (e.id === "draft") frame(["focus", "draft"]); return;
      case "send":
        if (e.id === "draft" && !ask) {
          if (slash.choice) insertCommand();
          else void submit("prompt", typeof e.text === "string" ? e.text : undefined);
        }
        return;
      case "action":
        if (e.id === "model" && e.act === "settings") { openPicker("settings"); return; }
        if (e.act === "remove-attachment" && typeof e.id === "string" && e.id.endsWith(".remove") &&
            !ask && !submitting && attachments.delete(e.id.slice(0, -7))) {
          frame(["del", e.id.slice(0, -7)], ["focus", "draft"]); attachmentError = ""; refresh();
          return;
        }
        if (e.act === "insert-command" && typeof e.id === "string") { insertCommand(e.id); return; }
        if (e.id === "workflow-toggle" && e.act === "workflow") { toggleWorkflow(); return; }
        if (e.id === "stop" && e.act === "stop") void stop();
        if (e.id === "send" && e.act === "submit") void submit("prompt");
        if (ask && e.act === "choose") {
          const choice = ask.choices.find((_, n) => e.id === `${ask?.id}.${n}`);
          if (choice) void answer(choice.fields);
        }
        return;
    }
  }
  if (picker) { pickerInput(picker, i); return; }
  if (i.kind === "key" && modelSettingsKey(i.value)) { openPicker("settings"); return; }
  if (i.kind === "key" && (i.value === "\x07" || i.value === "\x1b[103;5u")) { toggleWorkflow(); return; }
  if (!live || !ready) return;
  if (i.kind === "key" && slash.choice) {
    if (["\x1b[A", "\x1b[B"].includes(i.value)) { slash.move(i.value.endsWith("A") ? -1 : 1); return; }
    if (["\r", "\x1b[13u", "\t"].includes(i.value)) { insertCommand(); return; }
  }
  if (i.kind === "key" && isStopKey(i.value)) { slash.close(); void stop(); return; }
  if (ask && !ask.typed) return;
  const action = editor.apply(i);
  switch (action) {
    case "edit":
      if (editor === draft && !busy && !submitting && !stopping) slash.edit(draft.text, draft.cursor);
      refresh(); break;
    case "prompt": case "steer": case "follow_up": void submit(action); break;
    case "fold": transcript.flipTools(); break;
    case "exit": void close(); break;
  }
}
if (args[0] === "--workflow-pane" && args.length === 6 && args[1] && /^[a-f0-9]{32}$/.test(args[2]) && /^w\d{0,10}$/.test(args[4])) {
  workflowCompanion(args[1], args[2], args[3], args[4].slice(1), args[5]);
} else if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("OMO Native needs a Tern pane with native program surfaces enabled."); process.exitCode = 1;
} else {
  terminal.listen(screen, { start, handle, close });
}
