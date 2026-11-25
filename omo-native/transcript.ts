import type { RpcRecord } from "./rpc";
import { evalCard } from "./eval-card";
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
export type ChecklistPhase = {
  readonly id: string;
  readonly title: string;
  readonly collapsed: false;
  readonly items: readonly ChecklistItem[];
};

export function todoPhases(details: unknown): readonly ChecklistPhase[] | undefined {
  const { phases } = record(details);
  if (!Array.isArray(phases)) return;
  const checklist: ChecklistPhase[] = [];
  for (const phase of phases) {
    const { name, tasks } = record(phase);
    const title = plain(string(name));
    if (!title.trim() || !Array.isArray(tasks)) return;
    if (!tasks.length) continue;
    const items: ChecklistItem[] = [];
    for (const task of tasks) {
      const { content, status } = record(task);
      const text = plain(string(content));
      const state = status === "in_progress" ? "active" : status === "completed" ? "done"
        : status === "pending" ? "pending" : undefined;
      if (!text.trim() || !state) return;
      items.push({ id: `${checklist.length}:${items.length}`, text, status: state });
    }
    // Tern otherwise folds completed phases. A manual fold takes precedence by phase ID.
    checklist.push({ id: String(checklist.length), title, collapsed: false, items });
  }
  return checklist;
}

type TurnRecord = { readonly id: string; readonly assistant: boolean; reply?: true };
type TurnGroup = { readonly records: readonly TurnRecord[]; collapsed: boolean };

/** History and live tool events share one identity per call, including its disclosure. */
export class Transcript {
  #seq = 0;
  #assistant = "";
  #blocks = new Map<number, string>();
  #tools = new Map<string, { readonly id: string; readonly name: string; args: RpcRecord; checklist: boolean }>();
  #folds = new Map<string, boolean>();
  #turn: TurnRecord[] | undefined;
  #groups = new Map<string, TurnGroup>();
  constructor(private readonly frame: (...ops: Op[]) => void,
    private readonly onTodo?: (phases: readonly ChecklistPhase[]) => void,
    private readonly authorIcon?: string) {}
  #seenTodo = new Set<string>();
  get populated() { return this.#seq !== 0; }

  startTurn() { this.#turn ??= []; }
  finishTurn() {
    const records = this.#turn;
    this.#turn = undefined;
    const first = records?.[0];
    if (!records || !first) return;
    const id = this.#summaryId(first.id);
    // Keep a trailing answer or error even when the engine omits completion metadata.
    if (records[records.length - 1]?.assistant) records.pop();
    const activity = records.filter(item => !item.reply);
    if (!activity.length) { this.frame(["del", id]); return; }
    const group = { records: activity, collapsed: true };
    this.#groups.set(id, group);
    this.#showGroup(id, group, true);
  }
  #summaryId(first: string) { return `activity-${first}`; }
  #record(id: string, assistant: boolean) {
    if (!this.#turn) return;
    if (!this.#turn.length) this.frame(add("main", node(this.#summaryId(id), "button", {
      hidden: true, variant: "quiet", actions: { click: "toggle-turn-activity" },
    })));
    this.#turn.push({ id, assistant });
  }
  toggleActivity(id: string) {
    const group = this.#groups.get(id);
    if (group) this.#showGroup(id, group, !group.collapsed);
  }
  #showGroup(id: string, group: TurnGroup, collapsed: boolean) {
    group.collapsed = collapsed;
    const label = `${collapsed ? "Show" : "Hide"} turn activity (${group.records.length})`;
    this.frame(["set", id, { hidden: false, text: `${collapsed ? "▸" : "▾"} ${label}`, aria: label }]);
    for (const item of group.records) {
      this.frame(["set", item.id, { hidden: collapsed }]);
      if (!collapsed && !item.assistant) this.#setToolFold(item.id, false);
    }
  }
  fold(id: string, collapsed: boolean) { if (this.#folds.has(id)) this.#folds.set(id, collapsed); }
  #setToolFold(id: string, collapsed: boolean) {
    this.#folds.set(id, collapsed);
    this.frame(["set", id, { collapsed }]);
  }
  flipTools() {
    const ungrouped = new Map(this.#folds);
    for (const group of this.#groups.values()) {
      for (const { id } of group.records) ungrouped.delete(id);
    }
    const collapse = [...this.#groups.values()].some(group => !group.collapsed)
      || [...ungrouped.values()].some(folded => !folded);
    for (const [id, group] of this.#groups) {
      if (group.collapsed !== collapse) this.#showGroup(id, group, collapse);
    }
    for (const id of ungrouped.keys()) this.#setToolFold(id, collapse);
  }
  #tool(call: string, name: string, input: { readonly args: RpcRecord; readonly status: string; readonly result?: RpcRecord | undefined }) {
    if (!call) return;
    const { status, result } = input;
    const tool = this.#tools.get(call);
    if (tool && status === "pending") return;
    const id = tool?.id ?? `t${++this.#seq}`;
    const kind = tool?.name || name;
    const args = { ...tool?.args, ...input.args };
    const collapsed = kind !== "mcp" && kind !== "todo";
    const bodyId = kind === "mcp" || kind === "todo" || kind === "eval" ? `${id}.scroll` : id;
    const phases = kind === "todo" && status === "done" ? todoPhases(result?.details) : undefined;
    if (phases && !this.#seenTodo.has(call)) {
      this.#seenTodo.add(call);
      this.onTodo?.(phases);
    }
    const raw = body(result?.content);
    const evaluation = kind === "eval" ? evalCard(id, args, { status, details: result?.details, output: raw }) : undefined;
    const output = evaluation?.body ?? (phases?.length
      ? node(id + ".todo", "checklist", { mode: "full", phases })
      : node(id + ".out", "code", { lang: "text", text: raw }));
    if (!tool) {
      this.#tools.set(call, { id, name, args, checklist: !!phases?.length });
      this.#folds.set(id, collapsed);
      this.#record(id, false);
      const target = plain(string(args.path) || string(args.command) || string(args.query));
      this.frame(add("main", node(id, "tool", {
        name: plain(name), title: plain(name) || "Tool", target, targetKind: args.path ? "path" : args.command ? "command" : "text",
        collapsible: true, collapsed, status, ...evaluation?.head,
      }, bodyId === id ? [output] : [node(bodyId, "scroll", { max: { h: "12lines" } }, [output])])));
    } else {
      tool.args = args;
      if (evaluation) {
        this.frame(["set", id, { status, ...evaluation.head }], ["del", output.id], add(bodyId, output));
        return;
      }
      this.frame(["set", id, { status }]);
      if (!result) return;
      if (tool.checklist !== !!phases?.length) {
        this.frame(["del", id + (tool.checklist ? ".todo" : ".out")], add(bodyId, output));
        tool.checklist = !!phases?.length;
      } else if (phases?.length) {
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
    if (assistant) { this.#assistant = id; this.#record(id, true); }
    const avatar = assistant && this.authorIcon ? node(id + ".author", "image", {
      blob: this.authorIcon, alt: "OMO", actions: { click: "ignore" },
    }) : undefined;
    this.frame(add("main", node(id, "message", {
      side: assistant ? "start" : "end", variant: "auto",
      ...(avatar ? { avatar: avatar.id } : { author: assistant ? "OMO" : "You" }),
    }, [...(avatar ? [avatar] : []), node(id + ".body", assistant ? "md" : "text", { text })])));
  }
  message(m: RpcRecord) {
    switch (m.role) {
      case "user": this.#text(body(m.content), false); break;
      case "assistant": {
        this.#text(body(m.content) || plain(string(m.errorMessage)), true);
        const calls = Array.isArray(m.content) ? m.content.map(record).filter(b => b.type === "toolCall") : [];
        for (const call of calls) {
          this.#tool(string(call.id), string(call.name), { args: record(call.arguments), status: "pending" });
        }
        // Queued requests can produce multiple completed replies before session settlement.
        const records = this.#turn;
        const item = records?.[records.length - 1];
        if (item && item.id === this.#assistant && m.stopReason === "stop" && !calls.length) item.reply = true;
        this.#assistant = ""; this.#blocks.clear(); break;
      }
      case "toolResult":
        this.#tool(string(m.toolCallId), string(m.toolName), { args: {}, status: m.isError ? "error" : "done", result: m }); break;
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
        this.#tool(string(e.toolCallId), string(e.toolName), {
          args: record(e.args),
          status: e.type === "tool_execution_end" ? (e.isError ? "error" : "done") : "running",
          result: result ? record(result) : undefined,
        });
        break;
      }
    }
  }
}
