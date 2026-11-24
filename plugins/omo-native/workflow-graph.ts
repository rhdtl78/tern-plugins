import { workflowLayers, type Step } from "./workflow-projection";

const width = 480, cardHeight = 78, rowGap = 32, laneGap = 4;
const runtime = (s: Step) => s.runtimeMs === undefined ? "" :
  s.runtimeMs < 1000 ? `${s.runtimeMs}ms` : `${(s.runtimeMs / 1000).toFixed(1)}s`;

export function graph(steps: readonly Step[], dark: boolean, selected = "") {
  if (!steps.length || steps.length > 12 || steps.reduce((n, s) => n + s.needs.length, 0) > 24) return;
  const layers = workflowLayers(steps);
  if (!layers) return;
  // Wide parallel layers wrap without introducing dependencies between their bands.
  const columns = layers.some(layer => layer.length > 3) ? 2 : 3;
  const rows = layers.flatMap(layer => {
    const bands: Step[][] = [];
    for (let i = 0; i < layer.length; i += columns) bands.push(layer.slice(i, i + columns).map(j => steps[j]));
    return bands;
  });
  const levels = new Map(rows.flatMap((row, depth) => row.map(s => [s.id, depth] as const)));
  const links = steps.flatMap(step => step.needs.map(id => ({ source: id, target: step })));
  const routeCount = links.filter(({ source, target }) =>
    (levels.get(target.id) ?? 0) - (levels.get(source) ?? 0) > 1).length;
  if (rows.length > 7 || routeCount > 5) return;
  const gutter = 30 + routeCount * 5;
  const points = new Map<string, readonly [number, number, number]>();
  let top = 11;
  for (const [depth, row] of rows.entries()) {
    const available = width - gutter * 2, slot = available / row.length;
    row.forEach((step, i) => points.set(step.id, [gutter + (i + 0.5) * slot, top, Math.min(235, slot - 10)]));
    const outgoing = links.filter(link => levels.get(link.source) === depth).length;
    const incoming = links.filter(link => levels.get(link.target.id) === depth + 1).length;
    top += cardHeight + rowGap + Math.max(outgoing, incoming) * laneGap;
  }
  const height = Math.max(...[...points.values()].map(([, y]) => y + cardHeight)) + 11;
  const edge = dark ? "#9c93a2" : "#65596d";
  const departures = new Map<number, number>(), arrivals = new Map<number, number>();
  let outer = 0;
  const edges = links.map(({ source: id, target: step }) => {
    const target = points.get(step.id), source = points.get(id);
    if (!target || !source) return "";
    const [center, y, wide] = target, [sx, sourceTop] = source, sy = sourceTop + cardHeight;
    const from = levels.get(id) ?? 0, to = levels.get(step.id) ?? 0;
    const departure = departures.get(from) ?? 0, arrival = arrivals.get(to) ?? 0;
    departures.set(from, departure + 1); arrivals.set(to, arrival + 1);
    const x = center - wide / 2 + wide * (step.needs.indexOf(id) + 1) / (step.needs.length + 1);
    const leave = sy + 12 + departure * laneGap, enter = y - 15 - arrival * laneGap;
    const skip = to - from > 1;
    const rail = 10 + outer * 5;
    if (skip) outer++;
    const path = skip
      ? `M${sx} ${sy} V${leave} H${rail} V${enter} H${x} V${y - 1}`
      : `M${sx} ${sy} V${leave} H${x} V${y - 1}`;
    return `<path d="${path}" fill="none" stroke="${edge}" stroke-width="1.6" stroke-linejoin="round"/><path d="M${x - 4} ${y - 7} L${x} ${y - 1} L${x + 4} ${y - 7}Z" fill="${edge}"/>`;
  }).join("");
  const cards = steps.flatMap((step, i) => {
    const point = points.get(step.id);
    if (!point) return [];
    const [x, y, wide] = point;
    const id = `workflow-card-${i}`;
    const state = [step.status, runtime(step)].filter(Boolean).join(" · ");
    const route = step.route?.name || "";
    return [{ id, left: x - wide / 2, top: y, width: wide, height: cardHeight,
      label: step.label, route, state, status: step.status,
      props: { aria: [step.label, route, state].filter(Boolean).join(", "), role: "workflow-card", variant: "quiet",
        on: step.id === selected, actions: { click: "select-step" } } }];
  });
  return { width, height, cards, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${edges}</svg>` };
}
