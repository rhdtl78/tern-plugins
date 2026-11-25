import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Picker, savedRows, selectedSession } from "./picker";
import { appliedSettings, changeSetting, modelChoices, settingApplied, thinkingChoices } from "./model-settings";
import { entryRows, sessionCommand } from "./session-commands";
import type { RpcRecord } from "./rpc";
import { record } from "./surface";

// Exercise the real --resume entry and RPC launch boundary with a scripted TSP
// peer. Only the terminal flags are shimmed; no Tern window or engine is needed.
for (const change of ["replacement inode", "rewritten ID"] as const) {
  test(`listed row with ${change} offers Reload without starting RPC`, async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "picker-activation-")));
    const bucket = join(cwd, "sessions", "--test--"), path = join(bucket, "a.jsonl");
    const preload = join(cwd, "tty.ts"), launches = join(cwd, "invocations");
    const saved = (id: string, name: string) => [
      { type: "session", id, cwd }, { type: "session_info", name },
    ].map(row => JSON.stringify(row)).join("\n") + "\n";
    try {
      await mkdir(bucket, { recursive: true });
      await writeFile(path, saved("durable-A", "Listed A"));
      await writeFile(join(cwd, "omo"), '#!/bin/sh\nprintf "rpc\\n" >> "$PWD/invocations"\nexit 1\n', { mode: 0o700 });
      await writeFile(preload, `process.stdin.isTTY = process.stdout.isTTY = true; process.stdin.setRawMode = () => process.stdin;`);
      const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "main.ts"), "--resume"], {
        cwd, env: { ...process.env, OMO_CODING_AGENT_DIR: cwd, PATH: cwd }, stdin: "pipe", stdout: "pipe", stderr: "inherit",
        timeout: 3000,
      });
      const event = (value: RpcRecord) => child.stdin.write(`\x1b_tsp;e;${JSON.stringify({ sf: "omo", ...value })}\x1b\\`);
      let listed = false, reload = false, buffer = "";
      try {
        event({ r: "hello", v: 1, credits: 200 });
        for await (const chunk of child.stdout) {
          buffer += Buffer.from(chunk).toString();
          let end;
          while ((end = buffer.indexOf("\x1b\\")) !== -1) {
            const packet = buffer.slice(0, end).split("\x1b_tsp;f;")[1];
            buffer = buffer.slice(end + 2);
            if (!packet) continue;
            const { ops } = record(JSON.parse(packet));
            for (const op of Array.isArray(ops) ? ops : []) {
              const [action, id, props] = op;
              if (action !== "set") continue;
              if (!listed && props.items?.[0]?.label === "Listed A") {
                listed = true;
                if (change === "replacement inode") await rename(path, path + ".old");
                await writeFile(path, saved(change === "replacement inode" ? "durable-A" : "durable-B", "Not listed"));
                event({ ev: "activate", id, item: props.items[0].id });
              } else if (props.state === "error" || (id === "notice" && props.text?.startsWith("OMO unavailable"))) {
                reload = props.state === "error" && props.actions.some((a: RpcRecord) => a.label === "Reload");
                child.stdin.write("\x04");
              }
            }
          }
        }
        expect(await child.exited).toBe(0);
        expect(listed).toBe(true);
        expect({ launches: await Bun.file(launches).exists(), reload }).toEqual({ launches: false, reload: true });
      } finally { child.kill(); await child.exited; }
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}

test("duplicate display names switch by the selected registry pair, never the device default", async () => {
  const first = { provider: "one", id: "alpha", name: "Local" };
  const second = { provider: "two", id: "beta:latest", name: "Local" };
  const calls: unknown[] = [];
  const rpc = {
    getProtocolInfo: async () => ({ data: { capabilities: ["session_model_scope"] } }),
    request: async (cmd: string, fields?: RpcRecord) => {
      calls.push([cmd, fields]);
      return { data: cmd === "get_available_models" ? { models: [first, second] } : second };
    },
  };
  const p = new Picker("models", "sheet");
  p.load(await modelChoices(rpc, { model: first }, "models"));
  expect(p.props(true).current).toEqual([p.selected]);
  p.input({ kind: "paste", value: "TWO/BETA" });
  expect(p.props().order).toHaveLength(1);
  expect(p.input({ kind: "key", value: "\r" })).toBe("use");
  const target = p.choice?.target;
  if (!target || !("provider" in target)) throw new Error("No selected model");
  await changeSetting(rpc, target);
  expect(settingApplied({ model: second }, target)).toBe(true);
  expect(calls).toEqual([["get_available_models", undefined],
    ["set_model", { provider: "two", modelId: "beta:latest", scope: "session" }]]);
});

test("an old engine cannot offer a model switch that would change the default", async () => {
  const calls: string[] = [];
  const rpc = {
    getProtocolInfo: async () => ({ data: { capabilities: ["models"] } }),
    request: async (cmd: string) => { calls.push(cmd); return {}; },
  };
  await expect(modelChoices(rpc, {}, "models")).rejects.toThrow("only this session");
  expect(calls).toEqual([]);
});

test("only confirmed variants with a same-provider base move to the tier picker", async () => {
  const base = { provider: "one", id: "gpt-6.2-sol" };
  const fast = { ...base, id: "accelerated", upstreamModelId: base.id, serviceTier: "priority" };
  const solo = { provider: "two", id: "gpt-6.2-sol-ultrafast" };
  const state = { model: solo, serviceTier: "ultrafast", thinkingLevel: "medium" };
  const rpc = {
    getProtocolInfo: async () => ({ data: { capabilities: ["session_model_scope"] } }),
    request: async () => ({ data: { models: [base, fast, solo] } }),
  };
  expect((await modelChoices(rpc, state, "models")).map(row => row.label)).toEqual([base.id, solo.id]);
  expect(await modelChoices(rpc, state, "tiers")).toEqual([]);
  expect(appliedSettings(state)).toEqual({ model: base.id, tier: "ultrafast", thinking: "medium" });
  expect(appliedSettings({ model: solo })).toEqual({ model: solo.id, tier: "", thinking: "" });
  const [baseChoice, fastChoice] = await modelChoices(rpc, { model: base }, "tiers");
  expect(baseChoice?.label).toBe("Base model");
  expect(fastChoice?.label).toBe("fast");
  if (!fastChoice || !("provider" in fastChoice.target)) throw new Error("Missing fast tier");
  expect(settingApplied({ model: fast }, fastChoice.target)).toBe(false);
  expect(settingApplied({ model: fast, serviceTier: "priority" }, fastChoice.target)).toBe(true);
  expect((await modelChoices(rpc, { model: fast }, "models")).find(row => row.current)?.target)
    .toEqual({ provider: fast.provider, modelId: fast.id });
});

test("Thinking choices come from the active model and a write must match session readback", async () => {
  const calls: unknown[] = [];
  const rpc = { request: async (cmd: string, fields?: RpcRecord) => {
    calls.push([cmd, fields]);
    return { data: { levels: ["low", "medium"] } };
  } };
  expect(await thinkingChoices(rpc, {})).toEqual([]);
  const levels = await thinkingChoices(rpc, { model: { id: "model" }, thinkingLevel: "low" });
  expect(levels.map(row => [row.label, row.current])).toEqual([["low", true], ["medium", false]]);
  const choice = levels[1]?.target;
  if (!choice || !("level" in choice)) throw new Error("Missing Thinking choice");
  await changeSetting(rpc, choice);
  expect(settingApplied({ thinkingLevel: "low" }, choice)).toBe(false);
  expect(settingApplied({ thinkingLevel: "medium" }, choice)).toBe(true);
  expect(calls).toEqual([["get_available_thinking_levels", undefined],
    ["set_thinking_level", { level: "medium", scope: "turn" }]]);
});

test("keyboard and pointer can only activate a visible row of this picker", () => {
  const p = new Picker("sessions", "new");
  const event = (ev: string, item: string, id = p.id) => p.input({ kind: "event", value: { id, ev, item } });
  const key = (value: string) => p.input({ kind: "key", value });
  expect(key("\r")).toBeUndefined();
  p.load(savedRows(["first", "second"].map((title,i) => ({ path: `/${title}.jsonl`, title,
    modifiedAt: 0, sessionId: title, fileId: `1:${i}` }))));
  const [a, b] = p.props().order;
  if (!a || !b) throw new Error("Expected two options");
  key("\x1b[B"); expect(p.choice?.target).toEqual({ path: "/second.jsonl", sessionId: "second", fileId: "1:1" });
  key("\x1b[A"); expect(p.selected).toBe(a);
  expect(event("select", b)).toBe("draw");
  expect(event("activate", b, "old")).toBeUndefined();
  expect(event("activate", b)).toBe("use");
  key("x"); expect(p.props().order).toEqual([]);
  expect(event("activate", b)).toBeUndefined();
  expect(key("\r")).toBeUndefined();
  p.input({ kind: "event", value: { id: "new", ev: "action", act: "clear" } });
  expect(p.selected).toBe(a);
  expect(key("\x1b")).toBe("close");
});

test("native rename and branch choices provide only their intended arguments", () => {
  expect(sessionCommand("/NAME  Project review ")).toEqual({ name: "name", argument: "Project review" });
  expect(sessionCommand("show /resume")).toBeUndefined();
  expect(sessionCommand("/sessions-list")).toBeUndefined();
  const rename = new Picker("rename", "sheet");
  rename.load([]);
  expect(rename.usable).toBe(false);
  rename.input({ kind: "paste", value: "Project review" });
  expect(rename.input({ kind: "event", value: { ev: "action", id: "sheet", act: "use" } })).toBe("use");
  expect(rename.choice).toBeUndefined();

  const entry = (id: string, role: string, content: string) =>
    ({ id, type: "message", message: { role, content } });
  const tree = new Picker("tree", "branches");
  tree.load(entryRows("tree", { leafId: "leaf", tree: [{
    entry: entry("base", "user", "Original prompt"),
    children: [{ entry: entry("leaf", "assistant", "Chosen reply"), children: [] }],
  }] }));
  expect(tree.choice?.target).toEqual({ entryId: "leaf", expectedLeafId: "leaf" });
  tree.input({ kind: "paste", value: "original" });
  expect(tree.choice?.target).toEqual({ entryId: "base", expectedLeafId: "leaf" });
  expect(entryRows("fork", { messages: [{ entryId: "base", text: "Fork prompt" }] })[0]?.target)
    .toEqual({ entryId: "base" });
});

test("resume rejects deleted, replaced, redirected and foreign-cwd saved rows", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "picker-")));
  const path = join(dir, "saved.jsonl"), other = join(dir, "other.jsonl");
  const header = (cwd: string, id = "saved") => JSON.stringify({ type: "session", id, cwd }) + "\n";
  try {
    await Bun.write(path, header(dir));
    const { dev, ino } = await stat(path, { bigint: true });
    const target = { path, sessionId: "saved", fileId: `${dev}:${ino}` };
    await appendFile(path, '{"type":"message"}\n');
    const { fields, verify } = await selectedSession(target, dir);
    expect(fields).toEqual({ sessionPath: path, cwd: dir });
    await appendFile(path, '{"type":"message"}\n');
    await verify();
    await writeFile(path, header(dir, "rewritten"));
    await expect(verify()).rejects.toThrow("Reload");
    await writeFile(path, header("/"));
    await expect(selectedSession(target, dir)).rejects.toThrow("Session belongs");
    await expect(verify()).rejects.toThrow("Session belongs");
    await writeFile(path, header(dir));
    await rename(path, other);
    await expect(selectedSession(target, dir)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path, header(dir));
    await expect(verify()).rejects.toThrow("replaced");
    await rm(path); await symlink(other, path);
    await expect(selectedSession(target, dir)).rejects.toThrow("listed path");
    await expect(verify()).rejects.toThrow("replaced");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
