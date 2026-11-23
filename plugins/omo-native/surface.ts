import type { RpcRecord } from "./rpc";

export const surface = "omo";
export const node = (id: string, k: string, p: RpcRecord = {}, c: readonly SurfaceNode[] = []): SurfaceNode => ({ id, k, p, c });
interface SurfaceNode { readonly id: string; readonly k: string; readonly p: RpcRecord; readonly c: readonly SurfaceNode[] }
export type Op = readonly unknown[];
export const add = (parent: string, n: SurfaceNode): Op => ["add", n.id, parent, null, n];
export const record = (v: unknown): RpcRecord => typeof v === "object" && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : {};
export const string = (v: unknown): string => typeof v === "string" ? v : "";
export const plain = (s: string): string => Bun.stripANSI(s).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

// Break at a byte boundary, not a JS character boundary. Escape '=' in JSON
// strings so a continuation cannot be mistaken for a TSP key=value parameter.
export function packets(verb: string, value: unknown, limit: number): Buffer[] {
  const bytes = Buffer.from(JSON.stringify(value).replace(/[=\u007f-\u009f]/g, ch =>
    `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`));
  const parts = [];
  for (let i = 0; i < bytes.length; i += limit) {
    const param = bytes.length <= limit ? "" : `c=part;${i + limit < bytes.length ? "m=1;" : ""}`;
    parts.push(Buffer.concat([Buffer.from(`\x1b_tsp;${verb};${param}`), bytes.subarray(i, i + limit), Buffer.from("\x1b\\")]));
  }
  return parts;
}

export class Surface {
  #s = 0;
  #ack = 0;
  #credits = 1;
  #limit = 65536;
  #ops: Op[] = [];
  negotiate(hello: RpcRecord) {
    if (typeof hello.apc === "number" && hello.apc >= 128) this.#limit = Math.min(65536, hello.apc);
    if (typeof hello.credits === "number" && hello.credits > 0) this.#credits = hello.credits;
  }
  send(verb: string, value: unknown) {
    for (const part of packets(verb, value, this.#limit)) process.stdout.write(part);
  }
  ack(s: unknown) {
    if (typeof s === "number" && s <= this.#s) this.#ack = Math.max(this.#ack, s);
    this.#flush();
  }
  frame(...ops: Op[]) {
    this.#ops.push(...ops);
    queueMicrotask(() => this.#flush());
  }
  #flush() {
    if (this.#ops.length && this.#s - this.#ack < this.#credits)
      this.send("f", { sf: surface, s: ++this.#s, ops: this.#ops.splice(0) });
  }
}

export type Input = { kind: "event"; value: RpcRecord } | { kind: "key" | "paste"; value: string };
// PTY reads do not preserve message boundaries. Never parse pasted bytes as
// terminal replies or commands, even when the paste contains literal APCs.
export class InputStream {
  #buffer = "";
  feed(chunk: string, escapeTimeout = false): Input[] {
    this.#buffer += chunk;
    const events: Input[] = [];
    while (this.#buffer) {
      const b = this.#buffer;
      let size: number;
      if (b.startsWith("\x1b[200~")) {
        const end = b.indexOf("\x1b[201~", 6);
        if (end < 0) break;
        events.push({ kind: "paste", value: b.slice(6, end).replace(/\r\n?/g, "\n") });
        size = end + 6;
      } else if (b.startsWith("\x1b_")) {
        const end = b.indexOf("\x1b\\", 2);
        if (end < 0) break;
        if (/^\x1b_tsp;[re];/.test(b)) {
          try { events.push({ kind: "event", value: record(JSON.parse(b.slice(8, end))) }); }
          catch (e) { if (!(e instanceof SyntaxError)) throw e; }
        }
        size = end + 2;
      } else if (b.startsWith("\x1b[")) {
        const csi = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(b);
        if (!csi) break;
        size = csi[0].length;
        events.push({ kind: "key", value: csi[0] });
      } else {
        if (b === "\x1b" && !escapeTimeout) break;
        const char = String.fromCodePoint(b.codePointAt(0) ?? 0);
        size = char.length;
        events.push({ kind: "key", value: char });
      }
      this.#buffer = b.slice(size);
    }
    return events;
  }
}
