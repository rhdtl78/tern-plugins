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
let state = { model: fast, serviceTier: "fast" };
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
    case "get_available_models": reply({ models: [fast, base] }); break;
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
] as const;

for (const { scenario, tier, outcome } of cases) {
  test(`#19 tier picker respects ${scenario} readback and keeps the draft unsent`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omo-settings-"));
    try {
      const preload = join(cwd, "tty.ts");
      await writeFile(preload, "process.stdin.isTTY = process.stdout.isTTY = true; process.stdin.setRawMode = () => process.stdin;");
      await writeFile(join(cwd, "omo"), `#!${process.execPath}\n${fixture}`, { mode: 0o700 });
      const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "main.ts")], {
        cwd, env: { HOME: cwd, PATH: `${cwd}:${dirname(process.execPath)}:/usr/bin:/bin`, SETTINGS_SCENARIO: scenario },
        stdin: "pipe", stdout: "pipe", stderr: "inherit", timeout: 4000,
      });
      const send = (bytes: string) => { child.stdin.write(bytes); child.stdin.flush(); };
      const event = (value: object) => send(`\x1b_tsp;e;${JSON.stringify({ sf: surface, ...value })}\x1b\\`);
      const openTiers = () => event({ ev: "action", id: "tier", act: "tiers" });
      const draft = "unsent fixture draft";
      let phase: "start" | "draft" | "pick" | "confirm" | "reopen" | "cancel" | "done" = "start";
      let draftText: unknown, activeTier: unknown, reopened: unknown, actualOutcome: unknown;
      let buffer = "";
      try {
        send('\x1b_tsp;r;{"r":"hello","v":1,"credits":200}\x1b\\');
        for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
          buffer += chunk;
          let end: number;
          while ((end = buffer.indexOf("\x1b\\")) !== -1) {
            const packet = buffer.slice(0, end).split("\x1b_tsp;f;")[1];
            buffer = buffer.slice(end + 2);
            if (!packet) continue;
            const { ops } = record(JSON.parse(packet));
            if (!Array.isArray(ops)) continue;
            for (const op of ops) {
              if (!Array.isArray(op)) continue;
              const [verb, id, value] = op;
              const props = record(value);
              if (verb === "set" && id === "tier") activeTier = props.text ?? activeTier;
              if (verb === "set" && id === "draft") draftText = props.text ?? draftText;
              if (phase === "start" && verb === "set" && id === "draft" && props.readonly === false) {
                phase = "draft";
                send(`\x1b[200~${draft}\x1b[201~`);
              } else if (phase === "draft" && draftText === draft) {
                phase = "pick";
                openTiers();
              }
              if (typeof id !== "string" || !id.startsWith("pick")) continue;
              const items = Array.isArray(props.items) ? props.items.map(record) : [];
              const base = items.find(item => item.label === "Base model");
              if (phase === "pick" && base && typeof base.id === "string") {
                phase = "confirm";
                event({ ev: "activate", id, item: base.id });
              } else if (phase === "confirm" && verb === "del") {
                phase = "reopen";
                actualOutcome = "selected";
                openTiers();
              } else if (phase === "confirm" && props.state === "error") {
                actualOutcome = String(props.message).includes("fixture refused model") ? "refused"
                  : String(props.message).includes("confirm") ? "unconfirmed" : props.message;
                if (scenario === "reload") {
                  expect(activeTier).toBe("fast");
                  phase = "reopen";
                  event({ ev: "action", id, act: "retry" });
                } else {
                  phase = "done";
                  send("\x04");
                }
              } else if (phase === "reopen" && props.state === "ready" && base) {
                reopened = { current: props.current, selected: props.selected, base: base.id };
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
        if (outcome === "selected" || scenario === "reload") {
          const { current, selected, base } = record(reopened);
          expect(current).toEqual([base]);
          expect(selected).toBe(base);
        }
        expect(activeTier).toBe(tier);
      } finally {
        child.kill();
        await child.exited;
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
