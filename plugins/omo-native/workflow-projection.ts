import { plain, record, string } from "./surface";

export type Step = {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly needs: readonly string[];
  readonly reason: string;
};

const unfinishedStates = new Set(["pending", "waiting", "ready", "queued", "scheduled", "running", "paused"]);
const stoppedStates = new Set(["failed", "canceled", "cancelled"]);
const states = new Set([...unfinishedStates, ...stoppedStates, "completed", "blocked", "skipped"]);

export const unfinished = (status: string) => unfinishedStates.has(status);
export const displayStatus = (status: string) => states.has(status) ? status : "unknown";
export const short = (value: unknown) => plain(string(value)).replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 80);

const failureReason = (error: unknown) => {
  const { code } = record(error);
  if (code === "start_failed") return "The node could not start (start_failed).";
  if (code === "plan_unresolved") return "OmO could not resolve the node’s execution plan (plan_unresolved).";
  return "No safe failure reason is available.";
};

type SnapshotNode = Omit<Step, "reason"> & { readonly error: unknown };

export function workflowSteps(rows: readonly unknown[]): readonly Step[] {
  const nodes = new Map<string, SnapshotNode>();
  for (const row of rows) {
    const n = record(row), id = string(n.id);
    if (!id || nodes.has(id)) continue;
    nodes.set(id, {
      id, status: displayStatus(string(n.state)), error: n.error,
      label: short(string(n.title) || string(n.label) || string(n.name) || id),
      needs: Array.isArray(n.dependsOn) ? [...new Set(n.dependsOn.map(string).filter(Boolean))] : [],
    });
  }

  const dependents = new Map<string, SnapshotNode[]>();
  for (const node of nodes.values()) {
    if (node.status !== "skipped" && node.status !== "blocked") continue;
    for (const id of node.needs) {
      const successors = dependents.get(id) ?? [];
      successors.push(node);
      dependents.set(id, successors);
    }
  }

  // OmO traces failed/cancelled ancestors through skipped nodes only.
  // Keep four reasons and one overflow witness. Once a node has five sources,
  // its descendants have already seen those same sources (if it can propagate).
  const reasonLimit = 4;
  const blockers = new Map<string, string[]>();
  for (const root of nodes.values()) {
    if (!stoppedStates.has(root.status)) continue;
    const queue = [root.id];
    for (const id of queue) {
      for (const successor of dependents.get(id) ?? []) {
        const reasons = blockers.get(successor.id) ?? [];
        if (reasons.length > reasonLimit || reasons.includes(root.id)) continue;
        reasons.push(root.id);
        blockers.set(successor.id, reasons);
        if (successor.status === "skipped") queue.push(successor.id);
      }
    }
  }

  return [...nodes.values()].map(({ id, label, status, needs, error }) => {
    const reasons = blockers.get(id);
    if (reasons) {
      const labels = reasons.slice(0, reasonLimit).map(id => short(id).slice(0, 32).trim() || "unnamed node");
      return { id, label, status: "blocked", needs,
        reason: `Blocked by ${labels.join(", ")}${reasons.length > reasonLimit ? " …" : ""}.` };
    }
    const reason = status === "failed" ? failureReason(error)
      : status === "blocked" ? "No safe blocking reason is available." : "";
    return { id, label, status, needs, reason };
  });
}
