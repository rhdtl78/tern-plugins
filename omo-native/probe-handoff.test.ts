import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

test.each(["DA1", "timeout"] as const)("%s: ordinary CLI reads typeahead once, in order, and can return 75", async decision => {
  const cwd = await mkdtemp(join(tmpdir(), "omo-typeahead-"));
  const da1 = "\x1b[?1;2c", hello = '\x1b_tsp;r;{"r":"hello","v":1}\x1b\\';
  const paste = `\x1b[200~한🦉\r${da1}${hello}\x1b[201~`;
  const early = Buffer.concat([Buffer.from(`early\r${paste}\x01\x7f`), Buffer.from([0xff])]);
  const later = Buffer.from("later\r");
  const cliClipboard = "\x1b]5522;fixture\x1b\\";
  try {
    await writeFile(join(cwd, "omo"), `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
appendFileSync("calls", JSON.stringify(process.argv.slice(2)) + "\\n");
await Bun.sleep(60); // Startup precedes the first raw read.
const chunks = [];
process.stdin.setRawMode(true).on("data", bytes => {
  chunks.push(bytes);
  const received = Buffer.concat(chunks);
  if (received.includes("later\\r")) {
    writeFileSync("received", received);
    if (process.env.CHECK_RELAY_SIGNAL) {
      process.once("SIGTERM", () => process.exit(75));
      process.kill(process.ppid, "SIGTERM");
    } else process.exit(75);
  }
});
process.stdout.write("READER " + process.stdout.columns + " " + process.stdout.rows + "\\n");
process.stdout.write("\\x1b[0c");
process.stdout.on("resize", () => process.stdout.write("SIZE " + process.stdout.columns + " " + process.stdout.rows + "\\n"));
setTimeout(() => process.exit(92), 1500);
`, { mode: 0o700 });
    let output = "", probed = false, ready = false, resized = false;
    const shellArgs = decision === "timeout" && Bun.which("zsh") ? ["zsh", "-f"] : ["bash", "--noprofile", "--norc"];
    const shell = Bun.spawn([...shellArgs, "-ic",
      'before=$(stty -g); source "$1"; omo -r; rc=$?; [[ $(stty -g) == "$before" ]] || exit 98; exit "$rc"',
      shellArgs[0], join(import.meta.dir, "shell-integration.sh")], {
      cwd, timeout: 4000, env: { HOME: cwd, PATH: `${cwd}:${dirname(process.execPath)}:/usr/bin:/bin`,
        TERM_PROGRAM: "tern", TERN_PANE: "1", CHECK_RELAY_SIGNAL: decision === "timeout" ? "1" : "" },
      terminal: { cols: 97, rows: 31, data(pty, data) {
        output += Buffer.from(data).toString();
        if (!probed && output.includes("\x1b[c")) {
          probed = true;
          const split = early.indexOf(Buffer.from("한")) + 1;
          pty.write(early.subarray(0, split));
          setTimeout(() => pty.write(Buffer.concat([early.subarray(split), Buffer.from("\x1b]552")])), 5);
          if (decision === "DA1") {
            setTimeout(() => pty.write("2;fixture\x1b\\" + "\x1b[?1;"), 10);
            setTimeout(() => pty.write(`2c${hello.slice(0, -1)}`), 15);
            setTimeout(() => pty.write("\\tail"), 25);
          }
        }
        if (!ready && output.includes("READER 97 31")) { ready = true; pty.resize(83, 27); }
        if (!resized && output.includes("SIZE 83 27")) {
          resized = true;
          if (decision === "timeout") pty.write(`2;leftover\x07${hello}tail`);
          pty.write(Buffer.concat([Buffer.from(da1 + cliClipboard), later]));
        }
      } },
    });
    try {
      expect(await shell.exited, output).toBe(75);
      expect(await readFile(join(cwd, "calls"), "utf8")).toBe('["-r"]\n');
      expect(await readFile(join(cwd, "received"))).toEqual(Buffer.concat([early, Buffer.from("tail" + da1 + cliClipboard), later]));
    } finally { shell.terminal?.close(); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
