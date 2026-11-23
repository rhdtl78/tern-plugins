import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { record, string } from "./surface";
import type { RpcRecord } from "./rpc";

export function sessionActivity(type: unknown): boolean | undefined {
  switch (type) {
    case "agent_start": return true;
    case "agent_settled": case "agent_idle": return false;
    // agent_end only finishes an attempt; the engine may already be retrying.
    default: return undefined;
  }
}

export async function resumeFields(args: readonly string[], cwd: string) {
  if (!args.length) return {};
  const path = args[1];
  if (args.length !== 2 || args[0] !== "--session" || !path || !isAbsolute(path))
    throw new Error("Expected --session /absolute/session.jsonl");
  // Read only the JSONL header, not the conversation history.
  const first = await Bun.file(path).slice(0, 65536).text();
  const line = first.split("\n", 1)[0] ?? "";
  let header;
  try { header = record(JSON.parse(line)); }
  catch (e) { if (!(e instanceof SyntaxError)) throw e; throw new Error("Invalid saved session header"); }
  return resumeHeaderFields(path, cwd, header);
}

export async function resumeHeaderFields(path: string, cwd: string, header: RpcRecord) {
  const saved = string(header.cwd);
  if (header.type !== "session" || !isAbsolute(saved)) throw new Error("Saved session has no absolute working directory");
  if (await realpath(saved) !== await realpath(cwd))
    throw new Error(`Session belongs to ${saved}. Reopen it from that directory`);
  return { sessionPath: path, cwd: saved };
}
