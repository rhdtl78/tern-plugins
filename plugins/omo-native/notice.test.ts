import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { record } from "./surface";

test("an OmO notification uses Tern's toast layer rather than the composer dock", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "omo-notice-"));
  try {
    const preload = join(cwd, "tty.ts");
    await writeFile(preload, "process.stdin.isTTY = process.stdout.isTTY = true; process.stdin.setRawMode = () => process.stdin;");
    await writeFile(join(cwd, "omo"), `#!/usr/bin/env bun
import { createInterface } from "node:readline";
const sessionId = "notice-test";
const send = value => console.log(JSON.stringify({ sessionId, ...value }));
for await (const line of createInterface({ input: process.stdin })) {
  const { id, type } = JSON.parse(line);
  const data = type === "open_session" ? { sessionId, state: {} }
    : type === "get_messages" ? { messages: [] } : {};
  send({ id, type: "response", command: type, success: true, data });
  if (type === "get_messages") send({ type: "extension_ui_request", method: "notify",
    notifyType: "info", message: "Hot-reloaded: fixture/omo.jsonc" });
}
`, { mode: 0o700 });
    const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "main.ts")], {
      cwd, env: { ...process.env, PATH: `${cwd}:${dirname(process.execPath)}:/usr/bin:/bin` },
      stdin: "pipe", stdout: "pipe", stderr: "inherit", timeout: 3500,
    });
    const placements: string[] = [];
    try {
      child.stdin.write('\x1b_tsp;r;{"r":"hello","v":1,"credits":200}\x1b\\');
      child.stdin.flush();
      let buffer = "";
      for await (const chunk of child.stdout) {
        buffer += Buffer.from(chunk).toString();
        let end: number;
        while ((end = buffer.indexOf("\x1b\\")) !== -1) {
          const packet = buffer.slice(0, end).split("\x1b_tsp;f;")[1];
          buffer = buffer.slice(end + 2);
          if (!packet) continue;
          const { ops } = record(JSON.parse(packet));
          if (!Array.isArray(ops)) continue;
          for (const op of ops) {
            if (!Array.isArray(op)) continue;
            const [verb, , parentOrProps, , childNode] = op;
            const shape = record(childNode);
            const props = record(verb === "add" ? shape.p : parentOrProps);
            if (props.text !== "Hot-reloaded: fixture/omo.jsonc") continue;
            placements.push(verb === "add" ? `${parentOrProps}/${shape.k}` : String(verb));
          }
          if (placements.length) {
            child.stdin.write("\x04");
            child.stdin.flush();
          }
        }
      }
      expect(await child.exited).toBe(0);
      expect(placements).toEqual(["layer/toast"]);
    } finally { child.kill(); await child.exited; }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
