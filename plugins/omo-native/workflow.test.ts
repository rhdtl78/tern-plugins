import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcCommandError, type RpcRecord } from "./rpc";
import { Transcript } from "./transcript";
import { graph, supportsWorkflow, Workflow } from "./workflow";
import { sessionPlanPath } from "./plan-link";
import { record } from "./surface";
import { workflowSteps } from "./workflow-projection";

test("vertical DAG keeps a direct edge around the intermediate node", () => {
  const steps = [
    { id: "A", label: "A & <review>", status: "completed", needs: [], reason: "" },
    { id: "B", label: "B", status: "completed", needs: ["A"], reason: "" },
    { id: "C", label: "C", status: "completed", needs: ["A", "B"], reason: "" },
  ];
  const dark = graph(steps, true, "B");
  if (!dark) throw Error("Expected a drawable graph");
  expect(dark.svg).not.toMatch(/<text|<rect|review/);
  expect(dark.cards[0]).toMatchObject({ label: "A & <review>", state: "completed", props: { aria: "A & <review>, completed" } });
  expect(dark.cards.map(c => c.props.on)).toEqual([false, true, false]);
  const paths = [...dark.svg.matchAll(/<path d="M([\d.]+) ([\d.]+) V[\d.]+ H([\d.]+) V[\d.]+ H([\d.]+) V([\d.]+)"/g)];
  const [source, middle, target] = dark.cards;
  const [bypass] = paths;
  if (!source || !middle || !target || !bypass) throw Error("Expected three cards and a bypass path");
  const center = (card: typeof source) => card.left + card.width / 2;
  expect(Number(bypass[1])).toBe(center(source));
  expect(Number(bypass[2])).toBe(source.top + source.height);
  expect(Number(bypass[3])).toBeLessThan(middle.left);
  expect(Number(bypass[4])).toBe(center(target));
  expect(Number(bypass[5])).toBeLessThan(target.top);
  expect(graph(steps, false)?.svg).not.toBe(dark.svg);
  const refreshed = graph(steps.map(s => ({ ...s, status: "running" })), true, "B");
  expect(refreshed?.cards.map(c => c.id)).toEqual(dark.cards.map(c => c.id));
  expect(refreshed?.svg).toEqual(dark.svg);
});

test("a renderer without native workflow controls cannot offer the pane", () => {
  expect(supportsWorkflow({ features: ["aside", "blobs"], kinds: ["prefs", "image"] })).toBe(false);
});

test("provides both layouts and keeps selection when switching between row and card", async () => {
  const rendered = Promise.withResolvers<void>();
  const frames: unknown[] = [];
  const workflow = new Workflow((...ops) => {
    frames.push(...ops);
    if (JSON.stringify(ops).includes("A · completed")) rendered.resolve();
  });
  workflow.bind({ async request(_, fields) {
    const value = fields?.name === "omo.dag.list"
      ? { runs: [{ runId: "run", parentSessionId: "owner" }] }
      : { runId: "run", parentSessionId: "owner", nodes: [{ id: "A", state: "completed" }] };
    return { data: { ok: true, value } };
  } }, "owner", "/tmp");
  workflow.toggle();
  await rendered.promise;
  expect(JSON.stringify(frames)).toContain("<svg");
  frames.length = 0;
  workflow.action({ id: "workflow-card-0", act: "select-step" });
  expect(frames).toContainEqual(["set", "workflow-node-detail", { text: "A · completed", hidden: false }]);
  expect(frames).toContainEqual(["set", "workflow-step-0", expect.objectContaining({ on: true, variant: "quiet" })]);
  frames.length = 0;
  // Pane geometry chooses between both controls without waiting for a resize event.
  workflow.action({ id: "workflow-step-0", act: "select-step" });
  expect(JSON.stringify(frames)).toContain("A · completed");
  expect(JSON.stringify(frames)).toContain("<svg");
  expect(frames).toContainEqual(["graph", expect.objectContaining({ cards: [expect.objectContaining({
    id: "workflow-card-0", props: expect.objectContaining({ on: true }),
  })] })]);
});

test("a late duplicate or failed Todo cannot replace the latest cleared checklist", () => {
  const sizes: number[] = [];
  const transcript = new Transcript(() => {}, phases => sizes.push(phases.length));
  const saved = { role: "toolResult", toolName: "todo", toolCallId: "original",
    details: { phases: [{ name: "Plan", tasks: [{ content: "Current", status: "pending" }] }] } };
  transcript.message(saved);
  transcript.event({ type: "tool_execution_end", toolName: "todo", toolCallId: "clear",
    result: { details: { phases: [] } } });
  transcript.message(saved);
  transcript.message({ ...saved, toolCallId: "failed", isError: true });
  expect(sizes).toEqual([1, 0]);
});

const updated = (owner: string) => ({ type: "extension_event", name: "omo.dag.updated", data: { parent_session_id: owner } });
const listed = (...runs: readonly RpcRecord[]) => ({ data: { ok: true, value: { runs } } });

test("direct neighbors share selection and update in place when the selected worker finishes", async () => {
  let terminal = false;
  const frames: unknown[] = [];
  const workflow = new Workflow((...ops) => frames.push(...ops));
  workflow.bind({ async request(_, fields) {
    if (fields?.name === "omo.dag.list") return listed({ runId: "r", parentSessionId: "owner" });
    return { data: { ok: true, value: { runId: "r", parentSessionId: "owner", nodes: [
      { id: "root", state: "completed", route: { kind: "category", category: "quick", model: "ignore" } },
      { id: "next", dependsOn: ["root"], state: terminal ? "completed" : "scheduled", attempt: terminal ? 1 : 0,
        route: { kind: "agent", agent: "reviewer", model: "explicit/config" }, execAttempt: 9,
        runStats: terminal ? { runtime_ms: 4522, turns: 1, tool_calls: 0 } : undefined,
        prompt: "secret", output: "Actual result", error: { message: "secret" } },
    ] } } };
  } }, "owner", "/tmp");
  workflow.toggle();
  await Bun.sleep(0);
  workflow.action({ act: "select-step", id: "workflow-card-0" });
  expect(frames).toContainEqual(["set", "workflow-neighbor-1", expect.objectContaining({ text: "Successor: next", hidden: false })]);
  frames.length = 0;
  workflow.action({ act: "select-step", id: "workflow-neighbor-1" });
  const detail = () => frames.findLast(f => Array.isArray(f) && f[1] === "workflow-node-detail");
  expect(detail()).toEqual(["set", "workflow-node-detail", { text: "next · scheduled\nAttempts: 0\nAgent: reviewer\nConfigured model: explicit/config", hidden: false }]);
  expect(frames).toContainEqual(["set", "workflow-result", { text: "", hidden: true }]);
  terminal = true;
  workflow.event(updated("owner"));
  await Bun.sleep(0);
  expect(detail()).toEqual(["set", "workflow-node-detail", { text: "next · completed\nRuntime: 4.5s · Attempts: 1\nAgent: reviewer\nConfigured model: explicit/config", hidden: false }]);
  expect(frames).toContainEqual(["set", "workflow-result", { text: "Actual result", hidden: false }]);
  expect(frames).toContainEqual(["set", "workflow-step-1", expect.objectContaining({ on: true })]);
  expect(JSON.stringify(frames)).not.toMatch(/secret|ignore|"del"/);
  expect(frames).toContainEqual(["set", "workflow-neighbor-0", expect.objectContaining({ text: "Predecessor: root", hidden: false })]);
  workflow.action({ act: "select-step", id: "workflow-neighbor-0" });
  expect(detail()).toEqual(["set", "workflow-node-detail", { text: "root · completed\nCategory: quick", hidden: false }]);
});

test("disconnect fences the response from an in-flight list", async () => {
  const frames: unknown[] = [];
  let requests = 0;
  const list = Promise.withResolvers<RpcRecord>();
  const workflow = new Workflow((...ops) => frames.push(...ops));
  workflow.bind({ request: () => { requests++; return list.promise; } }, "owner", "/tmp");
  expect(requests).toBe(0);
  workflow.toggle();
  workflow.disconnect();
  const atDisconnect = frames.length;
  list.resolve({ data: { ok: true, value: { runs: [{ runId: "stale", parentSessionId: "owner" }] } } });
  await list.promise;
  await Promise.resolve();
  expect(requests).toBe(1);
  expect(frames).toHaveLength(atDisconnect);
  expect(JSON.stringify(frames)).toContain("Session disconnected");
});

test("result previews are bounded text from successful nodes, not paths or diagnostics", () => {
  const result = (state: string, output: unknown) =>
    workflowSteps([{ id: "A", state, output, prompt: "private", error: { message: "private" } }])[0]?.result;
  expect(result("completed", "\x1b[31m<b>ok</b>\x1b[0m\u202e")).toBe("<b>ok</b>");
  expect(result("completed", "1\n2\n3\n4\n5\n6")).toBe("1\n2\n3\n4\n5…");
  const preview = result("completed", "가".repeat(1000))!;
  expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(1024);
  expect(preview).toEndWith("…");
  for (const value of ["", undefined, {}, "read /tmp/private", "https://example.invalid/"]) {
    expect(result("completed", value)).toBeUndefined();
  }
  expect(result("failed", "diagnostic")).toBeUndefined();
});

test("recognizable filesystem paths omit the whole preview regardless of prose formatting", () => {
  const preview = (output: string) => workflowSteps([{ id: "A", state: "completed", output }])[0]?.result;
  for (const output of ["Saved `/tmp/fixture-note.md`", "Saved **~/fixture-note.md**", "Saved “/tmp/fixture-note.md”",
    "Saved [/tmp/fixture-note.md]", "path:/tmp/fixture-note.md", "```text\n/tmp/fixture-note.md\n```",
    "Saved `C:\\fixture\\note.md`", "Saved `\\\\fixture\\share\\note.md`"]) {
    expect(preview(output)).toBeUndefined();
  }
  for (const output of ["Saved `fixture-note.md`", "<b>safe</b> [literal](fixture-target)", "Completed 3/4 steps"]) {
    expect(preview(output)).toBe(output);
  }
});

test("a mismatched snapshot cannot expose terminal output from another owner or run", async () => {
  for (const [owner, runId] of [["other", "r"], ["owner", "other"]]) {
    const frames: unknown[] = [];
    const workflow = new Workflow((...ops) => frames.push(...ops));
    workflow.bind({ async request(_, fields) {
      return fields?.name === "omo.dag.list" ? listed({ parentSessionId: "owner", runId: "r" })
        : { data: { ok: true, value: { parentSessionId: owner, runId, nodes: [{ id: "A", state: "completed", output: "private-result" }] } } };
    } }, "owner", "/tmp");
    workflow.toggle();
    await Bun.sleep(0);
    workflow.action({ id: "workflow-card-0", act: "select-step" });
    expect(JSON.stringify(frames)).toContain("Workflow data unavailable");
    expect(JSON.stringify(frames)).not.toContain("private-result");
  }
});
test("a connected pane ignores foreign invalidations and refreshes for its own owner", async () => {
  let drawn = Promise.withResolvers<void>();
  let requests = 0;
  const workflow = new Workflow((...ops) => {
    if (JSON.stringify(ops).includes("No workflow runs.")) drawn.resolve();
  });
  workflow.bind({ async request() { requests++; return listed(); } }, "owner", "/tmp");
  workflow.toggle();
  await drawn.promise;
  workflow.event(updated("other"));
  expect(requests).toBe(1);
  drawn = Promise.withResolvers<void>();
  workflow.event(updated("owner"));
  await drawn.promise;
  expect(requests).toBe(2);
});

test("distinguishes an older RPC rejection from a supported empty list", async () => {
  const frames: unknown[] = [];
  const workflow = new Workflow((...ops) => frames.push(...ops));
  let old = true;
  workflow.bind({ async request() {
    if (old) throw new RpcCommandError("extension_request", {
      type: "response", command: "extension_request", success: false,
      error: "Unknown extension RPC request: omo.dag.list", sessionId: "rpc-1",
    });
    return { data: { ok: true, value: { runs: [] } } };
  } }, "owner", "/tmp");
  workflow.toggle();
  await Bun.sleep(0);
  expect(JSON.stringify(frames)).toContain("does not support workflow runs");
  expect(JSON.stringify(frames)).not.toContain("No workflow runs.");
  old = false;
  frames.length = 0;
  workflow.event({ type: "extension_event", name: "omo.dag.updated", data: { parent_session_id: "owner" } });
  await Bun.sleep(0);
  expect(JSON.stringify(frames)).toContain("No workflow runs.");
});

test("shows an owned paused run by default and retains a visible manual selection on refresh", async () => {
  let waitFor = "paused · 0/0";
  let drawn = Promise.withResolvers<string>();
  let refresh = false;
  const workflow = new Workflow((...ops) => {
    const frame = JSON.stringify(ops);
    if (frame.includes(waitFor)) drawn.resolve(frame);
  });
  workflow.bind({ async request(_, fields) {
    if (fields?.name === "omo.dag.list") return { data: { ok: true, value: { runs: [
      { runId: "foreign", parentSessionId: "other", status: "running" },
      { runId: "finished", parentSessionId: "owner", status: "completed" },
      { runId: "active", parentSessionId: "owner", status: "paused" },
    ] } } };
    const runId = record(fields?.data).runId;
    const status = runId === "active" ? "paused" : "completed";
    const nodes = refresh ? [{ id: "X", state: "completed" }] : [];
    return { data: { ok: true, value: { parentSessionId: "owner", runId, status, nodes } } };
  } }, "owner", "/tmp");
  workflow.toggle();
  const initial = await drawn.promise;
  expect(initial).toContain('"text":"active","on":true');
  expect(initial).not.toMatch(/Selected:|"primary"/);
  expect(initial).not.toContain("workflow-run-foreign");
  waitFor = "completed · 0/0";
  drawn = Promise.withResolvers<string>();
  workflow.action({ act: "select-run", id: "workflow-run-finished" });
  expect(await drawn.promise).toContain('"text":"finished","on":true');
  refresh = true;
  waitFor = "completed · 1/1";
  drawn = Promise.withResolvers<string>();
  workflow.event(updated("owner"));
  expect(await drawn.promise).toContain('"text":"finished","on":true');
});

test("attributes a skip only to failed or cancelled ancestors reachable through skipped nodes", () => {
  const projected = workflowSteps([
    { id: "A", state: "failed", error: { code: "plan_unresolved", message: "private failure" } },
    { id: "\x1b[31mK\x1b[0m", state: "cancelled" },
    { id: "B", state: "skipped", dependsOn: ["A", "\x1b[31mK\x1b[0m"] },
    { id: "C", state: "skipped", dependsOn: ["B"], prompt: "private task" },
    { id: "X", state: "blocked", dependsOn: ["B"] },
    { id: "Y", state: "skipped", dependsOn: ["X"] },
    { id: "Z", state: "blocked", dependsOn: ["missing"] },
  ]);
  expect(projected.find(n => n.id === "C")).toMatchObject({ status: "blocked", reason: "Blocked by A, K." });
  expect(projected.find(n => n.id === "X")).toMatchObject({ status: "blocked", reason: "Blocked by A, K." });
  expect(projected.find(n => n.id === "Y")).toMatchObject({ status: "skipped", reason: "" });
  expect(projected.find(n => n.id === "Z")).toMatchObject({ status: "blocked", reason: "" });
  expect(JSON.stringify(projected)).not.toMatch(/private failure|private task/);
});

test("malformed cycles and missing or unknown states do not fabricate a blocker", () => {
  const projected = workflowSteps([
    { id: "A", state: "skipped", dependsOn: ["A", "B", "missing", null] },
    { id: "B", state: "skipped", dependsOn: ["A", "unknown"] },
    { id: "unknown", state: "future" },
    { id: "clean", state: "skipped", dependsOn: [] },
  ]);
  expect(projected.map(({ status, reason }) => [status, reason])).toEqual([
    ["skipped", ""], ["skipped", ""], ["unknown", ""], ["skipped", ""],
  ]);
});

test("Boulder links require the exact owner and reject unsafe or ambiguous targets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omo-workflow-test-"));
  try {
    const work = join(dir, "work");
    await mkdir(work);
    await mkdir(join(work, ".omo"));
    await writeFile(join(work, "plan #1.md"), "# Plan");
    await writeFile(join(work, "beta.md"), "# Beta");
    await writeFile(join(dir, "outside.md"), "# Outside");
    await symlink(join(dir, "outside.md"), join(work, "escape.md"));
    const a = { session_ids: ["senpi:alpha"], active_plan: "plan #1.md", started_at: "2026-01-01T00:00:00Z" };
    const b = { session_ids: ["senpi:beta"], active_plan: "beta.md", started_at: "2026-01-02T00:00:00Z" };
    const registry = (works: unknown, schema_version = 2) => writeFile(join(work, ".omo/boulder.json"),
      JSON.stringify({ schema_version, works, active_work_id: "b", active_plan: b.active_plan, session_ids: ["senpi:other"] }));
    await registry({ a, b });
    expect(await sessionPlanPath(work, "alpha")).toEndWith("/plan #1.md");
    expect(await sessionPlanPath(work, "beta")).toEndWith("/beta.md");
    expect(await sessionPlanPath(work, "other")).toBeUndefined();
    await registry({ a, b: { ...b, session_ids: a.session_ids } });
    expect(await sessionPlanPath(work, "alpha")).toEndWith("/beta.md");
    await registry({ a, b: { ...b, session_ids: a.session_ids, updated_at: a.started_at } });
    expect(await sessionPlanPath(work, "alpha")).toBeUndefined();
    await registry({ a, b }, 1);
    expect(await sessionPlanPath(work, "alpha")).toBeUndefined();
    for (const active_plan of ["../outside.md", "escape.md", "missing.md"]) {
      await registry({ a: { ...a, active_plan }, b });
      expect(await sessionPlanPath(work, "alpha")).toBeUndefined();
    }
    await registry({ a: { ...a, worktree_path: dir }, b });
    expect(await sessionPlanPath(work, "alpha")).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Boulder worktree prefers a registered copy and falls back only when absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omo-plan-worktree-"));
  const root = join(dir, "base");
  const sibling = join(dir, "registered copy");
  const unregistered = join(dir, "unregistered");
  const git = async (...args: string[]) => {
    const proc = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", ...args], {
      env: { ...process.env, GIT_MASTER: "1" }, stdout: "ignore", stderr: "pipe",
    });
    const diagnostic = await new Response(proc.stderr).text();
    if (await proc.exited !== 0) throw new Error(diagnostic);
  };
  try {
    await git("clone", "--quiet", "--shared", "--", join(import.meta.dir, "../.."), root);
    await git("-C", root, "worktree", "add", "--detach", sibling, "HEAD");
    const rel = ".omo/plans/active.md";
    await mkdir(join(root, ".omo/plans"), { recursive: true });
    await mkdir(join(sibling, ".omo/plans"), { recursive: true });
    await mkdir(unregistered);
    await writeFile(join(root, rel), "# Original");
    const assign = (worktree_path: string) => writeFile(join(root, ".omo/boulder.json"), JSON.stringify({
      schema_version: 2, works: { a: { session_ids: ["senpi:alpha"], active_plan: rel, worktree_path } },
    }));
    await assign(sibling);
    expect(await sessionPlanPath(root, "alpha")).toEndWith("/base/" + rel);
    await writeFile(join(sibling, rel), "# Worktree copy");
    expect(await sessionPlanPath(root, "alpha")).toEndWith("/registered copy/" + rel);
    await rm(join(sibling, rel));
    await symlink(join(root, rel), join(sibling, rel));
    expect(await sessionPlanPath(root, "alpha")).toBeUndefined();
    await rm(join(sibling, rel));
    await mkdir(join(sibling, rel));
    expect(await sessionPlanPath(root, "alpha")).toBeUndefined();
    await assign(unregistered);
    expect(await sessionPlanPath(root, "alpha")).toBeUndefined();
    await assign(root);
    expect(await sessionPlanPath(root, "alpha")).toEndWith("/base/" + rel);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
