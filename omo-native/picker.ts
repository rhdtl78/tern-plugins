import { basename } from "node:path";
import type { Setting, SettingKind } from "./model-settings";
import { plain, string, type Input } from "./surface";
import { resumeHeaderFields } from "./session";
import { listedHeader, type SavedSession, type SavedTarget } from "./history";

type Row = {
  readonly id: string; readonly label: string; readonly detail: string; readonly current?: boolean;
  readonly target: Setting | SavedTarget;
};

export function savedRows(sessions: readonly SavedSession[]): Row[] {
  return sessions.map(({ title, modifiedAt, ...target }, i) => ({
    id: `s${i}`, label: plain(title || basename(target.path)),
    detail: plain(`${new Date(modifiedAt).toLocaleString()} · ${basename(target.path)}`), target,
  }));
}

/** Recheck the catalog path at activation, not just when the row was listed. */
export async function selectedSession(target: SavedTarget, cwd: string) {
  const verify = async () => resumeHeaderFields(target.path, cwd, await listedHeader(target));
  return { fields: await verify(), verify };
}

type Effect = "draw" | "close" | "use" | "retry" | undefined;
export class Picker {
  state: "loading" | "ready" | "error" = "loading";
  message = "";
  applying = false;
  query = "";
  selected = "";
  rows: readonly Row[] = [];
  constructor(readonly kind: SettingKind | "sessions", readonly id: string) {}

  get visible() {
    const q = this.query.trim().toLowerCase();
    return this.rows.filter(row => !q || `${row.label} ${row.detail}`.toLowerCase().includes(q));
  }
  get choice() { return this.visible.find(row => row.id === this.selected); }
  load(rows: readonly Row[]) {
    this.rows = rows;
    this.state = "ready";
    this.selected = rows.find(row => row.current)?.id ?? rows[0]?.id ?? "";
    this.filter(this.query);
  }
  private filter(query: string): Effect {
    this.query = query;
    if (!this.choice) this.selected = this.visible[0]?.id ?? "";
    return "draw";
  }
  // Send the catalog on load, not on every keystroke. Tern filters by `order`.
  props(catalog = false) {
    const copy = {
      models: ["Choose model", "Use model", "No available models"],
      tiers: ["Choose service tier", "Use tier", "No confirmed service tier choices for this model"],
      thinking: ["Choose Thinking level", "Use level", "No supported Thinking levels for this model"],
      sessions: ["Resume session", "Resume", "No saved sessions for this project"],
    }[this.kind];
    return {
      role: `omo.${this.kind}`, title: copy[0], size: "md", preview: "none",
      noun: this.kind, query: this.query, selected: this.selected, state: this.state, message: this.message,
      empty: copy[2],
      ...(catalog ? { items: this.rows.map(({ id, label, detail }) => ({ id, label, detail })),
        current: this.rows.filter(row => row.current).map(row => row.id) } : {}),
      order: this.visible.map(row => row.id), total: this.rows.length,
      actions: [
        { id: "close", label: "Cancel", keys: ["esc"], disabled: this.applying },
        ...(this.state === "error" ? [{ id: "retry", label: "Reload" }] : []),
        { id: "use", label: copy[1], keys: ["enter"], primary: true,
          disabled: this.state !== "ready" || !this.selected },
      ],
    };
  }
  input(i: Input): Effect {
    if (this.applying) return;
    if (i.kind === "event") {
      const e = i.value;
      if (e.id !== this.id) return;
      if (e.ev === "action") {
        if (e.act === "close") return "close";
        if (e.act === "retry" && this.state === "error") return "retry";
        if (e.act === "clear") return this.filter("");
        if (e.act === "use" && this.state === "ready" && this.choice) return "use";
      }
      if ((e.ev === "select" || e.ev === "activate") && this.state === "ready" &&
          this.visible.some(row => row.id === e.item)) {
        this.selected = string(e.item);
        return e.ev === "activate" ? "use" : "draw";
      }
      return;
    }
    if (i.kind === "paste") return this.filter(this.query + plain(i.value).replace(/\s+/g, " "));
    switch (i.value) {
      case "\x1b": case "\x1b[27u": case "\x03": return "close";
      case "\r": case "\x1b[13u": return this.state === "ready" && this.choice ? "use" : undefined;
      case "\x1b[A": case "\x1b[B": {
        const rows = this.visible, index = rows.findIndex(row => row.id === this.selected);
        this.selected = rows[Math.max(0, Math.min(rows.length - 1, index + (i.value.endsWith("A") ? -1 : 1)))]?.id ?? "";
        return "draw";
      }
      case "\b": case "\x7f": case "\x1b[127u": return this.filter([...this.query].slice(0, -1).join(""));
      default: if (/^[^\p{Cc}]$/u.test(i.value)) return this.filter(this.query + i.value);
    }
  }
}
