import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkpoint, model, noticeEngine, promptsFile, refusal, warning, type Checkpoint, type Scenario } from "./notice-fixture";
import { record, string, surface } from "./surface";

type View = {
  readonly parent: string;
  readonly kind: string;
  readonly props: ReturnType<typeof record>;
};
type Views = ReadonlyMap<string, View>;
const opening = "Opening session…", working = "Working…", stopping = "Stopping…";
const exit = "RPC exited (7)";
const clipboardDraft = "Synthetic draft to keep";
const clipboardSuffix = " plus new text";

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

async function exercise(rejectOpen: boolean, observe: (views: Views, controls: FixtureControls, ops: unknown[]) => boolean,
  scenario: Scenario = "notice") {
  const cwd = await mkdtemp(join(tmpdir(), "omo-notice-"));
  try {
    const promptsPath = join(cwd, promptsFile);
    if (scenario === "clipboard") await writeFile(promptsPath, "");
    await writeFile(join(cwd, "omo"), noticeEngine(rejectOpen, scenario), { mode: 0o700 });
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const output = writable.getWriter();
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts")], {
      cwd, env: { ...process.env, PATH: `${cwd}:${dirname(process.execPath)}:/usr/bin:/bin` },
      terminal: { data: (_terminal, bytes) => { void output.write(bytes.slice()); } },
      onExit: () => { void output.close(); },
      timeout: scenario === "clipboard" ? 6000 : 3500,
    });
    const views = new Map<string, View>();
    const send = (value: string) => { child.terminal?.write(value); };
    const event = (value: object) => send(`\x1b_tsp;e;${JSON.stringify({ sf: surface, ...value })}\x1b\\`);
    const release = (marker: Checkpoint) => writeFileSync(join(cwd, marker), "", { flag: "wx" });
    const controls = { event, key: send, release };
    try {
      let buffer = "";
      for await (const chunk of readable.pipeThrough(new TextDecoderStream())) {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\x1b\\")) !== -1) {
          const message = buffer.slice(0, end);
          const packet = message.split("\x1b_tsp;f;")[1];
          if (message.includes("\x1b_tsp;q;")) send('\x1b_tsp;r;{"r":"hello","v":1,"credits":200}\x1b\\');
          buffer = buffer.slice(end + 2);
          if (!packet) continue;
          const { ops } = record(JSON.parse(packet));
          if (!Array.isArray(ops)) continue;
          apply(views, ops);
          if (observe(views, controls, ops)) send("\x04");
        }
      }
      const code = await child.exited;
      if (scenario === "clipboard") {
        expect(await readFile(promptsPath, "utf8")).toBe(JSON.stringify(clipboardDraft + clipboardSuffix) + "\n");
      }
      expect(code).toBe(0);
    } finally { child.kill(); await child.exited; child.terminal?.close(); }
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
    expect(withText(views, "ULW 실행 중")).toEqual([]);
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

test("shows the localized ULW badge only after runtime confirmation and until Stop settles", async () => {
  let step = 0;
  await exercise(false, (views, { event, key }) => {
    const badges = withText(views, "ULW 실행 중");
    if (step === 0 && withText(views, warning).length) {
      step++;
      key("ULW fixture");
    } else if (step === 1 && views.get("composer-mode")?.props.role === "ulw-preview") {
      expect(badges).toEqual([]);
      step++;
      key("\r");
    } else if (step === 2 && withText(views, "Fixture turn started").length) {
      expect(badges.map(view => [view.parent, view.kind])).toEqual([["session-feedback", "badge"]]);
      step++;
      event({ ev: "action", id: "stop", act: "stop" });
    } else if (step === 3 && withText(views, "Stopped").length) {
      expect(badges).toEqual([]);
      step++;
      return true;
    }
    return false;
  }, "ulw");
  expect(step).toBe(4);
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

test.each([
  ["opening OK", ""],
  ["established DATA", "\x1b]5522;type=read:status=DATA:pw=interrupted:mime=Lg==;dGV4dA=="],
  ["established prefix before semicolon", "\x1b]5522"],
] as const)(
  "the first Send includes new typing after interrupted clipboard %s expires", async (interrupted, partial) => {
  let phase: "ready" | "pasted" | "offer" | "interrupted" | "sent" | "done" = "ready";
  let firstSend: ReturnType<typeof setTimeout> | undefined;
  let notices = 0;
  const submit = { ev: "action", id: "send", act: "submit" };
  try {
    await exercise(false, (views, { event, key }, ops) => {
      const draft = views.get("draft")?.props;
      const interrupt = (bytes: string) => {
        phase = "interrupted";
        key(bytes);
        // Allow both deadlines to elapse, even if there is no notice on the broken build.
        firstSend = setTimeout(() => {
          phase = "sent";
          key(clipboardSuffix);
          event(submit);
        }, 3600);
      };
      if (phase === "ready" && draft?.sendable) {
        phase = "pasted";
        key(`\x1b[200~${clipboardDraft}\x1b[201~`);
      } else if (phase === "pasted" && draft?.text === clipboardDraft) {
        const offer = "\x1b]5522;type=read:status=OK:pw=interrupted";
        if (interrupted === "opening OK") interrupt(offer);
        else {
          phase = "offer";
          key(offer + "\x1b\\");
          event(submit);
        }
      } else if (phase === "offer" && hasDetail(views, "Wait for the paste to finish")) {
        interrupt(partial);
      } else if (phase === "interrupted") {
        // Count reports while idle; the suffix's per-key redraws re-emit the same label.
        for (const op of ops) {
          if (!Array.isArray(op) || op[0] !== "set" || op[1] !== "attachment-error") continue;
          const { text, hidden } = record(op[2]);
          if (text !== "Tern did not complete the paste." || hidden !== false) continue;
          expect(draft?.text).toBe(clipboardDraft);
          notices++;
        }
      } else if (phase === "sent" && hasDetail(views, "Fixture turn started")) {
        phase = "done";
        return true;
      }
      return false;
    }, "clipboard");
  } finally { clearTimeout(firstSend); }
  expect(phase).toBe("done");
  expect(notices).toBe(1);
}, 8000);

test("projects the engine's steering and follow-up queue above the composer", async () => {
  let step = 0, sawAckWithoutRows = false;
  let editStage: "replace" | "undo" | "redo" | "done" = "replace";
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
      key("firxt");
      step++;
    } else if (step === 2 && editStage === "replace" && draft?.text === "firxt") {
      editStage = "undo";
      event({ ev: "edit", id: "draft", len: 5, from: 3, to: 4, text: "s", cursor: 4 });
    } else if (step === 2 && editStage === "undo" && draft?.text === "first") {
      editStage = "redo";
      key("\x1b[122;9u");
    } else if (step === 2 && editStage === "redo" && draft?.text === "firxt") {
      editStage = "done";
      key("\x1b[122;10u\x1b[13;5u");
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
