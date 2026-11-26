import { expect, test } from "bun:test";
import { checkpoint, sessionPending, sessionRefusal } from "./notice-fixture";
import { exercise, hasDetail, visible } from "./notice-pty";

const b64 = (text: string) => Buffer.from(text).toString("base64");
const osc = (packet: string) => `\x1b]5522;type=read:${packet}\x1b\\`;
const offer = (pw: string) => osc(`status=OK:pw=${pw}`) +
  osc(`status=DATA:pw=${pw}:mime=${b64(".")};${b64("text/plain")}`) + osc(`status=DONE:pw=${pw}`);
const complete = (id: string, text: string) =>
  osc(`status=DATA:id=${id}:mime=${b64("text/plain")};${b64(text)}`) + osc(`status=DONE:id=${id}`);

test("#33 discards the cancelled Resume clipboard read and accepts the next paste in the same session", async () => {
  const original = "/resume", suffix = " ordinary paste";
  let stage = 0, pickerRead = "", beforePaste: unknown, afterPaste: unknown;
  const calls = await exercise(false, (views, { clipboardReadId, key }, ops) => {
    const draft = views.get("draft")?.props;
    const picker = visible(views).find(view => view.props.role === "omo.sessions");
    if (stage === 0 && draft?.sendable === true) {
      stage++; key(original + "\r");
    } else if (stage === 1 && picker?.props.state === "ready") {
      stage++; key(offer("picker"));
    } else if (stage === 2 && clipboardReadId) {
      pickerRead = clipboardReadId;
      stage++; key("\x1b[27u");
    } else if (stage === 3 && !picker && draft?.sendable === true) {
      expect(draft.text).toBe(original);
      stage++; key(complete(pickerRead, "search words") + offer("composer"));
    } else if (stage === 4 && clipboardReadId) {
      expect(clipboardReadId).not.toBe(pickerRead);
      beforePaste = draft?.text;
      stage++; key(complete(clipboardReadId, suffix));
    } else if (stage === 5 && ops.some(op => Array.isArray(op) && op[0] === "set" && op[1] === "draft")) {
      afterPaste = draft?.text;
      return true;
    }
    return false;
  }, "session");
  expect(calls).toBe('["open_session",null]\n');
  expect(beforePaste).toBe(original);
  expect(afterPaste).toBe(original + suffix);
});

const nextDraft = "my next message";

test.each([
  ["stats menu success keeps replacement", "/sessi", "get_session_stats", null, "replace", true],
  ["inline rename success keeps replacement", "/rename New name", "set_session_name", "New name", "replace", true],
  ["stats menu success keeps an edited-back query (ABA)", "/sessi", "get_session_stats", null, "undo", true],
  ["stats menu success consumes the unchanged query", "/sessi", "get_session_stats", null, "unchanged", true],
  ["inline rename success consumes the unchanged command", "/rename New name", "set_session_name", "New name", "unchanged", true],
  ["stats menu failure retains the unchanged query", "/sessi", "get_session_stats", null, "unchanged", false],
  ["inline rename failure retains the replacement", "/rename New name", "set_session_name", "New name", "replace", false],
  ["addressed command success keeps a different existing draft", nextDraft, "set_session_name", "New name", "addressed", true],
] as const)("#33 %s", async (_case, typed, rpc, name, edit, success) => {
  let stage: "startup" | "invoked" | "replacement" | "undo" | "released" | "done" = "startup";
  let settled: unknown;
  const completion = !success ? sessionRefusal : rpc === "get_session_stats" ? "Session notice-test · 3 messages" : "Session renamed.";
  const calls = await exercise(false, (views, { event, key, release }) => {
    const draft = views.get("draft")?.props;
    if (stage === "startup" && draft?.sendable === true) {
      stage = "invoked";
      if (edit === "addressed") {
        key(typed);
        event({ ev: "send", id: "draft", text: `/rename ${name}` });
      } else key(typed + "\r");
    } else if (stage === "invoked" && hasDetail(views, sessionPending) && draft?.sendable === false) {
      expect(draft.text).toBe(typed);
      if (edit === "unchanged" || edit === "addressed") {
        stage = "released"; release(checkpoint.acknowledged);
      } else {
        stage = "replacement";
        event({ ev: "edit", id: "draft", len: typed.length, from: 0, to: typed.length, text: nextDraft, cursor: nextDraft.length });
      }
    } else if (stage === "replacement" && draft?.text === nextDraft) {
      if (edit === "undo") { stage = "undo"; event({ ev: "undo", id: "draft" }); }
      else { stage = "released"; release(checkpoint.acknowledged); }
    } else if (stage === "undo" && draft?.text === typed) {
      stage = "released"; release(checkpoint.acknowledged);
    } else if (stage === "released" && draft?.sendable === true && hasDetail(views, completion)) {
      settled = draft.text;
      stage = "done";
      return true;
    }
    return false;
  }, success ? "session" : "session-refused");
  expect(stage).toBe("done");
  expect(calls).toBe('["open_session",null]\n' + JSON.stringify([rpc, name]) + "\n");
  expect(settled).toBe(edit === "replace" ? nextDraft : success && edit === "unchanged" ? "" : typed);
});
