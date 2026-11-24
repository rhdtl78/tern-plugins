import { expect, test } from "bun:test";
import { ComposerMode } from "./composer-mode";

test.each([
  ["ULW please", "ulw-preview"],
  ["Use Ultrawork.", "ulw-preview"],
  ["Research this", "research-preview"],
  ["Research with ulw", "ulw-preview"],
  ["", undefined],
  ["ul", undefined],
  ["preulw researcher", undefined],
  ["내ulw research_2", undefined],
  ["docs/ulw.md, /research, ulw-plan", undefined],
  ["say \"ulw\", ‘research’ or `ulw`", undefined],
  ["say \"research", undefined],
  ["> ulw\nresearch this", "research-preview"],
  ["~~~sh\nulw\n~~~\nResearch this", "research-preview"],
  ["```\nresearch", undefined],
  ["Do not run ulw; skip research", undefined],
] as const)("projects only an exact eligible draft keyword in %j", (text, expected) => {
  expect(new ComposerMode().border(text)).toBe(expected);
});

const directive = {
  type: "message_start",
  message: { role: "custom", customType: "omo-ultrawork:directive", display: false },
};

test.each(["agent_settled", "agent_idle"])("confirms ULW on start and releases it on %s", settled => {
  const mode = new ComposerMode();
  mode.observe(directive);
  expect(mode.border("")).toBeUndefined();
  mode.observe({ type: "agent_start" });
  expect(mode.border("research")).toBe("ulw-running");
  mode.observe({ type: "agent_end" });
  expect(mode.border("")).toBe("ulw-running");
  mode.observe({ type: settled });
  expect(mode.border("research")).toBe("research-preview");
  mode.observe({ type: "agent_start" });
  expect(mode.border("")).toBeUndefined();
});

test("plain message content never promotes a draft preview to a running mode", () => {
  const mode = new ComposerMode();
  mode.observe({ type: "message_start", message: { role: "user", content: '"ulw" <ultrawork-mode> research' } });
  mode.observe({ ...directive, message: { ...directive.message, role: "user" } });
  mode.observe({ type: "agent_start" });
  expect(mode.border(undefined)).toBeUndefined();
  expect(mode.border("ulw")).toBe("ulw-preview");
});

test("clearing an unstarted directive prevents leaking into the next turn", () => {
  const mode = new ComposerMode();
  mode.observe(directive);
  mode.clear();
  mode.observe({ type: "agent_start" });
  expect(mode.border("")).toBeUndefined();
});
