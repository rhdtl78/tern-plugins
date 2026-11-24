import { expect, test } from "bun:test";
import type { RpcRecord } from "./rpc";
import type { Op } from "./surface";
import { renderUsage, supportsUsage, UsageMeter, usageNode } from "./usage";

const gpt = { provider: "chatgpt-subscription", id: "gpt" };
const claude = { provider: "anthropic-subscription", id: "sonnet" };
const active = { name: "work", active: true };
const pinned = { name: "personal", pinned: true };
const window = (id: string, usedPercent: number, label = "5h", resetsAt?: string) =>
  ({ id, label, usedPercent, resetsAt });
const account = (windows: readonly RpcRecord[], overrides: RpcRecord = {}) => ({
  provider: gpt.provider, account: active.name, reportedAt: "2026-01-01T00:00:00Z", windows, ...overrides,
});
const envelope = (command: string, accounts: readonly RpcRecord[]) =>
  ({ type: "response", command, success: true, data: { accounts } });
const limit = (used: number, overrides?: RpcRecord) => account([window("codex:primary", used)], overrides);

function fixture(descriptors: readonly RpcRecord[], reports: readonly RpcRecord[]) {
  const frames: Op[] = [];
  const render = renderUsage({ frame: (...ops) => { frames.push(...ops); } });
  const rpc = {
    request: async (_: string, { provider }: RpcRecord) =>
      envelope("get_provider_accounts", provider === gpt.provider ? descriptors : []),
    subscriptionLimits: async () => envelope("get_subscription_limits", reports),
  };
  return { frames, render, rpc, meter: new UsageMeter(rpc, render) };
}

test("mounts a native ring for the most depleted current base window of the active account", async () => {
  const { meter, frames } = fixture([pinned, active], [
    limit(98, { account: pinned.name }),
    account([
      window("codex:secondary", 81.25, "7d"),
      window("codex:primary", 20),
      window("gpt_spark:primary", 99),
    ]),
    limit(100, { provider: claude.provider }),
  ]);
  expect(supportsUsage({ kinds: ["meter", "icon"] })).toBe(true);
  expect(supportsUsage({ kinds: ["meter"] })).toBe(false);
  expect(supportsUsage({ features: ["blobs"], kinds: ["text"] })).toBe(false);
  expect(usageNode()).toMatchObject({ id: "omo-usage", p: { hidden: true }, c: [
    { id: "omo-usage-ring", k: "meter", p: { style: "ring", size: "lg" } },
    { id: "omo-usage-icon", k: "icon" },
  ] });
  await meter.setModel(gpt);
  const label = "ChatGPT 7d: 81.25% used, 18.75% remaining";
  expect(frames).toEqual([
    ["set", "omo-usage-ring", { value: 0.1875, aria: label, title: label }],
    ["set", "omo-usage-icon", { name: "provider-openai" }],
    ["set", "omo-usage", { hidden: false }],
  ]);
  await meter.event({ type: "subscription_limits", provider: gpt.provider, account: active.name });
  expect(frames).toHaveLength(3);
  meter.close();
});

test("switches the native icon and ring reading with the provider", async () => {
  const { frames, render, rpc } = fixture([active], [
    limit(60), account([window("claude:7d", 25, "7d")], { provider: claude.provider }),
  ]);
  const meter = new UsageMeter({ ...rpc, request: async () => envelope("get_provider_accounts", [active]) }, render);
  await meter.setModel(gpt);
  await meter.setModel(claude);
  const label = "Claude 7d: 25% used, 75% remaining";
  expect(frames.slice(3)).toEqual([
    ["set", "omo-usage", { hidden: true }],
    ["set", "omo-usage-ring", { value: 0.75, aria: label, title: label }],
    ["set", "omo-usage-icon", { name: "provider-anthropic" }],
    ["set", "omo-usage", { hidden: false }],
  ]);
  meter.close();
});

test.each([
  ["no active account", [pinned], [limit(77, { account: pinned.name })]],
  ["duplicated active accounts", [active, { ...pinned, active: true }], [limit(77)]],
  ["duplicated account names", [active, { name: active.name }], [limit(77)]],
  ["paused active descriptor", [{ ...active, paused: true }], [limit(77)]],
  ["no provider report", [active], []],
  ["wrong account", [active], [limit(77, { account: "default" })]],
  ["wrong provider", [active], [limit(77, { provider: claude.provider })]],
  ["duplicated account reports", [active], [limit(77), limit(55)]],
  ["error retaining old windows", [active], [limit(77, { error: "unreachable" })]],
  ["expired base window", [active], [account([window("codex:primary", 77, "5h", "2026-01-02T00:00:00Z")])]],
  ["model-scoped window only", [active], [account([window("spark:primary", 77)])]],
  ["duplicate base window ID", [active], [account([window("codex:primary", 77), window("codex:primary", 30)])]],
  ["out of bounds percent", [active], [limit(107)]],
] as const)("does not render quota with %s", async (_, descriptors, reports) => {
  const { meter, frames } = fixture(descriptors, reports);
  await meter.setModel(gpt);
  expect(frames).toEqual([]);
  meter.close();
});

test("reads again at the first turn and keeps reported zero distinct from unknown", async () => {
  const descriptors: RpcRecord[] = [pinned];
  const { meter, frames } = fixture(descriptors, [limit(0)]);
  await meter.setModel(gpt);
  expect(frames).toEqual([]);
  descriptors.push(active);
  await meter.event({ type: "agent_start" });
  expect(frames[0]).toEqual(["set", "omo-usage-ring", expect.objectContaining({
    value: 1, title: "ChatGPT 5h: 0% used, 100% remaining",
  })]);
  meter.close();
});

test("a newer failover read wins even when the earlier read returns last", async () => {
  const { render, frames, rpc } = fixture([active], [limit(33), limit(64, { account: pinned.name })]);
  const old = Promise.withResolvers<RpcRecord>();
  const next = { ...pinned, active: true };
  let listing: Promise<RpcRecord> | RpcRecord = old.promise;
  const meter = new UsageMeter({ ...rpc, request: async () => listing }, render);
  const started = meter.setModel(gpt);
  await Promise.resolve();
  listing = envelope("get_provider_accounts", [next]);
  await meter.event({ type: "account_failover", provider: gpt.provider, to: active.name });
  old.resolve(envelope("get_provider_accounts", [active]));
  await started;
  expect(frames).toHaveLength(3);
  expect(frames[0]).toEqual(["set", "omo-usage-ring", expect.objectContaining({
    value: 0.36, title: "ChatGPT 5h: 64% used, 36% remaining",
  })]);
  meter.close();
});

test("a model change or session reset hides the ring and fences pending replies", async () => {
  const { render, frames, rpc } = fixture([active], [limit(45)]);
  let limits: Promise<RpcRecord> = rpc.subscriptionLimits();
  const meter = new UsageMeter({ ...rpc, subscriptionLimits: () => limits }, render);
  await meter.setModel(gpt);
  const old = Promise.withResolvers<RpcRecord>();
  limits = old.promise;
  const refresh = meter.refresh();
  await Promise.resolve();
  await meter.setModel({ provider: "openai", id: "api-model" });
  const rebound = meter.setModel(gpt);
  await Promise.resolve();
  meter.reset();
  old.resolve(envelope("get_subscription_limits", [limit(81)]));
  await Promise.all([refresh, rebound]);
  expect(frames.slice(3)).toEqual([["set", "omo-usage", { hidden: true }]]);
  meter.close();
});

test("hides measured quota when a refresh fails", async () => {
  const { render, frames, rpc } = fixture([active], [limit(72)]);
  let failed = false;
  const meter = new UsageMeter({
    ...rpc, subscriptionLimits: async () => failed ? Promise.reject(new Error("offline")) : rpc.subscriptionLimits(),
  }, render);
  await meter.setModel(gpt);
  failed = true;
  await meter.event({ type: "agent_end" });
  expect(frames.slice(3)).toEqual([["set", "omo-usage", { hidden: true }]]);
  meter.close();
});
