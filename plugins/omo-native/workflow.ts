import { basename } from "node:path";
import { sessionPlanPath } from "./plan-link";
import { RpcCommandError, type OmoRpc, type RpcRecord } from "./rpc";
import { add, node, record, string, type Op } from "./surface";
import type { ChecklistPhase } from "./transcript";
import { displayStatus, short, unfinished, workflowSteps, type Step } from "./workflow-projection";

const sheet = "workflow";
export const workflowGraphMinWidth = 380;
type Run = { readonly id: string; readonly title: string; readonly status: string };
const runtime = (s: Step) => s.runtimeMs === undefined ? "" :
  s.runtimeMs < 1000 ? `${s.runtimeMs}ms` : `${(s.runtimeMs / 1000).toFixed(1)}s`;

export function graph(steps: readonly Step[], dark: boolean, selected = "") {
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
  const width = 480, cardHeight = 78, stride = cardHeight + 32, gutter = 30 + routeCount * 5;
  const height = 22 + (rows.size - 1) * stride + cardHeight;
  const points = new Map<string, readonly [number, number, number]>();
  for (const [depth, row] of rows) {
    const available = width - gutter * 2, slot = available / row.length;
    row.forEach((step, i) => points.set(step.id, [gutter + (i + 0.5) * slot, 11 + depth * stride, Math.min(235, slot - 10)]));
  }
  const edge = dark ? "#9c93a2" : "#65596d";
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
  const cards = steps.flatMap((step, i) => {
    const point = points.get(step.id);
    if (!point) return [];
    const [x, y, wide] = point;
    const id = `workflow-card-${i}`;
    const state = [step.status, runtime(step)].filter(Boolean).join(" · ");
    const route = step.route?.name || "";
    return [{ id, left: x - wide / 2, top: y, width: wide, height: cardHeight,
      label: step.label, route, state, status: step.status,
      props: { aria: [step.label, route, state].filter(Boolean).join(", "), role: "workflow-card", variant: "quiet",
        on: step.id === selected, actions: { click: "select-step" } } }];
  });
  return { width, height, cards, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${edges}</svg>` };
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
  #dark = false;
  #summary = "";
  constructor(private readonly frame: (...ops: Op[]) => void) {}

  get open() { return this.#open; }

  bind(source: Pick<OmoRpc, "request">, owner: string, cwd: string) {
    if (!owner || !cwd) return;
    this.#clearRun();
    this.#source = source;
    this.#owner = owner;
    this.#cwd = cwd;
    this.#status = "Loading workflow…";
    this.#resetPlan();
    if (this.#open) this.#invalidate();
  }

  disconnect() {
    this.#source = undefined;
    this.#clearRun();
    this.#revision++;
    this.#resetPlan();
    this.#status = "Session disconnected";
    this.#draw();
  }

  #clearRun() {
    this.#runs = []; this.#steps = [];
    this.#manualRun = this.#selected = this.#selectedStep = this.#summary = "";
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
    if (event.act === "dismiss-step" && this.#page === "dag") {
      this.#selectedStep = "";
      this.#draw();
    }
    if (event.act === "select-step" && this.#page === "dag") {
      const step = this.#steps.find((_, index) => event.id === `workflow-step-${index}` || event.id === `workflow-card-${index}` ||
        event.id === `workflow-neighbor-${index}`);
      if (step) {
        this.#selectedStep = step.id === this.#selectedStep && event.id === `workflow-card-${this.#steps.indexOf(step)}` ? "" : step.id;
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
    const title = this.#page === "plan" ? "Plan" : this.#runs.find(r => r.id === this.#selected)?.title || "DAG";
    const selected = this.#steps.find(s => s.id === this.#selectedStep);
    const status = this.#page === "plan" && this.#source ? "Current session Todo" : this.#status;
    return [node("workflow-content", "col", { gap: "sm" }, [
      node("workflow-heading", "text", { spans: [{ t: title, s: "strong" }] }),
      node("workflow-status", "text", { text: status, hidden: !status }),
      ...(this.#page === "dag" ? [node("workflow-summary", "text", { text: this.#summary, hidden: !this.#summary })] : []),
      ...(this.#page === "plan" ? [
      ...(this.#planPath ? [node("workflow-file", "button", { text: `Open ${basename(this.#planPath)}`, actions: { click: "open-file" } })] : []),
      this.#todo.length ? node("workflow-todo", "checklist", { mode: "full", phases: this.#todo })
        : node("workflow-no-todo", "text", { text: "No current Todo." }),
    ] : [...(this.#runs.length > 1 ? this.#runs : []).map((run, index) => node(`workflow-run-${run.id}`, "button", {
      text: run.title, on: run.id === this.#selected, variant: "quiet",
      role: index === this.#keyRow ? "workflow-run-focus" : "workflow-run", actions: { click: "select-run" },
    })), node("workflow-layout", "row", {}, [node("workflow-graph-anchor", "col"),
    node("workflow-fallback", "col", { gap: "sm" }, this.#steps.map((step, index) => node(`workflow-step-${index}`, "button", {
      text: `${step.label} · ${step.status}${step.needs.length ? ` · depends on ${this.#predecessors(step)}` : ""}`,
      on: step.id === this.#selectedStep, role: "workflow-step", variant: "quiet", actions: { click: "select-step" },
    })))]), node("workflow-dependencies", "col", { gap: "sm", hidden: !this.#steps.some(s => s.needs.length) }, [
      node("workflow-deps-heading", "text", { text: "Dependencies" }),
      ...this.#steps.flatMap((step, i) => step.needs.length ? [
        node(`workflow-dep-${i}`, "col", {}, [
          node(`workflow-dep-title-${i}`, "text", { text: `${step.label} · ${step.status}` }),
          node(`workflow-upstream-${i}`, "text", { text: this.#predecessors(step) }),
        ]),
      ] : []),
    ]), node("workflow-inspector", "col", { hidden: !selected, gap: "sm" }, [
      node("workflow-detail-bar", "row", { gap: "sm" }, [
        node("workflow-detail-heading", "text", { text: "Node details" }),
        node("workflow-detail-close", "button", { text: "×", aria: "Close node details", variant: "quiet", actions: { click: "dismiss-step" } }),
      ]),
      node("workflow-node-detail", "text", { text: this.#detail(), hidden: !selected }),
      ...this.#neighbors(),
      node("workflow-result", "text", { text: selected?.result || "", hidden: !selected?.result }),
    ])]),
    ])];
  }

  #draw() {
    if (!this.#open) return;
    const layout = this.#layout();
    const children = this.#children();
    // Keep the live controls mounted through a status-only snapshot update.
    if (layout && layout === this.#dagLayout) {
      const update = (n: ReturnType<typeof node>): Op[] => [["set", n.id, n.p], ...n.c.flatMap(update)];
      this.frame(...children.flatMap(update), this.#graph());
    } else {
      this.frame(["del", "workflow-content"], ...children.map(child => add(sheet, child)), this.#graph());
    }
    this.#dagLayout = layout;
  }

  #layout() {
    return this.#page === "dag" ? JSON.stringify([this.#selected, this.#runs.map(r => r.id), this.#steps.map(s => [s.id, !!s.needs.length])]) : "";
  }

  #predecessors(step: Step) {
    const label = (id: string) => this.#steps.find(s => s.id === id)?.label || short(id);
    return step.needs.slice(0, 6).map(label).join(", ") + (step.needs.length > 6 ? " …" : "");
  }

  #detail() {
    const step = this.#steps.find(s => s.id === this.#selectedStep);
    if (!step) return "";
    const r = step.route;
    return [`${step.label} · ${step.status}`,
      [runtime(step) && `Runtime: ${runtime(step)}`, step.attempt !== undefined && `Attempts: ${step.attempt}`].filter(Boolean).join(" · "),
      r && `${r.kind === "agent" ? "Agent" : "Category"}: ${r.name}`, r?.model && `Configured model: ${r.model}`,
      step.reason && `Reason: ${step.reason}`].filter(Boolean).join("\n");
  }
  #neighbors() {
    const selected = this.#steps.find(s => s.id === this.#selectedStep);
    const needs = new Set(selected?.needs);
    // Stable targets keep the same native controls across selection and status updates.
    return this.#steps.map((step, i) => {
      const relation = needs.has(step.id) ? "Predecessor" : selected && step.needs.includes(selected.id) ? "Successor" : "";
      return node(`workflow-neighbor-${i}`, "button", { text: relation ? `${relation}: ${step.label}` : "",
        hidden: !relation, role: "workflow-neighbor", variant: "quiet", actions: { click: "select-step" } });
    });
  }
  #graph(): Op { return ["graph", this.#page === "dag" ? graph(this.#steps, this.#dark, this.#selectedStep) : null]; }

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
        summary = `${displayStatus(string(snap.status))} · ${steps.filter(s => s.status === "completed").length}/${steps.length} completed`;
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
