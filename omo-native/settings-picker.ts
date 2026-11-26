import { appliedSettings, modelCatalog, modelSettingsKey, thinkingChoices, type SessionSettings } from "./model-settings";
import { Picker } from "./picker";
import type { OmoRpc, RpcRecord } from "./rpc";
import { effortPanel, modelsPanel, settingsOverlay, settingsStatus } from "./settings-panel";
import { add, node, plain, string, type Input, type Op } from "./surface";

type Page = "settings" | "models" | "tiers";
type Catalog = Awaited<ReturnType<typeof modelCatalog>>;
const message = (error: unknown) => plain(error instanceof Error ? error.message : String(error));

/** Confirmed settings and keyboard routing for the composer overlay. */
export class SettingsPicker extends Picker {
  #view: ReturnType<typeof appliedSettings> | undefined;
  #stateError = "";
  #catalog: Catalog | undefined;
  #catalogError = "";
  #thinkingError = "";
  #thinking: Awaited<ReturnType<typeof thinkingChoices>> = [];
  #revision = 0;
  #active = "";
  #pinned = false;
  #rendered = false;

  constructor(id: string) { super("settings", id); }

  get #speed() { return this.#catalog?.tiers ?? []; }

  mount() { return settingsOverlay(this.id); }
  remove(): Op[] { return [["del", this.id], ["del", `${this.id}.dismiss`]]; }

  draw(): Op[] {
    const body = `${this.id}.body`;
    const root = this.kind === "settings";
    const effort = this.#view?.thinking;
    const children = this.applying ? settingsStatus("Applying setting…", [])
      : this.state === "error" ? settingsStatus(this.message, root ? ["retry", "close"] : ["back", "retry", "close"], root)
      : this.state === "loading" ? settingsStatus(root ? "Loading settings…" : "Loading models…", root ? ["close"] : ["back", "close"], root)
      : this.kind === "models" ? modelsPanel({ rows: this.visible, selected: this.selected, query: this.query })
      : effortPanel({
        active: this.#active, pinned: this.#pinned, model: this.#view?.name || "Model",
        effort: effort ? effort.charAt(0).toUpperCase() + effort.slice(1)
          : this.#thinkingError ? "Effort unavailable" : "Effort not reported",
        fast: this.#view?.tier === "fast", levels: this.#thinking, speeds: this.#speed,
      });
    const ops: Op[] = [];
    if (this.#rendered) ops.push(["del", body]);
    this.#rendered = true;
    ops.push(add(this.id, node(body, "col", { role: "omo.settings-body" }, children)));
    return ops;
  }

  #chooseRoot(act: string) {
    if (act === "models") { this.page("models"); return "draw"; }
    if (this.state !== "ready") return;
    if (this.#speed.some(row => row.id === act)) this.page("tiers");
    else if (!this.#thinking.some(row => row.id === act)) return;
    this.selected = act;
    return "use";
  }

  override input(i: Input) {
    if (this.applying) return;
    let act = "";
    const tiers = this.#speed;
    const levels = this.#thinking.map(row => row.id);
    const root = [...(tiers.length ? ["speed"] : []), "models", ...levels];
    if (i.kind === "event") {
      const e = i.value, id = string(e.id);
      if (id === "model" && e.ev === "action" && e.act === "settings") return "close";
      if (id === "sp-effort" && e.ev === "change" && typeof e.value === "number") return this.#chooseRoot(levels[e.value] ?? "");
      if (id === "sp-list" && e.ev === "select" && typeof e.item === "string" && e.item.startsWith("sp-")) {
        return super.input({ kind: "event", value: { id: this.id, ev: "activate", item: e.item.slice(3) } });
      }
      if (e.ev !== "action" || !(id.startsWith("sp-") || id === `${this.id}.dismiss`)) return;
      act = string(e.act);
    } else if (i.kind === "key") {
      const key = i.value;
      if (["\x1b", "\x1b[27u", "\x03"].includes(key)) return "close";
      if (this.kind !== "settings") {
        if (key === "\x1b[D" && !this.query) return "back";
        if (this.state === "error" && (key === "\r" || key === "\x1b[13u")) {
          if (this.kind === "tiers") this.page("settings");
          return "retry";
        }
        if (this.state !== "ready") return;
        if (key === "\t" || key === "\x1b[9u") { this.step(1, true); return "select"; }
        if (key === "\x1b[Z" || key === "\x1b[9;2u") { this.step(-1, true); return "select"; }
        const effect = super.input(i);
        return effect === "draw" && (key === "\x1b[A" || key === "\x1b[B") ? "select" : effect;
      }
      const tierIds = tiers.map(row => row.id);
      const move = (ids: string[], delta: number) => {
        if (!ids.length) return;
        const index = ids.indexOf(this.#active);
        this.#active = ids[((index < 0 && delta < 0 ? 0 : index) + delta + ids.length) % ids.length] ?? "";
        return "draw" as const;
      };
      if (modelSettingsKey(key) && tiers.length) act = "speed";
      else if (this.state !== "ready") {
        if (key === "\r" || key === "\x1b[13u") return this.state === "error" ? "retry" : undefined;
        return;
      } else {
        switch (key) {
          case "\t": case "\x1b[9u": case "\x1b[B": return move(this.#pinned ? tierIds : root, 1);
          case "\x1b[Z": case "\x1b[9;2u": case "\x1b[A": return move(this.#pinned ? tierIds : root, -1);
          case "\x1b[D": case "\x1b[C":
            if (this.#pinned) {
              if (key === "\x1b[C") return;
              this.#pinned = false;
              this.#active = "speed";
              return "draw";
            }
            if (this.#active === "speed" && key === "\x1b[C") { act = "speed"; break; }
            if (!levels.includes(this.#active)) this.#active = this.#thinking.find(row => row.current)?.id ?? "";
            return move(levels, key === "\x1b[C" ? 1 : -1);
          case "\r": case "\x1b[13u": act = this.#active; break;
          default: return;
        }
      }
    } else if (this.kind === "models" && this.state === "ready") {
      return super.input(i);
    }
    if (act === "close" || act === "back") return act;
    if (act === "retry" && this.state === "error") {
      if (this.kind === "tiers") this.page("settings");
      return "retry";
    }
    if (act === "speed" && tiers.length) {
      this.#pinned = !this.#pinned;
      this.#active = this.#pinned ? tiers.find(row => row.current)?.id ?? tiers[0]?.id ?? "" : "speed";
      return "draw";
    }
    if (this.kind === "settings") return this.#chooseRoot(act);
  }

  page(kind: Page) {
    if (this.kind !== kind) { this.query = ""; this.#active = ""; this.#pinned = false; }
    this.kind = kind;
    this.message = "";
    if (!this.#view) {
      this.state = this.#stateError ? "error" : "loading";
      this.message = this.#stateError;
      return;
    }
    if (kind === "settings") {
      this.load(this.#thinking);
      return;
    }
    this.load(this.#catalog?.[kind] ?? []);
    if (!this.#catalog) {
      this.state = this.#catalogError ? "error" : "loading";
      this.message = this.#catalogError;
    }
  }

  async reload({ settings, client, live, draw }: {
    settings: SessionSettings; client: Pick<OmoRpc, "getState" | "getProtocolInfo" | "request">; live: () => boolean; draw: () => void;
  }) {
    const revision = ++this.#revision;
    const current = () => live() && revision === this.#revision;
    this.#view = undefined;
    this.#catalog = undefined;
    this.#stateError = this.#catalogError = this.#thinkingError = "";
    this.#thinking = [];
    this.#active = "";
    this.#pinned = false;
    this.load([]);
    this.page(this.kind === "models" || this.kind === "tiers" ? this.kind : "settings");
    draw();
    let state: RpcRecord;
    try { state = await settings.read(client); }
    catch (error) {
      if (current()) {
        this.#stateError = message(error) || "Could not load session settings";
        this.page(this.kind === "models" || this.kind === "tiers" ? this.kind : "settings");
        draw();
      }
      return;
    }
    if (!current()) return;
    this.#view = appliedSettings(state);
    this.page(this.kind === "models" || this.kind === "tiers" ? this.kind : "settings");
    draw();
    const catalog = modelCatalog(client, state).then(value => {
      if (!current()) return;
      this.#catalog = value;
    }, error => {
      if (!current()) return;
      this.#catalogError = message(error);
    }).then(() => {
      if (!current() || this.applying) return;
      if (this.kind === "models" || this.kind === "tiers") this.page(this.kind);
      draw();
    });
    const thinking = thinkingChoices(client, state).then(value => {
      if (current()) this.#thinking = value;
    }, error => {
      if (current()) this.#thinkingError = message(error);
    }).then(() => {
      if (!current() || this.applying || this.kind !== "settings") return;
      this.page("settings"); draw();
    });
    await Promise.all([catalog, thinking]);
  }
}
