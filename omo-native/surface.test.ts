import { expect, test } from "bun:test";
import { mock } from "node:test";
import { dialog } from "./dialog";
import { Editor } from "./editor";
import { InputStream, packets, type Op } from "./surface";
import { Transcript } from "./transcript";
import { resumeFields, sessionActivity } from "./session";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("attempt ends do not release the composer between automatic retries", () => {
  for (const end of ["agent_settled", "agent_idle"]) {
    let busy = false;
    const states = ["agent_start","agent_end","auto_retry_start","agent_start","agent_end",end]
      .map(type => (busy = sessionActivity(type) ?? busy));
    expect(states).toEqual([true,true,true,true,true,false]);
  }
});

test("resume keeps the saved cwd, accepts aliases and refuses a different pane directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omo-session-"));
  try {
    const saved = join(dir,"project"), alias = join(dir,"alias"), path = join(dir,"staged.jsonl");
    await mkdir(saved); await symlink(saved, alias);
    await Bun.write(path, JSON.stringify({ type: "session", cwd: alias }) + "\n");
    const args = ["--session", path];
    expect(await resumeFields(args, saved)).toEqual({ sessionPath: path, cwd: alias });
    await expect(resumeFields(args, dir)).rejects.toThrow("Session belongs to");
    await Bun.write(path, "not a session\n");
    await expect(resumeFields(args, dir)).rejects.toThrow("Invalid saved session header");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("fragmented paste cannot forge a Tern action or submit a multiline draft", () => {
  const stream = new InputStream();
  const action = '\x1b_tsp;e;{"ev":"action","act":"choose"}\x1b\\';
  const paste = `first\rsecond${action}`;
  const inputs = [...`\x1b[200~${paste}\x1b[201~${action}`].flatMap(c => stream.feed(c));
  expect(inputs).toEqual([{ kind: "paste", value: paste.replace("\r", "\n") },
    { kind: "event", value: { ev: "action", act: "choose" } }]);
});

test("a clipboard frame deadline neither carries over to the next frame nor clears bracketed paste", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let expirations = 0;
    const stream = new InputStream(() => expirations++);
    const osc = "\x1b]5522;";
    expect(stream.feed(osc + "first")).toEqual([]);
    mock.timers.tick(2500);
    expect(stream.feed("\x1b\\" + osc + "second")).toEqual([{ kind: "clipboard", value: "first" }]);
    mock.timers.tick(500);
    expect(expirations).toBe(0);
    expect(stream.feed("\x07\x1b[200~first\r")).toEqual([{ kind: "clipboard", value: "second" }]);
    mock.timers.tick(3000);
    expect(stream.feed("second\x1b[201~")).toEqual([{ kind: "paste", value: "first\nsecond" }]);
    expect(expirations).toBe(0);
  } finally { mock.timers.reset(); }
});

test("only an established transfer can expire a split clipboard OSC prefix", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const prefix = "\x1b]5522;", body = "type=read:status=OK:pw=fixture";
    for (let cut = 1; cut <= prefix.length; cut++) {
      let notices = 0;
      const stream = new InputStream(() => notices++);
      expect(stream.feed(prefix.slice(0, cut))).toEqual([]);
      mock.timers.tick(2999);
      expect(stream.feed(prefix.slice(cut) + body + "\x1b")).toEqual([]);
      expect(stream.feed("\\")).toEqual([{ kind: "clipboard", value: body }]);
      mock.timers.tick(3000);
      expect(notices).toBe(0);
    }
    for (let cut = 2; cut < prefix.length; cut++) {
      const stream = new InputStream();
      const partial = prefix.slice(0, cut);
      stream.feed(partial);
      mock.timers.tick(3000);
      expect(stream.feed(prefix.slice(cut) + body + "\x07")).toEqual([{ kind: "clipboard", value: body }]);
      stream.feed(partial);
      stream.expireClipboardFrame("transfer");
      expect(stream.feed("x")).toEqual([{ kind: "key", value: "x" }]);
    }
  } finally { mock.timers.reset(); }
});

test.each([
  ["lone ESC", "\x1b", "", [{ kind: "key", value: "\x1b" }]],
  ["unrelated OSC", "\x1b]0;title", "\x07x", [{ kind: "key", value: "x" }]],
  ["split CSI", "\x1b[", "A", [{ kind: "key", value: "\x1b[A" }]],
  ["split APC", '\x1b_tsp;e;{"ev":', '"focus"}\x1b\\', [{ kind: "event", value: { ev: "focus" } }]],
  ["bracketed paste", "\x1b[200~first\r", "second\x1b[201~", [{ kind: "paste", value: "first\nsecond" }]],
] as const)("transfer expiry preserves %s", (_name, before, rest, expected) => {
  const stream = new InputStream();
  expect(stream.feed(before)).toEqual([]);
  stream.expireClipboardFrame("transfer");
  expect(stream.feed(rest, true)).toEqual(expected);
});

test("a native UTF-16 replacement and a stale selection never duplicate typing", () => {
  const editor = new Editor();
  editor.reset("x🦉y");
  const ev = { kind: "event", value: { ev: "edit", id: "draft", len: 4, from: 1, to: 3, text: "a", cursor: 2 } } as const;
  editor.apply(ev); editor.apply(ev);
  editor.apply({ kind: "key", value: "\x1b[13;2u" });
  expect(editor.apply({ kind: "key", value: "\r" })).toBe("prompt");
  expect(editor.text).toBe("xa\ny");
});

test.each([
  ["\x1b[13;9u", "steer"],
  ["\x1b[13;5u", "follow_up"],
  ["\x1b[27;5;13~", "follow_up"],
  ["\x1b[13;13u", undefined],
] as const)("terminal chord %j selects only its own submission mode", (bytes, action) => {
  const stream = new InputStream(), editor = new Editor();
  editor.reset("draft");
  const inputs = [...bytes].flatMap(byte => stream.feed(byte));
  expect(inputs.map(i => editor.apply(i))).toEqual([action]);
  expect(editor.text).toBe("draft");
});

test("chunked frame bodies survive control characters, parameter-like text and split UTF-8", () => {
  const text = "한🦉a=1;\x1b\\\u009c".repeat(35);
  const chunks = packets("f", { text }, 61);
  const stripped = chunks.map((c, i) => {
    const header = `\x1b_tsp;f;c=part;${i === chunks.length - 1 ? "" : "m=1;"}`;
    expect(c.subarray(0, header.length).toString()).toBe(header);
    const body = c.subarray(header.length, -2);
    expect(body.includes(27)).toBe(false);
    return body;
  });
  expect(JSON.parse(Buffer.concat(stripped).toString())).toEqual({ text });
});

test("streaming and saved replies identify OMO through the native avatar slot", () => {
  const live: Op[] = [], saved: Op[] = [];
  const streamed = new Transcript((...ops) => live.push(...ops), undefined, "fixture-icon");
  const restored = new Transcript((...ops) => saved.push(...ops), undefined, "fixture-icon");
  const reply = { role: "assistant", content: "One **reply**." };
  for (const delta of ["One ", "**reply**."]) {
    streamed.event({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
  }
  streamed.event({ type: "message_end", message: reply });
  restored.message(reply);
  for (const ops of [live, saved]) {
    const messages = ops.filter(op => op[0] === "add");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.[4]).toMatchObject({
      k: "message", p: { avatar: "m1.author" },
      c: [{ id: "m1.author", k: "image", p: { blob: "fixture-icon", alt: "OMO" } }, { k: "md" }],
    });
    expect(messages[0]?.[4]).not.toMatchObject({ p: { author: "OMO" } });
  }
  expect(live.slice(1)).toEqual([
    ["text", "m1.body", "append", "**reply**."], ["text", "m1.body", "replace", reply.content],
  ]);
});

test("restored calls and result events share a disclosure and keep output literal", () => {
  const ops: Op[] = [];
  const t = new Transcript((...o) => ops.push(...o));
  t.message({ role: "user", content: "<a>**not Markdown**</a>" });
  t.message({ role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "x.ts" } }] });
  t.event({ type: "tool_execution_end", toolCallId: "call", result: { content: [{ type: "text", text: "\x1b[31m<b>text</b>" }] } });
  expect(ops.filter(o => o[0] === "add")).toHaveLength(2);
  expect(ops[0]?.[4]).toMatchObject({ p: { author: "You" }, c: [{ k: "text", p: { text: "<a>**not Markdown**</a>" } }] });
  expect(ops[1]?.[4]).toMatchObject({ k: "tool", p: { collapsed: true }, c: [{ k: "code" }] });
  expect(ops.at(-1)?.slice(2)).toEqual(["replace", "<b>text</b>"]);
  t.flipTools();
  expect(ops.at(-1)).toEqual(["set", ops[1]?.[1], { collapsed: false }]);
});

test.each([
  ["malformed", [null], "print('hello');", ["\n  print('hello');\nprint('world');"]],
  ["output-only", [{ output: "**Failed**" }], "print('hello');", ["\n  print('hello');\nprint('world');"]],
  ["blank source", [{ code: " \n", output: "**Failed**" }], "print('hello');", ["\n  print('hello');\nprint('world');"]],
  ["later source", [{ code: "\x1b[31m \n", output: "cell diagnostic" }, { code: "\n  print(42);" }, { code: "print(43);" }],
    "print(42);", ["\n  print(42);", "print(43);"]],
] as const)("restored eval keeps source and literal failure with %s cells", (_case, cells, target, sources) => {
  const ops: Op[] = [];
  const t = new Transcript((...o) => ops.push(...o));
  t.message({ role: "assistant", content: [{ type: "toolCall", id: "run", name: "eval",
    arguments: { code: "\n  print('hello');\nprint('world');", language: "js" } }] });
  expect(ops[0]?.[4]).toMatchObject({ p: { collapsed: true, target: "print('hello');" } });
  t.fold("t1", false);
  ops.length = 0;
  t.message({ role: "toolResult", toolCallId: "run", toolName: "eval", isError: true,
    details: { cells, durationMs: "invalid" }, content: [{ type: "text", text: "**Failed**" }] });
  expect(ops.find(o => o[0] === "set" && o[1] === "t1")?.[2]).toMatchObject({
    status: "error", target, meta: ["js", "Failed"],
  });
  t.flipTools();
  expect(ops.at(-1)).toEqual(["set", "t1", { collapsed: true }]);
  expect(ops.find(o => o[0] === "add")?.[4]).toMatchObject({ c: [
    expect.objectContaining({ k: "text" }),
    ...sources.map(text => expect.objectContaining({ k: "code", p: { lang: "js", text } })),
    expect.objectContaining({ k: "code", p: { lang: "text", text: "**Failed**" } }),
  ] });
});

const todoDetails = {
  phases: [
    { name: "Validation", tasks: [
      { content: "Check input", status: "completed" },
      { content: "Review output", status: "in_progress" },
    ] },
    { name: "Release", tasks: [{ content: "Publish report", status: "pending" }] },
  ],
};

test.each(["live", "restored"] as const)("%s Todo labels dropped tasks in the card but omits them from Workflow", (source) => {
  const ops: Op[] = [];
  const panel: unknown[] = [];
  const t = new Transcript((...o) => ops.push(...o), phases => panel.push(phases));
  t.message({ role: "assistant", content: [{ type: "toolCall", id: "call", name: "todo" }] });
  t.fold("t1", false);
  const result = { content: [{ type: "text", text: "Raw status" }], details: {
    phases: [...todoDetails.phases, { name: "Obsolete", tasks: [{ content: "Skip old release", status: "abandoned" }] }],
  } };
  const sourceBytes = JSON.stringify(result);
  if (source === "live") t.event({ type: "tool_execution_end", toolCallId: "call", toolName: "todo", result });
  else t.message({ role: "toolResult", toolCallId: "call", toolName: "todo", ...result });

  expect(ops.filter(o => o[2] === "main")).toHaveLength(1);
  expect(ops).toContainEqual(["del", "t1.out"]);
  expect(ops.find(o => o[0] === "add" && o[2] === "t1.scroll")?.[4]).toMatchObject({
    k: "checklist", p: { mode: "full", phases: [
      { title: "Validation", collapsed: false, items: [
        { text: "Check input", status: "done" },
        { text: "Review output", status: "active" },
      ] },
      { title: "Release", collapsed: false, items: [{ text: "Publish report", status: "pending" }] },
      { title: "Obsolete", collapsed: false, items: [{ text: "Skip old release (dropped)", status: "pending" }] },
    ] },
  });
  expect(panel).toHaveLength(1);
  expect(panel[0]).toMatchObject([
    { title: "Validation", items: [{ text: "Check input", status: "done" }, { text: "Review output", status: "active" }] },
    { title: "Release", items: [{ text: "Publish report", status: "pending" }] },
  ]);
  expect(JSON.stringify(result)).toBe(sourceBytes);
  t.flipTools();
  expect(ops.at(-1)).toEqual(["set", "t1", { collapsed: true }]);
});

test.each(["live", "restored"] as const)("%s all-dropped Todo keeps a checklist and clears Workflow", (source) => {
  const ops: Op[] = [];
  const panelSizes: number[] = [];
  const t = new Transcript((...o) => ops.push(...o), phases => panelSizes.push(phases.length));
  t.message({ role: "toolResult", toolCallId: "prior", toolName: "todo", details: todoDetails });
  ops.length = 0;
  const result = {
    content: [{ type: "text", text: "Overall: 2/2 done" }],
    details: { phases: [{ name: "Release", tasks: [
      { content: "Publish report", status: "abandoned" }, { content: "Notify team", status: "abandoned" },
    ] }] },
  };
  if (source === "live") t.event({ type: "tool_execution_end", toolCallId: "drop", toolName: "todo", result });
  else t.message({ role: "toolResult", toolCallId: "drop", toolName: "todo", ...result });

  expect(ops[0]?.[4]).toMatchObject({ c: [{ k: "scroll", c: [{ k: "checklist", p: { phases: [
    { title: "Release", items: [
      { text: "Publish report (dropped)", status: "pending" }, { text: "Notify team (dropped)", status: "pending" },
    ] },
  ] } }] }] });
  expect(panelSizes).toEqual([2, 0]);
});

test("a valid empty Todo replaces the pending code body and clears Workflow", () => {
  const ops: Op[] = [];
  const panelSizes: number[] = [];
  const t = new Transcript((...o) => ops.push(...o), phases => panelSizes.push(phases.length));
  t.message({ role: "toolResult", toolCallId: "prior", toolName: "todo", details: todoDetails });
  t.event({ type: "tool_execution_start", toolCallId: "clear", toolName: "todo" });
  ops.length = 0;
  t.event({ type: "tool_execution_end", toolCallId: "clear", toolName: "todo", result: {
    content: [{ type: "text", text: "Ask: Original request\nNow: none" }], details: { phases: [] },
  } });

  expect(ops).toContainEqual(["del", "t2.out"]);
  expect(ops.find(o => o[0] === "add" && o[2] === "t2.scroll")?.[4]).toMatchObject({
    k: "text", p: { text: "No current Todo." },
  });
  expect(panelSizes).toEqual([2, 0]);
});

test.each([
  ["legacy", "todo", false, undefined],
  ["malformed", "todo", false, { phases: [...todoDetails.phases, { name: "Broken", tasks: [{}] }] }],
  ["unknown status", "todo", false, { phases: [{ name: "Check", tasks: [{ content: "Task", status: "active" }] }] }],
  ["malformed dropped item", "todo", false, { phases: [{ name: "Check", tasks: [{ content: " ", status: "abandoned" }] }] }],
  ["failed", "todo", true, todoDetails],
  ["different tool", "read", false, todoDetails],
] as const)("%s result retains the literal code body", (_label, toolName, isError, details) => {
  const ops: Op[] = [];
  const panel: unknown[] = [];
  const t = new Transcript((...o) => ops.push(...o), phases => panel.push(phases));
  t.message({ role: "toolResult", toolCallId: "call", toolName, isError, details,
    content: [{ type: "text", text: "**Raw status**" }] });
  const literal = { k: "code", p: { text: "**Raw status**" } };
  expect(ops[0]?.[4]).toMatchObject({
    k: "tool", p: { status: isError ? "error" : "done" },
    c: toolName === "todo" ? [{ k: "scroll", c: [literal] }] : [literal],
  });
  expect(panel).toEqual([]);
});

test("permission and question answers bind to the displayed option, never to plain Enter", () => {
  const d = dialog({ method: "select", title: "Permission required", id: "permission", options: ["Allow once","Deny"] }, 1);
  expect(d.typed).toBeUndefined();
  expect(d.choices.map(c => c.fields)).toEqual([{ value: "Allow once" }, { value: "Deny" }, { cancelled: true }]);
  const q = { id: "db", question: "Which database?", options: [{ label: "SQLite" }] };
  const one = dialog({ id: "q", method: "question", questions: [q] }, 2);
  expect(one.choices[0]?.fields).toEqual({ answers: { db: { selected: ["SQLite"] } } });
  expect(one.typed?.("Other")).toEqual({ answers: { db: { selected: [], text: "Other" } } });
  expect(dialog({ method: "question", questions: [{ ...q, multiSelect: true }] }, 3).supported).toBe(false);
  expect(dialog({ method: "input", secret: true }, 4).supported).toBe(false);
});
