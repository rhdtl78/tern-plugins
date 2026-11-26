import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Exercise the sourced function, real foreground renderer and PTY together.
// The replacement ordinary CLI records calls instead of starting a second TUI.
for (const [name, args, reply, expectedCalls, status] of [
  ["DA1 before a late hello declines exactly once", "--resume", "late", "--resume\n", 23],
  ["an unanswered probe preserves the short resume argument", "-r", "none", "-r\n", 23],
  ["a negotiated short resume cancels without running either CLI or RPC", "-r", "hello", "", 0],
  ["RPC bypasses the probe", "--mode rpc", "bypass", "--mode rpc\n", 23],
] as const) {
  test(name, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omo-shell-"));
    try {
      await writeFile(join(cwd, "calls"), "");
      await writeFile(join(cwd, "omo"), '#!/bin/sh\nprintf "%s\\n" "$*" >> calls\nexit 23\n', { mode: 0o700 });
      let bytes = "", answered = false, closed = false;
      const child = Bun.spawn(["bash", "--noprofile", "--norc", "-ic",
        `source "$1"; omo ${args}`, "bash", join(import.meta.dir, "shell-integration.sh")], {
        cwd, timeout: 3500, env: { HOME: cwd, PATH: `${cwd}:${dirname(process.execPath)}:/usr/bin:/bin`,
          TERM_PROGRAM: "tern", TERN_PANE: "1" },
        terminal: { data(pty, data) {
          bytes += Buffer.from(data).toString();
          if (!answered && bytes.includes("\x1b[c")) {
            answered = true;
            const hello = '\x1b_tsp;r;{"r":"hello","v":1,"credits":10}\x1b\\';
            if (reply === "late") pty.write("\x1b[?1;2c" + hello);
            if (reply === "hello") pty.write(hello);
          }
          if (!closed && bytes.includes("omo.sessions")) { closed = true; pty.write("\x04"); }
        } },
      });
      try {
        expect(await child.exited).toBe(status);
        expect(answered).toBe(reply !== "bypass");
        expect(closed).toBe(reply === "hello");
        expect(await readFile(join(cwd, "calls"), "utf8")).toBe(expectedCalls);
      } finally { child.terminal?.close(); }
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}
