export const model = "Fixture model";
export const warning = "Hot-reloaded: fixture/omo.jsonc";
export const refusal = "fixture refused startup";

export type Scenario = "notice" | "composer" | "queue" | "clipboard" | "ulw" | "session" | "session-refused" | "images";
export const promptsFile = "prompts.jsonl";
export const sessionCallsFile = "session-calls.jsonl";
export const sessionPending = "Fixture session command pending";
export const sessionRefusal = "Fixture session command refused";
export const checkpoint = {
  acknowledged: "acknowledged",
  stopped: "stopped",
  restarted: "restarted",
  retained: "retained",
} as const;
export type Checkpoint = typeof checkpoint[keyof typeof checkpoint];

export function noticeEngine(rejectOpen: boolean, scenario: Scenario) {
  return `#!/usr/bin/env bun
import { appendFileSync, existsSync, unwatchFile, watchFile } from "node:fs";
import { createInterface } from "node:readline";
const sessionId = "notice-test";
const send = value => console.log(JSON.stringify({ sessionId, ...value }));
let prompts = 0, stopCalls = 0;
const composer = ${scenario === "composer"};
const queue = ${scenario === "queue"};
const checkpoint = ${JSON.stringify(checkpoint)};
let ordered = [], next = 0, turn = "turn-one";
const snapshot = () => send({ type: "queue_update", ordered });

// Stat the durable marker rather than relying on a directory notification
// arriving after the watcher starts.
async function waitForCheckpoint(marker) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const check = () => { if (existsSync(marker)) resolve(); };
  watchFile(marker, { interval: 10 }, check);
  const deadline = setTimeout(() => reject(new Error("Fixture timed out waiting for " + marker)), 2500);
  try {
    check();
    await promise;
  } finally {
    clearTimeout(deadline);
    unwatchFile(marker, check);
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  const { id, type, ...fields } = JSON.parse(line);
  if (${scenario === "session" || scenario === "session-refused"}) {
    if (["open_session", "switch_session", "get_session_stats", "set_session_name", "prompt"].includes(type))
      appendFileSync(${JSON.stringify(sessionCallsFile)}, JSON.stringify([type, fields.name ?? fields.message ?? null]) + "\\n");
    if (type === "get_session_stats" || type === "set_session_name") {
      send({ type: "extension_ui_request", method: "notify", message: ${JSON.stringify(sessionPending)} });
      await waitForCheckpoint(checkpoint.acknowledged);
      const success = ${scenario !== "session-refused"};
      send({ id, type: "response", command: type, success,
        ...(success ? { data: { sessionId, totalMessages: 3 } } : { error: ${JSON.stringify(sessionRefusal)} }) });
      continue;
    }
  }
  if (queue && (type === "steer" || type === "follow_up")) {
    if (fields.expectedTurnId !== turn) process.exit(10);
    if (fields.message === "refused") {
      send({ id, type: "response", command: type, success: false, error: "fixture queue refused" });
    } else {
      send({ id, type: "response", command: type, success: true, data: { disposition: "queued" } });
      if (next === 0) {
        send({ type: "extension_ui_request", method: "notify", message: "Fixture acknowledged" });
        await waitForCheckpoint(checkpoint.acknowledged);
      }
      ordered.push({ queuedId: "q_" + ++next, mode: type === "steer" ? "steer" : "followUp",
        text: fields.message, enqueueOrder: next, revision: 1 });
      snapshot();
    }
    continue;
  }
  if (type === "open_session" && ${rejectOpen}) {
    send({ id, type: "response", command: type, success: false, error: ${JSON.stringify(refusal)} });
    continue;
  }
  if (composer && type === "steer") {
    const correct = fields.message === "previous" && fields.expectedTurnId === "turn-one";
    send({ id, type: "response", command: type, success: false, error: correct ? "fixture turn changed" : "wrong steer request" });
    continue;
  }
  if (composer && type === "prompt") {
    if (++prompts !== 1 || fields.message !== "Run fixture" ||
        typeof fields.clientMessageId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(fields.clientMessageId) ||
        Object.keys(fields).sort().join() !== "clientMessageId,message,sessionId") process.exit(8);
  }
  if (${scenario === "clipboard"} && type === "prompt") appendFileSync(${JSON.stringify(promptsFile)}, JSON.stringify(fields.message) + "\\n");
  if (type === "abort" && (composer || queue) &&
      (fields.awaitIdle !== true || fields.intent !== "stop" || fields.clearQueue !== undefined ||
        (composer && ++stopCalls !== 1))) process.exit(9);
  const data = type === "open_session" ? { sessionId, state: { model: { name: ${JSON.stringify(model)} } } }
    : type === "get_messages" ? { messages: [] }
    : type === "get_state" ? { isStreaming: true, currentTurnId: turn, ordered }
    : type === "abort" ? { idle: !composer } : {};
  send({ id, type: "response", command: type, success: true, data });
  if (type === "get_messages") send({ type: "extension_ui_request", method: "notify",
    notifyType: "warning", message: ${JSON.stringify(warning)} });
  if (type === "prompt") {
    if (${scenario === "images"}) {
      send({ type: "agent_start" });
      send({ type: "message_end", message: { role: "user",
        content: [{ type: "text", text: fields.message }, ...(fields.images ?? [])] } });
      send({ type: "agent_settled" });
      continue;
    }
    if (!composer && ++prompts === 2) process.exit(7);
    if (${scenario === "ulw"}) send({ type: "message_start",
      message: { role: "custom", customType: "omo-ultrawork:directive", display: false } });
    send({ type: "agent_start" });
    send({ type: "extension_ui_request", method: "notify", message: "Fixture turn started" });
  }
  if (queue && type === "abort") {
    if (++stopCalls === 1) {
      // Stop settles the turn without draining it. The next turn consumes
      // just one of two equal-text entries, publishing the queue update first.
      send({ type: "agent_idle" });
      await waitForCheckpoint(checkpoint.stopped);
      turn = "turn-two";
      send({ type: "agent_start" });
      await waitForCheckpoint(checkpoint.restarted);
      const delivered = ordered[1];
      ordered = ordered.filter(row => row !== delivered);
      snapshot();
      const message = { role: "user", content: delivered.text };
      send({ type: "message_start", message });
      send({ type: "message_end", message });
    } else {
      // Discard without adding user messages, preserving the intermediate row.
      ordered = ordered.slice(1);
      snapshot();
      await waitForCheckpoint(checkpoint.retained);
      ordered = ordered.slice(1);
      snapshot();
    }
  }
  if (type === "abort" && !composer && !queue) send({ type: "agent_idle" });
}
`;
}
