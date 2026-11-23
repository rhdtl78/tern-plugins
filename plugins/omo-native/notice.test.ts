import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { record, string, surface } from "./surface";

type View = {
  readonly parent: string;
  readonly kind: string;
  readonly props: ReturnType<typeof record>;
};
type Views = ReadonlyMap<string, View>;
const opening = "Opening session…", working = "Working…", stopping = "Stopping…";
const model = "Fixture model";
const warning = "Hot-reloaded: fixture/omo.jsonc";
const refusal = "fixture refused startup";
const exit = "RPC exited (7)";

function apply(views: Map<string, View>, ops: unknown[]) {
  function add(parent: string, value: unknown) {
    const { id, k, p, c } = record(value);
    if (typeof id !== "string") return;
    views.set(id, { parent, kind: string(k), props: record(p) });
    if (Array.isArray(c)) for (const child of c) add(id, child);
  }
  for (const op of ops) {
    if (!Array.isArray(op)) continue;
    const [verb, id, value, , child] = op;
    if (typeof id !== "string") continue;
    if (verb === "add") add(string(value), child);
    if (verb === "del") views.delete(id);
    if (verb === "set") {
      const prior = views.get(id);
      if (prior) views.set(id, { ...prior, props: { ...prior.props, ...record(value) } });
    }
  }
}

const visible = (views: Views) => [...views.values()].filter(view => view.props.hidden !== true);
const withText = (views: Views, text: string) => visible(views).filter(view => view.props.text === text);
const hasDetail = (views: Views, detail: string) =>
  visible(views).some(view => string(view.props.text).includes(detail));

async function exercise(rejectOpen: boolean, observe: (views: Views, event: (value: object) => void) => boolean) {
  const cwd = await mkdtemp(join(tmpdir(), "omo-notice-"));
  try {
    const preload = join(cwd, "tty.ts");
    await writeFile(preload, "process.stdin.isTTY = process.stdout.isTTY = true; process.stdin.setRawMode = () => process.stdin;");
    await writeFile(join(cwd, "omo"), `#!/usr/bin/env bun
import { createInterface } from "node:readline";
const sessionId = "notice-test";
const send = value => console.log(JSON.stringify({ sessionId, ...value }));
let prompts = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, type } = JSON.parse(line);
  if (type === "open_session" && ${rejectOpen}) {
    send({ id, type: "response", command: type, success: false, error: ${JSON.stringify(refusal)} });
    continue;
  }
  const data = type === "open_session" ? { sessionId, state: { model: { name: ${JSON.stringify(model)} } } }
    : type === "get_messages" ? { messages: [] } : {};
  send({ id, type: "response", command: type, success: true, data });
  if (type === "get_messages") send({ type: "extension_ui_request", method: "notify",
    notifyType: "warning", message: ${JSON.stringify(warning)} });
  if (type === "prompt") {
    if (++prompts === 2) process.exit(7);
    send({ type: "agent_start" });
  }
}
`, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "main.ts")], {
      cwd, env: { ...process.env, PATH: `${cwd}:${dirname(process.execPath)}:/usr/bin:/bin` },
      stdin: "pipe", stdout: "pipe", stderr: "inherit", timeout: 3500,
    });
    const views = new Map<string, View>();
    const send = (value: string) => { child.stdin.write(value); child.stdin.flush(); };
    const event = (value: object) => send(`\x1b_tsp;e;${JSON.stringify({ sf: surface, ...value })}\x1b\\`);
    try {
      send('\x1b_tsp;r;{"r":"hello","v":1,"credits":200}\x1b\\');
      let buffer = "";
      for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\x1b\\")) !== -1) {
          const packet = buffer.slice(0, end).split("\x1b_tsp;f;")[1];
          buffer = buffer.slice(end + 2);
          if (!packet) continue;
          const { ops } = record(JSON.parse(packet));
          if (!Array.isArray(ops)) continue;
          apply(views, ops);
          if (observe(views, event)) send("\x04");
        }
      }
      expect(await child.exited).toBe(0);
    } finally { child.kill(); await child.exited; }
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

function expectFailure(views: Views, detail: string) {
  const error = [...views].find(([, view]) =>
    view.parent === "main" && view.kind === "card" && view.props.tone === "error" && view.props.hidden !== true);
  expect(error?.[1].props.head).toBe("OMO unavailable");
  const [message] = visible(views).filter(view => view.parent === error?.[0] && view.kind === "text");
  expect(message?.props.text).toContain(detail);
  expect(message?.props.text).toContain("Ctrl+D");
  expect(views.get("draft")?.props.readonly).toBe(true);
  expect(views.get("stop")?.props.hidden).toBe(true);
  expect(visible(views).some(view => [opening, working, stopping].includes(string(view.props.text)))).toBe(false);
  expect(visible(views).some(view => view.kind === "toast" && string(view.props.text).includes(detail))).toBe(false);
}

test("opens, works, and stops in the composer footer and keeps engine exit in main", async () => {
  const phases = new Map<string, Views>();
  const save = (name: string, views: Views) => phases.set(name, new Map(views));
  const submit = { ev: "send", id: "draft", text: "Run fixture" };
  await exercise(false, (views, event) => {
    if (!phases.has(opening) && withText(views, opening).length) save(opening, views);
    if (!phases.has("ready") && withText(views, warning).length) {
      save("ready", views);
      event(submit);
    } else if (phases.has("ready") && !phases.has(working) && withText(views, working).length) {
      save(working, views);
      event({ ev: "action", id: "stop", act: "stop" });
    } else if (!phases.has(stopping) && withText(views, stopping).length) {
      save(stopping, views);
    } else if (!phases.has("stopped") && withText(views, "Stopped").length) {
      save("stopped", views);
      event(submit);
    } else if (hasDetail(views, exit)) {
      if (phases.has(exit)) { save("after focus", views); return true; }
      save(exit, views);
      event({ ev: "focus", id: "draft" });
    }
    return false;
  });

  for (const phase of [opening, working, stopping]) {
    const views = phases.get(phase) ?? new Map();
    expect(withText(views, phase).map(view => `${view.parent}/${view.kind}`)).toEqual(["footer/badge"]);
    expect(views.get("model")?.props.hidden).not.toBe(true);
    expect(views.get("model")?.props.text).toBe(phase === opening ? "OMO" : model);
    expect(views.get("stop")?.props.hidden).toBe(phase === opening);
  }
  const ready = phases.get("ready") ?? new Map();
  expect(withText(ready, warning).map(view => `${view.parent}/${view.kind}`)).toEqual(["layer/toast"]);
  const stopped = phases.get("stopped") ?? new Map();
  expect(stopped.get("stop")?.props.hidden).toBe(true);
  expect(stopped.get("draft")?.props.sendable).toBe(true);
  expect(visible(stopped).filter(view => view.parent === "footer" && view.kind === "badge")).toEqual([]);
  expectFailure(phases.get("after focus") ?? new Map(), exit);
});

test("keeps a refused RPC startup in a durable error card in main", async () => {
  let failed: Views = new Map();
  await exercise(true, views => {
    if (!hasDetail(views, refusal)) return false;
    failed = new Map(views);
    return true;
  });
  expectFailure(failed, refusal);
});
