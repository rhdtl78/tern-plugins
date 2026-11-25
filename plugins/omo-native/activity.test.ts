import { expect, test } from "bun:test";
import { ActivityProjection } from "./activity";
import { Workflow } from "./workflow";
import { record, type Op } from "./surface";

const route = "rpc-1", durable = "owning-session-uuid";
const agent = {
  task_id: "st_01a20c83", status: "running", residency_state: "resident", execution_mode: "process",
  description: "raw task prompt", task_summary: "Review workspace changes", name: "Workspace reviewer",
  final_response: "raw task output",
};
const snapshot = (tasks: unknown[], owner = durable) => ({ parent_session_id: owner, tasks });
const extension = (name: string, data: unknown, sessionId = route) => ({ type: "extension_event", sessionId, name, data });
const update = (tasks: unknown[], owner = durable) => extension("omo.task.updated", snapshot(tasks, owner));
const pulled = (value: unknown) => ({
  type: "response", command: "extension_request", sessionId: route, success: true, data: value,
});
const bash = { source: "terminal-background-sessions", activeCount: 1, items: [{ id: "bash_1", label: "raw command" }] };
const monitor = { source: "terminal-monitors", activeCount: 1, items: [
  { id: "mon_1PYH050XYJ1NJ6X8", startedAt: "2024-03-09T16:00:00.000Z" },
] };
const lifecycle = (seq: number, background: unknown[], state = "waiting_background") => ({
  seq, role: "root", rootSessionId: durable, state, waitingOn: { children: 0, background, human: [] },
});
const push = (seq: number, background: unknown[], state?: string) => ({
  type: "session_lifecycle", sessionId: route, lifecycle: lifecycle(seq, background, state),
});
const make = () => new ActivityProjection(route, durable);

// Apply the same mount/set/delete rules as a native subtree. An update to a
// nonexistent row cannot create it; deleting its parent must remove old rows.
function panelFixture() {
  const nodes = new Map<string,{ p: ReturnType<typeof record>; parent: string; kind: unknown }>();
  const order = new Map<string, string[]>();
  const remove = (id: string) => {
    const parent = nodes.get(id)?.parent;
    if (parent) order.set(parent, (order.get(parent) ?? []).filter(child => child !== id));
    for (const child of order.get(id) ?? []) remove(child);
    order.delete(id);
    nodes.delete(id);
  };
  const mount = (data: unknown, parent: string, before?: unknown) => {
    const n = record(data);
    const id = String(n.id);
    const siblings = order.get(parent) ?? [];
    const at = typeof before === "string" ? siblings.indexOf(before) : siblings.length;
    if (at < 0) throw new Error(`No sibling ${before} under ${parent}`);
    siblings.splice(at, 0, id);
    order.set(parent, siblings);
    nodes.set(id, { p: record(n.p), parent, kind: n.k });
    if (Array.isArray(n.c)) n.c.forEach(c => mount(c, id));
  };
  const frame = (...ops: Op[]) => {
    for (const [action,id,p,before,child] of ops) {
      if (action === "add") mount(child, String(p), before);
      if (action === "del") remove(String(id));
      const n = nodes.get(String(id));
      if (action === "set" && n) Object.assign(n.p, record(p));
    }
  };
  const workflow = new Workflow(frame), activity = make();
  const pushView = () => workflow.background(activity.view);
  return { workflow, activity, pushView, props: (id: string) => nodes.get(`workflow-${id}`)?.p,
    kind: (id: string) => nodes.get(`workflow-${id}`)?.kind,
    sections: () => (order.get("workflow") ?? []).filter(id => /^(?:workflow-(?:dag|activity)-bar|workflow-(?:agents|jobs)-body)$/.test(id)) };
}

test("owner activity badges count work rather than capped rows", () => {
  const {workflow, activity, pushView, props} = panelFixture();
  workflow.toggle();
  activity.observe(push(1,[bash])); activity.observe(update([agent])); pushView();
  expect(props("agents-count")?.text).toBe("1");
  expect(props("jobs-0-name")?.text).toBe("Detached job");
  expect(props("jobs-0-status")?.text).toBe("running");
  expect(props("jobs-0-ref")?.text).toBe("bash_1");
  activity.observe(update(Array.from({length:18},(_,i)=>({...agent, task_id:`st_${i.toString(16).padStart(8,"0")}`})))); pushView();
  expect(props("agents-count")?.text).toBe("18");
  expect(props("agents-15-name")?.text).toBe("Review workspace changes");
  expect(props("agents-16-name")).toBeUndefined();
  expect(props("jobs-count")?.text).toBe("1");
  expect(props("jobs-0-name")?.text).toBe("Detached job");
  expect(props("agents-0-name")?.text).toBe("Review workspace changes");
  activity.observe(update([], "foreign")); pushView();
  expect(props("agents-count")?.text).toBe("18");
  activity.observe(update([])); activity.observe(push(2,[{...bash,activeCount:3,items:[]}])); pushView();
  expect(props("agents-body")?.hidden).toBe(true);
  expect(props("jobs-count")?.text).toBe("3");
  expect(props("jobs-0-name")?.text).toBe("3 detached jobs");
  expect(props("jobs-0-status")?.text).toBe("running");
  expect(props("jobs-0-ref")?.hidden).toBe(true);
  activity.observe(push(3,[])); pushView();
  expect(props("jobs-body")?.hidden).toBe(true);
  expect(props("jobs-0")).toBeUndefined();
});

test("Background Activity folds both groups without giving their headings a fold action", () => {
  const { workflow, activity, pushView, props, kind, sections } = panelFixture();
  const expectedOrder = ["workflow-dag-bar", "workflow-activity-bar", "workflow-agents-body", "workflow-jobs-body"];
  workflow.toggle();
  expect(props("activity")?.text).toContain("Background Activity");
  expect(props("activity-empty")?.hidden).toBe(false);
  activity.observe(update([agent])); pushView();
  expect(props("agents-body")?.hidden).toBe(false);
  expect(props("jobs-body")?.hidden).toBe(true);
  activity.observe(push(1, [bash])); pushView();
  expect(props("activity-empty")?.hidden).toBe(true);
  expect(sections()).toEqual(expectedOrder);
  for (const group of ["agents", "jobs"]) {
    expect(kind(group + "-heading")).toBe("text");
    expect(props(group + "-heading")?.actions).toBeUndefined();
  }
  workflow.action({ act: "fold", id: "workflow-agents-heading" });
  expect(props("agents-body")?.hidden).toBe(false);
  workflow.action({ act: "fold", id: "workflow-activity" });
  expect(props("agents-body")?.hidden).toBe(true);
  expect(props("jobs-body")?.hidden).toBe(true);
  activity.observe(update([])); pushView();
  workflow.action({ act: "fold", id: "workflow-activity" });
  expect(sections()).toEqual(expectedOrder);
  expect(props("agents-body")?.hidden).toBe(true);
  expect(props("jobs-body")?.hidden).toBe(false);
  activity.observe(push(2, [])); pushView();
  expect(props("activity-empty")?.hidden).toBe(false);
  expect(props("jobs-0")).toBeUndefined();
});

test("an ID-only agent name falls back to readable text and renders the ID as metadata", () => {
  const { workflow, activity, pushView, props } = panelFixture();
  workflow.toggle();
  activity.observe(update([{ ...agent, task_summary: undefined, name: agent.task_id }]));
  pushView();
  expect(props("agents-0-name")?.text).toBe("Background agent");
  expect(props("agents-0-ref")?.text).toBe(agent.task_id);
  expect(props("agents-0-ref")?.hidden).toBe(false);
});

for (const startsLive of [false,true]) test(`reopen reconciles jobs from the mounted ${startsLive ? "populated" : "empty"} body`, () => {
  const {workflow,activity,pushView,props}=panelFixture();
  let seq=0;
  const change=(live:boolean)=>{activity.observe(push(++seq,live?[bash]:[]));pushView();};
  workflow.toggle(); change(true);
  if(startsLive) change(false);
  workflow.toggle(); change(startsLive); workflow.toggle(); change(!startsLive);
  expect(props("jobs-0-name")?.text).toBe(startsLive ? undefined : "Detached job");
  expect(props("jobs-body")?.hidden).toBe(startsLive);
});

test("cold restores owned terminal sources and clears them on newer empty lifecycle", () => {
  const activity = make();
  expect(activity.restore({ sessionId: durable, lifecycle: lifecycle(2, [bash, monitor]) })).toBe(true);
  expect(activity.view).toEqual({ active: true, running: { agents: 0, jobs: 2 }, counts: { agent: 0, bash: 1, monitor: 1 }, rows: [
    { id: "bash:bash_1", kind: "bash", status: "running", label: "Detached job", reference: "bash_1" },
    { id: "monitor:mon_1PYH050XYJ1NJ6X8", kind: "monitor", status: "running", label: "Monitor", reference: "mon_1PYH050XYJ1NJ6X8" },
  ] });

  activity.observe(push(3, []));
  expect(activity.restore({ sessionId: durable, lifecycle: lifecycle(2, [bash]) })).toBe(false);
  expect(activity.view).toEqual({ active: false, running: { agents: 0, jobs: 0 }, counts: { agent: 0, bash: 0, monitor: 0 }, rows: [] });
});

test("preserves registration counts without assuming omitted monitors are running", () => {
  const activity = make();
  activity.observe(push(1, [{ ...bash, activeCount: 34 }, { ...monitor, items: undefined, activeCount: 2 }]));
  expect(activity.view.rows.map(row => [row.label, row.reference])).toEqual([
    ["Detached job", "bash_1"], ["33 detached jobs", undefined], ["2 monitors", undefined],
  ]);
  expect(activity.view.counts).toEqual({ agent: 0, bash: 34, monitor: 2 });
  expect(activity.view.running).toEqual({ agents: 0, jobs: 34, jobsMayBeHigher: true });
  expect(activity.view.rows.at(-1)?.status).toBe("unknown");
});

test("reconciles truncated owned monitors when complete details match the listed identities", () => {
  const activity = make();
  const at = Date.parse(monitor.items[0].startedAt);
  const monitors = Array.from({ length: 34 }, (_, i) => ({ id: `bash_${i}`, startedAtMs: at + i, paused: true }));
  const truncated = { ...monitor, activeCount: 34, items: monitors.slice(0, 32).map((detail, i) =>
    ({ id: `mon_${i}`, startedAt: new Date(detail.startedAtMs).toISOString() })) };
  const detail = (rows: typeof monitors, owner = route) =>
    extension("terminal_monitor_state", { activeCount: rows.length, monitors: rows }, owner);
  activity.observe(push(1, [truncated]));
  activity.observe(detail(monitors));
  expect(activity.view.running).toEqual({ agents: 0, jobs: 0 });
  expect(activity.view.active).toBe(false);
  const mixed = monitors.map((row, i) => i === 33 ? { ...row, paused: false } : row);
  expect(activity.observe(detail(mixed, "foreign-route"))).toBe(false);
  expect(activity.view.active).toBe(false);
  activity.observe(detail(mixed));
  expect(activity.view.running).toEqual({ agents: 0, jobs: 1 });
  expect(activity.view.active).toBe(true);
  expect(activity.view.rows[0]).toMatchObject({ label: "2 monitors", status: "mixed" });
  activity.observe(detail(mixed.map((row, i) => i === 33 ? { ...row, startedAtMs: at } : row)));
  expect(activity.view.running).toEqual({ agents: 0, jobs: 0, jobsMayBeHigher: true });
  expect(activity.view.active).toBe(false);
  activity.observe(push(2, [{ ...truncated, items: [] }]));
  expect(activity.view.running).toEqual({ agents: 0, jobs: 0, jobsMayBeHigher: true });
});

test("ignores widgets including live task duplicates and retained done or fallback bash", () => {
  const activity = make();
  activity.observe(update([agent]));
  activity.observe(extension("job_widget_state", { v: 1, sessionId: durable, jobs: [
    { id: agent.task_id, kind: "task", state: "live" },
    { id: "bash_1", kind: "bash", state: "done" },
    { id: "bash_2", kind: "bash", state: "fallback" },
    { id: "bash_3", kind: "bash", state: "live" },
  ] }));

  expect(activity.view).toEqual({ active: true, running: { agents: 1, jobs: 0 }, counts: { agent: 1, bash: 0, monitor: 0 }, rows: [
    { id: "agent:st_01a20c83", kind: "agent", status: "running", label: "Review workspace changes", reference: "st_01a20c83" },
  ] });
});

test("prefers the summary, falls back to the name, and rejects unsafe free text", () => {
  const activity = make();
  activity.observe(update([
    agent,
    { ...agent, task_id: "st_01a20c84", task_summary: "curl https://example.invalid", name: "Audit changes" },
    { ...agent, task_id: "st_01a20c85", task_summary: "API key abc123", name: "bad\u001b[31m" },
  ]));
  expect(activity.view.rows.map(row => row.label)).toEqual([
    "Review workspace changes", "Audit changes", "Background agent",
  ]);
});

test("rejects foreign routes and durable owners and preserves data on malformed input", () => {
  const activity = make();
  activity.observe(push(1, [bash]));
  expect(activity.observe({ ...push(2, []), sessionId: "rpc-2" })).toBe(false);
  expect(activity.observe({ ...push(2, []), lifecycle: { ...lifecycle(2, []), rootSessionId: "other" } })).toBe(false);
  expect(activity.observe(push(2, [{ ...bash, activeCount: "1" }]))).toBe(false);
  expect(activity.observe(update([], "other"))).toBe(false);
  expect(activity.observe(update([null]))).toBe(false);
  expect(activity.view.rows.map(row => row.id)).toEqual(["bash:bash_1"]);
  expect(activity.view.running).toEqual({ agents: 0, jobs: 1 });
});

test("only projects owned resident task runners with supported modes and states", () => {
  const activity = make();
  const task = (n: number, fields: Record<string, unknown>) => ({
    ...agent, task_id: `st_01a20c8${n}`, ...fields,
  });
  activity.observe(update([
    task(1, { status: "pending" }), task(2, { execution_mode: "in-process" }),
    task(3, { awaiting_input: { reason: "own_host_unreachable" } }),
    task(4, { status: "future_status" }), task(5, { residency_state: "persisted_only" }),
    task(6, { execution_mode: "unknown-runner" }), task(7, { status: "completed" }),
  ]));
  expect(activity.view.rows.map(row => [row.id, row.status])).toEqual([
    ["agent:st_01a20c82", "running"], ["agent:st_01a20c81", "queued"], ["agent:st_01a20c83", "paused"],
  ]);
  expect(activity.view.running).toEqual({ agents: 1, jobs: 0 });
  activity.observe(update([task(2, { status: "completed" })]));
  expect(activity.view).toEqual({ active: false, running: { agents: 0, jobs: 0 }, counts: { agent: 0, bash: 0, monitor: 0 }, rows: [] });
});

test("same-owner push wins over in-flight pulls; reset fences old replies and a new pull can restore", () => {
  const activity = make();
  const stale = activity.beginTaskList();
  activity.observe(update([{ ...agent, status: "completed" }]));
  expect(stale(pulled(snapshot([agent])))).toBe(false);

  const beforeReset = activity.beginTaskList();
  activity.reset();
  expect(beforeReset(pulled(snapshot([agent])))).toBe(false);
  expect(activity.beginTaskList()(pulled(snapshot([agent], "other")))).toBe(false);
  expect(activity.beginTaskList()(pulled(snapshot([agent])))).toBe(true);
  expect(activity.view.active).toBe(true);
});

test("an unavailable task endpoint is not a successful empty replacement", () => {
  const activity = make();
  activity.observe(update([agent]));
  expect(activity.beginTaskList()(pulled({ kind: "unavailable" }))).toBe(false);
  expect(activity.view.active).toBe(true);
  expect(activity.beginTaskList()(pulled(snapshot([])))).toBe(true);
  expect(activity.view.active).toBe(false);
});

test("user Stop holds wakes without cancelling jobs; a muted monitor remains registered", () => {
  const activity = make();
  activity.observe(extension("terminal_monitor_state", { activeCount: 1, monitors: [
    { id: "bash_2", paused: true, startedAtMs: 1710000000000, description: "raw watch command" },
  ] }));
  activity.observe(push(3, [bash, monitor], "paused"));

  expect(activity.view.active).toBe(true);
  expect(activity.view.running).toEqual({ agents: 0, jobs: 1 });
  expect(activity.view.rows.map(row => [row.kind, row.status])).toEqual([
    ["bash", "running"], ["monitor", "paused"],
  ]);
  activity.observe(push(4, [monitor], "paused"));
  expect(activity.view.active).toBe(false);
  expect(activity.view.running).toEqual({ agents: 0, jobs: 0 });
  expect(activity.view.rows.map(row => row.status)).toEqual(["paused"]);
  activity.observe(push(5, []));
  expect(activity.view).toEqual({ active: false, running: { agents: 0, jobs: 0 }, counts: { agent: 0, bash: 0, monitor: 0 }, rows: [] });
});

test("bounds sidebar rows without deriving liveness from the displayed rows", () => {
  const activity = make();
  const tasks = Array.from({ length: 24 }, (_, i) => ({
    ...agent, task_id: `st_01a20c${(i + 16).toString(16)}`, status: i < 20 ? "running" : "paused",
  }));
  activity.observe(update(tasks));
  activity.observe(push(1, [bash]));
  expect(activity.view.active).toBe(true);
  expect(activity.view.counts).toEqual({ agent: 24, bash: 1, monitor: 0 });
  expect(activity.view.running).toEqual({ agents: 20, jobs: 1 });
  expect(activity.view.rows.filter(row => row.kind === "agent")).toHaveLength(16);
  expect(activity.view.rows).toHaveLength(17);
  expect(activity.view.rows.at(-1)?.kind).toBe("bash");
});
