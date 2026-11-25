import { expect, test } from "bun:test";
import { graph } from "./workflow";
import { workflowSteps } from "./workflow-projection";

test("five independent roots stay legible with exactly their five fan-in links", () => {
  const roots = ["cards", "activity", "border", "icon", "slash"];
  const steps = workflowSteps([
    ...roots.map(id => ({ id, state: "completed", prompt: "private description" })),
    { id: "integration", dependsOn: roots, state: "pending" },
  ]);
  const model = graph(steps, false, "integration");
  if (!model) throw Error("Expected a six-card fan-in graph");
  expect(model.cards.map(c => c.label)).toEqual([...roots, "integration"]);
  expect(model.cards.map(c => c.props.on)).toEqual([false, false, false, false, false, true]);
  expect(model.svg).not.toContain("private");
  expect(model.svg.length).toBeLessThanOrEqual(8000);
  const paths = [...model.svg.matchAll(/<path d="([^"]+)" fill="none"/g)];
  expect(paths).toHaveLength(5);
  const leaf = model.cards[5];
  if (!leaf) throw Error("Missing integration card");
  const ports = new Set<string>();
  for (const [i, path] of paths.entries()) {
    const source = model.cards[i];
    const numbers = path[1].match(/[\d.]+/g)?.map(Number);
    if (!source || !numbers) throw Error("Missing source or connector geometry");
    expect(numbers[0]).toBeGreaterThan(source.left);
    expect(numbers[0]).toBeLessThan(source.left + source.width);
    expect(numbers[1]).toBe(source.top + source.height);
    expect(numbers.at(-2)).toBeGreaterThan(leaf.left);
    expect(numbers.at(-2)).toBeLessThan(leaf.left + leaf.width);
    expect(numbers.at(-1)).toBe(leaf.top - 1);
    ports.add(String(numbers.at(-2)));
    // Every axis-aligned connector segment must stay outside all card interiors.
    let x = 0, y = 0;
    for (const command of path[1].matchAll(/([MHV])([\d.]+)(?: ([\d.]+))?/g)) {
      const nx = command[1] === "V" ? x : Number(command[2]);
      const ny = command[1] === "H" ? y : Number(command[3] ?? command[2]);
      if (command[1] !== "M") for (const card of model.cards) {
        const crosses = nx === x
          ? x > card.left && x < card.left + card.width &&
            Math.max(y, ny) > card.top && Math.min(y, ny) < card.top + card.height
          : y > card.top && y < card.top + card.height &&
            Math.max(x, nx) > card.left && Math.min(x, nx) < card.left + card.width;
        expect(crosses).toBe(false);
      }
      x = nx; y = ny;
    }
  }
  expect(ports.size).toBe(5);
  for (const card of model.cards) {
    expect(card.width * 380 / model.width).toBeGreaterThanOrEqual(140);
    expect(card.top + card.height).toBeLessThanOrEqual(model.height);
    for (const other of model.cards) {
      if (card === other) continue;
      expect(card.left < other.left + other.width && card.left + card.width > other.left &&
        card.top < other.top + other.height && card.top + card.height > other.top).toBe(false);
    }
  }
});

test("unusual valid IDs and reverse input keep real topology without markup injection", () => {
  const steps = workflowSteps([
    { id: 'finish"<>', dependsOn: ["__proto__", "constructor"] },
    { id: "__proto__" }, { id: "constructor" },
  ]);
  const model = graph(steps, true);
  if (!model) throw Error("Expected unusual valid IDs to render");
  expect(model.cards.map(c => c.label)).toEqual(['finish"<>', "__proto__", "constructor"]);
  expect(model.svg).not.toMatch(/finish|__proto__|constructor/);
  expect(model.cards[0].top).toBeGreaterThan(model.cards[1].top);
  expect([...model.svg.matchAll(/fill="none"/g)]).toHaveLength(2);
});

test("invalid topology and bounded large layouts retain the selectable list fallback", () => {
  const cases = [
    [],
    [{ id: "a", dependsOn: ["missing"] }],
    [{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }],
    Array.from({ length: 13 }, (_, i) => ({ id: String(i) })),
    Array.from({ length: 8 }, (_, i) => ({ id: String(i), dependsOn: i ? [String(i - 1)] : [] })),
    Array.from({ length: 8 }, (_, i) => ({ id: String(i), dependsOn: Array.from({ length: i }, (_, j) => String(j)) })),
    [...Array.from({ length: 8 }, (_, i) => ({ id: String(i) })),
      { id: "merge", dependsOn: Array.from({ length: 8 }, (_, i) => String(i)) }],
  ];
  for (const rows of cases) expect(graph(workflowSteps(rows), false)).toBeUndefined();
});
