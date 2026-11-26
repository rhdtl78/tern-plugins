import { appliedSettings, modelCatalog, modelSettingsKey, thinkingChoices, type SessionSettings } from "./model-settings";
import { Picker } from "./picker";
import type { OmoRpc, RpcRecord } from "./rpc";
import { plain, string, type Input } from "./surface";

type Page = "settings" | "models" | "tiers";
type Catalog = Awaited<ReturnType<typeof modelCatalog>>;
const message = (error: unknown) => plain(error instanceof Error ? error.message : String(error));

/** Native menu at the root; searchable sheets for model choices and recovery. */
export class SettingsPicker extends Picker {
  #view: ReturnType<typeof appliedSettings> | undefined;
  #stateError = "";
  #catalog: Catalog | undefined;
  #catalogError = "";
  #thinkingError = "";
  #thinking: Awaited<ReturnType<typeof thinkingChoices>> = [];
  #revision = 0;
  #active = "";
  menuOpen = true;

  constructor(id: string) { super("settings", id); }
  protected override get searchQuery() { return this.kind === "settings" ? null : super.searchQuery; }

  get #speed() { return this.#catalog?.tiers ?? []; }

  menuProps() {
    const row = ({ id, label, current }: Catalog["tiers"][number]) => ({ id, label, checked: !!current });
    return { open: true, active: this.#active, items: [
      { header: this.state === "loading" ? "Loading settings…" : `Thinking: ${this.#view?.thinking || "Not reported"}` },
      ...(this.#thinkingError ? [{ header: "Thinking options unavailable" }] : []),
      ...(this.state === "error" && this.kind === "settings" ? [{ id: "reload", label: "Reload", detail: this.message }] : []),
      ...this.#thinking.map(row),
      { id: "models", label: this.#view?.name || "Model" },
      ...(this.#speed.length ? [{ id: "speed", label: "Speed", icon: this.#view?.tier === "fast" ? "bolt" : "",
        items: this.#speed.map(row) }] : []),
    ] };
  }

  menuInput(i: Input) {
    let act = "";
    const tiers = this.#speed;
    const root = [...this.#thinking.map(row => row.id), "models", ...(tiers.length ? ["speed"] : []),
      ...(this.state === "error" ? ["reload"] : [])];
    if (i.kind === "event") {
      if (i.value.id !== "model") return;
      if (i.value.ev === "toggle" && i.value.open === false) return "close";
      if (i.value.ev === "action") act = string(i.value.act);
    } else if (i.kind === "key") {
      const key = i.value;
      const tierIds = tiers.map(row => row.id);
      const inSpeed = tierIds.includes(this.#active);
      const move = (ids: string[], delta: number) => {
        const index = ids.indexOf(this.#active);
        this.#active = ids[((index < 0 && delta < 0 ? 0 : index) + delta + ids.length) % ids.length] ?? "";
        return "draw" as const;
      };
      if (modelSettingsKey(key) && tiers.length) {
        this.#active = tiers.find(row => row.current)?.id ?? tiers[0].id;
        return "draw";
      }
      switch (key) {
        case "\x1b": case "\x1b[27u": case "\x03": return "close";
        case "\t": case "\x1b[9u": case "\x1b[B": return move(inSpeed ? tierIds : root, 1);
        case "\x1b[Z": case "\x1b[9;2u": case "\x1b[A": return move(inSpeed ? tierIds : root, -1);
        case "\x1b[D": if (inSpeed) { this.#active = "speed"; return "draw"; } return;
        case "\x1b[C": if (this.#active !== "speed") return; break;
        case "\r": case "\x1b[13u": act = this.#active; break;
        default: return;
      }
      if (this.#active === "speed" && tiers.length) {
        this.#active = tiers.find(row => row.current)?.id ?? tiers[0].id;
        return "draw";
      }
    }
    if (act === "models") { this.page("models"); return "models"; }
    if (act === "reload" && this.state === "error") return "retry";
    if (tiers.some(row => row.id === act)) this.page("tiers");
    else if (!this.#thinking.some(row => row.id === act)) return;
    this.selected = act;
    return "use";
  }

  override props(catalog = false) {
    const props = super.props(catalog);
    const thinking = this.#view?.thinking;
    return {
      ...props,
      title: this.kind === "settings" ? `Thinking: ${thinking || "Not reported"}` : this.kind === "tiers" ? "Speed" : props.title,
      actions: [
        ...props.actions.slice(0, -1),
        { id: "back", label: "Back", disabled: this.applying },
        ...props.actions.slice(-1),
      ],
    };
  }

  override input(i: Input) {
    if (this.applying) return;
    if (i.kind === "key") {
      switch (i.value) {
        case "\t": case "\x1b[9u": return this.step(1, true);
        case "\x1b[Z": case "\x1b[9;2u": return this.step(-1, true);
        default: if (this.kind === "settings" && /^[^\p{Cc}]$/u.test(i.value)) return;
      }
    }
    if (i.kind === "paste" && this.kind === "settings") return;
    if (i.kind === "event" && i.value.id === this.id && i.value.ev === "action") {
      if (i.value.act === "back") return "back";
    }
    return super.input(i);
  }

  page(kind: Page) {
    if (this.kind !== kind) this.query = "";
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
