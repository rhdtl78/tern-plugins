import { record } from "./surface";
import type { RpcRecord } from "./rpc";

const pasteStart = "\x1b[200~", pasteEnd = "\x1b[201~", tsp = "\x1b_tsp;";
const limit = 65536;

// Latin-1 is a one-to-one byte view, not a decoding of user text. Only the
// hello JSON is UTF-8; the ordinary CLI gets the original bytes and CRs.
export class ProbeInput {
  #tail = "";
  #paste = false;
  #frame: "tsp" | "osc" | "cli-osc" | undefined;
  #body = "";
  #ordinary = "";
  #relay = false;
  #sawDA1 = false;
  #queryTail = "";
  declined = false;
  hello?: RpcRecord;
  cancelled = false;

  get full() { return this.#ordinary.length >= limit; }
  get partial() { return !!this.#tail || !!this.#frame; }

  childOutput(bytes: Uint8Array) {
    if (this.#sawDA1) return;
    // After an unanswered probe the CLI may ask for DA1 itself. Its answer
    // takes precedence; terminal reports carry no request ID.
    const chunk = this.#queryTail + Buffer.from(bytes).toString("latin1");
    this.#sawDA1 = /\x1b\[0?c/.test(chunk);
    this.#queryTail = chunk.slice(-3);
  }

  take() {
    const bytes = Buffer.from(this.#ordinary, "latin1");
    this.#ordinary = "";
    return bytes;
  }

  feed(chunk: Buffer, allowCancel = false) {
    let b = this.#tail + chunk.toString("latin1");
    this.#tail = "";
    while (b) {
      if (this.#frame) {
        const end = (this.#frame === "tsp" ? /\x1b\\/ : /\x07|\x1b\\/).exec(b);
        const n = end?.index ?? b.length - Number(b.endsWith("\x1b"));
        if (this.#frame === "cli-osc") this.#ordinary += b.slice(0, n) + (end?.[0] ?? "");
        if (this.#frame === "tsp" && !this.declined && this.#body.length <= limit)
          this.#body += b.slice(0, Math.min(n, limit + 1 - this.#body.length));
        if (!end) { this.#tail = b.slice(n); break; }
        b = b.slice(n + end[0].length);
        if (!this.declined && this.#frame === "tsp" && this.#body.length <= limit && /^[re];/.test(this.#body)) {
          try {
            const reply = record(JSON.parse(Buffer.from(this.#body.slice(2), "latin1").toString()));
            if (reply.r === "hello" && reply.v === 1) this.hello = reply;
          } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
        }
        this.#frame = undefined; this.#body = "";
        if (this.hello) return Buffer.from(b, "latin1");
        continue;
      }
      const esc = b.indexOf("\x1b");
      if (esc !== 0) {
        const n = esc < 0 ? b.length : esc;
        const text = b.slice(0, n);
        if (allowCancel && !this.declined && !this.#paste && /[\x03\x04]/.test(text)) { this.cancelled = true; return; }
        this.#ordinary += text; b = b.slice(n);
        continue;
      }
      const paste = this.#paste ? pasteEnd : pasteStart;
      if (b.startsWith(paste)) {
        this.#ordinary += paste; b = b.slice(paste.length); this.#paste = !this.#paste;
        continue;
      }
      if (paste.startsWith(b)) { this.#tail = b; break; }
      if (!this.#paste) {
        if (b.startsWith(tsp) || b.startsWith("\x1b]")) {
          this.#frame = b.startsWith(tsp) ? "tsp" : this.#relay ? "cli-osc" : "osc";
          if (this.#frame === "cli-osc") this.#ordinary += "\x1b]";
          b = b.slice(this.#frame === "tsp" ? tsp.length : 2); continue;
        }
        const da = /^\x1b\[\?[0-9;]*c/.exec(b);
        if (da && (!this.#relay || !this.#sawDA1)) { this.#sawDA1 = this.declined = true; b = b.slice(da[0].length); continue; }
        if (tsp.startsWith(b) || (b.length < 128 && /^\x1b\[\?[0-9;]*$/.test(b))) {
          this.#tail = b; break;
        }
      }
      this.#ordinary += b[0]; b = b.slice(1);
    }
    if (this.full) this.declined = true;
  }

  // An uncompleted key prefix (including a lone Escape) belongs to the CLI;
  // an established but truncated protocol packet never does.
  releaseKey() {
    if (!this.#frame && !this.#paste && this.#tail) {
      this.#ordinary += this.#tail;
      this.#tail = "";
    }
  }

  handoff() {
    this.#relay = this.declined = true;
    // Known control-string or paste prefixes can continue in the next read.
    if (!this.#ordinary.length || this.#tail === "\x1b") this.releaseKey();
    return this.take();
  }

  finish() {
    if (!this.#frame || this.#frame === "cli-osc") this.#ordinary += this.#tail;
    this.#tail = "";
    return this.take();
  }
}
