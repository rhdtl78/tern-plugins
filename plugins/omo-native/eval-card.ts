import type { RpcRecord } from "./rpc";
import { node, plain, record, string } from "./surface";

const labels: Readonly<Record<string, string>> = {
  pending: "Pending", running: "Running", done: "Completed", error: "Failed",
};

export function evalCard(id: string, args: RpcRecord, state: { readonly status: string; readonly details: unknown; readonly output: string }) {
  const details = record(state.details);
  const cells = Array.isArray(details.cells) ? details.cells.map(record).filter(cell =>
    typeof cell.code === "string" || typeof cell.output === "string").map(cell => ({
      code: plain(string(cell.code)), language: plain(string(cell.language)),
      output: plain(string(cell.output)), summary: cell.summary, runtime: cell.runtime, durationMs: cell.durationMs,
    })) : [];
  const first = cells[0];
  const reported = cells.find(cell => cell.code.trim());
  const saved = plain(string(args.code));
  const source = reported?.code ?? saved;
  const summary = plain(string(details.summary) || string(first?.summary) || string(args.summary)).trim();
  const target = summary.replace(/\s+/g, " ") || source.split("\n").find(line => line.trim())?.trim() || "";
  const language = plain(string(details.language) || string(first?.language) || string(args.language));
  const runtime = record(details.runtime ?? first?.runtime);
  const elapsed = details.durationMs ?? first?.durationMs;
  const duration = typeof elapsed === "number" && Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined;
  const status = labels[state.status];
  const timing = duration === undefined ? "" : `${duration} ms`;
  const context = [status, language, [plain(string(runtime.name)), plain(string(runtime.version))].filter(Boolean).join(" "),
    timing].filter(Boolean).join(" · ");
  return {
    head: { target, meta: [language, status, timing].filter(Boolean) },
    body: node(`${id}.eval`, "col", { gap: "sm" }, [
      node(`${id}.info`, "text", { text: [context, summary].filter(Boolean).join("\n") }),
      ...(!reported && saved.trim() ? [node(`${id}.saved`, "code", { lang: plain(string(args.language)) || language || "text", text: saved })] : []),
      ...cells.flatMap((cell, i) => [
        ...(cell.code.trim() ? [node(`${id}.source${i}`, "code", { lang: cell.language || language || "text", text: cell.code })] : []),
        ...(cell.output && !state.output ? [node(`${id}.cellOut${i}`, "code", { lang: "text", text: cell.output })] : []),
      ]),
      ...(state.output ? [node(`${id}.out`, "code", { lang: "text", text: state.output })] : []),
    ]),
  };
}
