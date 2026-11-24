import { plain, record, string } from "./surface";

export type Step = {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly needs: readonly string[];
  readonly reason: string;
  readonly route?: { kind: "category" | "agent"; name: string; model?: string };
  readonly runtimeMs?: number;
  readonly attempt?: number;
  readonly result?: string;
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
  return "";
};

type SnapshotNode = Omit<Step, "reason"> & { readonly error: unknown };

const count = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
function execution(n: ReturnType<typeof record>) {
  const r = record(n.route), stats = record(n.runStats);
  const kind = r.kind === "category" || r.kind === "agent" ? r.kind : undefined;
  const name = kind && short(r[kind]).trim();
  const route: Step["route"] = kind && name ? { kind, name,
    model: kind === "agent" ? short(r.model).trim() || undefined : undefined } : undefined;
  return { route, runtimeMs: stats.duration_status === "unavailable" ? undefined : count(stats.runtime_ms),
    attempt: count(n.attempt) };
}

// Only the successful snapshot's text, never its prompt, diagnostic or artifact path.
function resultText(output: unknown) {
  if (typeof output !== "string") return;
  const clean = plain(output.replace(/\r\n?/g, "\n")).replace(/\p{Cf}/gu, "").replace(/\t/g, " ").trim();
  if (!clean) return;
  // Treat punctuation (including Markdown delimiters) as a path boundary.
  // A literal closing tag is markup, not a path; don't change its displayed text.
  const pathText = clean.replace(/<\/[A-Za-z][\w:-]*\s*>/g, " ");
  if (/\b(?:https?|file):\/\//i.test(clean) ||
      /(?:^|[^\p{L}\p{N}])(?:~\/|\/|[A-Za-z]:[\\/]|\\\\)/u.test(pathText)) return;
  let text = "", bytes = 0, lines = 1;
  for (const ch of clean) {
    bytes += Buffer.byteLength(ch);
    if (bytes > 1021 || (ch === "\n" && ++lines > 5)) return text.trimEnd() + "…";
    text += ch;
  }
  return text;
}

export function workflowSteps(rows: readonly unknown[]): readonly Step[] {
  const nodes = new Map<string, SnapshotNode>();
  for (const row of rows) {
    const n = record(row), id = string(n.id);
    if (!id || nodes.has(id)) continue;
    nodes.set(id, {
      id, status: displayStatus(string(n.state)), error: n.error, ...execution(n),
      label: short(string(n.label) || id),
      result: n.state === "completed" ? resultText(n.output) : undefined,
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

  return [...nodes.values()].map(({ error, ...step }) => {
    const reasons = blockers.get(step.id);
    if (reasons) {
      const labels = reasons.slice(0, reasonLimit).map(id => short(id).slice(0, 32).trim() || "unnamed node");
      return { ...step, status: "blocked",
        reason: `Blocked by ${labels.join(", ")}${reasons.length > reasonLimit ? " …" : ""}.` };
    }
    const reason = step.status === "failed" ? failureReason(error) : "";
    return { ...step, reason };
  });
}
