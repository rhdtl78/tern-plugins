import { RpcCommandError, RpcRequestTimeoutError, RpcTransportError, type OmoRpc, type RpcRecord } from "./rpc";
import { add, node, plain, record, string, type Op } from "./surface";
import { sessionCommand, sessionCommands } from "./session-commands";

type Source = Pick<OmoRpc, "sessionId" | "request">;
type Command = { readonly name: string; readonly description: string; readonly source: string };
const token = /^[\p{L}\p{N}_:-][\p{L}\p{N}_.:-]*$/u;

function catalog(value: unknown): Command[] {
  const commands = new Map<string, Command>(sessionCommands.map(row => [row.name, row]));
  for (const raw of Array.isArray(value) ? value : []) {
    const { name, description, source, syntax } = record(raw);
    if (typeof name !== "string" || !token.test(name) || commands.has(name) || sessionCommand(`/${name}`)) continue;
    if (syntax !== "slash" && !(syntax === undefined && (source === "extension" || source === "prompt"))) continue;
    commands.set(name, { name, description: plain(string(description)), source: plain(string(source)) });
  }
  return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Edits and catalog events meet here; discovery never receives a submit callback. */
export class SlashMenu {
  #source?: Source;
  #version = 0;
  #revision = 0;
  #rows = catalog(undefined);
  #matches: Command[] = [];
  #index = 0;
  #query?: string;
  #selection?: string;
  buttons: readonly { readonly id: string; readonly name: string }[] = [];
  constructor(private readonly frame: (...ops: Op[]) => void) {}

  async bind(source: Source) {
    this.#source = source; this.#rows = catalog(undefined); this.#filter();
    const version = ++this.#version;
    let reply: RpcRecord;
    try {
      reply = await source.request("get_commands");
    } catch (error) {
      if (error instanceof RpcTransportError || error instanceof RpcRequestTimeoutError ||
          (error instanceof RpcCommandError && error.command === "get_commands")) return;
      throw error;
    }
    if (version === this.#version) this.changed(source.sessionId, record(reply.data).commands);
  }
  changed(owner: unknown, rows: unknown) {
    if (!owner || owner !== this.#source?.sessionId) return;
    this.#version++;
    this.#rows = catalog(rows); this.#filter();
  }
  edit(text: string, cursor: number) {
    const q = text.slice(1);
    if (cursor !== text.length || !text.startsWith("/") || (q && !token.test(q))) { this.close(); return; }
    const query = q.toLowerCase();
    if (query !== this.#query) this.#selection = undefined;
    this.#query = query; this.#filter();
  }
  #filter() {
    const q = this.#query;
    this.#matches = q === undefined ? [] : this.#rows.filter(row => row.name.toLowerCase().includes(q));
    const selected = this.#matches.findIndex(row => row.name === this.#selection);
    if (selected < 0) this.#selection = undefined;
    const exact = this.#matches.findIndex(row => row.name.toLowerCase() === q);
    this.#index = selected >= 0 ? selected : Math.max(0, exact);
    this.#draw();
  }
  get choice() { return this.#matches[this.#index]?.name; }
  move(by: number) {
    this.#index = Math.max(0, Math.min(this.#matches.length - 1, this.#index + by));
    this.#selection = this.choice;
    this.#draw();
  }
  pick(id?: unknown) {
    const name = id === undefined ? this.choice : this.buttons.find(row => row.id === id)?.name;
    if (!name) return;
    this.close(); return `/${name} `;
  }
  close() { this.#query = undefined; this.#selection = undefined; this.#matches = []; this.#index = 0; this.#draw(); }
  #draw() {
    if (this.buttons.length) this.frame(["del", "slash-menu"]);
    const first = Math.max(0, this.#index - 4), revision = ++this.#revision;
    const rows = this.#matches.slice(first, first + 5);
    this.buttons = rows.map(({ name }, i) => ({ id: `slash-option-${revision}-${i}`, name }));
    if (!rows.length) return;
    this.frame(add("dialogs", node("slash-menu", "col", { gap: "xs" }, [
      node("slash-hint", "text", { text: `Commands · ${this.#index + 1}/${this.#matches.length} · ↑↓ choose · Enter select · Esc close` }),
      ...rows.map((row, i) => node(this.buttons[i].id, "button", {
        text: `/${row.name}`, title: [row.source, row.description].filter(Boolean).join(" · "),
        variant: first + i === this.#index ? "primary" : "quiet", actions: { click: "insert-command" },
      })),
    ])));
  }
}
