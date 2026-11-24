import { expect, test } from "bun:test";
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

test("restored calls and result events share a disclosure and keep output literal", () => {
  const ops: Op[] = [];
  const t = new Transcript((...o) => ops.push(...o));
  t.message({ role: "user", content: "<a>**not Markdown**</a>" });
  t.message({ role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "x.ts" } }] });
  t.event({ type: "tool_execution_end", toolCallId: "call", result: { content: [{ type: "text", text: "\x1b[31m<b>text</b>" }] } });
  expect(ops.filter(o => o[0] === "add")).toHaveLength(2);
  expect(ops[0]?.[4]).toMatchObject({ c: [{ k: "text", p: { text: "<a>**not Markdown**</a>" } }] });
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

test.each(["live", "restored"] as const)("%s Todo displays all phases and statuses inside the original tool card", (source) => {
  const ops: Op[] = [];
  const t = new Transcript((...o) => ops.push(...o));
  t.message({ role: "assistant", content: [{ type: "toolCall", id: "call", name: "todo" }] });
  t.fold("t1", false);
  const result = { content: [{ type: "text", text: "Raw status" }], details: todoDetails };
  if (source === "live") t.event({ type: "tool_execution_end", toolCallId: "call", toolName: "todo", result });
  else t.message({ role: "toolResult", toolCallId: "call", toolName: "todo", ...result });

  expect(ops.filter(o => o[2] === "main")).toHaveLength(1);
  expect(ops).toContainEqual(["del", "t1.out"]);
  expect(ops.find(o => o[0] === "add" && o[2] === "t1.scroll")?.[4]).toMatchObject({
    k: "checklist", p: { mode: "full", phases: [
      { title: "Validation", items: [
        { text: "Check input", status: "done" },
        { text: "Review output", status: "active" },
      ] },
      { title: "Release", items: [{ text: "Publish report", status: "pending" }] },
    ] },
  });
  t.flipTools();
  expect(ops.at(-1)).toEqual(["set", "t1", { collapsed: true }]);
});

test.each([
  ["legacy", "todo", false, undefined],
  ["malformed", "todo", false, { phases: [...todoDetails.phases, { name: "Broken", tasks: [{}] }] }],
  ["unknown status", "todo", false, { phases: [{ name: "Check", tasks: [{ content: "Task", status: "active" }] }] }],
  ["failed", "todo", true, todoDetails],
  ["different tool", "read", false, todoDetails],
] as const)("%s result retains the literal code body", (_label, toolName, isError, details) => {
  const ops: Op[] = [];
  const t = new Transcript((...o) => ops.push(...o));
  t.message({ role: "toolResult", toolCallId: "call", toolName, isError, details,
    content: [{ type: "text", text: "**Raw status**" }] });
  const literal = { k: "code", p: { text: "**Raw status**" } };
  expect(ops[0]?.[4]).toMatchObject({
    k: "tool", p: { status: isError ? "error" : "done" },
    c: toolName === "todo" ? [{ k: "scroll", c: [literal] }] : [literal],
  });
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
