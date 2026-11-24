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
  const dark = graph(steps, true);
  expect(dark).toContain("A &amp; &lt;review&gt;");
  const cards = [...(dark ?? "").matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)];
  const paths = [...(dark ?? "").matchAll(/<path d="M([\d.]+) ([\d.]+) V[\d.]+ H([\d.]+) V[\d.]+ H([\d.]+) V([\d.]+)"/g)];
  const [source, middle, target] = cards;
  const [bypass] = paths;
  if (!source || !middle || !target || !bypass) throw Error("Expected three cards and a bypass path");
  const center = (card: RegExpMatchArray) => Number(card[1]) + Number(card[3]) / 2;
  expect(Number(bypass[1])).toBe(center(source));
  expect(Number(bypass[2])).toBe(Number(source[2]) + Number(source[4]));
  expect(Number(bypass[3])).toBeLessThan(Number(middle[1]));
  expect(Number(bypass[4])).toBe(center(target));
  expect(Number(bypass[5])).toBeLessThan(Number(target[2]));
  expect(graph(steps, false)).not.toBe(dark);
});

test("a renderer without native workflow controls cannot offer the pane", () => {
  expect(supportsWorkflow({ features: ["aside", "blobs"], kinds: ["prefs", "image"] })).toBe(false);
});

test("uses the native DAG list when the graph no longer fits", async () => {
  let rendered = Promise.withResolvers<void>();
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
  rendered = Promise.withResolvers<void>();
  workflow.width(310);
  await rendered.promise;
  expect(frames).toContainEqual(["graph", null]);
  expect(JSON.stringify(frames)).toContain("A · completed");
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
  let waitFor = "active · paused";
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
  expect(initial).toContain("Selected: active");
  expect(initial).not.toContain("workflow-run-foreign");
  waitFor = "finished · completed";
  drawn = Promise.withResolvers<string>();
  workflow.action({ act: "select-run", id: "workflow-run-finished" });
  expect(await drawn.promise).toContain("Selected: finished");
  refresh = true;
  waitFor = "finished · completed · 1/1";
  drawn = Promise.withResolvers<string>();
  workflow.event(updated("owner"));
  expect(await drawn.promise).toContain("Selected: finished");
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
  expect(projected.find(n => n.id === "Z")).toMatchObject({ status: "blocked", reason: "No safe blocking reason is available." });
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
