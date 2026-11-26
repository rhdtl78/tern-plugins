import type { RpcRecord } from "./rpc";
import { InputStream, type Input, type Surface } from "./surface";

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
    const decline = () => {
      if (this.#state !== "probing") return;
      this.#state = "closing";
      if (!this.fromShell) process.stderr.write("OMO Native: Tern did not negotiate a surface. Enable Native program surfaces and reopen this pane.\r\n");
      process.exitCode = this.fromShell ? 75 : 1;
      callbacks.close();
    };
    const dispatch = (i: Input) => {
      if (this.#state === "closing") return;
      if (this.#state === "active") { callbacks.handle(i); return; }
      if (i.kind === "event" && i.value.r === "hello" && i.value.v === 1) {
        this.#state = "active";
        clearTimeout(this.#timer);
        this.#modes = true;
        process.stdout.write("\x1b[?2004h\x1b[?5522h\x1b[>1u");
        callbacks.start(i.value);
      } else if (i.kind === "key") {
        if (/^\x1b\[\?[0-9;]*c$/.test(i.value)) decline();
        else if (i.value === "\x03" || i.value === "\x04") callbacks.close();
      }
    };
    this.#raw = process.stdin.isRaw === true;
    process.stdin.setRawMode(true).setEncoding("utf8").on("data", (chunk: string) => {
      clearTimeout(this.#escape);
      this.input.feed(chunk).forEach(dispatch);
      if (chunk.endsWith("\x1b")) this.#escape = setTimeout(() => this.input.feed("", true).forEach(dispatch), 40);
    }).once("end", callbacks.close).resume();
    for (const signal of ["SIGINT","SIGHUP","SIGTERM"] as const) process.once(signal, callbacks.close);
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
