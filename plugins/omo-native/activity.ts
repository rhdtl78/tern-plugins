export type ActivityRow = {
  readonly id: string;
  readonly kind: "agent" | "bash" | "monitor";
  readonly label: string;
  readonly status: "running" | "queued" | "paused";
};

export type ActivityView = {
  readonly active: boolean;
  readonly rows: readonly ActivityRow[];
};

const MAX_ENTRIES = 256;
const MAX_ROWS = 16;
const taskId = /^st_[a-f0-9]{8}$/u;
const bashId = /^bash_[0-9]{1,12}$/u;
const monitorId = /^mon_[A-Za-z0-9_-]{1,48}$/u;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function entries(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) && value.length <= MAX_ENTRIES ? value : undefined;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function taskLabel(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 120 ||
      !/^[\p{L}\p{N}\p{M} .,'’()_-]+$/u.test(value)) return;
  const label = value.trim().replace(/ +/g, " ");
  // Reject credential markers, opaque tokens, and common shell command prefixes.
  if (!label || /\b(?:api[_ -]?keys?|access[_ -]?tokens?|passwords?|passphrases?|secrets?|credentials?|bearer|authorization)\b|(?:^|[ _-])(?:sk[-_]|gh[pousr]_|xox[baprs]-|AKIA)|[\w-]{24,}/iu.test(label) ||
      /^(?:sudo|curl|wget|bash|zsh|sh|eval|export|echo|sleep|cd|git|bun|npm|node|python[23]?|rm|chmod)\s/iu.test(label)) return;
  return label.length <= 72 ? label : `${Array.from(label).slice(0, 69).join("")}…`;
}

function row(kind: ActivityRow["kind"], id: string, status: ActivityRow["status"]): ActivityRow {
  const label = kind === "agent" ? `Background agent · ${id}`
    : `${kind === "bash" ? "Detached job" : "Monitor"} · ${id.slice(kind === "bash" ? 5 : 4)}`;
  return { id: `${kind}:${id}`, kind, label, status };
}

function tasks(value: unknown, owner: string): readonly ActivityRow[] | undefined {
  const data = object(value);
  const list = entries(data?.tasks);
  if (data?.parent_session_id !== owner || !list) return;
  const rows = new Map<string, ActivityRow>();
  for (const value of list) {
    const task = object(value);
    if (!task || typeof task.task_id !== "string" || !taskId.test(task.task_id) ||
        typeof task.status !== "string" || typeof task.residency_state !== "string" ||
        typeof task.execution_mode !== "string") return;
    const id = task.task_id;
    rows.delete(id);
    // The RPC exposes the runner, not the store's foreground/background delivery mode.
    if ((task.execution_mode !== "process" && task.execution_mode !== "in-process") ||
        task.residency_state !== "resident") continue;
    const status = task.status === "paused" || (task.status === "running" && task.awaiting_input !== undefined)
      ? "paused" : task.status === "pending" ? "queued" : task.status === "running" ? "running" : undefined;
    if (!status) continue;
    const entry = row("agent", id, status);
    rows.set(id, { ...entry, label: taskLabel(task.task_summary) ?? taskLabel(task.name) ?? entry.label });
  }
  return [...rows.values()];
}

type MonitorDetail = { readonly startedAt: number; readonly paused: boolean };

function monitors(value: unknown): readonly MonitorDetail[] | undefined {
  const data = object(value);
  const list = entries(data?.monitors);
  if (!list || data?.activeCount !== list.length) return;
  const details = new Map<string, MonitorDetail>();
  for (const value of list) {
    const monitor = object(value);
    if (!monitor || typeof monitor.id !== "string" || !bashId.test(monitor.id) ||
        typeof monitor.paused !== "boolean" || !count(monitor.startedAtMs)) return;
    details.set(monitor.id, { startedAt: monitor.startedAtMs, paused: monitor.paused });
  }
  return details.size === list.length ? [...details.values()] : undefined;
}

type SourceRow = ActivityRow & { readonly startedAt?: number };
type Source = { readonly count: number; readonly rows: readonly SourceRow[] };
type TerminalState = { readonly seq: number; readonly bash?: Source; readonly monitor?: Source };

function terminalState(value: unknown, owner: string): TerminalState | undefined {
  const data = object(value);
  if (data?.role !== "root" || data.rootSessionId !== owner || !count(data.seq)) return;
  const waits = object(data.waitingOn);
  const sources = entries(waits?.background);
  if (data.waitingOn !== undefined && !sources) return;
  let bash: Source | undefined, monitor: Source | undefined;
  for (const value of sources ?? []) {
    const source = object(value);
    const kind = source?.source === "terminal-background-sessions" ? "bash"
      : source?.source === "terminal-monitors" ? "monitor" : undefined;
    if (!kind || !source) continue;
    if (!count(source.activeCount) || (kind === "bash" ? bash : monitor)) return;
    const items = new Map<string, number | undefined>();
    for (const value of entries(source.items)?.slice(0, 32) ?? []) {
      const item = object(value);
      const id = item?.id;
      if (item && typeof id === "string" && (kind === "bash" ? bashId : monitorId).test(id)) {
        const startedAt = typeof item.startedAt === "string" ? Date.parse(item.startedAt) : NaN;
        items.set(id, count(startedAt) ? startedAt : undefined);
      }
    }
    const rows: SourceRow[] = [...items].slice(0, source.activeCount)
      .map(([id, startedAt]) => ({ ...row(kind, id, "running"), ...(startedAt === undefined ? {} : { startedAt }) }));
    const missing = source.activeCount - rows.length;
    if (missing > 0) rows.push({
      id: `${kind}:additional`, kind, status: "running",
      label: `${missing} ${kind === "bash" ? "detached job" : "monitor"}${missing === 1 ? "" : "s"}`,
    });
    const parsed = { count: source.activeCount, rows };
    if (kind === "bash") bash = parsed;
    else monitor = parsed;
  }
  return { seq: data.seq, bash, monitor };
}

/** One projection per connection/session. Feed extension events in wire order. */
export class ActivityProjection {
  #taskRevision = 0;
  #tasks?: readonly ActivityRow[];
  #terminal?: TerminalState;
  #monitors: readonly MonitorDetail[] = [];

  constructor(readonly routeId: string, readonly durableId: string) {}

  get view(): ActivityView {
    const monitor = this.#terminal?.monitor;
    const monitorRows = monitor?.rows.map(({ startedAt, ...row }): ActivityRow => {
      const matches = this.#monitors.filter(detail => detail.startedAt === startedAt);
      return matches.length === 1 && matches[0]?.paused &&
        monitor.rows.filter(other => other.startedAt === startedAt).length === 1
        ? { ...row, status: "paused" } : row;
    }) ?? [];
    const all = [
      ...(this.#tasks ?? []),
      ...(this.#terminal?.bash?.rows.map(({ startedAt: _startedAt, ...row }) => row) ?? []),
      ...monitorRows,
    ];
    const active = all.filter(row => row.status === "running");
    return {
      active: active.length > 0,
      rows: [...active, ...all.filter(row => row.status !== "running")].slice(0, MAX_ROWS),
    };
  }

  reset(): void {
    this.#taskRevision++;
    this.#tasks = undefined;
    this.#terminal = undefined;
    this.#monitors = [];
  }

  /** Feed OmoRpc.openSession().state or getState() for this projection's connection. */
  restore(state: unknown): boolean {
    const data = object(state);
    return data?.sessionId === this.durableId && this.#setTerminal(data.lifecycle);
  }

  /** Capture before sending extension_request/omo.task.list. Feed the full RPC response. */
  beginTaskList(): (response: unknown) => boolean {
    const revision = ++this.#taskRevision;
    return response => {
      const frame = object(response);
      if (revision !== this.#taskRevision || frame?.type !== "response" ||
          frame.sessionId !== this.routeId || frame.command !== "extension_request" ||
          frame.success !== true) return false;
      return this.#setTasks(frame.data);
    };
  }

  /** True for an accepted snapshot; refresh consumers even while the sidebar is closed. */
  observe(event: unknown): boolean {
    const frame = object(event);
    if (frame?.sessionId !== this.routeId) return false;
    if (frame.type === "session_lifecycle") return this.#setTerminal(frame.lifecycle);
    if (frame.type !== "extension_event") return false;
    switch (frame.name) {
      case "omo.task.updated":
        return this.#setTasks(frame.data);
      case "terminal_monitor_state": {
        const rows = monitors(frame.data);
        if (!rows) return false;
        this.#monitors = rows;
        return true;
      }
      default:
        return false;
    }
  }

  #setTerminal(value: unknown): boolean {
    const next = terminalState(value, this.durableId);
    if (!next || next.seq <= (this.#terminal?.seq ?? -1)) return false;
    this.#terminal = next;
    return true;
  }

  #setTasks(value: unknown): boolean {
    const rows = tasks(value, this.durableId);
    if (!rows) return false;
    this.#tasks = rows;
    this.#taskRevision++;
    return true;
  }
}
