import { basename } from "node:path";
import { sessionPlanPath } from "./plan-link";
import { RpcCommandError, type OmoRpc, type RpcRecord } from "./rpc";
import { add, node, record, string, type Op } from "./surface";
import type { ChecklistPhase } from "./transcript";
import { displayStatus, short, unfinished, workflowSteps, type Step } from "./workflow-projection";

const sheet = "workflow";
type Run = { readonly id: string; readonly title: string; readonly status: string };

export function graph(steps: readonly Step[], dark: boolean): string | undefined {
  if (!steps.length || steps.length > 12 || steps.reduce((n, s) => n + s.needs.length, 0) > 24) return;
  const levels = new Map<string, number>();
  for (let i = 0; i < steps.length; i++) {
    for (const step of steps) {
      if (!levels.has(step.id) && step.needs.every(id => levels.has(id))) {
        levels.set(step.id, Math.max(0, ...step.needs.map(id => (levels.get(id) ?? 0) + 1)));
      }
    }
  }
  if (levels.size !== steps.length) return;
  const rows = new Map<number, Step[]>();
  for (const step of steps) {
    const depth = levels.get(step.id) ?? 0;
    const row = rows.get(depth) ?? [];
    row.push(step);
    rows.set(depth, row);
  }
  const routeCount = steps.reduce((n, s) => n + s.needs.filter(id =>
    (levels.get(s.id) ?? 0) - (levels.get(id) ?? 0) > 1).length, 0);
  if (rows.size > 7 || routeCount > 5 || [...rows.values()].some(row => row.length > 3)) return;
  const width = 480, cardHeight = 58, stride = 106, gutter = 30 + routeCount * 5;
  const height = 22 + (rows.size - 1) * stride + cardHeight;
  const points = new Map<string, readonly [number, number, number]>();
  for (const [depth, row] of rows) {
    const available = width - gutter * 2, slot = available / row.length;
    row.forEach((step, i) => points.set(step.id, [gutter + (i + 0.5) * slot, 11 + depth * stride, Math.min(235, slot - 10)]));
  }
  const ink = dark ? "#e9e4eb" : "#241f29";
  const edge = dark ? "#9c93a2" : "#65596d";
  const card = dark ? "#27232c" : "#fbf9fc";
  const outline = dark ? "#514858" : "#cfc4d5";
  const success = dark ? "#8ad7ae" : "#286647";
  const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  let outer = 0;
  const edges = steps.flatMap(step => step.needs.map(id => {
    const target = points.get(step.id);
    const source = points.get(id);
    if (!target || !source) return "";
    const [x, y] = target, [sx, top] = source, sy = top + cardHeight, mid = sy + 24;
    const skip = y - top > stride;
    const rail = 10 + outer * 5;
    if (skip) outer++;
    const path = skip
      ? `M${sx} ${sy} V${sy + 12} H${rail} V${y - 15} H${x} V${y - 1}`
      : `M${sx} ${sy} V${mid} H${x} V${y - 1}`;
    return `<path d="${path}" fill="none" stroke="${edge}" stroke-width="1.6" stroke-linejoin="round"/><path d="M${x - 4} ${y - 7} L${x} ${y - 1} L${x + 4} ${y - 7}Z" fill="${edge}"/>`;
  })).join("");
  const cards = steps.map(step => {
    const point = points.get(step.id);
    if (!point) return "";
    const [x, y, wide] = point, left = x - wide / 2;
    const label = [...step.label], limit = Math.floor((wide - 24) / 7);
    const title = escape(label.length > limit ? label.slice(0, limit - 1).join("") + "…" : label.join(""));
    const state = escape([...step.status].slice(0, 25).join(""));
    const accent = step.status === "completed" ? success : edge;
    return `<rect x="${left}" y="${y}" width="${wide}" height="${cardHeight}" rx="9" fill="${card}" stroke="${outline}"/><path d="M${left + 2} ${y + 12} V${y + 46}" stroke="${accent}" stroke-width="3"/><text x="${left + 13}" y="${y + 23}" fill="${ink}" font-size="13">${title}</text><text x="${left + 13}" y="${y + 43}" fill="${accent}" font-size="11">${state}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${edges}${cards}</svg>`;
}

export function supportsWorkflow(hello: RpcRecord): boolean {
  const kinds = hello.kinds;
  return Array.isArray(kinds) && ["col", "row", "text", "button", "checklist", "card", "editor"]
    .every(kind => kinds.includes(kind));
}

/** One instance per chat, with no shared cache or command transport. */
export class Workflow {
  #source: Pick<OmoRpc, "request"> | undefined;
  #owner = "";
  #cwd = "";
  #open = false;
  #revision = 0;
  #reading = false;
  #runs: readonly Run[] = [];
  #steps: readonly Step[] = [];
  #selected = "";
  #manualRun = "";
  #selectedStep = "";
  #dagLayout = "";
  #status = "Connecting…";
  #todo: readonly ChecklistPhase[] = [];
  #planPath: string | undefined;
  #planRevision = 0;
  #page = "dag";
  #keyRow = 0;
  #wide = true;
  #dark = false;
  #summary = "";
  constructor(private readonly frame: (...ops: Op[]) => void) {}

  get open() { return this.#open; }

  bind(source: Pick<OmoRpc, "request">, owner: string, cwd: string) {
    if (!owner || !cwd) return;
    this.#source = source;
    this.#owner = owner;
    this.#cwd = cwd;
    this.#status = "Loading workflow…";
    this.#resetPlan();
    if (this.#open) this.#invalidate();
  }

  disconnect() {
    this.#source = undefined;
    this.#revision++;
    this.#resetPlan();
    this.#status = "Session disconnected";
    this.#draw();
  }

  width(pixels: number) {
    // Below this width the graph's labels are less readable than the native rows.
    const wide = pixels >= 420;
    if (wide !== this.#wide) { this.#wide = wide; this.#draw(); }
  }
  theme(dark: boolean) {
    if (dark !== this.#dark) { this.#dark = dark; this.#draw(); }
  }

  todo(phases: readonly ChecklistPhase[]) {
    this.#todo = phases;
    if (this.#page === "plan") this.#draw();
  }

  event(event: RpcRecord) {
    if (!this.#source || !this.#open || event.type !== "extension_event" || event.name !== "omo.dag.updated" ||
        record(event.data).parent_session_id !== this.#owner) return;
    this.#invalidate();
  }

  toggle() {
    this.#open = !this.#open;
    this.#revision++;
    this.#resetPlan();
    if (this.#open) {
      this.frame(add("main", node(sheet, "col", { gap: "sm" }, this.#children())), this.#graph());
      this.#dagLayout = this.#layout();
      if (this.#source) this.#invalidate();
    } else this.frame(["del", sheet]);
  }

  action(event: RpcRecord): "close" | undefined {
    if (!this.#open) return;
    if (event.act === "close" && event.value === undefined) return "close";
    if (event.act === "page" && (event.value === "dag" || event.value === "plan")) {
      this.#page = event.value;
      this.#resetPlan();
      this.#keyRow = 0;
      this.#draw();
    }
    if (event.act === "select-run" && this.#source) {
      const run = this.#runs.find(r => `workflow-run-${r.id}` === event.id || r.id === event.value);
      if (!run) return;
      this.#manualRun = run.id;
      if (run.id !== this.#selected) {
        this.#selected = run.id;
        this.#selectedStep = "";
        this.#steps = [];
        this.#summary = "";
        this.#draw();
        this.#invalidate();
      }
    }
    if (event.act === "select-step" && this.#page === "dag") {
      const step = this.#steps.find((_, index) => event.id === `workflow-step-${index}`);
      if (step && step.id !== this.#selectedStep) {
        this.#selectedStep = step.id;
        this.#draw();
      }
    }
  }

  key(key: string) {
    if (key === "\t" || key === "\x1b[9u" || key === "\x1b[Z") {
      this.action({ id: sheet, act: "page", value: this.#page === "dag" ? "plan" : "dag" });
    } else if (this.#page === "dag" && (key === "\x1b[D" || key === "\x1b[C")) {
      const current = this.#steps.findIndex(s => s.id === this.#selectedStep);
      const next = current < 0 ? 0 : Math.max(0, Math.min(this.#steps.length - 1, current + (key === "\x1b[C" ? 1 : -1)));
      this.action({ id: `workflow-step-${next}`, act: "select-step" });
    } else if (this.#page === "dag" && (key === "\x1b[A" || key === "\x1b[B")) {
      this.#keyRow = Math.max(0, Math.min(this.#runs.length - 1, this.#keyRow + (key === "\x1b[B" ? 1 : -1)));
      this.#draw();
    } else if (key === "\r" || key === "\x1b[13u") {
      const run = this.#page === "dag" ? this.#runs[this.#keyRow] : undefined;
      if (run) this.action({ id: sheet, act: "select-run", value: run.id });
    }
  }

  #resetPlan() {
    this.#planRevision++;
    this.#planPath = undefined;
    void this.refreshPlan();
  }

  async refreshPlan(open?: (path: string) => void) {
    if (!this.#open || this.#page !== "plan" || !this.#source) return;
    const revision = ++this.#planRevision;
    const displayed = this.#planPath;
    const path = await sessionPlanPath(this.#cwd, this.#owner);
    if (revision !== this.#planRevision) return;
    if (path !== displayed) {
      this.#planPath = path;
      this.#draw();
    } else if (path) open?.(path);
  }

  #children() {
    const title = this.#page === "plan" ? "Plan" : "DAG";
    const status = this.#page === "plan" && this.#source ? "Current session Todo" : this.#status;
    return [node("workflow-content", "col", { gap: "sm" }, [
      node("workflow-heading", "text", { spans: [{ t: title, s: "strong" }] }),
      node("workflow-status", "text", { text: status, hidden: !status }),
      ...(this.#page === "dag" ? [node("workflow-summary", "text", { text: this.#summary, hidden: !this.#summary })] : []),
      ...(this.#page === "plan" ? [
      ...(this.#planPath ? [node("workflow-file", "button", { text: `Open ${basename(this.#planPath)}`, actions: { click: "open-file" } })] : []),
      this.#todo.length ? node("workflow-todo", "checklist", { mode: "full", phases: this.#todo })
        : node("workflow-no-todo", "text", { text: "No current Todo." }),
    ] : [...this.#runs.map((run, index) => node(`workflow-run-${run.id}`, "button", {
      text: `${run.id === this.#selected ? "Selected: " : ""}${run.title}`,
      variant: index === this.#keyRow ? "primary" : "quiet", actions: { click: "select-run" },
    })), node("workflow-graph-anchor", "col"), ...(this.#steps.length ? [
      node("workflow-node-keys", "text", { text: "Inspect a node: ← / →" }),
    ] : []), ...this.#steps.map((step, index) => node(`workflow-step-${index}`, "button", {
      text: `${step.id === this.#selectedStep ? "Selected: " : ""}${step.label} · ${step.status}${step.needs.length ? ` · depends on ${this.#predecessors(step)}` : ""}`,
      variant: step.id === this.#selectedStep ? "primary" : "quiet", actions: { click: "select-step" },
    })), node("workflow-node-detail", "text", { text: this.#detail(), hidden: !this.#selectedStep })]),
    ])];
  }

  #draw() {
    if (!this.#open) return;
    const layout = this.#layout();
    const children = this.#children();
    // Keep the live controls mounted through a status-only snapshot update.
    if (layout && layout === this.#dagLayout) {
      this.frame(...children.flatMap(n => n.c.filter(c => c.k !== "col")
        .map((c): Op => ["set", c.id, c.p])), this.#graph());
    } else {
      this.frame(["del", "workflow-content"], ...children.map(child => add(sheet, child)), this.#graph());
    }
    this.#dagLayout = layout;
  }

  #layout() {
    return this.#page === "dag" ? JSON.stringify([this.#selected, this.#runs.map(r => r.id), this.#steps.map(s => s.id)]) : "";
  }

  #predecessors(step: Step) {
    const label = (id: string) => this.#steps.find(s => s.id === id)?.label || short(id);
    return step.needs.slice(0, 6).map(label).join(", ") + (step.needs.length > 6 ? " …" : "");
  }

  #detail() {
    const step = this.#steps.find(s => s.id === this.#selectedStep);
    if (!step) return "";
    return `${step.label} · ${step.status}\nPredecessors: ${this.#predecessors(step) || "None"}${step.reason ? `\nReason: ${step.reason}` : ""}`;
  }
  #graph(): Op { return ["graph", this.#wide && this.#page === "dag" ? graph(this.#steps, this.#dark) : null]; }

  #invalidate() {
    this.#revision++;
    if (!this.#reading) void this.#read();
  }

  async #read() {
    const source = this.#source;
    if (!source || !this.#open) return;
    this.#reading = true;
    const revision = this.#revision;
    const current = () => this.#source === source && this.#open && revision === this.#revision;
    const read = async (name: string, data: RpcRecord) => {
      const reply = record((await source.request("extension_request", { name, data })).data);
      if (reply.ok !== true) throw new Error("OmO refused workflow read");
      return record(reply.value);
    };
    try {
      const { runs } = await read("omo.dag.list", { limit: 50 });
      if (!current()) return;
      if (!Array.isArray(runs)) throw new Error("Invalid OmO run list");
      const own = runs.map(record).filter(r => r.parentSessionId === this.#owner && string(r.runId))
        .map(r => ({ id: string(r.runId), title: short(string(r.name) || string(r.runId)), status: string(r.status) }));
      const selected = own.find(r => r.id === this.#manualRun) ??
        own.find(r => r.id === this.#selected && unfinished(r.status)) ??
        own.find(r => unfinished(r.status)) ?? own[0];
      let steps: readonly Step[] = [];
      let summary = "";
      if (selected) {
        const snap = await read("omo.dag.snapshot", { runId: selected.id });
        if (!current()) return;
        if (snap.parentSessionId !== this.#owner || snap.runId !== selected.id || !Array.isArray(snap.nodes)) {
          throw new Error("Invalid OmO snapshot owner");
        }
        steps = workflowSteps(snap.nodes);
        summary = `${selected.title} · ${displayStatus(string(snap.status))} · ${steps.filter(s => s.status === "completed").length}/${steps.length} completed`;
        for (const status of ["failed", "blocked"]) {
          const count = steps.filter(s => s.status === status).length;
          if (count) summary += ` · ${count} ${status}`;
        }
      }
      this.#runs = own;
      if (this.#selected !== selected?.id || !steps.some(s => s.id === this.#selectedStep)) this.#selectedStep = "";
      this.#selected = selected?.id ?? "";
      this.#steps = steps;
      this.#summary = summary;
      this.#status = own.length ? "" : "No workflow runs.";
      this.#draw();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (!current()) return;
      this.#status = error instanceof RpcCommandError && error.command === "extension_request" &&
        error.response.error === "Unknown extension RPC request: omo.dag.list"
        ? "This OmO version does not support workflow runs." : "Workflow data unavailable";
      this.#steps = [];
      this.#selectedStep = "";
      this.#summary = "";
      this.#runs = [];
      this.#draw();
    } finally {
      this.#reading = false;
      if (revision !== this.#revision && this.#source && this.#open) void this.#read();
    }
  }
}
