import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { OmoRpc, RpcCommandError, type RpcRecord } from "./rpc";
import { add, InputStream, node, plain, record, string, Surface, surface, type Input, type Op } from "./surface";
import { Editor } from "./editor";
import { Transcript } from "./transcript";
import { dialog } from "./dialog";
import { resumeFields, sessionActivity } from "./session";
import { listSavedSessions } from "./history";
import { applyModel, availableModels, Picker, savedRows, selectedSession } from "./picker";

const screen = new Surface(), editor = new Editor(), input = new InputStream();
const frame = (...ops: Op[]) => screen.frame(...ops);
const transcript = new Transcript(frame);
const cwd = process.cwd();
let rpc: OmoRpc | undefined, unsubscribe: (() => void) | undefined;
let live = false, ready = false, closing = false, busy = false, welcome = true;
let status = "Opening session…", seq = 0, answering = false, savedDraft = "";
let ask: ReturnType<typeof dialog> | undefined;
let picker: Picker | undefined, currentModel: RpcRecord = {};
const args = process.argv.slice(2), resume = args.length === 1 && args[0] === "--resume";
const waiting = new Map<string, RpcRecord>();
let timer: ReturnType<typeof setTimeout>, esc: ReturnType<typeof setTimeout>;
const why = (e: unknown) => plain(e instanceof Error ? e.message : String(e));

function refresh() {
  const canSend = ready && !busy && !ask && !picker;
  frame(["set", "draft", { text: editor.text, cursor: editor.cursor, readonly: !!picker || !ready || (!!ask && !ask.typed),
    placeholder: ask?.typed ? "Type your answer" : "Message OMO", sendable: canSend }],
    ["set", "send", { hidden: !canSend && !ask?.typed }],
    ["set", "model", { disabled: !canSend }], ["set", "stop", { hidden: !busy || !!ask || !!picker }],
    ["set", "notice", { text: status, hidden: !status }]);
  if (welcome && transcript.populated) { welcome = false; frame(["del", "welcome"]); }
}
function notice(text: string) { status = text; refresh(); }
function fail(e: unknown) {
  ready = false; busy = false;
  removePicker();
  notice(`OMO unavailable: ${why(e)}. Close this pane or press Ctrl+D.`);
}
async function close() {
  if (closing) return;
  closing = true; clearTimeout(timer); clearTimeout(esc); unsubscribe?.();
  try { await rpc?.close(); }
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
  savedDraft = editor.text; editor.reset("");
  if (!ask.supported) {
    notice(`Cannot display ${plain(string(req.method))} in this surface; cancelling.`);
    void answer({ cancelled: true }); return;
  }
  frame(add("dialogs", ask.view), ["focus", ask.typed ? "draft" : null]); refresh();
}
function dismiss(id: string) {
  waiting.delete(id);
  if (ask?.requestId !== id) return;
  if (ask.supported) frame(["del", ask.id]);
  ask = undefined; answering = false;
  editor.reset(savedDraft); frame(["focus", "draft"]); nextDialog(); refresh();
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
    notice(`Answer not accepted: ${why(e)}`);
  }
}
function onRpc(e: RpcRecord) {
  if (closing) return;
  const active = sessionActivity(e.type);
  if (active !== undefined) {
    if (active) removePicker();
    if (active !== busy || active) { busy = active; notice(active ? "Working…" : ""); }
    return;
  }
  switch (e.type) {
    case "question_resolved": dismiss(string(e.id)); return;
    case "extension_ui_request": {
      if (e.method === "notify") { notice(plain(string(e.message))); return; }
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
  // omp.session is Tern's built-in chat stylesheet, not the program's identity.
  screen.send("o", { id: surface, mode: "inline", title: "OMO", role: "omp.session" });
  frame(add(surface, node("main", "col", {}, [
    node("welcome", "card", { role: "omp.welcome" }, [
      node("wordmark", "text", { role: "omp.welcome.wordmark", spans: [{ t: "OMO", s: "strong" }] }),
      node("hint", "text", { role: "omp.welcome.tip-text", text: "Enter to send · Shift+Enter for a new line" }),
    ]),
  ])), add(surface, node("dock", "col", {}, [
    node("dialogs", "col"), node("notice", "text", { text: status }),
    node("composer", "col", { role: "omp.editor" }, [
      node("line", "row", { role: "omp.composer.line", align: "start", gap: "sm" }, [
        node("draft", "editor", { aria: "Message OMO", placeholder: "Message OMO", maxLines: 8, readonly: true, grow: 1 }),
      ]), node("footer", "row", { role: "omp.composer.bar", align: "center", gap: "sm" }, [
        node("model", "button", { text: "OMO", variant: "quiet", title: "Choose model", disabled: true,
          actions: { click: "models" } }), node("gap", "row", { grow: 1 }),
        node("stop", "button", { text: "Stop", actions: { click: "stop" }, hidden: true }),
        node("send", "kbd", { keys: ["enter"], role: "omp.composer.send", title: "Send message", actions: { click: "submit" }, hidden: true }),
      ]),
    ]),
  ])), add(surface, node("layer", "col")), ["focus", resume ? null : "draft"]);
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
      env: { PATH: [process.env.PATH, dirname(process.execPath)].filter(Boolean).join(":") },
      capabilities: ["interactive_user","question"] });
    const pending: RpcRecord[] = [];
    unsubscribe = client.onEvent(e => ready ? onRpc(e) : pending.push(e));
    const { state } = await client.openSession({ auto_title: false, ...fields });
    await verify?.();
    if (closing) return;
    for (const message of await client.getMessages()) transcript.message(message);
    busy = state.isStreaming === true; ready = true; status = busy ? "Working…" : "";
    showModel(state.model);
    frame(["focus", "draft"]);
    refresh();
    if (Array.isArray(state.pendingQuestions)) for (const q of state.pendingQuestions) onRpc({ ...record(q), type: "extension_ui_request", method: "question" });
    pending.forEach(onRpc);
    void client.exited.then(exit => { if (!closing) fail(`RPC exited (${exit.signal ?? exit.code})`); });
}
function showModel(value: unknown) {
  currentModel = record(value);
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
      removePicker(); notice("Opening session…");
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
async function submit(text: string) {
  if (ask) { if (ask.typed && text.trim()) await answer(ask.typed(text)); return; }
  if (!ready || !rpc || busy || !text.trim()) return;
  busy = true; editor.reset(""); notice("Working…");
  try {
    const reply = await rpc.prompt(text);
    // A slash command may finish inside an extension without any agent_idle.
    if (record(reply.data).disposition === "handled") {
      busy = false;
      if (status === "Working…") status = "";
      refresh();
    }
  }
  catch (e) {
    busy = false;
    if (!editor.text) editor.reset(text);
    notice(`Prompt not sent or not acknowledged: ${why(e)}`);
  }
}
async function stop() {
  if (ask) return answer({ cancelled: true });
  if (!rpc || !busy) return;
  notice("Stopping…");
  try { await rpc.abort({ awaitIdle: true }); busy = false; notice("Stopped"); }
  catch (e) { notice(`Stop failed: ${why(e)}`); }
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
      case "send": if (e.id === "draft" && !ask) void submit(string(e.text)); return;
      case "action":
        if (e.id === "model" && e.act === "models") openPicker("models");
        if (e.id === "stop" && e.act === "stop") void stop();
        if (e.id === "send" && e.act === "submit") void submit(editor.text);
        if (ask && e.act === "choose") {
          const choice = ask.choices.find((_, n) => e.id === `${ask?.id}.${n}`);
          if (choice) void answer(choice.fields);
        }
        return;
    }
  }
  if (picker) { pickerInput(picker, i); return; }
  if (!live || !ready || (ask && !ask.typed && i.kind !== "key")) return;
  if (ask && !ask.typed) {
    if (i.value === "\x1b" || i.value === "\x03") void stop();
    return;
  }
  switch (editor.apply(i)) {
    case "edit": refresh(); break;
    case "submit": void submit(editor.text); break;
    case "stop": void stop(); break;
    case "fold": transcript.flipTools(); break;
    case "exit": void close(); break;
  }
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("OMO Native needs a Tern pane with native program surfaces enabled."); process.exitCode = 1;
} else {
  process.stdin.setRawMode(true).setEncoding("utf8").on("data", (chunk: string) => {
    clearTimeout(esc); input.feed(chunk).forEach(handle);
    if (chunk.endsWith("\x1b")) esc = setTimeout(() => input.feed("", true).forEach(handle), 40);
  }).once("end", close).resume();
  for (const signal of ["SIGINT","SIGHUP","SIGTERM"] as const) process.once(signal, close);
  process.stdout.on("error", close);
  screen.send("q", { q: "hello", app: "omo", v: [1], features: ["edit","send"] });
  process.stdout.write("\x1b[c\x1b[?2004h\x1b[>1u");
  timer = setTimeout(() => {
    process.stderr.write("OMO Native: Tern did not negotiate a surface. Enable Native program surfaces and reopen this pane.\r\n");
    process.exitCode = 1; void close();
  }, 1500);
}
