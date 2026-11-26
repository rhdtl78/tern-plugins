import type { RpcRecord } from "./rpc";
import { InputStream, type Input, type Surface } from "./surface";
import { StringDecoder } from "node:string_decoder";
import { ProbeInput } from "./probe-input";
import { ordinaryCli } from "./ordinary-cli";

type PaneCallbacks = {
  readonly start: (hello: RpcRecord) => void;
  readonly handle: (input: Input) => void;
  readonly close: () => void;
};

/** No renderer callback can start a session after a declined probe. */
export class PaneTerminal {
  #state: "probing" | "active" | "closing" = "probing";
  #timer?: ReturnType<typeof setTimeout>;
  #escape?: ReturnType<typeof setTimeout>;
  #raw = false;
  #modes = false;

  constructor(private readonly input: InputStream, private readonly fromShell: boolean) {}

  listen(screen: Surface, callbacks: PaneCallbacks) {
    const probe = new ProbeInput();
    const decoder = new StringDecoder("utf8");
    const cli = this.fromShell ? process.env.OMO_NATIVE_CLI : undefined;
    delete process.env.OMO_NATIVE_CLI;
    const signals = ["SIGINT","SIGHUP","SIGTERM"] as const;
    const decline = async () => {
      if (this.#state !== "probing") return;
      this.closing();
      process.stdin.off("data", read).off("end", callbacks.close).pause();
      for (const signal of signals) process.off(signal, callbacks.close);
      process.stdout.off("error", callbacks.close);
      if (cli) {
        try { process.exitCode = await ordinaryCli(cli, probe, this.#raw); }
        catch (e) {
          console.error("OMO Native: could not run ordinary CLI:", e);
          process.exitCode = 1;
        }
      } else {
        process.stderr.write("OMO Native: Tern did not negotiate a surface. Enable Native program surfaces and reopen this pane.\r\n");
        process.exitCode = 1;
      }
      callbacks.close();
    };
    const read = (bytes: Buffer) => {
      if (this.#state === "closing") return;
      let native = bytes;
      if (this.#state === "probing") {
        const rest = probe.feed(bytes, true);
        if (probe.cancelled) { callbacks.close(); return; }
        if (!probe.hello || !rest) {
          if (cli && probe.full) { void decline(); return; }
          if (probe.declined && !this.#escape) {
            // DA1 wins immediately. Drain adjacent replies before transferring
            // the inherited tty; a fragmented reply still has the probe deadline.
            this.#escape = setTimeout(() => {
              this.#escape = undefined;
              if (!probe.partial) void decline();
            }, 40);
          }
          if (!cli) probe.take();
          return;
        }
        this.#state = "active";
        clearTimeout(this.#timer);
        this.#modes = true;
        process.stdout.write("\x1b[?2004h\x1b[?5522h\x1b[>1u");
        callbacks.start(probe.hello);
        probe.take();
        native = rest;
      }
      const chunk = decoder.write(native);
      clearTimeout(this.#escape);
      this.input.feed(chunk).forEach(callbacks.handle);
      if (chunk.endsWith("\x1b")) this.#escape = setTimeout(() => this.input.feed("", true).forEach(callbacks.handle), 40);
    };
    this.#raw = process.stdin.isRaw === true;
    process.stdin.setRawMode(true).on("data", read).once("end", callbacks.close).resume();
    for (const signal of signals) process.once(signal, callbacks.close);
    process.stdout.on("error", callbacks.close);
    this.#timer = setTimeout(decline, 1000);
    screen.send("q", { q: "hello", app: "omo", v: [1], features: ["edit","send","undo"] });
    process.stdout.write("\x1b[c");
  }

  closing() {
    this.#state = "closing";
    clearTimeout(this.#timer);
    clearTimeout(this.#escape);
  }

  async restore() {
    if (this.#modes) {
      process.stdout.write("\x1b[<u\x1b[?2004l\x1b[?5522l");
      await Bun.sleep(60);
    }
    process.stdin.setRawMode(this.#raw); process.stdin.pause();
  }
}
