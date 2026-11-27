import { expect, spyOn, test } from "bun:test";
import quickTitle from "./quick-title-extension";

type Api = Parameters<typeof quickTitle>[0];
type Handler = Parameters<Api["on"]>[1];
type Context = Parameters<Handler>[1];
const valid = { provider: "opencode-go", id: "configured", api: "anthropic-messages", baseUrl: "https://example.test" };
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function session() {
  const events = new Map<string, Handler>();
  let rpc: (data: unknown) => void = () => {};
  let ticket: unknown;
  let clientMessageId: unknown;
  let durableSessionId: unknown;
  let title: string | undefined;
  let resolve!: (value: { stopReason: string; content: { type: string; text: string }[] }) => void;
  let request: { context: Record<string, unknown>; options: Record<string, unknown> } | undefined;
  let id = "first";
  const ctx: Context = {
    sessionManager: { getSessionId: () => id },
    modelRegistry: {
      find: (provider, id) => provider === valid.provider && id === valid.id ? valid : undefined,
      streamSimple(_model, context, options) {
        request = { context, options };
        return { result: () => new Promise(done => { resolve = done; }) };
      },
    },
  };
  quickTitle({
    on: (name, handler) => { events.set(name, handler); },
    rpc: { emit: (_, data) => { ({ ticket, clientMessageId, durableSessionId } = data); }, handle: (_, handler) => { rpc = handler; } },
    getSessionName: () => title,
    setSessionName: value => { title = value; },
  });
  return {
    event: (name: string, data: Record<string, unknown> = {}) => events.get(name)?.(data, ctx),
    start: (reason = "new") => events.get("session_start")?.({ reason }, ctx),
    input(clientMessageId: string) {
      events.get("message_start")?.({ message: { role: "user", clientMessageId, content: "Plant beans\nsynthetic-workspace-only" } }, ctx);
    },
    run: (route = "opencode-go/configured", originalText = "Plant beans", overrides = {}) =>
      rpc({ ticket, clientMessageId, durableSessionId, route, originalText, ...overrides }),
    name: (value: string) => { title = value; },
    replace: () => { id = "replacement"; },
    async send() {
      if (!request) throw new Error("No model request");
      const payload = (request.options.onPayload as (body: unknown, model: typeof valid) => unknown)({}, valid);
      const send = request.options.fetch as typeof fetch;
      const init = { method: "POST", body: JSON.stringify(payload) };
      await send(`${valid.baseUrl}/v1/messages?beta=true`, init);
      await expect(send(`${valid.baseUrl}/v1/messages?beta=true`, init)).rejects.toThrow("already consumed");
    },
    finish: (stopReason = "stop") => resolve({ stopReason, content: [{ type: "text", text: "Plant Beans" }] }),
    get title() { return title; },
    get request() { return request; },
  };
}

test("only the matching native handoff supplies title text, not the engine message", () => {
  const s = session();
  s.start(); s.event("input_disposition", { inputId: "handled", disposition: "handled" }); s.run();
  expect(s.request).toBeUndefined();
  s.input("first"); s.run(undefined, undefined, { clientMessageId: "wrong" });
  s.run(undefined, undefined, { durableSessionId: "retired" });
  expect(s.request).toBeUndefined();
  s.run();
  const first = s.request;
  expect(first?.context.messages).toEqual([{
    role: "user", content: "Write a short title for the following request. Return only the title, on one line.\n\nPlant beans",
    timestamp: expect.any(Number),
  }]);
  s.input("second"); s.run();
  expect(s.request).toBe(first);
});

test("unsupported, already named, and resumed sessions do not call the model", () => {
  for (const [reason, name, route] of [["new", "", "google/other"], ["new", "Manual", undefined], ["resume", "", undefined]]) {
    const s = session();
    s.start(reason); if (name) s.name(name);
    s.input("first"); s.run(route);
    expect(s.request).toBeUndefined();
  }
});

test("manual title, replacement, shutdown, and tool responses defeat a late result", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(new Response());
  try {
    for (const mode of ["success", "manual", "replace", "shutdown", "tool", "failure"]) {
      const s = session();
      s.start(); s.input("first"); s.run();
      await s.send();
      if (mode === "manual") s.name("Manual");
      if (mode === "replace") { s.replace(); s.start(); }
      if (mode === "shutdown") s.event("session_shutdown");
      s.finish(mode === "tool" ? "toolUse" : mode === "failure" ? "error" : "stop");
      await flush();
      expect(s.title).toBe(mode === "success" ? "Plant Beans" : mode === "manual" ? "Manual" : undefined);
    }
    expect(fetch).toHaveBeenCalledTimes(6);
  } finally {
    fetch.mockRestore();
  }
});
