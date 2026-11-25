import { plain, record, string } from "./surface";

const commands = {
  clone: "Duplicate the current branch",
  fork: "Fork from a previous user message",
  name: "Rename the current session",
  new: "Start a fresh session",
  rename: "Rename the current session",
  resume: "Resume a saved session in this project",
  session: "Show current session information",
  sessions: "Resume a saved session in this project",
  tree: "Navigate the current session tree",
} as const;

export type SessionCommand = keyof typeof commands;
export const sessionCommands = Object.entries(commands).map(([name, description]) => ({
  name, description, source: "OMO Native",
}));

export function sessionCommand(text: string) {
  // Check before trimming: even a trailing newline belongs to the draft.
  if (/[\r\n\u2028\u2029]/u.test(text)) return;
  const match = /^\/([\w-]+)(?:\s+(.+))?$/u.exec(text.trim());
  const name = match?.[1].toLowerCase();
  if (!name || !Object.hasOwn(commands, name)) return;
  const argument = match?.[2] ?? "";
  if (argument && name !== "name" && name !== "rename") return;
  return { name: name as SessionCommand, argument };
}

export function entryRows(kind: "fork" | "tree", data: unknown) {
  const rows = [], value = record(data);
  if (kind === "fork") {
    const messages = Array.isArray(value.messages) ? value.messages : [];
    for (const raw of messages) {
      const { entryId, text } = record(raw);
      if (typeof entryId === "string" && entryId)
        rows.push({ id: `e${rows.length}`, label: plain(string(text)).slice(0, 160) || "User message",
          detail: "User", target: { entryId } });
    }
  } else {
    const stack = (Array.isArray(value.tree) ? value.tree : []).slice().reverse().map(node => ({ node, depth: 0 }));
    while (stack.length) {
      const { node, depth } = stack.pop()!;
      const { entry: raw, children } = record(node), entry = record(raw), message = record(entry.message);
      const content = message.content, role = string(message.role) || string(entry.type);
      const text = typeof content === "string" ? content : Array.isArray(content)
        ? content.map(record).filter(block => block.type === "text").map(block => string(block.text)).join(" ") : "";
      const entryId = string(entry.id);
      if (entryId)
        rows.push({ id: `e${rows.length}`, label: plain(text).slice(0, 160) || role,
          detail: `${"› ".repeat(Math.min(depth, 8))}${role}`, current: entryId === value.leafId,
          target: { entryId, expectedLeafId: typeof value.leafId === "string" ? value.leafId : null } });
      if (Array.isArray(children))
        for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], depth: depth + 1 });
    }
  }
  return rows;
}
