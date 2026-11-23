import { expect, test } from "bun:test";
import { OmoRpc, RpcCommandError, RpcTransportError } from "./rpc";
import type { RpcEvent } from "./rpc";

// A subprocess at the JSONL boundary, not a mock of OmoRpc.
const engine = String.raw`
const output = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const reply = (q, extra = {}) => output({
  type: "response", command: q.type, id: q.id, sessionId: q.sessionId, success: true, ...extra,
});
const sessionId = "owned";
let capabilities = [];
let prompt;
let closed = false;
for await (const line of console) {
  if (line === "") continue;
  const q = JSON.parse(line);
  if (q.type === "set_client_info") {
    capabilities = q.capabilities;
    reply(q);
  } else if (q.type === "open_session") {
    reply(q, { sessionId, data: { sessionId, state: { isStreaming: false } } });
    if (capabilities.includes("extension_events")) {
      const frame = Buffer.from(JSON.stringify({ type: "extension_event", sessionId, text: "🦉\u2028ready" }) + "\r\n");
      const split = frame.indexOf(Buffer.from("🦉")) + 1;
      process.stdout.write(frame.subarray(0, split));
      process.stdout.write(frame.subarray(split));
    }
  } else if (q.sessionId !== sessionId) {
    reply(q, { success: false, errorCode: "unknown_session" });
  } else if (q.type === "get_messages") {
    reply(q, { data: { messages: [{ role: "user", content: "persisted" }] } });
  } else if (q.type === "prompt") {
    prompt = q;
    output({ type: "extension_ui_request", id: q.id, sessionId: "foreign" });
    output({ type: "extension_ui_request", id: q.id, sessionId, method: "confirm" });
    reply(q, { sessionId: "foreign", data: { accepted: false } });
    reply(q, { command: "abort", data: { accepted: false } });
  } else if (q.type === "extension_ui_response") {
    if (q.uiRequestId !== prompt.id || q.id === prompt.id || q.confirmed !== true) {
      reply(q, { success: false, errorCode: "invalid_ui_answer" });
    } else {
      reply(q);
      reply(prompt, { data: { accepted: true } });
    }
  } else if (q.type === "abort") {
    reply(q, { success: false, errorCode: "not_running" });
  } else if (q.type === "close_session") {
    closed = true;
    reply(q);
  }
}
process.exitCode = closed ? 0 : 7;
`;

test("routes hydration and UI replies without mixing responses or foreign events", async () => {
  const rpc = new OmoRpc({
    cwd: import.meta.dir,
    argv: [process.execPath, "-e", engine],
    capabilities: ["extension_events"],
    timeoutMs: 1500,
  });
  const events: RpcEvent[] = [];
  const dialog = Promise.withResolvers<RpcEvent>();
  const unsubscribe = rpc.onEvent((event) => {
    events.push(event);
    if (event.type === "extension_ui_request") dialog.resolve(event);
  });
  try {
    await rpc.openSession();
    expect(await rpc.getMessages()).toEqual([{ role: "user", content: "persisted" }]);
    const turn = rpc.prompt("continue", { sessionId: "foreign" });
    // A failed transport also releases the event wait; no timed sleep.
    const event = await Promise.race([dialog.promise, turn.then(() => undefined)]);
    if (typeof event?.id !== "string") throw new Error("Prompt settled before its UI request");
    await rpc.respondToUi(event.id, { confirmed: true, id: event.id });
    expect((await turn).data).toEqual({ accepted: true });
    expect(events.map(({ type, text }) => [type, text])).toEqual([
      ["extension_event", "🦉\u2028ready"],
      ["extension_ui_request", undefined],
    ]);
    await expect(rpc.abort()).rejects.toBeInstanceOf(RpcCommandError);
  } finally {
    unsubscribe();
    await rpc.close();
  }
  expect(await rpc.exited).toEqual({ code: 0, signal: null });
});

test("rejects in-flight and later commands when the subprocess exits", async () => {
  const rpc = new OmoRpc({
    cwd: import.meta.dir,
    argv: [process.execPath, "-e", "for await (const _ of console) process.exit(23);"],
    timeoutMs: 1500,
  });
  try {
    const results = await Promise.allSettled([rpc.openSession(), rpc.getProtocolInfo()]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") throw new Error("Request unexpectedly succeeded");
      expect(result.reason).toBeInstanceOf(RpcTransportError);
      expect(result.reason.message).toContain("(23)");
    }
    await expect(rpc.getProtocolInfo()).rejects.toThrow("(23)");
  } finally {
    expect(await rpc.close()).toEqual({ code: 23, signal: null });
  }
});

test("reports an executable spawn failure instead of waiting for the request timeout", async () => {
  const open = async () => {
    const rpc = new OmoRpc({ cwd: import.meta.dir, argv: ["/dev/null/omo"], timeoutMs: 1500 });
    try {
      return await rpc.openSession();
    } finally {
      await rpc.close();
    }
  };
  await expect(open()).rejects.toMatchObject({
    name: "RpcTransportError",
    cause: { code: "ENOTDIR" },
  });
});
