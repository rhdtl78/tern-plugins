import { basename } from "node:path";
import { sessionPlanPath } from "./plan-link";
import { usageBody, workflowUsage } from "./workflow-usage";
import { RpcCommandError, type OmoRpc, type RpcRecord } from "./rpc";
import { add, node, record, string, type Op } from "./surface";
import type { ChecklistPhase } from "./transcript";
import type { ActivityView } from "./activity";
import { displayStatus, short, unfinished, workflowLayers, workflowSteps, type Step } from "./workflow-projection";
import { graph } from "./workflow-graph";
export { graph } from "./workflow-graph";

const sheet = "workflow";
export const workflowGraphMinWidth = 380;
type Run = { readonly id: string; readonly title: string; readonly status: string };
type Section = "usage" | "plan" | "dag" | "activity";
type Reader = Pick<OmoRpc, "request"> & Partial<Pick<OmoRpc, "sessionId">>;
const runtime = (s: Step) => s.runtimeMs === undefined ? "" :
  s.runtimeMs < 1000 ? `${s.runtimeMs}ms` : `${(s.runtimeMs / 1000).toFixed(1)}s`;

export function supportsWorkflow(hello: RpcRecord): boolean {
  const kinds = hello.kinds;
  return Array.isArray(kinds) && ["col", "row", "text", "button", "checklist", "card", "editor", "select"]
    .every(kind => kinds.includes(kind));
}

/** One instance per chat, with no shared cache or command transport. */
export class Workflow {
  #source: Reader | undefined;
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
  #expanded = { usage: true, plan: true, dag: true, activity: true };
  #usage: ReturnType<typeof workflowUsage>;
  #usageRevision = 0;
  #menuCursor = "";
  #dark = false;
  #summary = "";
  constructor(private readonly frame: (...ops: Op[]) => void) {}

  get open() { return this.#open; }

  bind(source: Reader, owner: string, cwd: string) {
    if (!owner || !cwd) return;
    if (this.#owner !== owner) this.#todo = [];
    this.#clearRun();
    this.#source = source;
    this.#owner = owner;
    this.#cwd = cwd;
    this.#status = "Loading workflow…";
    this.#resetPlan();
    if (this.#open) { this.#draw(); this.#invalidate(); void this.refreshUsage(); }
  }

  disconnect() {
    this.#source = undefined;
    this.#todo = [];
    this.#clearRun();
    this.#revision++;
    this.#resetPlan();
    this.#status = "Session disconnected";
    this.#draw();
  }

  #clearRun() {
    this.#usageRevision++;
    this.#usage = undefined;
    this.#menuCursor = "";
    this.#runs = []; this.#steps = [];
    this.#manualRun = this.#selected = this.#selectedStep = this.#summary = "";
    this.#background = undefined;
  }

  #background?: ActivityView;

  background(view: ActivityView) {
    const previous = this.#background, { rows, counts } = view;
    if (previous && counts.agent === previous.counts.agent && counts.bash === previous.counts.bash &&
        counts.monitor === previous.counts.monitor && rows.length === previous.rows.length && rows.every((row, index) => {
      const old = previous.rows[index];
      return row.id === old?.id && row.label === old.label && row.status === old.status && row.reference === old.reference;
    })) return;
    this.#background = view;
    if (this.#open) this.#draw();
  }

  #bar(section: Section, label: string, count = "", hidden = false) {
    const open = this.#expanded[section];
    return node(`workflow-${section}-bar`, "row", { role: "workflow-bar", gap: "sm", hidden }, [
      node(`workflow-${section}`, "button", { text: `${open ? "▾" : "▸"}  ${label}`, aria: `${open ? "Collapse" : "Expand"} ${label}`,
        role: "workflow-fold", variant: "quiet", on: open, actions: { click: "fold" } }),
      node(`workflow-${section}-count`, "text", { text: count, hidden: !count }),
      ...(section === "dag" ? [node("workflow-run-picker", "select", { aria: "Workflow run", variant: "quiet", hidden: true })] : []),
    ]);
  }

  theme(dark: boolean) {
    if (dark !== this.#dark) { this.#dark = dark; this.#draw(); }
  }

  todo(phases: readonly ChecklistPhase[]) {
    this.#todo = phases;
    this.#draw();
  }

  event(event: RpcRecord) {
    if (!this.#source || !this.#open || event.type !== "extension_event" || event.name !== "omo.dag.updated" ||
        record(event.data).parent_session_id !== this.#owner) return;
    this.#invalidate();
  }

  toggle() {
    this.#usageRevision++;
    this.#menuCursor = "";
    this.#open = !this.#open;
    this.#revision++;
    this.#resetPlan();
    if (this.#open) {
      const children = this.#children();
      for (const child of children) {
        if (child.id === "workflow-agents-body" || child.id === "workflow-jobs-body")
          this.#rowCounts.set(child.id, child.c.length);
      }
      this.frame(add("main", node(sheet, "col", { gap: "sm" }, children)),
        ...this.#controls(), this.#graph());
      this.#dagLayout = this.#layout();
      if (this.#source) { this.#invalidate(); void this.refreshUsage(); }
    } else this.frame(["del", sheet]);
  }

  action(event: RpcRecord): "close" | undefined {
    if (!this.#open) return;
    if (event.act === "close" && event.value === undefined) return "close";
    if (event.act === "fold") {
      for (const section of ["usage", "plan", "dag", "activity"] as const) {
        if (event.id !== `workflow-${section}`) continue;
        this.#expanded[section] = !this.#expanded[section];
        if (section === "dag") this.#menuCursor = "";
        if (section === "plan" && this.#expanded.plan) void this.refreshPlan();
        this.#draw();
      }
    }
    if (event.act === "select-run" && this.#source && this.#expanded.dag) {
      if (event.id === "workflow-run-picker" && typeof event.open === "boolean") {
        this.#menuCursor = event.open && this.#runs.length > 1 ? this.#selected : "";
        this.frame(...this.#controls());
        return;
      }
      const run = this.#runs.find(r => `workflow-run-${r.id}` === event.id || r.id === event.value);
      if (!run) return;
      this.#menuCursor = "";
      this.#manualRun = run.id;
      if (run.id !== this.#selected) {
        this.#selected = run.id;
        this.#selectedStep = "";
        this.#steps = [];
        this.#summary = "";
        this.#draw();
        this.#invalidate();
      } else this.frame(...this.#controls());
    }
    if (event.act === "dismiss-step" && this.#expanded.dag) {
      this.#selectedStep = "";
      this.#draw();
    }
    if (event.act === "select-step" && this.#expanded.dag) {
      const step = this.#steps.find((_, index) => event.id === `workflow-step-${index}` || event.id === `workflow-card-${index}` ||
        event.id === `workflow-neighbor-${index}`);
      if (step) {
        this.#selectedStep = step.id === this.#selectedStep && event.id === `workflow-card-${this.#steps.indexOf(step)}` ? "" : step.id;
        this.#draw();
      }
    }
  }

  key(key: string) {
    if (this.#expanded.dag && this.#runs.length > 1) {
      const enter = key === "\r" || key === "\x1b[13u";
      const dir = key === "\x1b[A" ? -1 : key === "\x1b[B" ? 1 : 0;
      if (this.#menuCursor && enter) {
        this.action({ act: "select-run", value: this.#menuCursor });
        return;
      }
      if (dir || enter || key === " ") {
        const at = this.#runs.findIndex(run => run.id === (this.#menuCursor || this.#selected));
        this.#menuCursor = this.#runs[Math.max(0, Math.min(this.#runs.length - 1, at + dir))]?.id || "";
        this.frame(...this.#controls());
        return;
      }
    }
    if (this.#expanded.dag && (key === "\x1b[D" || key === "\x1b[C")) {
      const current = this.#steps.findIndex(s => s.id === this.#selectedStep);
      const next = current < 0 ? 0 : Math.max(0, Math.min(this.#steps.length - 1, current + (key === "\x1b[C" ? 1 : -1)));
      this.action({ id: `workflow-step-${next}`, act: "select-step" });
    }
  }

  #controls(): Op[] {
    return [["set", "workflow-run-picker", { value: this.#selected, open: !!this.#menuCursor, active: this.#menuCursor || this.#selected,
        hidden: !this.#expanded.dag || this.#runs.length < 2,
        options: this.#runs.map(run => ({ value: run.id, label: run.title, detail: displayStatus(run.status) })) }]];
  }

  #resetPlan() {
    this.#planRevision++;
    this.#planPath = undefined;
    void this.refreshPlan();
  }

  async refreshUsage() {
    const source = this.#source, route = source?.sessionId;
    if (!this.#open || !source || !route) return;
    const revision = ++this.#usageRevision;
    let usage: ReturnType<typeof workflowUsage>;
    try {
      const reply = await source.request("get_session_stats");
      const stats = record(reply.data);
      if (reply.sessionId === route && stats.sessionId === this.#owner) usage = workflowUsage(stats);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // Optional on older runtimes. A missing reading must not look like zero usage.
    }
    if (!this.#open || revision !== this.#usageRevision || source !== this.#source) return;
    if (JSON.stringify(usage) !== JSON.stringify(this.#usage)) { this.#usage = usage; this.#draw(); }
  }

  async refreshPlan(open?: (path: string) => void) {
    if (!this.#open || !this.#expanded.plan || !this.#source) return;
    const revision = ++this.#planRevision;
    const displayed = this.#planPath;
    const path = await sessionPlanPath(this.#cwd, this.#owner);
    if (revision !== this.#planRevision || !this.#expanded.plan) return;
    if (path !== displayed) {
      this.#planPath = path;
      this.#draw();
    } else if (path) open?.(path);
  }

  #children() {
    const title = this.#runs.find(r => r.id === this.#selected)?.title;
    const selected = this.#steps.find(s => s.id === this.#selectedStep);
    const timed = this.#steps.flatMap(s => s.runtimeMs === undefined ? [] : [s.runtimeMs]);
    const ms = timed.reduce((sum, n) => sum + n, 0);
    const seconds = Math.floor(ms / 1000);
    const duration = ms < 1000 ? `${ms}ms` : seconds < 60 ? `${(ms / 1000).toFixed(1)}s`
      : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const listItem = (index: number) => {
      const step = this.#steps[index];
      return node(`workflow-step-${index}`, "button", {
        text: [step.label, step.status, step.route?.name, runtime(step),
          step.needs.length && `depends on ${this.#predecessors(step)}`].filter(Boolean).join(" · "),
        on: step.id === this.#selectedStep, role: "workflow-step", variant: "quiet", actions: { click: "select-step" },
      });
    };
    const layers = workflowLayers(this.#steps);
    const counts = this.#background?.counts;
    const hasActivity = !!counts && (counts.agent > 0 || counts.bash > 0 || counts.monitor > 0);
    const activity = (section: "agents" | "jobs") => {
      const rows = this.#background?.rows.filter(r => (r.kind === "agent") === (section === "agents")) ?? [];
      const count = !counts ? 0 : section === "agents" ? counts.agent : counts.bash + counts.monitor;
      return node(`workflow-${section}-body`, "col", {
        hidden: !count || !this.#expanded.activity, role: "workflow-activity-group",
      }, [
        node(`workflow-${section}-header`, "row", { role: "workflow-activity-header" }, [
          node(`workflow-${section}-heading`, "text", { text: section === "agents" ? "Agents" : "Jobs", role: "workflow-subheading" }),
          node(`workflow-${section}-count`, "text", { text: String(count), role: "workflow-activity-meta" }),
        ]),
        ...rows.map((row, i) => {
          const id = `workflow-${section}-${i}`;
          return node(id, "row", { role: "workflow-activity-row" }, [
            node(id + "-name", "text", { text: row.label, role: "workflow-activity-name" }),
            node(id + "-status", "text", { text: row.status, role: "workflow-activity-status" }),
            node(id + "-ref", "text", { text: row.reference ?? "", hidden: !row.reference, role: "workflow-activity-ref" }),
          ]);
        }),
      ]);
    };
    return [this.#bar("usage", "Usage", "", !this.#usage),
      usageBody(this.#usage, this.#expanded.usage),
      this.#bar("plan", "Plan"),
      node("workflow-plan-body", "col", { gap: "sm", hidden: !this.#expanded.plan }, [
        node("workflow-file", "button", { text: this.#planPath ? `Open ${basename(this.#planPath)}` : "",
          hidden: !this.#planPath, actions: { click: "open-file" } }),
        node("workflow-todo", "checklist", { mode: "full", phases: this.#todo, hidden: !this.#todo.length }),
        node("workflow-no-todo", "text", { hidden: !!this.#todo.length || !!this.#planPath, text: "No current plan or Todo." }),
      ]),
      this.#bar("dag", "DAG", this.#steps.length ? `${this.#steps.filter(s => s.status === "completed").length}/${this.#steps.length}` : ""),
      node("workflow-content", "col", { gap: "sm", hidden: !this.#expanded.dag }, [
      node("workflow-heading", "text", { text: title || "", hidden: !title || this.#runs.length > 1 }),
      node("workflow-status", "text", { text: this.#status, hidden: !this.#status }),
      node("workflow-summary", "text", { text: this.#summary, hidden: !this.#summary }),
      node("workflow-time", "text", { text: timed.length ? `Node time  ${duration} · ${timed.length}/${this.#steps.length} timed` : "", hidden: !timed.length }),
      node("workflow-layout", "row", {}, [node("workflow-graph-anchor", "col"),
        node("workflow-fallback", "col", { gap: "sm" }, layers ? layers.flatMap((indices, i) => [
          node(`workflow-layer-${i}`, "text", { text: `Layer ${i + 1}` }), ...indices.map(listItem),
        ]) : this.#steps.map((_, i) => listItem(i)))]),
      node("workflow-dependencies", "col", { gap: "sm", hidden: !this.#steps.some(s => s.needs.length) }, [
      node("workflow-deps-heading", "text", { text: "Dependencies", role: "workflow-subheading" }),
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
      this.#bar("activity", "Background Activity"),
      node("workflow-activity-empty", "text", { hidden: hasActivity || !this.#expanded.activity, text: "No background activity reported." }),
      activity("agents"), activity("jobs")];
  }

  #draw() {
    if (!this.#open) return;
    const layout = this.#layout();
    const children = this.#children();
    const update = (n: ReturnType<typeof node>): Op[] => n.id === "workflow-run-picker" ? []
      : [["set", n.id, n.p], ...n.c.flatMap(update)];
    const ops = children.flatMap((child, i): Op[] => {
      if (child.id === "workflow-content" && layout !== this.#dagLayout ||
          (child.id === "workflow-agents-body" || child.id === "workflow-jobs-body") &&
          this.#rowCounts.get(child.id) !== child.c.length) {
        this.#rowCounts.set(child.id, child.c.length);
        return [["del", child.id], ["add", child.id, sheet, children[i+1]?.id ?? null, child]];
      }
      return update(child);
    });
    this.frame(...ops, ...this.#controls(), this.#graph());
    this.#dagLayout = layout;
  }

  #layout() {
    return JSON.stringify([this.#selected, this.#steps.map(s => [s.id, s.needs])]);
  }
  #rowCounts = new Map<string, number>();

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
  #graph(): Op { return ["graph", graph(this.#steps, this.#dark, this.#selectedStep)]; }

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
      if (own.length < 2 || !own.some(run => run.id === this.#menuCursor)) this.#menuCursor = "";
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
      this.#menuCursor = "";
      this.#draw();
    } finally {
      this.#reading = false;
      if (revision !== this.#revision && this.#source && this.#open) void this.#read();
    }
  }
}
