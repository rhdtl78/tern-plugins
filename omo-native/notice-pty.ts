import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { noticeEngine, promptsFile, sessionCallsFile, type Checkpoint, type Scenario } from "./notice-fixture";
import { record, string, surface } from "./surface";

type View = {
  readonly parent: string;
  readonly kind: string;
  readonly props: ReturnType<typeof record>;
};
export type Views = ReadonlyMap<string, View>;

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

export const visible = (views: Views) => [...views.values()].filter(view => view.props.hidden !== true);
export const withText = (views: Views, text: string) => visible(views).filter(view => view.props.text === text);
export const hasDetail = (views: Views, detail: string) =>
  visible(views).some(view => string(view.props.text).includes(detail));

type FixtureControls = {
  readonly event: (value: object) => void;
  readonly key: (bytes: string) => void;
  readonly release: (marker: Checkpoint) => void;
  readonly clipboardReadId?: string;
};

export async function exercise(rejectOpen: boolean, observe: (views: Views, controls: FixtureControls, ops: unknown[]) => boolean,
  scenario: Scenario = "notice") {
  const cwd = await mkdtemp(join(tmpdir(), "omo-notice-"));
  try {
    const promptsPath = join(cwd, promptsFile);
    if (scenario === "clipboard") await writeFile(promptsPath, "");
    await writeFile(join(cwd, "omo"), noticeEngine(rejectOpen, scenario), { mode: 0o700 });
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const output = writable.getWriter();
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts")], {
      cwd, env: { ...process.env, OMO_CODING_AGENT_DIR: cwd, PATH: `${cwd}:${dirname(process.execPath)}:/usr/bin:/bin` },
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
          const clipboardReadId = /\x1b\]5522;type=read:id=([^:;]+):/.exec(message)?.[1];
          if (clipboardReadId && observe(views, { ...controls, clipboardReadId }, [])) send("\x04");
          if (!packet) continue;
          const { ops } = record(JSON.parse(packet));
          if (!Array.isArray(ops)) continue;
          apply(views, ops);
          if (observe(views, controls, ops)) send("\x04");
        }
      }
      const code = await child.exited;
      expect(code).toBe(0);
      switch (scenario) {
        case "session":
        case "session-refused": return await readFile(join(cwd, sessionCallsFile), "utf8");
        default: return;
        case "clipboard": return await readFile(promptsPath, "utf8");
      }
    } finally { child.kill(); await child.exited; child.terminal?.close(); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
