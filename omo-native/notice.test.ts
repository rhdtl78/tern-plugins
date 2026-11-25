import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkpoint, model, noticeEngine, refusal, warning, type Checkpoint, type Scenario } from "./notice-fixture";
import { record, string, surface } from "./surface";

type View = {
  readonly parent: string;
  readonly kind: string;
  readonly props: ReturnType<typeof record>;
};
type Views = ReadonlyMap<string, View>;
const opening = "Opening session…", working = "Working…", stopping = "Stopping…";
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

type FixtureControls = {
  readonly event: (value: object) => void;
  readonly key: (bytes: string) => void;
  readonly release: (marker: Checkpoint) => void;
};

async function exercise(rejectOpen: boolean, observe: (views: Views, controls: FixtureControls) => boolean,
  scenario: Scenario = "notice") {
  const cwd = await mkdtemp(join(tmpdir(), "omo-notice-"));
  try {
    const preload = join(cwd, "tty.ts");
    await writeFile(preload, "process.stdin.isTTY = process.stdout.isTTY = true; process.stdin.setRawMode = () => process.stdin;");
    await writeFile(join(cwd, "omo"), noticeEngine(rejectOpen, scenario), { mode: 0o700 });
    const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "main.ts")], {
      cwd, env: { ...process.env, PATH: `${cwd}:${dirname(process.execPath)}:/usr/bin:/bin` },
      stdin: "pipe", stdout: "pipe", stderr: "inherit", timeout: 3500,
    });
    const views = new Map<string, View>();
    const send = (value: string) => { child.stdin.write(value); child.stdin.flush(); };
    const event = (value: object) => send(`\x1b_tsp;e;${JSON.stringify({ sf: surface, ...value })}\x1b\\`);
    const release = (marker: Checkpoint) => writeFileSync(join(cwd, marker), "", { flag: "wx" });
    const controls = { event, key: send, release };
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
          if (observe(views, controls)) send("\x04");
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

test("shows progress outside the composer and keeps engine exit in main", async () => {
  const phases = new Map<string, Views>();
  const save = (name: string, views: Views) => phases.set(name, new Map(views));
  const submit = { ev: "send", id: "draft", text: "Run fixture" };
  await exercise(false, (views, { event }) => {
    if (!phases.has(opening) && withText(views, opening).length) save(opening, views);
    if (!phases.has("ready") && withText(views, warning).length) {
      save("ready", views);
      event(submit);
    } else if (phases.has("ready") && !phases.has(working) && withText(views, "Fixture turn started").length) {
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
    expect(withText(views, phase).map(view => `${view.parent}/${view.kind}`))
      .toEqual(phase === working ? [] : ["session-feedback/badge"]);
    expect(views.get("session-activity")).toMatchObject({
      parent: "session-feedback", kind: "spinner", props: { hidden: phase === opening },
    });
    expect(views.get("model")?.props.hidden).not.toBe(true);
    expect(views.get("model")?.props.text).toBe(phase === opening ? "OMO" : model);
    expect(views.get("stop")?.props.hidden).toBe(phase === opening);
  }
  const ready = phases.get("ready") ?? new Map();
  expect(withText(ready, warning).map(view => `${view.parent}/${view.kind}`)).toEqual(["layer/toast"]);
  const stopped = phases.get("stopped") ?? new Map();
  expect(stopped.get("stop")?.props.hidden).toBe(true);
  expect(stopped.get("session-activity")?.props.hidden).toBe(true);
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

test("rejected steer restores both drafts and repeated Escape cannot stop twice before settlement", async () => {
  let step = 0;
  await exercise(false, (views, { event, key }) => {
    const draft = views.get("draft")?.props;
    if (step === 0 && withText(views, warning).length) {
      step++;
      key("\x1b[27u"); // Idle Escape has no effect.
      event({ ev: "send", id: "draft", text: "Run fixture", streamingBehavior: "followUp", expectedTurnId: "foreign" });
    } else if (step === 1 && withText(views, "Fixture turn started").length) {
      step++;
      key("previous\r\x1b[13;9u" + "new");
    } else if (step === 2 && hasDetail(views, "fixture turn changed")) {
      expect(draft?.text).toBe("previous\nnew");
      expect(draft?.sendable).toBe(false);
      expect(views.get("stop")?.props).toMatchObject({ hidden: false, aria: "Stop turn" });
      step++;
      key("\x1b[27u\x1b[27u");
    } else if (step === 3 && hasDetail(views, "The turn is still running")) {
      if (views.get("stop")?.props.disabled !== false) return false;
      expect(draft?.text).toBe("previous\nnew");
      expect(draft?.sendable).toBe(false);
      step++;
      return true;
    }
    return false;
  }, "composer");
  expect(step).toBe(4);
});

test("projects the engine's steering and follow-up queue above the composer", async () => {
  let step = 0, sawAckWithoutRows = false;
  await exercise(false, (views, { event, key, release }) => {
    const pending = views.get("pending-messages");
    const rows = [...views].filter(([, view]) => view.parent === "pending-messages")
      .map(([id, view]) => [id, view.props.text]);
    const messages = withText(views, "same").filter(view => view.parent !== "pending-messages");
    const draft = views.get("draft")?.props;
    const ids = rows.map(([id]) => id);
    if (step === 0 && withText(views, warning).length) {
      expect(pending?.props.hidden).toBe(true);
      expect([...views.keys()].indexOf("pending-messages")).toBeLessThan([...views.keys()].indexOf("composer"));
      expect(pending?.parent).toBe("dock");
      step++;
      event({ ev: "send", id: "draft", text: "Run fixture" });
    } else if (step === 1 && withText(views, "Fixture turn started").length) {
      step++;
      key("first\x1b[13;5u");
    } else if (step === 2 && !sawAckWithoutRows && withText(views, "Fixture acknowledged").length) {
      expect(rows).toEqual([]);
      expect(pending?.props.hidden).toBe(true);
      expect(draft?.text).toBe("");
      sawAckWithoutRows = true;
      release(checkpoint.acknowledged);
    } else if (step === 2 && ids.length === 1) {
      expect(rows).toEqual([["pending.q_1", "Queue: first"]]);
      expect(pending?.props.hidden).toBe(false);
      step++;
      key("same\x1b[13;9u");
    } else if (step === 3 && ids.length === 2) {
      expect(rows).toEqual([["pending.q_1", "Queue: first"], ["pending.q_2", "Steering: same"]]);
      step++;
      key("same\x1b[13;5u");
    } else if (step === 4 && ids.length === 3) {
      expect(rows[2]).toEqual(["pending.q_3", "Queue: same"]);
      expect(messages).toHaveLength(0);
      step++;
      key("refused\x1b[13;9u" + "new draft");
    } else if (step === 5 && hasDetail(views, "fixture queue refused")) {
      expect(draft?.text).toBe("refused\nnew draft");
      expect(ids).toEqual(["pending.q_1", "pending.q_2", "pending.q_3"]);
      step++;
      event({ ev: "action", id: "stop", act: "stop" });
    } else if (step === 6 && draft?.sendable) {
      expect(ids).toEqual(["pending.q_1", "pending.q_2", "pending.q_3"]);
      expect(draft.text).toBe("refused\nnew draft");
      step++;
      release(checkpoint.stopped);
    } else if (step === 7 && draft?.sendable === false && views.get("stop")?.props.hidden === false) {
      expect(ids).toEqual(["pending.q_1", "pending.q_2", "pending.q_3"]);
      expect(messages).toHaveLength(0);
      step++;
      release(checkpoint.restarted);
    } else if (step === 8 && messages.length) {
      expect(ids).toEqual(["pending.q_1", "pending.q_3"]);
      expect(messages).toHaveLength(1);
      expect(draft?.text).toBe("refused\nnew draft");
      step++;
      event({ ev: "action", id: "stop", act: "stop" });
    } else if (step === 9 && ids.length === 1) {
      expect(ids).toEqual(["pending.q_3"]);
      step++;
      release(checkpoint.retained);
    } else if (step === 10 && pending?.props.hidden) {
      expect(rows).toEqual([]);
      expect(messages).toHaveLength(1);
      expect(draft?.text).toBe("refused\nnew draft");
      step++;
      return true;
    }
    return false;
  }, "queue");
  expect(sawAckWithoutRows).toBe(true);
  expect(step).toBe(11);
});
