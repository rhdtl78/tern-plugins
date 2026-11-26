import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { record, surface } from "./surface";

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
      const open = () => event({ ev: "toggle", id: "model", open: true });
      const pickMenu = (act: string) => {
        event({ ev: "action", id: "model", act, checked: true });
        event({ ev: "toggle", id: "model", open: false });
      };
      const draft = "unsent fixture draft";
      let phase: "start" | "draft" | "attach" | "pick" | "confirm" | "reopen" | "back" | "cancel" | "done" = "start";
      let draftText: unknown, modelTitle = "", reopened: unknown, actualOutcome: unknown;
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
              const items = Array.isArray(props.items) ? props.items.map(record) : [];
              if (id === "model" && props.open === true) {
                const tiers = record(items.find(item => item.id === "speed")).items;
                if (phase === "back") {
                  const thinking = items.filter(item => String(item.id).startsWith("l"));
                  backMenus.push({
                    heading: items[0]?.header,
                    checked: [...items, ...(Array.isArray(tiers) ? tiers.map(record) : [])]
                      .filter(item => item.checked).map(item => item.label),
                    speed: items.find(item => item.id === "speed")?.label,
                    thinking: thinking.map(item => item.label),
                  });
                  if (tiers || thinking.length) {
                    phase = "done";
                    send("\x04");
                  }
                }
                const menuOption = (thinking ? items : Array.isArray(tiers) ? tiers.map(record) : [])
                  .find(item => item.label === (thinking ? "high" : "Standard"));
                if (phase === "pick" && typeof menuOption?.id === "string") {
                  phase = "confirm";
                  pickMenu(menuOption.id);
                  pickMenu(menuOption.id);
                } else if (phase === "reopen" && menuOption) {
                  reopened = { current: menuOption.checked ? [menuOption.id] : [], selected: menuOption.id, base: menuOption.id };
                  phase = "done";
                  send("\x04");
                }
              }
              if (typeof id !== "string" || !id.startsWith("pick")) continue;
              const option = items.find(item => item.label === (thinking ? "high" : "Standard"));
              if (phase === "confirm" && verb === "del") {
                actualOutcome = "selected";
                if (thinking) { phase = "done"; send("\x04"); }
                else { phase = "reopen"; open(); }
              } else if (phase === "confirm" && props.state === "error") {
                actualOutcome = String(props.message).includes("fixture refused model") ? "refused"
                  : String(props.message).includes("confirm") ? "unconfirmed" : props.message;
                if (scenario === "reload") {
                  expect(modelTitle).toEndWith("Service tier: fast");
                  phase = "reopen";
                  event({ ev: "action", id, act: "retry" });
                } else if (scenario === "wrong model") {
                  phase = "back";
                  event({ ev: "action", id, act: "back" });
                } else {
                  phase = "done";
                  send("\x04");
                }
              } else if (phase === "reopen" && props.state === "ready" && option) {
                reopened = { current: props.current, selected: props.selected, base: option.id };
                if (scenario === "reload") {
                  phase = "cancel";
                  event({ ev: "action", id, act: "close" });
                } else {
                  phase = "done";
                  send("\x04");
                }
              } else if (phase === "cancel" && verb === "del") {
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
        if (!thinking && (outcome === "selected" || scenario === "reload")) {
          const { current, selected, base } = record(reopened);
          expect(current).toEqual([base]);
          expect(selected).toBe(base);
        }
        expect(modelTitle).toEndWith(`Service tier: ${tier}`);
        if (scenario === "wrong model") {
          expect(modelTitle).toContain("Model settings: other; Thinking: not reported;");
          for (const menu of backMenus) {
            expect(menu.checked).toEqual([]);
            expect(menu.speed).toBeUndefined();
          }
          expect(backMenus.at(-1)).toMatchObject({ heading: "Thinking: Not reported", thinking: ["off"] });
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
