import type { RpcRecord } from "./rpc";
import { add, node, plain, record, string, type Op } from "./surface";

function body(content: unknown): string {
  if (typeof content === "string") return plain(content);
  return Array.isArray(content) ? content.map(record).flatMap(b =>
    b.type === "text" ? [plain(string(b.text))] : b.type === "image" ? ["[Image]"] : []).join("\n\n") : "";
}

type ChecklistItem = {
  readonly id: string;
  readonly text: string;
  readonly status: "pending" | "active" | "done";
};
type ChecklistPhase = {
  readonly id: string;
  readonly title: string;
  readonly items: readonly ChecklistItem[];
};

function todoPhases(details: unknown): readonly ChecklistPhase[] | undefined {
  const { phases } = record(details);
  if (!Array.isArray(phases) || !phases.length) return;
  const checklist: ChecklistPhase[] = [];
  for (const phase of phases) {
    const { name, tasks } = record(phase);
    const title = plain(string(name));
    if (!title.trim() || !Array.isArray(tasks) || !tasks.length) return;
    const items: ChecklistItem[] = [];
    for (const task of tasks) {
      const { content, status } = record(task);
      const text = plain(string(content));
      const state = status === "in_progress" ? "active" : status === "completed" ? "done"
        : status === "pending" ? "pending" : undefined;
      if (!text.trim() || !state) return;
      items.push({ id: `${checklist.length}:${items.length}`, text, status: state });
    }
    checklist.push({ id: String(checklist.length), title, items });
  }
  return checklist;
}

/** History and live tool events share one identity per call, including its disclosure. */
export class Transcript {
  #seq = 0;
  #assistant = "";
  #blocks = new Map<number, string>();
  #tools = new Map<string, { readonly id: string; readonly name: string; checklist: boolean }>();
  #folds = new Map<string, boolean>();
  constructor(private readonly frame: (...ops: Op[]) => void) {}
  get populated() { return this.#seq !== 0; }

  fold(id: string, collapsed: boolean) { if (this.#folds.has(id)) this.#folds.set(id, collapsed); }
  flipTools() {
    const collapse = [...this.#folds.values()].some(folded => !folded);
    for (const id of this.#folds.keys()) {
      this.#folds.set(id, collapse);
      this.frame(["set", id, { collapsed: collapse }]);
    }
  }
  #tool(call: string, name: string, args: RpcRecord, status: string, result?: RpcRecord) {
    if (!call) return;
    const tool = this.#tools.get(call);
    const id = tool?.id ?? `t${++this.#seq}`;
    const phases = (name || tool?.name) === "todo" && status === "done" ? todoPhases(result?.details) : undefined;
    const output = phases
      ? node(id + ".todo", "checklist", { mode: "full", phases })
      : node(id + ".out", "code", { lang: "text", text: body(result?.content) });
    if (!tool) {
      this.#tools.set(call, { id, name, checklist: !!phases });
      this.#folds.set(id, true);
      const target = plain(string(args.path) || string(args.command) || string(args.query));
      this.frame(add("main", node(id, "tool", {
        name: plain(name), title: plain(name) || "Tool", target, targetKind: args.path ? "path" : args.command ? "command" : "text",
        collapsible: true, collapsed: true, status,
      }, [output])));
    } else {
      this.frame(["set", id, { status }]);
      if (!result) return;
      if (tool.checklist !== !!phases) {
        this.frame(["del", id + (tool.checklist ? ".todo" : ".out")], add(id, output));
        tool.checklist = !!phases;
      } else if (phases) {
        this.frame(["set", output.id, { phases }]);
      } else {
        this.frame(["text", output.id, "replace", output.p.text]);
      }
    }
  }
  #text(text: string, assistant: boolean) {
    if (!text) return;
    if (assistant && this.#assistant) {
      this.frame(["text", this.#assistant + ".body", "replace", text]);
      return;
    }
    const id = `m${++this.#seq}`;
    if (assistant) this.#assistant = id;
    this.frame(add("main", node(id, "message", { side: assistant ? "start" : "end", author: assistant ? "OMO" : "You", variant: "auto" },
      [node(id + ".body", assistant ? "md" : "text", { text })])));
  }
  message(m: RpcRecord) {
    switch (m.role) {
      case "user": this.#text(body(m.content), false); break;
      case "assistant": {
        this.#text(body(m.content) || plain(string(m.errorMessage)), true);
        if (Array.isArray(m.content)) for (const b of m.content.map(record)) {
          if (b.type === "toolCall") this.#tool(string(b.id), string(b.name), record(b.arguments), "pending");
        }
        this.#assistant = ""; this.#blocks.clear(); break;
      }
      case "toolResult":
        this.#tool(string(m.toolCallId), string(m.toolName), {}, m.isError ? "error" : "done", m); break;
    }
  }
  event(e: RpcRecord) {
    switch (e.type) {
      case "message_update": {
        const b = record(e.assistantMessageEvent);
        if (b.type !== "text_delta" || typeof b.contentIndex !== "number") return;
        const part = plain(string(b.delta));
        const sep = this.#blocks.size && !this.#blocks.has(b.contentIndex) ? "\n\n" : "";
        this.#blocks.set(b.contentIndex, "");
        if (this.#assistant) this.frame(["text", this.#assistant + ".body", "append", sep + part]);
        else this.#text(part, true);
        break;
      }
      case "message_end": this.message(record(e.message)); break;
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end": {
        const result = e.partialResult ?? e.result;
        this.#tool(string(e.toolCallId), string(e.toolName), record(e.args),
          e.type === "tool_execution_end" ? (e.isError ? "error" : "done") : "running",
          result ? record(result) : undefined);
        break;
      }
    }
  }
}
