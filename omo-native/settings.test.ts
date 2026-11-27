import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { SessionSettings } from "./model-settings";
import type { RpcRecord } from "./rpc";
import { SettingsPicker } from "./settings-picker";
import { record, surface } from "./surface";

test.each(["event first", "picker first", "picker rejected", "session closed"] as const)(
  "dismissed model picker keeps session readback fenced: %s", async order => {
    const old = { model: { id: "old", input: ["text", "image"] } };
    const eventState = { model: { id: "event-model", input: ["text"] } };
    const pickerState = { model: { id: "picker-model", input: ["text"] } };
    const a = Promise.withResolvers<RpcRecord>(), b = Promise.withResolvers<RpcRecord>();
    const reads = [a.promise, b.promise].values();
    const published: unknown[] = [];
    const settings = new SessionSettings(model => published.push(record(model).id));
    settings.show(old);
    const picker = new SettingsPicker("test");
    const client = {
      getState: () => reads.next().value ?? Promise.reject(new Error("Unexpected state read")),
      getProtocolInfo: () => Promise.reject(new Error("Dismissed picker must not load options")),
      request: () => Promise.reject(new Error("Dismissed picker must not load options")),
    };
    let live = true, draws = 0;
    const event = settings.observed(client, {});
    const reload = picker.reload({ settings, client, live: () => live, draw: () => { draws++; } });
    expect(picker.input({ kind: "key", value: "\x1b" })).toBe("close");
    live = false;
    if (order === "session closed") settings.invalidate();
    if (order === "event first") {
      a.resolve(eventState); await event;
      b.resolve(pickerState); await reload;
      expect(published).toEqual(["old", "event-model", "picker-model"]);
    } else {
      if (order === "picker rejected") b.reject(new Error("Picker read failed"));
      else b.resolve(pickerState);
      await reload;
      a.resolve(eventState); await event;
      expect(published).toEqual(order === "session closed" ? ["old"] :
        ["old", order === "picker rejected" ? "event-model" : "picker-model"]);
    }
    expect(settings.input).toEqual(order === "session closed" ? ["text", "image"] : ["text"]);
    expect(draws).toBe(1);
  },
);

test("Model and Back preserve a failed state read until settings are reloaded", async () => {
  const model = { id: "fixture", provider: "test", name: "Confirmed fixture model" };
  let fail = true;
  const picker = new SettingsPicker("test");
  const load = {
    settings: new SessionSettings(() => {}),
    client: {
      getState: async () => {
        if (fail) throw new Error("Fixture state read failed");
        return { model };
      },
      getProtocolInfo: async () => ({ data: { capabilities: ["session_model_scope"] } }),
      request: async (type: string) => ({ data: type === "get_available_models" ? { models: [model] } : { levels: [] } }),
    },
    live: () => true, draw: () => {},
  };
  const action = (act: string) => picker.input({ kind: "event", value: { id: `sp-${act}`, ev: "action", act } });
  await picker.reload(load);
  expect(action("models")).toBe("draw");
  expect(picker.props()).toMatchObject({ state: "error", message: "Fixture state read failed" });
  picker.page("settings"); // Back callback; main.ts retries automatically on errors.
  expect(action("retry")).toBe("retry");
  fail = false;
  await picker.reload(load);
  expect(panelProp(picker, "sp-models").text).toBe(model.name);
  expect(action("models")).toBe("draw");
  expect(panelProp(picker, "sp-m0").value).toBe("✓");
});

test("a pending catalog cannot clear an effort write error or make stale Models actionable", async () => {
  const old = { id: "old", provider: "fixture", name: "Old model" };
  const next = { id: "next", provider: "fixture", name: "New model" };
  const pending = Promise.withResolvers<{ data: RpcRecord }>();
  const refreshed = Promise.withResolvers<RpcRecord>();
  let reading = false, draws = 0;
  const p = new SettingsPicker("test");
  const load = {
    settings: new SessionSettings(() => {}),
    client: {
      getState: async () => reading ? refreshed.promise : { model: old, thinkingLevel: "low" },
      getProtocolInfo: async () => ({ data: { capabilities: ["session_model_scope"] } }),
      request: async (type: string) => type === "get_available_models"
        ? reading ? { data: { models: [old, next] } } : pending.promise
        : { data: { levels: reading ? ["off"] : ["low", "medium"] } },
    },
    live: () => true, draw: () => { draws++; },
  };
  const first = p.reload(load);
  await Bun.sleep(0);
  expect(p.input({ kind: "event", value: { id: "sp-effort", ev: "change", value: 1 } })).toBe("use");
  p.writeFailed("Unconfirmed effort");
  const errorDraws = draws;
  pending.resolve({ data: { models: [old, next] } }); await first;
  expect(draws).toBe(errorDraws);
  expect(panelProp(p, "sp-message").text).toBe("Unconfirmed effort");
  expect(p.input({ kind: "event", value: { id: "sp-models", ev: "action", act: "models" } })).toBe("retry");
  reading = true;
  const retry = p.reload(load);
  expect(panelProp(p, "sp-list")).toEqual({});
  refreshed.resolve({ model: next, thinkingLevel: "off" }); await retry;
  expect(panelProp(p, "sp-m0").value).toBe("");
  expect(panelProp(p, "sp-m1").value).toBe("✓");
  p.page("settings");
  expect(panelProp(p, "sp-title").text).toBe("Off");
  expect(panelProp(p, "sp-speed-trigger")).toEqual({});
});

test("the rendered model identity survives a filter that hides the colliding row", async () => {
  const one = { id: "id-1", provider: "one", name: "Local" };
  const two = { id: "id-2", provider: "two", name: "Local" };
  const p = new SettingsPicker("test");
  await p.reload({
    settings: new SessionSettings(() => {}),
    client: {
      getState: async () => ({ model: one }),
      getProtocolInfo: async () => ({ data: { capabilities: ["session_model_scope"] } }),
      request: async (type: string) => ({ data: type === "get_available_models" ? { models: [one, two] } : { levels: [] } }),
    },
    live: () => true, draw: () => {},
  });
  p.page("models");
  expect(panelProp(p, "sp-m0").detail).toBe("one/id-1");
  p.input({ kind: "paste", value: "two/id-2" });
  expect(panelProp(p, "sp-m0")).toEqual({});
  expect(panelProp(p, "sp-m1")).toMatchObject({ detail: "two/id-2", aria: "Local · two/id-2" });
});

const fixture = String.raw`
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const sessionId = "settings-test";
const base = { provider: "fixture", id: "base" };
const fast = { ...base, id: "base-fast", serviceTier: "fast" };
const scenario = process.env.SETTINGS_SCENARIO;
let state = { model: fast, serviceTier: "fast", thinkingLevel: "low" };
let attempted = false;
for await (const line of createInterface({ input: process.stdin })) {
  const q = JSON.parse(line);
  const reply = (data, extra = {}) => console.log(JSON.stringify({
    id: q.id, type: "response", command: q.type, sessionId: q.sessionId, success: true, data, ...extra,
  }));
  switch (q.type) {
    case "open_session": reply({ sessionId, state }, { sessionId }); break;
    case "get_messages": reply({ messages: [] }); break;
    case "get_protocol_info": reply({ capabilities: ["session_model_scope"] }); break;
    case "get_available_models":
      if (scenario === "catalog failed") reply(undefined, { success: false, error: "Fixture catalog unavailable" });
      else reply({ models: [fast, base] });
      break;
    case "get_available_thinking_levels":
      reply({ levels: state.model.id === "other" ? ["off"] : ["low", "high"] });
      break;
    case "set_thinking_level":
      attempted = true;
      appendFileSync("calls", "write\n");
      if (q.sessionId !== sessionId || q.scope !== "turn" || q.level !== "high")
        reply(undefined, { success: false, error: "unexpected Thinking request" });
      else {
        state = { ...state, thinkingLevel: "high" };
        reply({});
      }
      break;
    case "get_state":
      if (attempted) appendFileSync("calls", "read\n");
      reply(state);
      if (attempted && scenario === "reload") state = { model: base, serviceTier: "auto" };
      break;
    case "set_model":
      attempted = true;
      appendFileSync("calls", "write\n");
      if (q.sessionId !== sessionId || q.provider !== base.provider || q.modelId !== base.id || q.scope !== "session") {
        reply(undefined, { success: false, error: "unexpected model request" });
        break;
      }
      if (scenario === "default") state = { model: base, serviceTier: "default" };
      if (scenario === "auto") state = { model: base, serviceTier: "auto" };
      if (scenario === "named") state = { model: base, serviceTier: "flex" };
      if (scenario === "wrong provider") state = { model: { ...base, provider: "other" }, serviceTier: "auto" };
      if (scenario === "wrong model") state = { model: { ...base, id: "other" }, serviceTier: "auto" };
      if (scenario === "refused") reply(undefined, { success: false, error: "fixture refused model" });
      else reply({ model: base, serviceTier: "default" });
      break;
    case "prompt": case "steer": case "follow_up":
      appendFileSync("calls", q.type + "\n");
      reply({});
      break;
    default: reply({});
  }
}
`;

const cases = [
  { scenario: "default", tier: "default", outcome: "selected" },
  { scenario: "auto", tier: "auto", outcome: "selected" },
  { scenario: "reload", tier: "auto", outcome: "unconfirmed" },
  { scenario: "stale", tier: "fast", outcome: "unconfirmed" },
  { scenario: "named", tier: "flex", outcome: "unconfirmed" },
  { scenario: "wrong provider", tier: "auto", outcome: "unconfirmed" },
  { scenario: "wrong model", tier: "auto", outcome: "unconfirmed" },
  { scenario: "refused", tier: "fast", outcome: "refused" },
  { scenario: "catalog failed", tier: "fast", outcome: "selected" },
] as const;

const b64 = (value: string) => Buffer.from(value).toString("base64");
const osc = (value: string) => `\x1b]5522;type=read:${value}\x1b\\`;
function panelNodes(nodes: unknown): RpcRecord[] {
  return (Array.isArray(nodes) ? nodes : []).map(record).flatMap(n => [n, ...panelNodes(n.c)]);
}
function panelProp(picker: SettingsPicker, id: string) {
  return record(panelNodes(picker.draw().map(op => op[4])).find(n => n.id === id)?.p);
}

for (const { scenario, tier, outcome } of cases) {
  const thinking = scenario === "catalog failed";
  test(thinking ? "#34 a failed model catalog leaves Thinking writable with readback and no prompt"
    : `#19 tier picker respects ${scenario} readback and keeps the draft unsent`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omo-settings-"));
    try {
      const preload = join(cwd, "tty.ts");
      const attachment = join(cwd, "keep.zip");
      await writeFile(preload, "process.stdin.isTTY = process.stdout.isTTY = true; process.stdin.setRawMode = () => process.stdin;");
      await writeFile(join(cwd, "omo"), `#!${process.execPath}\n${fixture}`, { mode: 0o700 });
      if (thinking) await writeFile(attachment, "fixture");
      const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "main.ts")], {
        cwd, env: { HOME: cwd, PATH: `${cwd}:${dirname(process.execPath)}:/usr/bin:/bin`, SETTINGS_SCENARIO: scenario,
          TMPDIR: process.env.TMPDIR, NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE,
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH, GIT_MASTER: process.env.GIT_MASTER },
        stdin: "pipe", stdout: "pipe", stderr: "inherit", timeout: 4000,
      });
      const send = (bytes: string) => { child.stdin.write(bytes); child.stdin.flush(); };
      const event = (value: object) => send(`\x1b_tsp;e;${JSON.stringify({ sf: surface, ...value })}\x1b\\`);
      const action = (id: unknown, act: string) => event({ ev: "action", id, act });
      const open = () => action("model", "settings");
      const draft = "unsent fixture draft";
      let phase: "start" | "draft" | "attach" | "pick" | "confirm" | "reopen" | "back" | "cancel" | "done" = "start";
      let draftText: unknown, modelTitle = "", confirmedTier = false, actualOutcome: unknown;
      let modelLabel: unknown, effortLabel: unknown, speedHidden: unknown, extraBoltHidden: unknown;
      const backMenus: { heading: unknown; checked: unknown[]; speed: unknown; thinking: unknown[] }[] = [];
      let attachmentId = "", attachmentHidden: unknown;
      let buffer = "";
      try {
        send('\x1b_tsp;r;{"r":"hello","v":1,"credits":200}\x1b\\');
        for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
          buffer += chunk;
          let end: number;
          while ((end = buffer.indexOf("\x1b\\")) !== -1) {
            const response = buffer.slice(0, end);
            const packet = response.split("\x1b_tsp;f;")[1];
            buffer = buffer.slice(end + 2);
            const readId = /\x1b\]5522;type=read:id=([^:]+):/.exec(response)?.[1];
            if (phase === "attach" && readId) {
              send(osc(`status=DATA:id=${readId}:mime=${b64("text/uri-list")};${b64(Bun.pathToFileURL(attachment).href)}`)
                + osc(`status=DONE:id=${readId}`));
            }
            if (!packet) continue;
            const { ops } = record(JSON.parse(packet));
            if (!Array.isArray(ops)) continue;
            for (const op of ops) {
              if (!Array.isArray(op)) continue;
              const [verb, id, value] = op;
              const props = record(value);
              if (verb === "set" && id === "model" && typeof props.title === "string") modelTitle = props.title;
              if (verb === "set" && id === "model-name") modelLabel = props.text ?? modelLabel;
              if (verb === "set" && id === "model-effort") effortLabel = props.hidden ? "" : props.text;
              if (verb === "set" && id === "model-speed") speedHidden = props.hidden;
              if (verb === "set" && id === "model-speed-extra") extraBoltHidden = props.hidden;
              if (verb === "set" && id === "draft") draftText = props.text ?? draftText;
              if (verb === "set" && id === "attachments") attachmentHidden = props.hidden ?? attachmentHidden;
              if (verb === "del" && id === attachmentId) attachmentId = "";
              if (phase === "start" && verb === "set" && id === "draft" && props.readonly === false) {
                phase = "draft";
                send(`\x1b[200~${draft}\x1b[201~`);
              } else if (phase === "draft" && draftText === draft) {
                phase = thinking ? "attach" : "pick";
                if (thinking) send(osc("status=OK:pw=fixture")
                  + osc(`status=DATA:pw=fixture:mime=${b64(".")};${b64("text/uri-list")}`)
                  + osc("status=DONE:pw=fixture"));
                else open();
              } else if (phase === "attach" && verb === "add" && value === "attachments" && typeof id === "string") {
                attachmentId = id;
                phase = "pick";
                open();
              }
              if (typeof id !== "string" || !id.startsWith("pick") || id.endsWith(".dismiss")) continue;
              const body = verb === "add" && id.endsWith(".body");
              const nodes = body ? panelNodes([op[4]]) : [];
              if (body) {
                const propsOf = (key: string) => record(nodes.find(n => n.id === key)?.p);
                const standard = nodes.find(n => String(n.id).startsWith("sp-t") && record(n.p).text === "Standard");
                const option = record(standard?.p);
                const act = record(option.actions).click;
                const effort = propsOf("sp-effort");
                const single = propsOf("sp-unset-effort");
                const notice = propsOf("sp-message").text;
                if (phase === "back") {
                  backMenus.push({
                    heading: propsOf("sp-title").text,
                    checked: nodes.filter(item => record(item.p).icon === "check"),
                    speed: nodes.find(item => item.id === "sp-speed-trigger"),
                    thinking: single.text ? [single.text] : [],
                  });
                  if (single.text) {
                    phase = "done";
                    send("\x04");
                  }
                }
                if (phase === "pick" && (thinking ? effort.max === 1 : typeof act === "string")) {
                  phase = "confirm";
                  const pick = () => {
                    if (thinking) event({ ev: "change", id: "sp-effort", value: 1 });
                    else if (typeof act === "string") action(standard?.id, act);
                  };
                  pick(); pick();
                } else if (phase === "reopen" && option.icon === "check") {
                  confirmedTier = true;
                  phase = "done";
                  if (scenario === "reload") {
                    phase = "cancel";
                    action("sp-close", "close");
                  } else send("\x04");
                } else if (phase === "confirm" && typeof notice === "string" && propsOf("sp-retry").text) {
                  actualOutcome = notice.includes("fixture refused model") ? "refused"
                    : notice.includes("confirm") ? "unconfirmed" : notice;
                  if (scenario === "reload") {
                    expect(modelTitle).toEndWith("Service tier: fast");
                    phase = "reopen";
                    action("sp-retry", "retry");
                  } else if (scenario === "wrong model") {
                    phase = "back";
                    action("sp-back", "back");
                  } else {
                    phase = "done";
                    send("\x04");
                  }
                }
              }
              if (phase === "confirm" && verb === "del" && !id.endsWith(".body")) {
                actualOutcome = "selected";
                if (thinking) { phase = "done"; send("\x04"); }
                else { phase = "reopen"; open(); }
              } else if (phase === "cancel" && verb === "del" && !id.endsWith(".body")) {
                phase = "done";
                send("\x04");
              }
            }
          }
        }
        expect(await child.exited).toBe(0);
        expect(phase).toBe("done");
        const calls = (await Bun.file(join(cwd, "calls")).text()).trim().split("\n");
        expect(calls.slice(0, 2)).toEqual(["write", "read"]);
        expect(calls.filter(call => call !== "read")).toEqual(["write"]);
        expect(draftText).toBe(draft);
        expect(actualOutcome).toBe(outcome);
        if (!thinking && (outcome === "selected" || scenario === "reload")) expect(confirmedTier).toBe(true);
        expect(modelTitle).toEndWith(`Service tier: ${tier}`);
        expect(modelLabel).toBe(scenario === "wrong model" ? "OTHER" : "BASE");
        expect(effortLabel).toBe(thinking ? "· high" : tier === "fast" ? "· low" : "");
        expect(speedHidden).toBe(tier !== "fast");
        expect(extraBoltHidden).toBe(true);
        if (scenario === "wrong model") {
          expect(modelTitle).toContain("Model settings: other; Thinking: not reported;");
          for (const menu of backMenus) {
            expect(menu.checked).toEqual([]);
            expect(menu.speed).toBeUndefined();
          }
          expect(backMenus.at(-1)).toMatchObject({ heading: "Effort not reported", thinking: ["Off"] });
          expect(calls).toEqual(["write", "read", "read"]);
        }
        if (thinking) {
          expect(modelTitle).toContain("Thinking: high;");
          expect(attachmentId).not.toBe("");
          expect(attachmentHidden).toBe(false);
        }
      } finally {
        child.kill();
        await child.exited;
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
