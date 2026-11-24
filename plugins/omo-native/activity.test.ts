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
  const nodes = new Map<string,{ p: ReturnType<typeof record>; parent: string }>();
  const remove = (id: string) => {
    nodes.delete(id);
    for (const [key, item] of nodes) if (item.parent === id) remove(key);
  };
  const mount = (data: unknown, parent: string) => {
    const n = record(data);
    nodes.set(String(n.id), { p: record(n.p), parent });
    if (Array.isArray(n.c)) n.c.forEach(c => mount(c, String(n.id)));
  };
  const frame = (...ops: Op[]) => {
    for (const [action,id,p,,child] of ops) {
      if (action === "add") mount(child, String(p));
      if (action === "del") remove(String(id));
      const n = nodes.get(String(id));
      if (action === "set" && n) Object.assign(n.p, record(p));
    }
  };
  const workflow = new Workflow(frame), activity = make();
  const pushView = () => workflow.background(activity.view);
  return { workflow, activity, pushView, props: (id: string) => nodes.get(`workflow-${id}`)?.p };
}

test("owner activity badges count work rather than capped rows", () => {
  const {workflow, activity, pushView, props} = panelFixture();
  workflow.toggle();
  activity.observe(push(1,[bash])); activity.observe(update([agent])); pushView();
  expect(props("agents-count")?.text).toBe("1");
  expect(props("jobs-0")?.text).toBe("Detached job · 1 · running");
  activity.observe(update(Array.from({length:16},(_,i)=>({...agent, task_id:`st_${i.toString(16).padStart(8,"0")}`})))); pushView();
  expect(props("agents-count")?.text).toBe("16");
  expect(props("jobs-count")?.text).toBe("1");
  expect(props("jobs-0")?.text).toBe("Detached job · 1 · running");
  activity.observe(update([], "foreign")); pushView();
  expect(props("agents-count")?.text).toBe("16");
  activity.observe(update([])); activity.observe(push(2,[{...bash,activeCount:3,items:[]}])); pushView();
  expect(props("agents-bar")?.hidden).toBe(true);
  expect(props("jobs-count")?.text).toBe("3");
  expect(props("jobs-0")?.text).toBe("3 detached jobs · running");
  activity.observe(push(3,[])); pushView();
  expect(props("jobs-bar")?.hidden).toBe(true);
  expect(props("jobs-0")).toBeUndefined();
});

for (const startsLive of [false,true]) test(`reopen reconciles jobs from the mounted ${startsLive ? "populated" : "empty"} body`, () => {
  const {workflow,activity,pushView,props}=panelFixture();
  let seq=0;
  const change=(live:boolean)=>{activity.observe(push(++seq,live?[bash]:[]));pushView();};
  workflow.toggle(); change(true);
  if(startsLive) change(false);
  workflow.toggle(); change(startsLive); workflow.toggle(); change(!startsLive);
  expect(props("jobs-0")?.text).toBe(startsLive ? undefined : "Detached job · 1 · running");
  expect(props("jobs-bar")?.hidden).toBe(startsLive);
});

test("cold restores owned terminal sources and clears them on newer empty lifecycle", () => {
  const activity = make();
  expect(activity.restore({ sessionId: durable, lifecycle: lifecycle(2, [bash, monitor]) })).toBe(true);
  expect(activity.view).toEqual({ active: true, counts: { agent: 0, bash: 1, monitor: 1 }, rows: [
    { id: "bash:bash_1", kind: "bash", status: "running", label: "Detached job · 1" },
    { id: "monitor:mon_1PYH050XYJ1NJ6X8", kind: "monitor", status: "running", label: "Monitor · 1PYH050XYJ1NJ6X8" },
  ] });

  activity.observe(push(3, []));
  expect(activity.restore({ sessionId: durable, lifecycle: lifecycle(2, [bash]) })).toBe(false);
  expect(activity.view).toEqual({ active: false, counts: { agent: 0, bash: 0, monitor: 0 }, rows: [] });
});

test("uses authoritative counts when detail is truncated or missing", () => {
  const activity = make();
  activity.observe(push(1, [{ ...bash, activeCount: 34 }, { ...monitor, items: undefined, activeCount: 2 }]));
  expect(activity.view.rows.map(row => row.label)).toEqual(["Detached job · 1", "33 detached jobs", "2 monitors"]);
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

  expect(activity.view).toEqual({ active: true, counts: { agent: 1, bash: 0, monitor: 0 }, rows: [
    { id: "agent:st_01a20c83", kind: "agent", status: "running", label: "Review workspace changes" },
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
    "Review workspace changes", "Audit changes", "Background agent · st_01a20c85",
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
  activity.observe(update([task(2, { status: "completed" })]));
  expect(activity.view).toEqual({ active: false, counts: { agent: 0, bash: 0, monitor: 0 }, rows: [] });
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
  expect(activity.view.rows.map(row => [row.kind, row.status])).toEqual([
    ["bash", "running"], ["monitor", "paused"],
  ]);
  activity.observe(push(4, [monitor], "paused"));
  expect(activity.view.active).toBe(false);
  expect(activity.view.rows.map(row => row.status)).toEqual(["paused"]);
  activity.observe(push(5, []));
  expect(activity.view).toEqual({ active: false, counts: { agent: 0, bash: 0, monitor: 0 }, rows: [] });
});

test("bounds sidebar rows without deriving liveness from the displayed rows", () => {
  const activity = make();
  const tasks = Array.from({ length: 24 }, (_, i) => ({
    ...agent, task_id: `st_01a20c${(i + 16).toString(16)}`, status: "paused",
  }));
  activity.observe(update(tasks));
  activity.observe(push(1, [bash]));
  expect(activity.view.active).toBe(true);
  expect(activity.view.counts).toEqual({ agent: 24, bash: 1, monitor: 0 });
  expect(activity.view.rows.filter(row => row.kind === "agent")).toHaveLength(16);
  expect(activity.view.rows).toHaveLength(17);
  expect(activity.view.rows[0]?.kind).toBe("bash");
});
