import type { RpcRecord } from "./rpc";
import { node, plain, record, string } from "./surface";

interface Choice { readonly label: string; readonly fields: RpcRecord }
export function dialog(request: RpcRecord, seq: number) {
  const id = `ask${seq}`;
  const choices: Choice[] = [];
  let title = plain(string(request.title) || "OMO needs your input");
  let detail = plain(string(request.message));
  let typed: ((text: string) => RpcRecord) | undefined;
  let supported = !request.secret;
  switch (request.method) {
    case "confirm":
      choices.push({ label: "Deny", fields: { confirmed: false } }, { label: "Allow", fields: { confirmed: true } }); break;
    case "select":
      if (!Array.isArray(request.options) || !request.options.every(o => typeof o === "string")) supported = false;
      else for (const value of request.options) choices.push({ label: plain(value), fields: { value } });
      break;
    case "input": case "editor": typed = value => ({ value }); break;
    case "question": {
      const q = record(Array.isArray(request.questions) && request.questions.length === 1 ? request.questions[0] : null);
      const key = string(q.id);
      if (!key || q.multiSelect) { supported = false; break; }
      title = plain(string(q.question)); detail = plain(string(q.header));
      for (const o of Array.isArray(q.options) ? q.options.map(record) : []) {
        const label = string(o.label);
        if (label) choices.push({ label: plain([label, string(o.description)].filter(Boolean).join(": ")), fields: { answers: { [key]: { selected: [label] } } } });
      }
      typed = text => ({ answers: { [key]: { selected: [], text } } });
      break;
    }
    default: supported = false;
  }
  choices.push({ label: "Cancel", fields: { cancelled: true } });
  return { id, requestId: string(request.id), choices, typed, supported,
    view: node(id, "card", { head: title }, [
      ...(detail ? [node(id + ".detail", "text", { text: detail })] : []),
      node(id + ".choices", "row", { gap: "sm", wrap: true }, choices.map((c, i) =>
        node(`${id}.${i}`, "button", { text: c.label, actions: { click: "choose" } }))),
    ]),
  };
}
