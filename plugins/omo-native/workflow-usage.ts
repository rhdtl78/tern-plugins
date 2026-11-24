import { node, record } from "./surface";
import type { RpcRecord } from "./rpc";

const categories = [
  ["input", "Input", "accent"], ["output", "Output", "pending"],
  ["cacheRead", "Cache read", "success"], ["cacheWrite", "Cache write", "warning"],
] as const;
const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 });
const tokens = (n: number) => compact.format(n || 0).replace("K", "k");
const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 });
function costRow({ cost, costUnknown }: RpcRecord) {
  const partial = costUnknown === true;
  if (costUnknown !== undefined && !partial && costUnknown !== false) return;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0 || (partial && cost === 0)) {
    if (partial) return { id: "cost", cells: { key: "Cost (USD)", value: "Unknown" } };
    return;
  }
  return { id: "cost", cells: { key: partial ? "Known cost (USD)" : "Cost (USD)",
    value: cost > 0 && cost < 0.000001 ? "<$0.000001" : dollars.format(cost || 0) } };
}

export function workflowUsage(stats: RpcRecord) {
  const raw = record(stats.tokens), window = record(stats.contextUsage);
  const total = count(raw.total) ? tokens(raw.total) : undefined;
  const series = categories.flatMap(([id, label, token]) => {
    const value = raw[id];
    return count(value) ? [{ id, label, token, value, title: `${label}: ${value} tokens` }] : [];
  });
  const cost = costRow(stats);
  const rows = [
    ...(total === undefined ? [] : [{ id: "total", cells: { key: "Total tokens", value: total } }]),
    ...series.map(({ id, label, token, value, title }) => ({
      id, title, cells: { key: { text: label, dot: token }, value: tokens(value) },
    })),
    ...(cost ? [cost] : []),
  ];
  const context = count(window.tokens) && count(window.contextWindow) && window.contextWindow > 0
    ? { value: Math.min(1, window.tokens / window.contextWindow),
      label: `Context  ${tokens(window.tokens)} / ${tokens(window.contextWindow)}` } : undefined;
  if (!rows.length && !context) return;
  // A partial breakdown is a mix of the reported categories, not the full session total.
  const center = series.length === categories.length && series.reduce((n, s) => n + s.value, 0) === raw.total
    ? total : undefined;
  return { series, rows, center, context };
}

export function usageBody(usage: ReturnType<typeof workflowUsage>, expanded: boolean) {
  const series = usage?.series ?? [], rows = usage?.rows ?? [], context = usage?.context;
  return node("workflow-usage-body", "col", { gap: "sm", hidden: !expanded || !usage }, [
    node("workflow-usage-split", "row", { gap: "md", hidden: !rows.length }, [
      node("workflow-usage-chart", "chart", { kind: "donut", size: "sm", series, total: usage?.center ?? "Mix",
        caption: usage?.center ? "tokens" : "reported", aria: "Reported token composition",
        hidden: !series.some(s => s.value > 0) }),
      node("workflow-usage-table", "table", { grow: 1, aria: "Cumulative session usage",
        cols: [{ id: "key", head: "Session usage", grow: 1 }, { id: "value", head: "Amount", align: "end", mono: true }],
        rows }),
    ]),
    node("workflow-context", "meter", { size: "sm", hidden: !context, label: context?.label ?? "",
      value: context?.value ?? null, aria: context?.label ?? "" }),
  ]);
}
