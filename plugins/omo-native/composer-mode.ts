import type { RpcRecord } from "./rpc";
import { sessionActivity } from "./session";
import { record } from "./surface";

type Preview = "ulw-preview" | "research-preview";
type Border = Preview | "ulw-running" | undefined;

// Draft hints are narrower than OmO's input expansions. Do not preview
// command names, paths, literals, negated mentions or partial words.
const fenced = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?(?:^ {0,3}\1[ \t]*$|(?![\s\S])))?/gm;
const literals = /^ {0,3}>[^\n]*|(?<!`)(`+)(?!`)[\s\S]*?(?:(?<!`)\1(?!`)|(?![\s\S]))|"[^"\n]*(?:"|$)|“[^”\n]*(?:”|$)|(?<![\p{L}\p{N}])'[^'\n]*(?:'|$)|‘[^’\n]*(?:’|$)|\b[a-z][a-z\d+.-]*:\/\/\S+/gimu;
const negated = /\b(?:avoid(?:ing)?|skip(?:ping)?|without|no|never|do\s+not|don['’]t|dont)\s+(?:(?:using|use(?:\s+of)?|the|run|invoke|start|trigger|arm|enable)\s+)*(?:ultrawork|ulw|research)\b/giu;
const keywords = /(?<![\p{L}\p{N}\p{M}_/\\.-])(?:ultrawork|ulw|research)(?![\p{L}\p{N}\p{M}_/\\-]|\.[\p{L}\p{N}\p{M}_])/giu;

function draftPreview(text: string): Preview | undefined {
  const prose = text.replace(fenced, " ").replace(literals, " ").replace(negated, " ");
  let research = false;
  for (const token of prose.matchAll(keywords)) {
    if (token[0].toLowerCase() !== "research") return "ulw-preview";
    research = true;
  }
  return research ? "research-preview" : undefined;
}

export class ComposerMode {
  #ulw: "armed" | "running" | undefined;

  observe(event: RpcRecord) {
    const active = sessionActivity(event.type);
    if (active === false) this.clear();
    if (active === true && this.#ulw === "armed") this.#ulw = "running";
    if (event.type === "message_start") {
      const message = record(event.message);
      // Installed OmO emits this hidden custom message on the live route
      // before agent_start. History and ordinary message text are not signals.
      if (message.role === "custom" && message.customType === "omo-ultrawork:directive" &&
          message.display === false && !this.#ulw) this.#ulw = "armed";
    }
  }

  clear() { this.#ulw = undefined; }

  border(draft: string | undefined): Border {
    if (this.#ulw === "running") return "ulw-running";
    return draft === undefined ? undefined : draftPreview(draft);
  }
}
