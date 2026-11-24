import type { RpcRecord } from "./rpc";
import { node, record } from "./surface";
import type { Surface } from "./surface";

const providers = {
  "anthropic-subscription": {
    name: "Claude", base: ["claude:5h", "claude:7d"],
    icon: "provider-anthropic",
  },
  "chatgpt-subscription": {
    name: "ChatGPT", base: ["codex:primary", "codex:secondary"],
    icon: "provider-openai",
  },
} as const;

type Provider = keyof typeof providers;
type ModelScope = { readonly provider: Provider; readonly id: string };
type Usage = {
  readonly provider: Provider;
  readonly account: string;
  readonly used: number;
  readonly title: string;
  readonly expires?: number;
};

export interface UsageRpc {
  request(type: "get_provider_accounts", fields: RpcRecord): Promise<RpcRecord>;
  subscriptionLimits(): Promise<RpcRecord>;
}

const rows = (value: unknown): RpcRecord[] => Array.isArray(value) ? value.map(record) : [];

function scope(model: unknown): ModelScope | undefined {
  const { provider, id } = record(model);
  if ((provider === "anthropic-subscription" || provider === "chatgpt-subscription") &&
      typeof id === "string" && id) return { provider, id };
}

function measure(provider: Provider, accounts: RpcRecord, limits: RpcRecord, now: number): Usage | undefined {
  const descriptors = rows(record(accounts.data).accounts);
  const active = descriptors.filter(a => a.active === true);
  if (active.length !== 1) return;
  const account = active[0];
  if (typeof account.name !== "string" || !account.name || account.blocked === true ||
      account.paused === true || account.signedOut === true ||
      descriptors.filter(a => a.name === account.name).length !== 1) return;

  const matches = rows(record(limits.data).accounts).filter(a => a.provider === provider && a.account === account.name);
  if (matches.length !== 1 || matches[0].error !== undefined) return;
  const { reportedAt, windows } = matches[0];
  if (typeof reportedAt !== "string") return;
  const reported = Date.parse(reportedAt);
  if (!Number.isFinite(reported) || reported > now) return;

  const base = rows(windows);
  let selected: Usage | undefined;
  // Iterate in provider order so equal depletion never depends on response order.
  for (const id of providers[provider].base) {
    const matches = base.filter(w => w.id === id);
    if (matches.length > 1) return;
    if (!matches.length) continue;
    const { label, usedPercent: used, resetsAt } = matches[0];
    if (typeof label !== "string" || !/^[\w -]{1,24}$/.test(label) ||
        typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) continue;
    const expires = typeof resetsAt === "string" ? Date.parse(resetsAt) : undefined;
    if (resetsAt !== undefined && (expires === undefined || !Number.isFinite(expires) || expires <= now)) continue;
    if (selected && selected.used >= used) continue;
    // Keep tiny measured shares from appearing as zero or 100 at display precision.
    const percent = (value: number) => value > 0 && value < 0.01 ? "<0.01" :
      value < 100 && value > 99.99 ? ">99.99" : String(Number(value.toFixed(2)));
    selected = {
      provider, account: account.name, used, expires,
      title: `${providers[provider].name} ${label}: ${percent(used)}% used, ${percent(100 - used)}% remaining`,
    };
  }
  return selected;
}

/** One meter per opened RPC session. Host events invalidate; only scoped reads can publish. */
export class UsageMeter {
  #scope?: ModelScope;
  #revision = 0;
  #queued?: Promise<void>;
  #shown?: Usage;
  #expiry?: ReturnType<typeof setTimeout>;
  #closed = false;

  constructor(
    private readonly rpc: UsageRpc,
    private readonly render: (usage: Usage | undefined) => void,
  ) {}

  setModel(model: unknown): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const next = scope(model);
    if (next?.provider === this.#scope?.provider && next?.id === this.#scope?.id) return Promise.resolve();
    this.reset();
    this.#scope = next;
    return this.refresh();
  }

  /** Drop the model and invalidate in-flight reads before a session replacement. */
  reset(): void {
    this.#scope = undefined;
    this.#revision++;
    this.#publish(undefined);
  }

  close(): void {
    this.#closed = true;
    this.reset();
  }

  event(event: RpcRecord): Promise<void> {
    switch (event.type) {
      case "model_changed": return this.setModel(event.model);
      case "agent_start":
      case "agent_end": return this.refresh();
      case "auth_accounts_changed":
      case "account_failover":
        if (this.#scope && event.provider === this.#scope.provider) {
          this.#publish(undefined);
          return this.refresh();
        }
        break;
      case "subscription_limits":
        if (this.#scope && event.provider === this.#scope.provider) {
          // The wire event may overtake a read. Reread the authoritative host snapshot.
          if (event.error !== undefined && event.account === this.#shown?.account) this.#publish(undefined);
          return this.refresh();
        }
        break;
    }
    return Promise.resolve();
  }

  refresh(): Promise<void> {
    if (!this.#scope) return Promise.resolve();
    this.#revision++;
    // Coalesce bursts before beginning reads, e.g. model_changed + agent_start.
    return this.#queued ??= Promise.resolve().then(async () => {
      this.#queued = undefined;
      const current = this.#scope;
      if (!current) return;
      const revision = this.#revision;
      const { provider } = current;
      const reads = await Promise.all([
        this.rpc.subscriptionLimits(),
        this.rpc.request("get_provider_accounts", { provider }),
      ]).catch(() => undefined);
      if (revision !== this.#revision) return;
      const usage = reads && measure(provider, reads[1], reads[0], Date.now());
      this.#publish(usage);
    });
  }

  #publish(usage: Usage | undefined): void {
    clearTimeout(this.#expiry);
    const previous = this.#shown;
    this.#shown = usage;
    if (previous?.used !== usage?.used || previous?.title !== usage?.title) this.render(usage);
    if (usage?.expires !== undefined) {
      const retire = () => {
        const remaining = (usage.expires ?? 0) - Date.now();
        if (remaining > 0) {
          this.#expiry = setTimeout(retire, Math.min(remaining, 2_147_483_647));
          return;
        }
        this.#publish(undefined);
        void this.refresh();
      };
      retire();
    }
  }
}

const slot = "omo-usage";
const ring = "omo-usage-ring";
const icon = "omo-usage-icon";

export const usageCss = `
.sf-row[data-id="${slot}"] {
  position: relative;
  flex: 0 0 24px;
  width: 24px;
  height: 24px;
}
.sf-row[data-id="${slot}"] > .sf-icon[data-id="${icon}"] {
  position: absolute;
  left: 6px;
  top: 6px;
  pointer-events: none;
}
.sf-row[data-id="${slot}"] > .sf-icon[data-id="${icon}"],
.sf-row[data-id="${slot}"] > .sf-icon[data-id="${icon}"] .ico {
  width: 12px;
  height: 12px;
}
`;

export function supportsUsage(hello: RpcRecord): boolean {
  return Array.isArray(hello.kinds) && hello.kinds.includes("meter") && hello.kinds.includes("icon");
}

export function usageNode() {
  return node(slot, "row", { hidden: true }, [
    node(ring, "meter", { style: "ring", size: "lg" }),
    node(icon, "icon"),
  ]);
}

export function renderUsage(screen: Pick<Surface, "frame">) {
  let shown = false;
  let provider: Provider | undefined;
  return (usage: Usage | undefined): void => {
    if (!usage) {
      if (shown) screen.frame(["set", slot, { hidden: true }]);
      shown = false;
      return;
    }
    screen.frame(
      ["set", ring, { value: (100 - usage.used) / 100, aria: usage.title, title: usage.title }],
      ...(provider !== usage.provider ? [["set", icon, { name: providers[usage.provider].icon }]] : []),
      ...(!shown ? [["set", slot, { hidden: false }]] : []),
    );
    shown = true;
    provider = usage.provider;
  };
}
