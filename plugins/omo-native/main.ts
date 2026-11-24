import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { OmoRpc, RpcCommandError, type RpcRecord } from "./rpc";
import { add, InputStream, node, plain, record, string, Surface, surface, type Input, type Op } from "./surface";
import { Editor, isStopKey, type SubmitMode } from "./editor";
import { Transcript } from "./transcript";
import omoIcon from "./omo-icon.svg" with { type: "text" };
import { dialog } from "./dialog";
import { resumeFields, sessionActivity } from "./session";
import { listSavedSessions } from "./history";
import { applyModel, availableModels, Picker, savedRows, selectedSession } from "./picker";
import { supportsWorkflow, Workflow } from "./workflow";
import { launchWorkflowPane, workflowCompanion } from "./workflow-pane";
import { ActivityProjection } from "./activity";
import { renderUsage, supportsUsage, UsageMeter, usageCss, usageNode } from "./usage";

const screen = new Surface(), draft = new Editor(), input = new InputStream();
let editor = draft;
const workflowIntent = "workflow-open-intent";
const frame = (...ops: Op[]) => screen.frame(...ops);
let workflowFrame: ((...ops: Op[]) => void) | undefined;
let workflowLaunch: AbortController | undefined;
let workflowLifetime: Promise<void> | undefined;
const workflow = new Workflow((...ops) => workflowFrame?.(...ops));
let transcript: Transcript;
const cwd = process.cwd();
let rpc: OmoRpc | undefined, unsubscribe: (() => void) | undefined;
let background: ActivityProjection | undefined, quota: UsageMeter | undefined;
let quotaAvailable = false;
let live = false, ready = false, closing = false, busy = false, welcome = true;
let submitting = false, stopping = false, activity = 0;
let status: "" | "Opening session…" | "Stopping…" = "Opening session…";
let seq = 0, answering = false, failureShown = false;
let ask: ReturnType<typeof dialog> | undefined;
let picker: Picker | undefined, currentModel: RpcRecord = {};
let workflowAvailable = false;
let toastId: string | undefined;
const args = process.argv.slice(2), resume = args.length === 1 && args[0] === "--resume";
const waiting = new Map<string, RpcRecord>();
let timer: ReturnType<typeof setTimeout>, esc: ReturnType<typeof setTimeout>;
const why = (e: unknown) => plain(e instanceof Error ? e.message : String(e));

function refresh() {
  const canSend = ready && !busy && !submitting && !stopping && !ask && !picker;
  const backgroundView = background?.view;
  const { agents, jobs } = backgroundView?.running ?? { agents: 0, jobs: 0 };
  const running = [agents ? `${agents} agent${agents === 1 ? "" : "s"}` : "",
    jobs ? `${jobs} job${jobs === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  frame(["set", "draft", { text: editor.text, cursor: editor.cursor, readonly: !!picker || !ready || (!!ask && !ask.typed),
    placeholder: ask?.typed ? "Type your answer" : "Message OMO", sendable: canSend }],
    ["set", "send", { hidden: !canSend && !ask?.typed }],
    ["set", "model", { disabled: !canSend }], ["set", "stop", { hidden: !busy || !!ask || !!picker, disabled: stopping }],
    ["set", "session-status", { text: status, hidden: !status }],
    ["set", "session-activity", { hidden: !busy && !backgroundView?.active }],
    ["set", "session-background-counts", { text: running, hidden: !running }]);
  if (welcome && transcript.populated) { welcome = false; frame(["del", "welcome"]); }
}
function showStatus(text: typeof status) { status = text; refresh(); }
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
  ready = false; busy = false;
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
  closing = true; clearTimeout(timer); clearTimeout(esc); unsubscribe?.();
  quota?.close();
  workflow.disconnect();
  workflowLaunch?.abort();
  try { await Promise.all([rpc?.close(), workflowLifetime]); }
  finally {
    if (live) screen.send("x", { id: surface, keep: !resume || ready });
    process.stdout.write("\x1b[<u\x1b[?2004l");
    await Bun.sleep(60);
    process.stdin.setRawMode(false); process.stdin.pause();
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
  if (e.type === "session_closed") { fail("OmO session closed"); return; }
  void quota?.event(e);
  if (e.type === "model_changed" && Object.keys(record(e.model)).length) showModel(e.model);
  if (background?.observe(e)) {
    workflow.background(background.view);
    refresh();
  }
  workflow.event(e);
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
async function start(hello: RpcRecord) {
  clearTimeout(timer); live = true; screen.negotiate(hello);
  quotaAvailable = supportsUsage(hello);
  workflowAvailable = supportsWorkflow(hello) && !!process.env.TERN_PANE && !!Bun.which("tern");
  // omp.session is Tern's built-in chat stylesheet, not the program's identity.
  screen.send("o", { id: surface, mode: "inline", title: "OMO", role: "omp.session" });
  let authorIcon: string | undefined;
  if (Array.isArray(hello.features) && hello.features.includes("blobs") &&
    Array.isArray(hello.kinds) && hello.kinds.includes("image")) {
    const bytes = Buffer.from(omoIcon);
    authorIcon = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    process.stdout.write(`\x1b_tsp;b;mime=image/svg+xml;${bytes.toString("base64")}\x1b\\`);
  }
  transcript = new Transcript(frame, phases => workflow.todo(phases), authorIcon);
  screen.send("s", { sf: surface, name: "omo-composer", css: `
    .sf-col[data-id="composer"][data-role="omp.editor"] {
      background: var(--raise);
      border: 1px solid var(--l3);
      border-radius: 22px;
      box-shadow: none;
      gap: 4px;
      padding: 8px 10px;
    }
    .sf-col[data-id="composer"][data-role="omp.editor"]::before,
    .sf-col[data-id="composer"][data-role="omp.editor"]::after { display: none; }
    .sf-col[data-id="composer"][data-role="omp.editor"]:focus-within {
      border-color: var(--accent);
    }
    .sf-col[data-id="composer"] > .sf-row[data-id="session-feedback"] {
      position: absolute;
      bottom: 100%;
      left: 22px;
      pointer-events: none;
    }
    .sf-text[data-id="session-background-counts"] {
      color: var(--t2);
      font-size: .875em;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .sf-col[data-id="composer"][data-role="omp.editor"] > .sf-row[data-id="line"] {
      min-height: 0;
      padding: 0 4px;
    }
    .sf-col[data-id="composer"][data-role="omp.editor"] > .sf-row[data-id="line"] > .sf-editor[data-id="draft"] {
      min-height: 0;
    }
    .sf-col[data-id="composer"] .sf-editor[data-id="draft"] .sf-ed-ph { color: var(--t2); }
    .sf-col[data-id="composer"] > .sf-row[data-id="footer"] { gap: 4px; }
    .sf-row[data-id="footer"] > .sf-button[data-id="model"] {
      border: 1px solid var(--l3);
      border-radius: 999px;
      min-width: 0;
    }
    .sf-row[data-id="footer"] > .sf-button[data-id="model"] .sf-btn-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sf-row[data-id="footer"] > .sf-button:is([data-id="send"], [data-id="stop"]) {
      background: var(--t1);
      color: var(--raise);
      border: none;
      border-radius: 50%;
      width: 28px;
      height: 28px;
      padding: 0;
      flex: 0 0 28px;
      order: 1;
    }
    .sf-row[data-id="footer"] > .sf-button[data-id="stop"]:hover {
      background: var(--t2);
    }
    .sf-row[data-id="footer"] > .sf-button[data-id="send"] {
      background: var(--accent-fill);
      color: #fff;
    }
    .sf-row[data-id="footer"] > .sf-button[data-id="send"]:hover { opacity: .9; }
  ` });
  if (quotaAvailable) screen.send("s", { sf: surface, name: "omo-subscription-usage", css: usageCss });
  frame(add(surface, node("main", "col", {}, [
    node("welcome", "card", { role: "omp.welcome" }, [
      node("wordmark", "text", { role: "omp.welcome.wordmark", spans: [{ t: "OMO", s: "strong" }] }),
      node("hint", "text", { role: "omp.welcome.tip-text", text: "Enter to send · Shift+Enter for a new line" }),
    ]),
  ])), add(surface, node("dock", "col", {}, [
    node("dialogs", "col"),
    node("composer", "col", { role: "omp.editor" }, [
      node("session-feedback", "row", { align: "center", gap: "sm" }, [
        node("session-activity", "spinner", { style: "orbit", title: "Session work in progress", hidden: true }),
        node("session-status", "badge", { text: status, tone: "muted", hidden: !status }),
        node("session-background-counts", "text", { hidden: true }),
      ]),
      node("line", "row", { role: "omp.composer.line", align: "start", gap: "sm" }, [
        node("draft", "editor", { aria: "Message OMO", placeholder: "Message OMO", maxLines: 8, readonly: true, grow: 1 }),
      ]), node("footer", "row", { role: "omp.composer.bar", align: "center", gap: "sm" }, [
        node("model", "button", { text: "OMO", variant: "quiet", title: "Choose model", disabled: true,
          actions: { click: "models" } }),
        ...(quotaAvailable ? [usageNode()] : []), node("gap", "row", { grow: 1 }),
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
    const command = Bun.which("omo") ?? Bun.which(join(dirname(process.execPath), "omo")) ?? Bun.which(join(homedir(), ".bun/bin/omo"));
    if (!command) throw new Error("Could not find the omo executable");
    const client = rpc = new OmoRpc({ cwd, argv: [command, "--mode", "rpc", "--listen", "stdio://"],
      env: { PATH: [process.env.PATH, dirname(process.execPath)].filter(Boolean).join(":"),
        // Task activity also feeds the composer when Workflow is unavailable.
        SENPI_RPC_CLIENT_CAPABILITIES: "extension_events" },
      capabilities: ["interactive_user","question","extension_events"] });
    const pending: RpcRecord[] = [];
    const events = client.onEvent(e => ready ? onRpc(e) : pending.push(e));
    const limits = client.onSubscriptionLimits(e => { void quota?.event(e); });
    unsubscribe = () => { events(); limits(); };
    const { state, sessionId } = await client.openSession({ auto_title: false, ...fields });
    await verify?.();
    if (closing) return;
    const history = await client.getMessages();
    if (closing) return;
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
    showModel(state.model);
    frame(["focus", "draft"]);
    refresh();
    if (Array.isArray(state.pendingQuestions)) for (const q of state.pendingQuestions) onRpc({ ...record(q), type: "extension_ui_request", method: "question" });
    pending.forEach(onRpc);
    void client.exited.then(exit => { if (!closing) fail(`RPC exited (${exit.signal ?? exit.code})`); });
}
function showModel(value: unknown) {
  currentModel = record(value);
  void quota?.setModel(value);
  frame(["set", "model", { text: plain(string(currentModel.name) || string(currentModel.id) || string(value) || "No model selected") }]);
}
function removePicker() {
  if (!picker) return;
  frame(["del", picker.id], ["focus", ready ? "draft" : null]);
  picker = undefined;
}
function openPicker(kind: Picker["kind"]) {
  if (picker || ask || (kind === "models" && (!ready || busy))) return;
  const p = picker = new Picker(kind, `pick${++seq}`);
  frame(add("layer", node(p.id, "picker", p.props(true))), ["focus", null]);
  refresh(); void loadPicker(p);
}
async function loadPicker(p: Picker) {
  p.state = "loading"; p.message = "";
  frame(["set", p.id, p.props()]);
  try {
    if (p.kind === "sessions") p.load(savedRows(await listSavedSessions(cwd)));
    else if (rpc) p.load(await availableModels(rpc, currentModel));
  } catch (e) { p.state = "error"; p.message = why(e); }
  if (picker === p && !closing) frame(["set", p.id, p.props(true)]);
}
async function choose(p: Picker) {
  const target = p.choice?.target;
  if (!target || p.applying) return;
  const client = rpc;
  if (!("path" in target) && (!ready || !client || busy || ask)) {
    removePicker(); refresh(); return;
  }
  p.applying = true; p.state = "loading";
  frame(["set", p.id, p.props()]);
  try {
    if ("path" in target) {
      const { fields, verify } = await selectedSession(target, cwd);
      if (closing || picker !== p) return;
      removePicker(); showStatus("Opening session…");
      try { await openSession(fields, verify); }
      catch (e) { if (!closing) fail(e); await rpc?.close(); }
      return;
    }
    if (!client) throw new Error("No active OmO session");
    const model = await applyModel(client, target);
    if (closing || !ready) return;
    showModel(model);
    if (p === picker) { removePicker(); refresh(); }
  } catch (e) {
    if (p !== picker || closing) return;
    p.applying = false; p.state = "error"; p.message = why(e);
    frame(["set", p.id, p.props()]);
  }
}
function pickerInput(p: Picker, i: Input) {
  switch (p.input(i)) {
    case "use": void choose(p); break;
    case "draw": frame(["set", p.id, p.props()]); break;
    case "retry": void loadPicker(p); break;
    case "close":
      removePicker();
      if (p.kind === "sessions") void close(); else refresh();
      break;
  }
}
async function submit(mode: SubmitMode, supplied?: string) {
  const text = supplied ?? editor.text;
  if (ask) { if (mode === "prompt" && ask.typed && text.trim()) await answer(ask.typed(text)); return; }
  if (!ready || !rpc || submitting || stopping || !text.trim()) return;
  if (mode === "prompt" && busy) {
    if (supplied === undefined) notify("Turn running. Use ⌘+Enter to steer or Ctrl+Enter to queue.");
    return;
  }
  if (mode !== "prompt" && !busy) return;
  const startedAt = activity, cursor = supplied === undefined ? editor.cursor : text.length;
  submitting = true;
  if (supplied === undefined || supplied === editor.text) editor.reset("");
  if (mode === "prompt") { busy = true; showStatus(""); }
  else refresh();
  try {
    if (mode === "prompt") {
      const reply = await rpc.prompt(text);
      // A slash command may finish inside an extension without any agent_idle.
      if (record(reply.data).disposition === "handled") {
        void workflow.refreshPlan();
        if (startedAt === activity) { busy = false; status = ""; }
      }
    } else {
      // Without a turn fence, these RPCs can queue on an idle or replacement turn.
      const state = await rpc.getState();
      const expectedTurnId = string(state.currentTurnId);
      if (startedAt !== activity || !expectedTurnId || state.isStreaming !== true || stopping || closing)
        throw new Error("The active turn changed before the message could be sent.");
      await rpc.request(mode, { message: text, expectedTurnId });
    }
  } catch (e) {
    if (mode === "prompt" && startedAt === activity) { busy = false; status = ""; }
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
  const startedAt = activity;
  stopping = true;
  showStatus("Stopping…");
  try {
    const reply = await rpc.abort({ intent: "stop", awaitIdle: true });
    if (record(reply.data).idle === true) {
      if (startedAt === activity) busy = false;
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
function handle(i: Input) {
  if (closing) return;
  if (i.kind === "key" && (i.value === "\x04" || i.value === "\x1b[100;5u")) { void close(); return; }
  if (i.kind === "event") {
    const e = i.value;
    if (!live && e.r === "hello" && e.v === 1) { void start(e); return; }
    if (!live || e.sf !== surface) return;
    switch (e.ev) {
      case "ack": screen.ack(e.s); return;
      case "gone": if (Array.isArray(e.ids) && e.ids.includes(surface)) void close(); return;
      case "error": fail(`Tern: ${string(e.msg)}`); return;
    }
    if (picker) { pickerInput(picker, i); return; }
    switch (e.ev) {
      case "toggle": transcript.fold(string(e.id), e.collapsed === true); return;
      case "focus": if (e.id === "draft") frame(["focus", "draft"]); return;
      case "send": if (e.id === "draft" && !ask) void submit("prompt", string(e.text)); return;
      case "action":
        if (e.id === "workflow-toggle" && e.act === "workflow") { toggleWorkflow(); return; }
        if (e.id === "model" && e.act === "models") openPicker("models");
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
  if (i.kind === "key" && (i.value === "\x07" || i.value === "\x1b[103;5u")) { toggleWorkflow(); return; }
  if (!live || !ready) return;
  if (i.kind === "key" && isStopKey(i.value)) { void stop(); return; }
  if (ask && !ask.typed) return;
  const action = editor.apply(i);
  switch (action) {
    case "edit": refresh(); break;
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
  process.stdin.setRawMode(true).setEncoding("utf8").on("data", (chunk: string) => {
    clearTimeout(esc); input.feed(chunk).forEach(handle);
    if (chunk.endsWith("\x1b")) esc = setTimeout(() => input.feed("", true).forEach(handle), 40);
  }).once("end", close).resume();
  for (const signal of ["SIGINT","SIGHUP","SIGTERM"] as const) process.once(signal, close);
  process.stdout.on("error", close);
  screen.send("q", { q: "hello", app: "omo", v: [1], features: ["edit","send","undo"] });
  process.stdout.write("\x1b[c\x1b[?2004h\x1b[>1u");
  timer = setTimeout(() => {
    process.stderr.write("OMO Native: Tern did not negotiate a surface. Enable Native program surfaces and reopen this pane.\r\n");
    process.exitCode = 1; void close();
  }, 1500);
}
