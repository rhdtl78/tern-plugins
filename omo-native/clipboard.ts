const formats = [ "text/uri-list", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain" ];
const base64 = (text: string) => Buffer.from(text).toString("base64");
export const attachmentLimit = 4 * 1024 * 1024;

type Phase = "offer" | "read";
type Transfer = {
  readonly key: string;
  readonly chunks: Buffer[];
  size: number;
  readonly mime: string;
  readonly timer: ReturnType<typeof setTimeout>;
};

/** OSC 5522 paste is user initiated. Never read the clipboard without its one-use token. */
export class Clipboard {
  readonly #transfers: Partial<Record<Phase, Transfer>> = {};
  get pending() { return !!this.#transfers.offer || !!this.#transfers.read; }
  constructor(private send: (packet: string) => void,
    private accept: (mime: string, data: Buffer) => void, private error: (reason: string, cause?: "timeout") => void) {}

  cancel() {
    this.#clear("offer");
    this.#clear("read");
  }

  #clear(phase: Phase) {
    clearTimeout(this.#transfers[phase]?.timer);
    delete this.#transfers[phase];
  }

  #start(phase: Phase, key: string, mime: string) {
    this.#clear(phase);
    const timer = setTimeout(() => {
      this.#clear(phase);
      this.error("Tern did not complete the paste.", "timeout");
    }, 3000);
    this.#transfers[phase] = { key, chunks: [], size: 0, mime, timer };
  }

  receive(packet: string, textOnly = false) {
    if (!packet && this.pending) {
      this.cancel();
      this.error("Tern sent an oversized clipboard packet.");
      return;
    }
    const [header = "", data = ""] = packet.split(";", 2);
    const params = new Map(header.split(":").map(field => {
      const i = field.indexOf("=");
      return [field.slice(0, i), field.slice(i + 1)] as const;
    }));
    const pw = params.get("pw"), id = params.get("id"), status = params.get("status");
    if (params.get("type") !== "read") return;
    if (!id && status === "OK" && pw && /^[\w+/=-]{1,128}$/.test(pw)) {
      this.#start("offer", pw, ".");
      return;
    }
    const phase = id ? "read" : "offer";
    const transfer = this.#transfers[phase];
    if (!transfer || transfer.key !== (id ?? pw)) return;
    switch (status) {
      case "OK": return;
      case "DATA": {
        if (params.get("mime") !== base64(transfer.mime) || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return;
        const bytes = Buffer.from(data, "base64");
        transfer.size += bytes.length;
        const limit = transfer.mime === "." ? 4096 : attachmentLimit;
        if (transfer.size > limit) {
          this.cancel();
          this.error("Clipboard data exceeds the 4 MiB paste limit.");
        } else if (bytes.length) transfer.chunks.push(bytes);
        return;
      }
      case "DONE": {
        this.#clear(phase);
        const bytes = Buffer.concat(transfer.chunks, transfer.size);
        if (id) {
          this.accept(transfer.mime, bytes);
          return;
        }
        const offered = bytes.toString("utf8").trim().split(/\s+/);
        const mime = formats.find(format => (!textOnly || format === "text/plain") && offered.includes(format));
        if (!mime) { this.error("This clipboard format is not supported."); return; }
        if (this.#transfers.read) { this.error("A paste is already in progress. Try again."); return; }
        const key = crypto.randomUUID();
        this.#start("read", key, mime);
        this.send(`\x1b]5522;type=read:id=${key}:pw=${transfer.key}:name=${base64("Paste event")};${base64(mime)}\x1b\\`);
        return;
      }
      default:
        this.cancel();
        this.error(status === "EPERM" ? "Tern denied this paste." : "Tern could not read this clipboard format.");
    }
  }
}
