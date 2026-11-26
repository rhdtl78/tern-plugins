import { expect, test } from "bun:test";
import { Editor } from "./editor";
import { InputStream } from "./surface";

const undo = "\x1b_tsp;e;{\"ev\":\"undo\",\"id\":\"draft\",\"sf\":\"omo\"}\x1b\\";
const state = ({ text, cursor }: Editor) => ({ text, cursor });
function type(editor: Editor, bytes: string) {
  for (const input of new InputStream().feed(bytes)) editor.apply(input);
}

test.each([
  ["Option+Backspace", "\x1b[127;3u", 17, "before\n🦉 café, ", 16, "before\n🦉 café, λ", 17],
  ["Cmd+Backspace", "\x15", 17, "before\n", 7, "before\n🦉 café, λ", 17],
  ["Option+Left", "\x1b[98;3u", 16, "before\n🦉 café, λ", 10, "before\n🦉 café, λ", 10],
  ["Option+Right", "\x1b[102;3u", 10, "before\n🦉 café, λ", 14, "before\n🦉 café, λ", 14],
  ["Cmd+Backspace at a new line", "\x15", 7, "before\n🦉 café, λ", 7, "before\n🦉 café, λ", 7],
] as const)("%s follows draft boundaries and only records mutations", (_, bytes, cursor, text, at, undone, undoAt) => {
  const editor = new Editor();
  editor.reset("before\n🦉 café, λ", cursor);

  type(editor, bytes);
  expect(state(editor)).toEqual({ text, cursor: at });
  type(editor, undo);
  expect(state(editor)).toEqual({ text: undone, cursor: undoAt });
});

test("undo reverses the selected UTF-16 replacement, not the following caret move", () => {
  const editor = new Editor();
  editor.reset("a🦉z", 3);
  editor.apply({ kind: "event", value: { ev: "edit", id: "draft", len: 4, from: 1, to: 3, text: "x", cursor: 2 } });
  editor.apply({ kind: "event", value: { ev: "edit", id: "draft", len: 3, from: 0, to: 0, text: "", cursor: 0 } });
  type(editor, undo);
  expect(state(editor)).toEqual({ text: "a🦉z", cursor: 3 });
});

test("undo restores an emptied draft but not a prior submitted draft", () => {
  const editor = new Editor();
  type(editor, "sent");
  editor.reset("");
  type(editor, "x");
  type(editor, "\x7f");
  type(editor, "\x1b[122;9u");
  expect(state(editor)).toEqual({ text: "x", cursor: 1 });
  type(editor, undo + undo);
  expect(state(editor)).toEqual({ text: "", cursor: 0 });
});

test("undo retains only the latest 100 changes", () => {
  const editor = new Editor();
  type(editor, "x".repeat(101));
  type(editor, undo.repeat(101));
  expect(state(editor)).toEqual({ text: "x", cursor: 1 });
});

test("selected multiline replacement can be undone and redone without submitting", () => {
  const editor = new Editor();
  const original = "before\n한글 🦉";
  editor.reset(original);
  expect(editor.apply({ kind: "event", value: {
    ev: "edit", id: "draft", len: original.length, from: 0, to: original.length, text: "", cursor: 0,
  } })).toBe("edit");
  expect(state(editor)).toEqual({ text: "", cursor: 0 });
  type(editor, undo);
  expect(state(editor)).toEqual({ text: original, cursor: original.length });
  type(editor, "\x1b[122;10u");
  expect(state(editor)).toEqual({ text: "", cursor: 0 });
  type(editor, undo);
  expect(state(editor)).toEqual({ text: original, cursor: original.length });
});

test("moving the caret preserves redo, but editing or resetting the draft discards it", () => {
  const editor = new Editor();
  type(editor, "\x1b[200~one\ntwo\x1b[201~");
  type(editor, undo + "\x1b[1;5H\x1b[121;5u");
  expect(state(editor)).toEqual({ text: "one\ntwo", cursor: 7 });
  type(editor, undo + "x\x1b[122;6u");
  expect(state(editor)).toEqual({ text: "x", cursor: 1 });
  type(editor, undo);
  editor.reset("new");
  type(editor, "\x1b[122;10u");
  expect(state(editor)).toEqual({ text: "new", cursor: 3 });
});

test("vertical moves preserve the preferred column over short and empty lines", () => {
  const editor = new Editor();
  editor.reset("1234\nx\n\n🦉한글요", 3);
  for (const [key, cursor] of [["B", 6], ["B", 7], ["B", 12], ["A", 7], ["A", 6], ["A", 3]] as const) {
    type(editor, `\x1b[${key}`);
    expect(editor.cursor).toBe(cursor);
  }
});

test("word and character deletions preserve neighboring text", () => {
  const editor = new Editor();
  editor.reset("one two\n👩‍💻!", 0);
  type(editor, "\x1b[3;3~");
  expect(state(editor)).toEqual({ text: " two\n👩‍💻!", cursor: 0 });
  type(editor, "\x1b[1;5F\x1b[D\x7f");
  expect(state(editor)).toEqual({ text: " two\n!", cursor: 5 });
});
