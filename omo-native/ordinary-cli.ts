import { basename, resolve } from "node:path";
import type { ProbeInput } from "./probe-input";

const signals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;

// Only the sourced wrapper selects the executable; no input becomes shell
// text, an argument, a file, or data on the invoking shell's input queue.
export async function ordinaryCli(executable: string, probe: ProbeInput, originalRaw: boolean) {
  const path = resolve(executable);
  const flags = process.argv.slice(3);
  if (basename(path) !== "omo" || (flags.length && !(flags.length === 1 && ["--resume", "-r"].includes(flags[0]))))
    throw new Error("expected the shell-resolved omo executable with an interactive argument vector");
  const args = [path, ...flags];
  const early = probe.handoff();
  if (!early.length) {
    process.stdin.setRawMode(originalRaw);
    process.execve(path, args, process.env);
  }

  const outer = process.stdout;
  let draining = true;
  const tty = new Bun.Terminal({
    cols: outer.columns, rows: outer.rows,
    data(_tty, bytes) { if (draining) probe.childOutput(bytes); outer.write(bytes); },
  });
  try {
    // A cooked slave would echo, erase, or map CR before the TUI's first read.
    tty.setRawMode(true);
    const child = Bun.spawn(args, { terminal: tty, env: process.env });
    let escape: ReturnType<typeof setTimeout> | undefined;
    // A truncated probe packet must not eat the new CLI's input indefinitely.
    // After one probe interval the relay is byte-transparent.
    const deadline = setTimeout(() => {
      clearTimeout(escape);
      draining = false;
      tty.write(probe.finish());
    }, 1000);
    const write = (bytes: Buffer) => {
      if (!draining) { tty.write(bytes); return; }
      clearTimeout(escape);
      probe.feed(bytes);
      tty.write(probe.take());
      if (probe.partial) escape = setTimeout(() => {
        probe.releaseKey();
        tty.write(probe.take());
      }, 40);
    };
    const resize = () => tty.resize(outer.columns, outer.rows);
    const hangup = () => child.kill("SIGHUP");
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    try {
      for (const signal of signals) process.on(signal, forward);
      outer.on("resize", resize).once("error", hangup);
      tty.write(early);
      write(Buffer.alloc(0));
      process.stdin.on("data", write).once("end", hangup).resume();
      return await child.exited;
    } finally {
      clearTimeout(deadline);
      clearTimeout(escape);
      for (const signal of signals) process.off(signal, forward);
      outer.off("resize", resize).off("error", hangup);
      process.stdin.off("data", write).off("end", hangup).pause();
      if (child.exitCode === null && !child.signalCode) child.kill();
    }
  } finally { tty.close(); }
}
