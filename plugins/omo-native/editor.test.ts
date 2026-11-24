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
