const formats = [ "text/uri-list", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain" ];
const base64 = (text: string) => Buffer.from(text).toString("base64");
export const attachmentLimit = 4 * 1024 * 1024;

type Transfer = { key: string; chunks: Buffer[]; size: number; mime: string };
type Read = Transfer & { timer: ReturnType<typeof setTimeout> };

/** OSC 5522 paste is user initiated. Never read the clipboard without its one-use token. */
export class Clipboard {
  #offer?: Transfer;
  #read?: Read;
  get pending() { return !!this.#offer || !!this.#read; }
  constructor(private send: (packet: string) => void,
    private accept: (mime: string, data: Buffer) => void, private error: (reason: string) => void) {}

  cancel() {
    clearTimeout(this.#read?.timer);
    this.#read = undefined;
    this.#offer = undefined;
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
      this.#offer = { key: pw, chunks: [], size: 0, mime: "." };
      return;
    }
    const transfer = id ? this.#read : this.#offer;
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
        const bytes = Buffer.concat(transfer.chunks, transfer.size);
        if (id) {
          clearTimeout(this.#read?.timer); this.#read = undefined;
          this.accept(transfer.mime, bytes);
          return;
        }
        this.#offer = undefined;
        const offered = bytes.toString("utf8").trim().split(/\s+/);
        const mime = formats.find(format => (!textOnly || format === "text/plain") && offered.includes(format));
        if (!mime) { this.error("This clipboard format is not supported."); return; }
        if (this.#read) { this.error("A paste is already in progress. Try again."); return; }
        const key = crypto.randomUUID();
        this.#read = { key, mime, chunks: [], size: 0, timer: setTimeout(() => {
          this.cancel(); this.error("Tern did not complete the paste.");
        }, 3000) };
        this.send(`\x1b]5522;type=read:id=${key}:pw=${transfer.key}:name=${base64("Paste event")};${base64(mime)}\x1b\\`);
        return;
      }
      default:
        this.cancel();
        this.error(status === "EPERM" ? "Tern denied this paste." : "Tern could not read this clipboard format.");
    }
  }
}
