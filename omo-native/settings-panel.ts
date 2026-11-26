import { add, node } from "./surface";
import type { RpcRecord } from "./rpc";

type Choice = { readonly id: string; readonly label: string; readonly current?: boolean };
type View = {
  readonly active: string;
  readonly pinned: boolean;
  readonly model: string;
  readonly effort: string;
  readonly fast: boolean;
  readonly levels: readonly Choice[];
  readonly speeds: readonly Choice[];
};

const button = (id: string, text: string, action: string, props: RpcRecord = {}) =>
  node(id, "button", { text, variant: "quiet", ...props, actions: { click: action } });
const label = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const speedOrder = ["Ultrafast", "Fast", "Standard"];
const modelsButton = (model: string, active = false) => button("sp-models", model, "models", {
  title: model, aria: `Select model: ${model}`,
  role: active ? "omo.settings-active" : "",
});

export function effortPanel(v: View) {
  const index = v.levels.findIndex(row => row.current);
  const preview = v.levels.find(row => row.id === v.active);
  const speed = v.speeds.length ? [
    node("sp-speed", "row", { role: v.pinned ? "omo.speed-open" : "omo.speed" }, [
      button("sp-speed-trigger", v.fast ? "" : "Speed", "speed", {
        icon: v.fast ? "bolt" : "", aria: "Speed", title: "Speed (Ctrl+S)",
        role: v.active === "speed" ? "omo.settings-active" : "",
      }),
      node("sp-speed-options", "col", { aria: "Speed options" },
        [...v.speeds].sort((a, b) => speedOrder.indexOf(b.label) - speedOrder.indexOf(a.label))
          .map(row => button(`sp-${row.id}`, row.label, row.id, {
            icon: row.current ? "check" : "",
            aria: row.current ? `${row.label}, current speed` : row.label,
            role: v.active === row.id ? "omo.settings-active" : "",
          }))),
    ]),
  ] : [];
  return [
    node("sp-header", "row", {}, [
      ...speed,
      node("sp-title", "text", { text: v.effort }),
      button("sp-close", "", "close", { icon: "x", aria: "Close model settings", title: "Close (Esc)" }),
    ]),
    modelsButton(v.model, v.active === "models"),
    ...(v.levels.length > 1 ? [
      node("sp-effort", "slider", {
        min: 0, max: v.levels.length - 1, step: 1, value: index < 0 ? -1 : index,
        label: "Reasoning effort", title: `${v.levels.map(row => label(row.label)).join(" · ")} (Left/Right, Enter)`,
        ticks: true, variant: "accent", role: index < 0 ? "omo.effort-unknown" : "",
      }),
    ] : v.levels.filter(row => !row.current).map(row => button("sp-unset-effort", label(row.label), row.id, {
      role: v.active === row.id ? "omo.settings-active" : "",
    }))),
    ...(preview ? [node("sp-effort-preview", "text", { text: `${label(preview.label)} · Enter to select` })] : []),
  ];
}

export function modelsPanel(view: { readonly rows: readonly Choice[]; readonly selected: string; readonly query: string }) {
  return [
    node("sp-model-head", "row", {}, [
      button("sp-back", "‹", "back", { title: "Back", aria: "Back to model settings" }),
      node("sp-model-title", "text", { text: "Select model" }),
      button("sp-close", "", "close", { icon: "x", aria: "Close model settings", title: "Close (Esc)" }),
    ]),
    ...(view.query ? [node("sp-filter", "text", { text: view.query, aria: "Model filter" })] : []),
    node("sp-list", "list", {
      max: 0.30, aria: "Available models", selected: `sp-${view.selected}`, filter: view.query, empty: "No matching models",
    }, view.rows.map(row => node(`sp-${row.id}`, "item", {
      label: row.label, title: row.label, value: row.current ? "✓" : "",
      aria: row.current ? `${row.label}, current model` : row.label,
    }))),
  ];
}

export function settingsStatus(message: string, options: readonly ("back" | "retry" | "close")[], modelRoute = false) {
  const copy = { back: "Back", retry: "Reload", close: "Close" };
  return [node("sp-message", "text", { text: message }),
    ...(modelRoute ? [modelsButton("Model")] : []),
    node("sp-recovery", "row", {}, options.map(action => button(`sp-${action}`, copy[action], action)))];
}

export function settingsOverlay(id: string) {
  return [
    add("layer", button(`${id}.dismiss`, "", "close", { role: "omo.settings-dismiss", aria: "Dismiss model settings" })),
    add("layer", node(id, "overlay", { anchor: { node: "model", side: "above" }, aria: "Model settings", role: "omo.settings" })),
  ];
}
