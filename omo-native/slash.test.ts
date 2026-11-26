import { expect, test } from "bun:test";
import { SlashMenu } from "./slash";
import { sessionCommand } from "./session-commands";
import { RpcCommandError, RpcTransportError } from "./rpc";
import type { Op } from "./surface";

const command = (name: string, source = "extension", syntax = "slash") => ({ name, source, syntax });

test.each([
  "/new\nPlease keep this paragraph",
  "/clone\r\nDraft to preserve",
  "/resume this paragraph",
  "/session\n",
  "/rename\nDraft to preserve",
  "/name First\u2028Second",
])("session command parsing leaves %j for normal submission", (draft) => {
  expect(sessionCommand(draft)).toBeUndefined();
});

test.each([
  [" /NEW \t", "new", ""],
  ["/resume ", "resume", ""],
  ["/rename", "rename", ""],
  ["/rename  Fixture name ", "rename", "Fixture name"],
  ["/NAME\tOther name", "name", "Other name"],
])("session command parsing recognizes %j as local intent", (draft, name, argument) => {
  expect(sessionCommand(draft)).toEqual({ name, argument });
});

function setup() {
  const frames: Op[] = [];
  const menu = new SlashMenu((...ops) => frames.push(...ops));
  const deferred = Promise.withResolvers<{data: {commands: unknown[]}}>();
  const owner = { sessionId: "one", request: () => deferred.promise };
  const loaded = menu.bind(owner);
  return { menu, frames, deferred, owner, loaded };
}

test("new source wins over late catalog; reply filters the latest draft only", async () => {
  const { menu, owner, deferred, loaded } = setup();
  menu.edit("/a", 2); menu.edit("/b", 2);
  menu.changed("other", [command("bad")]);
  expect(menu.choice).toBeUndefined();
  menu.changed(owner.sessionId, [command("alpha"), command("beta")]);
  deferred.resolve({data:{commands:[command("bad")]}}); await loaded;
  expect(menu.choice).toBe("beta");
  menu.edit("/a", 2); expect(menu.choice).toBe("alpha");
});

test("a replaced client, a dismissed query and an obsolete button cannot select", async () => {
  const { menu, deferred, loaded, frames } = setup();
  await menu.bind({sessionId:"two", request:async()=>({data:{commands:[command("fresh")]}})});
  menu.edit("/", 1); const oldId=menu.buttons[0]?.id;
  menu.edit("/fr", 3); expect(menu.pick(oldId)).toBeUndefined();
  menu.close(); deferred.resolve({data:{commands:[command("stale")]}}); await loaded;
  expect(menu.choice).toBeUndefined(); expect(frames.at(-1)).toEqual(["del", "slash-menu"]);
  menu.edit("/fre", 4); expect(menu.choice).toBe("fresh");
});

test("only session slash invocations in command position are offered", async () => {
  const { menu, deferred, loaded } = setup();
  deferred.resolve({data:{commands:[command("skill:one", "skill", "dollar"), command("template", "prompt"), command("invalid name"), command("x"), command("x")]}}); await loaded;
  for (const input of ["a /x", "https://x", "/usr/bin", "/x arg", "x\n/"]) {
    menu.edit(input, input.length); expect(menu.choice).toBeUndefined();
  }
  menu.edit("/x", 1); expect(menu.choice).toBeUndefined();
  menu.edit("/temp", 5); expect(menu.choice).toBe("template");
  menu.edit("/x", 2); expect(menu.pick()).toBe("/x "); expect(menu.choice).toBeUndefined();
});

test("exact slash defaults without overriding explicit arrow or click selection", async () => {
  const { menu, deferred, owner, loaded } = setup();
  const commands = [command("reload-rules"), command("rules"), command("rules-next")];
  deferred.resolve({ data: { commands } }); await loaded;
  menu.edit("/RULES", 6);
  expect(menu.pick()).toBe("/rules ");
  menu.edit("/rules", 6);
  menu.move(-1); menu.move(-1);
  menu.changed(owner.sessionId, commands);
  expect(menu.pick()).toBe("/reload-rules ");
  menu.edit("/rules", 6);
  expect(menu.choice).toBe("rules");
  expect(menu.pick(menu.buttons.find(row => row.name === "rules-next")?.id)).toBe("/rules-next ");
});

for (const error of [new RpcCommandError("get_commands", { error: "unknown command" }), new RpcTransportError("disconnected")]) test(`optional catalog ${error.name} does not capture editing`, async () => {
  const { menu, deferred, loaded } = setup(); menu.edit("/external",9);
  deferred.reject(error); await loaded;
  expect(menu.choice).toBeUndefined(); expect(menu.pick()).toBeUndefined();
  menu.edit("/res", 4); expect(menu.pick()).toBe("/resume ");
});

test("session actions remain searchable and authoritative across RPC catalog changes", async () => {
  const { menu, owner, deferred, loaded } = setup();
  const names = ["clone", "fork", "name", "new", "rename", "resume", "session", "sessions", "tree"];
  deferred.resolve({ data: { commands: [command("resume"), command("RESUME"), command("help")] } });
  await loaded;
  menu.edit("/", 1);
  const seen = new Set<string>();
  for (let i = 0; i < names.length + 1; i++) {
    if (menu.choice) seen.add(menu.choice);
    menu.move(1);
  }
  expect([...seen]).toEqual(["clone", "fork", "help", "name", "new", "rename", "resume", "session", "sessions", "tree"]);
  menu.changed(owner.sessionId, []);
  for (const name of names) {
    menu.edit(`/${name}`, name.length + 1);
    expect(menu.pick()).toBe(`/${name} `);
  }
});

test("unexpected request failures reach the slash discovery caller", async () => {
  const { deferred, loaded } = setup();
  const error = new TypeError("request failed unexpectedly");
  deferred.reject(error);
  await expect(loaded).rejects.toBe(error);
});

test("render failure after successful discovery reaches the slash discovery caller", async () => {
  const error = new TypeError("render failed unexpectedly");
  const menu = new SlashMenu(() => { throw error; });
  const deferred = Promise.withResolvers<{ data: { commands: unknown[] } }>();
  const loaded = menu.bind({ sessionId: "one", request: () => deferred.promise });
  menu.edit("/rules", 6);
  deferred.resolve({ data: { commands: [command("rules")] } });
  await expect(loaded).rejects.toBe(error);
});
