import { expect, test } from "bun:test";
import { SlashMenu } from "./slash";
import type { Op } from "./surface";

const command = (name: string, source = "extension", syntax = "slash") => ({ name, source, syntax });
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
  menu.edit("/", 1); expect(menu.choice).toBe("fresh");
});

test("only session slash invocations in command position are offered", async () => {
  const { menu, deferred, loaded } = setup();
  deferred.resolve({data:{commands:[command("skill:one", "skill", "dollar"), command("template", "prompt"), command("invalid name"), command("x"), command("x")]}}); await loaded;
  for (const input of ["a /x", "https://x", "/usr/bin", "/x arg", "x\n/"]) {
    menu.edit(input, input.length); expect(menu.choice).toBeUndefined();
  }
  menu.edit("/x", 1); expect(menu.choice).toBeUndefined();
  menu.edit("/", 1); expect(menu.buttons.map(row=>row.name)).toEqual(["template","x"]);
  menu.move(1); expect(menu.pick()).toBe("/x "); expect(menu.choice).toBeUndefined();
});

test("catalog refusal does not capture ordinary editing or selection", async () => {
  const { menu, deferred, loaded } = setup(); menu.edit("/",1);
  deferred.reject(new Error("unknown command")); await loaded;
  expect(menu.choice).toBeUndefined(); expect(menu.pick()).toBeUndefined();
});
