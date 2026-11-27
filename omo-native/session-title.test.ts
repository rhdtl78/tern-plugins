import { expect, test } from "bun:test";
import { SessionTitle } from "./session-title";

test("the title uses only one OSC sequence even when the saved name contains terminal controls", () => {
  const output: string[] = [];
  const title = new SessionTitle(sequence => output.push(sequence));
  title.observe("Saved\x1b]0;payload\x07\u009c");
  expect(output).toEqual(["\x1b]0;Saved ]0;payload\x1b\\"]);
});

test("an older state read cannot undo a newer session title event", () => {
  const output: string[] = [];
  const title = new SessionTitle(sequence => output.push(sequence));
  const beforeRead = title.revision;
  title.observe("New session");
  title.restore("Previous session", beforeRead);
  expect(output).toEqual(["\x1b]0;New session\x1b\\"]);
});

test("an untitled replacement clears the old pane title and close stops output", () => {
  const output: string[] = [];
  const title = new SessionTitle(sequence => output.push(sequence));
  title.observe("Previous session");
  title.observe(undefined);
  title.close();
  title.observe("Late result");
  expect(output).toEqual(["\x1b]0;Previous session\x1b\\", "\x1b]0;OMO\x1b\\"]);
});
