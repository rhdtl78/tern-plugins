import { expect, test } from "bun:test";
import { QuickTitleClient } from "./quick-title-client";
import { OmoRpc, RpcCommandError, RpcRequestTimeoutError, RpcTransportError, type RpcRecord } from "./rpc";

const engine = `
const send = row => console.log(JSON.stringify(row));
for await (const line of console) {
  const q = JSON.parse(line);
  if (q.type === "die") process.exit(23);
  if (q.type === "silent") continue;
  const sessionId = "owned";
  send({ type: "response", id: q.id, command: q.type, sessionId, success: true,
    data: q.type === "open_session" ? { sessionId, state: {} } : { alive: true } });
}
`;
const route = { data: { schemaVersion: 1, rows: [{ kind: "category", name: "quick", effective: "opencode-go/configured" }] } };

function fixture() {
  const prompts: { id: unknown; reply: PromiseWithResolvers<RpcRecord> }[] = [];
  const routes: PromiseWithResolvers<RpcRecord>[] = [];
  const handoffs: unknown[] = [];
  const client = new QuickTitleClient({
    prompt(_text, { clientMessageId } = {}) {
      const reply = Promise.withResolvers<RpcRecord>();
      prompts.push({ id: clientMessageId, reply });
      return reply.promise;
    },
    request(_type, { name, data } = {}) {
      if (name !== "omo.modelRouting.resolve") {
        handoffs.push(data);
        return Promise.resolve({});
      }
      const reply = Promise.withResolvers<RpcRecord>();
      routes.push(reply);
      return reply.promise;
    },
  });
  function submit(text: string, durableSessionId: string) {
    const submitted = client.prompt(text, {});
    const { id, reply } = prompts[prompts.length - 1];
    const ticket = `ticket-${durableSessionId}`;
    const offer = () => client.offer({ ticket, clientMessageId: id, durableSessionId });
    const ack = (disposition = "started", overrides: RpcRecord = {}, admissionOverrides: RpcRecord = {}) => reply.resolve({ data: {
      clientMessageId: id, disposition, ...overrides,
      admission: { clientMessageId: id, durableSessionId, disposition, ...admissionOverrides },
    } });
    const expected = { ticket, clientMessageId: id, durableSessionId, originalText: text, route: "opencode-go/configured" };
    return { submitted, offer, ack, expected, reject: reply.reject };
  }
  async function claim(text: string, durable: string) {
    const input = submit(text, durable);
    const offered = input.offer();
    input.ack();
    await input.submitted;
    return { ...input, offered, route: routes[routes.length - 1] };
  }
  return { client, claim, submit, handoffs, routes };
}

test("a real request deadline leaves stdio usable and cannot retire the replacement's first title", async () => {
  const rpc = new OmoRpc({ cwd: import.meta.dir, argv: [process.execPath, "-e", engine], timeoutMs: 750 });
  try {
    await rpc.openSession();
    const f = fixture();
    const old = await f.claim("Old original", "D1");
    // Real OmoRpc deadline, relayed to the old owner only after D2 owns a claim.
    const deadline = rpc.request("silent").catch((error: unknown) => error);
    f.client.invalidate();
    const fresh = await f.claim("Fresh original", "D2");
    const expired = await deadline;
    expect(expired).toBeInstanceOf(RpcRequestTimeoutError);
    expect((await rpc.request("probe")).data).toEqual({ alive: true });
    old.route.reject(expired);
    await old.offered;
    fresh.route.resolve(route);
    await fresh.offered;
    expect(f.handoffs).toEqual([fresh.expected]);

    const retired = f.submit("Retired admission", "D2");
    const staleOffer = retired.offer();
    const refused = retired.submitted.catch((error: unknown) => error);
    f.client.invalidate();
    const next = await f.claim("Next original", "D3");
    retired.reject(expired);
    expect(await refused).toBe(expired);
    await staleOffer;
    next.route.resolve(route);
    await next.offered;
    expect(f.handoffs).toEqual([fresh.expected, next.expected]);
  } finally {
    await rpc.close();
  }
});

test("a true owned subprocess exit rejects calls and retires the pending title claim", async () => {
  const rpc = new OmoRpc({ cwd: import.meta.dir, argv: [process.execPath, "-e", engine], timeoutMs: 750 });
  try {
    await rpc.openSession();
    const f = fixture();
    const first = await f.claim("Old original", "D1");
    const failed = await rpc.request("die").catch((error: unknown) => error);
    expect(await rpc.exited).toEqual({ code: 23, signal: null });
    expect(failed).toBeInstanceOf(RpcTransportError);
    await expect(rpc.request("probe")).rejects.toBe(failed);
    const second = f.submit("Later original", "D1");
    first.route.reject(failed);
    await first.offered;
    second.ack();
    await second.submitted;
    await second.offer();
    expect(f.routes).toHaveLength(1);
    expect(f.handoffs).toEqual([]);
  } finally {
    await rpc.close();
  }
});

test.each(["started", "handled", "refused"])("a later %s prompt leaves the claimed original intact", async outcome => {
  const f = fixture();
  const first = await f.claim("First original", "D1");
  const second = f.submit("Second original", "D1");
  if (outcome === "refused") {
    second.reject(new RpcCommandError("prompt", { error: "refused" }));
    await expect(second.submitted).rejects.toBeInstanceOf(RpcCommandError);
  } else {
    second.ack(outcome);
    await second.submitted;
  }
  first.route.resolve(route);
  await first.offered;
  expect(f.handoffs).toEqual([first.expected]);
});

test("declines queued, handled, mismatched and retired admissions", async () => {
  const f = fixture();
  for (const [disposition, outer, nested] of [
    ["queued", {}, {}], ["handled", {}, {}],
    ["started", { clientMessageId: "wrong" }, {}],
    ["started", {}, { clientMessageId: "wrong" }],
    ["started", {}, { disposition: "queued" }],
    ["started", {}, { durableSessionId: "wrong" }],
  ] as const) {
    const input = f.submit("Unproven", "D1");
    const offered = input.offer();
    input.ack(disposition, outer, nested);
    await input.submitted;
    await offered;
  }
  const retired = f.submit("Retired", "D1");
  const stale = retired.offer();
  f.client.invalidate();
  retired.ack();
  await retired.submitted;
  await stale;
  expect(f.routes).toHaveLength(0);
  expect(f.handoffs).toEqual([]);
});

test.each(["success", "refusal"])("a cancelled route's late %s does not affect a replacement claim", async outcome => {
  const f = fixture();
  const first = await f.claim("Cancelled", "D2");
  f.client.invalidate();
  const fresh = await f.claim("Fresh original", "D3");
  if (outcome === "success") first.route.resolve(route);
  else first.route.reject(new RpcCommandError("extension_request", { error: "refused" }));
  await first.offered;
  fresh.route.resolve(route);
  await fresh.offered;
  expect(f.handoffs).toEqual([fresh.expected]);
});
