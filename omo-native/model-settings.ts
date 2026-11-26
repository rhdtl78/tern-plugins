import type { OmoRpc, RpcRecord } from "./rpc";
import { node, plain, record, string, type Op } from "./surface";
import { usageNode } from "./usage";

class ModelSettingsError extends Error {
  readonly name = "ModelSettingsError";
}

type Model = { readonly provider: string; readonly modelId: string };
export type Setting = (Model & { readonly tier?: string }) | { readonly level: string };
type SettingRow = {
  readonly id: string; readonly label: string; readonly detail: string; readonly current?: boolean;
  readonly target: Setting;
};
function tierLabel(value: unknown) {
  return value === "priority" ? "fast" : string(value);
}

export function appliedSettings(state: RpcRecord) {
  const model = record(state.model), id = string(model.id), name = string(model.name);
  const tier = tierLabel(state.serviceTier);
  const suffix = /-(fast|ultrafast)$/.exec(id);
  const upstream = tier === "fast" || tier === "ultrafast" ? string(model.upstreamModelId) : "";
  const base = upstream && upstream !== id ? upstream : suffix && suffix[1] === tier ? id.slice(0, suffix.index) : "";
  return { model: plain(base || name || id || "No model selected"),
    tier: plain(tier), thinking: plain(string(state.thinkingLevel)) };
}

function sameModel(a: RpcRecord, b: RpcRecord) {
  return !!a.id && a.id === b.id && a.provider === b.provider;
}

export async function modelCatalog(rpc: Pick<OmoRpc, "request" | "getProtocolInfo">, state: RpcRecord) {
  const { capabilities } = record((await rpc.getProtocolInfo()).data);
  if (!Array.isArray(capabilities) || !capabilities.includes("session_model_scope"))
    throw new ModelSettingsError("This OmO engine cannot switch models for only this session. Update OmO to use this picker.");
  const { models } = record((await rpc.request("get_available_models")).data);
  if (!Array.isArray(models)) throw new ModelSettingsError("Invalid model catalog from OmO");
  const catalog = models.map(record);
  for (const m of catalog) if (!string(m.provider) || !string(m.id))
    throw new ModelSettingsError("Model catalog entry is missing its provider or ID");
  const byKey = new Map(catalog.map(m => [JSON.stringify([m.provider, m.id]), m]));
  function baseOf(m: RpcRecord) {
    const tier = tierLabel(m.serviceTier);
    if (tier !== "fast" && tier !== "ultrafast") return m;
    const upstream = string(m.upstreamModelId);
    const id = string(m.id);
    const baseId = upstream && upstream !== id ? upstream
      : id.endsWith(`-${tier}`) ? id.slice(0, -tier.length - 1) : "";
    const base = byKey.get(JSON.stringify([m.provider, baseId]));
    return base && !["fast", "ultrafast"].includes(tierLabel(base.serviceTier)) ? base : m;
  }
  const current = record(state.model);
  const listed = byKey.get(JSON.stringify([current.provider, current.id]));
  const base = listed && baseOf(listed);
  const modelsRows: SettingRow[] = [], tiers: SettingRow[] = [];
  for (const [i, m] of catalog.entries()) {
    const provider = string(m.provider), modelId = string(m.id), group = baseOf(m);
    const tier = tierLabel(m.serviceTier);
    if (base && group === base) {
      tiers.push({ id: `t${i}`, label: tier && !["auto", "default"].includes(tier)
        ? plain(tier.charAt(0).toUpperCase() + tier.slice(1)) : "Standard",
        detail: plain(`${provider}/${modelId}`),
        current: settingApplied(state, { provider, modelId, tier }),
        target: { provider, modelId, tier } });
    }
    if (group !== m) continue;
    modelsRows.push({ id: `m${i}`, label: plain(string(m.name) || modelId), detail: plain(`${provider}/${modelId}`),
      current: sameModel(m, base ?? current),
      target: sameModel(m, base ?? current) && listed
        ? { provider, modelId: string(listed.id) } : { provider, modelId } });
  }
  return { models: modelsRows, tiers: tiers.length > 1 ? tiers : [] };
}

export async function thinkingChoices(rpc: Pick<OmoRpc, "request">, state: RpcRecord): Promise<SettingRow[]> {
  if (!string(record(state.model).id)) return [];
  const { levels } = record((await rpc.request("get_available_thinking_levels")).data);
  if (!Array.isArray(levels) || !levels.every(level => typeof level === "string" && level))
    throw new ModelSettingsError("Invalid Thinking levels from OmO");
  return [...new Set<string>(levels)].map((level, i) => ({
    id: `l${i}`, label: plain(level), detail: "", current: level === state.thinkingLevel, target: { level },
  }));
}

export async function changeSetting(rpc: Pick<OmoRpc, "request">, target: Setting) {
  if ("level" in target) {
    // The wire names the non-device scope "turn"; the engine applies it to the active session.
    await rpc.request("set_thinking_level", { level: target.level, scope: "turn" });
  } else {
    await rpc.request("set_model", { provider: target.provider, modelId: target.modelId, scope: "session" });
  }
}

export function settingApplied(state: RpcRecord, target: Setting) {
  if ("level" in target) return state.thinkingLevel === target.level;
  if (!sameModel(record(state.model), { provider: target.provider, id: target.modelId })) return false;
  const effectiveTier = tierLabel(state.serviceTier);
  // OmO can report "auto" or "default" even when the base catalog entry omits its tier.
  return target.tier === undefined || effectiveTier === target.tier
    || (target.tier === "" && (effectiveTier === "auto" || effectiveTier === "default"));
}

export const settingsCss = `
.sf-col[data-id="composer"] > .sf-row[data-id="footer"] { flex-wrap: wrap; }
.sf-row[data-id="model-settings"] { flex: 0 1 auto; min-width: 0; max-width: 100%; gap: var(--omo-composer-row-gap); }
.sf-menu[data-id="model"] { flex: 0 1 auto; min-width: 0; }
.sf-menu[data-id="model"] .sf-menu-trigger {
  border: var(--omo-composer-edge) solid var(--l3);
  border-radius: 999px;
  min-width: 0;
  max-width: 100%;
}
.sf-menu[data-id="model"] .sf-btn-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sf-menu[data-id="model"] .sf-menu-subpop {
  width: max-content;
  min-width: 0;
  top: auto;
  bottom: 0;
}
`;

export const modelSettingsKey = (key: string) => key === "\x13" || key === "\x1b[115;5u";

export function settingsNode(quotaAvailable: boolean) {
  return node("model-settings", "row", { align: "center" }, [
    node("model", "menu", { text: "OMO", trigger: "quiet", variant: "dense",
      title: "Model settings", disabled: true, open: false, items: [] }),
    ...(quotaAvailable ? [usageNode()] : []),
  ]);
}

/** Owns the last readback and fences reads superseded by newer reads, local writes, or shutdown. */
export class SessionSettings {
  #model: RpcRecord = {};
  #revision = 0;
  #applying = false;

  constructor(private readonly publish: (model: unknown, ops: Op[]) => void) {}

  get input() { return this.#model.input; }
  get applying() { return this.#applying; }

  show(state: RpcRecord) {
    this.#model = record(state.model);
    const { model, thinking, tier } = appliedSettings(state);
    const speed = tier && !["auto", "default", "standard"].includes(tier) ? tier : "";
    const description = `Model settings: ${model}; Thinking: ${thinking || "not reported"}; Service tier: ${tier || "not reported"}`;
    this.publish(state.model, [["set", "model", {
      text: [thinking, speed, model].filter(Boolean).join(" · "),
      title: `Ctrl+S · ${description}`, aria: description,
    }]]);
  }

  invalidate() { this.#revision++; }

  async read(client: OmoRpc, live = () => true) {
    const revision = ++this.#revision;
    const state = await client.getState();
    if (revision === this.#revision && live()) this.show(state);
    return state;
  }

  async observed(client: OmoRpc, event: RpcRecord) {
    const expected = this.#revision + 1;
    try { await this.read(client); }
    catch {
      if (expected === this.#revision && string(record(event.model).id)) this.show(event);
    }
  }

  async apply(client: OmoRpc, target: Setting) {
    this.#applying = true;
    this.invalidate();
    try {
      try { await changeSetting(client, target); }
      catch (error) {
        // A refused or unacknowledged write may still have changed the session.
        await this.read(client).catch(() => undefined);
        throw error;
      }
      if (!settingApplied(await this.read(client), target))
        throw new ModelSettingsError("OmO did not confirm the selected setting");
    } finally { this.#applying = false; }
  }
}
