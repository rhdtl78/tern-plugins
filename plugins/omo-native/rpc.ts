import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export type RpcRecord = Readonly<Record<string, unknown>>;
export type RpcEvent = RpcRecord & {
  readonly type: string;
  readonly sessionId: string;
};
export type RpcSession = {
  readonly sessionId: string;
  readonly state: RpcRecord;
};
export type RpcExit = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
};
export type OmoRpcOptions = {
  readonly cwd: string;
  readonly argv?: readonly [string, ...string[]];
  readonly env?: NodeJS.ProcessEnv;
  readonly capabilities?: readonly string[];
  readonly timeoutMs?: number;
};

export class RpcTransportError extends Error {
  readonly name = "RpcTransportError";
}

export class RpcCommandError extends Error {
  readonly name = "RpcCommandError";
  constructor(readonly command: string, readonly response: RpcRecord) {
    super(`${command}: ${response.error ?? response.errorCode ?? "RPC request failed"}`);
  }
}

type Request = RpcRecord & {
  readonly type: string;
  readonly sessionId?: string;
};
type Pending = {
  readonly request: Request;
  readonly settle: (outcome: RpcRecord | Error) => void;
};

function isRecord(value: unknown): value is RpcRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An owned OmO stdio process with one explicit session route. */
export class OmoRpc {
  readonly exited: Promise<RpcExit>;
  readonly #child;
  readonly #options: OmoRpcOptions;
  readonly #pending = new Map<string, Pending>();
  readonly #listeners = new Set<(event: RpcEvent) => void>();
  readonly #limitListeners = new Set<(event: RpcRecord) => void>();
  #buffer = "";
  #sequence = 0;
  #failure?: RpcTransportError;
  #opening?: Promise<RpcSession>;
  #closing?: Promise<RpcExit>;
  #sessionId?: string;

  constructor(options: OmoRpcOptions) {
    this.#options = options;
    const [command, ...args] = options.argv ?? ["omo", "--mode", "rpc", "--listen", "stdio://"];
    try {
      this.#child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ["pipe", "pipe", "ignore"],
        shell: false,
      });
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause;
      throw new RpcTransportError(`OmO RPC process: ${cause.message}`, { cause });
    }
    this.exited = new Promise((resolve) => {
      this.#child.once("close", (code, signal) => {
        this.#fail(new RpcTransportError(`OmO RPC exited (${signal ?? code})`));
        resolve({ code, signal });
      });
    });
    this.#child.on("error", (cause) => this.#fail(new RpcTransportError(`OmO RPC process: ${cause.message}`, { cause })));
    this.#child.stdin.on("error", (cause) => this.#fail(new RpcTransportError(`OmO RPC stdin: ${cause.message}`, { cause })));
    this.#child.stdout.on("error", (cause) => this.#fail(new RpcTransportError(`OmO RPC stdout: ${cause.message}`, { cause })));
    this.#child.stdout.setEncoding("utf8").on("data", (chunk: string) => this.#read(chunk));
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  onEvent(listener: (event: RpcEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  onSubscriptionLimits(listener: (event: RpcRecord) => void): () => void {
    this.#limitListeners.add(listener);
    return () => { this.#limitListeners.delete(listener); };
  }

  openSession(fields: RpcRecord = {}): Promise<RpcSession> {
    if (this.#closing) return Promise.reject(new RpcTransportError("OmO RPC is closing"));
    return this.#opening ??= this.#open(fields);
  }

  async #open(fields: RpcRecord): Promise<RpcSession> {
    if (this.#options.capabilities) {
      await this.#send({ type: "set_client_info", width: 80, capabilities: this.#options.capabilities });
    }
    const response = await this.#send({ cwd: this.#options.cwd, ...fields, type: "open_session" });
    const data = response.data;
    if (!isRecord(data) || typeof data.sessionId !== "string" || !data.sessionId ||
        response.sessionId !== data.sessionId || !isRecord(data.state)) {
      throw new RpcTransportError("OmO returned an invalid open_session response");
    }
    return { sessionId: data.sessionId, state: data.state };
  }

  getProtocolInfo(): Promise<RpcRecord> {
    if (this.#closing) return Promise.reject(new RpcTransportError("OmO RPC is closing"));
    return this.#send({ type: "get_protocol_info" });
  }

  subscriptionLimits(): Promise<RpcRecord> {
    if (this.#closing) return Promise.reject(new RpcTransportError("OmO RPC is closing"));
    return this.#send({ type: "get_subscription_limits", observe: true });
  }

  /** Return the raw successful response envelope; throw RpcCommandError on refusal. */
  request(type: string, fields: RpcRecord = {}): Promise<RpcRecord> {
    if (this.#closing) return Promise.reject(new RpcTransportError("OmO RPC is closing"));
    if (this.#failure) return Promise.reject(this.#failure);
    if (!this.#sessionId) return Promise.reject(new RpcTransportError("Open an OmO session first"));
    return this.#send({ ...fields, type, sessionId: this.#sessionId });
  }

  async getState(): Promise<RpcRecord> {
    const { data } = await this.request("get_state");
    if (!isRecord(data)) throw new RpcTransportError("OmO returned an invalid get_state response");
    return data;
  }

  async getMessages(): Promise<readonly RpcRecord[]> {
    const { data } = await this.request("get_messages");
    if (!isRecord(data) || !Array.isArray(data.messages) || !data.messages.every(isRecord)) {
      throw new RpcTransportError("OmO returned an invalid get_messages response");
    }
    return data.messages;
  }

  prompt(message: string, fields: RpcRecord = {}): Promise<RpcRecord> {
    return this.request("prompt", { ...fields, message });
  }

  abort(fields: RpcRecord = {}): Promise<RpcRecord> {
    return this.request("abort", fields);
  }

  respondToUi(uiRequestId: string, fields: RpcRecord): Promise<RpcRecord> {
    return this.request("extension_ui_response", { ...fields, uiRequestId });
  }

  close(): Promise<RpcExit> {
    return this.#closing ??= this.#close();
  }

  async #close(): Promise<RpcExit> {
    const sessionId = this.#sessionId;
    if (sessionId && !this.#failure) {
      try {
        await this.#send({ type: "close_session", sessionId }, 12_000);
      } catch (error) {
        // Always tear down the owned process, even if OmO refuses graceful close.
        if (!(error instanceof RpcCommandError || error instanceof RpcTransportError)) throw error;
      }
    }
    this.#child.stdin.end();
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      const timer = new AbortController();
      const kill = delay(1000, undefined, { signal: timer.signal }).then(
        () => this.#child.kill("SIGKILL"),
        (error: unknown) => {
          if (!(error instanceof Error && error.name === "AbortError")) throw error;
        },
      );
      try {
        return await this.exited;
      } finally {
        timer.abort();
        await kill;
      }
    }
    return this.exited;
  }

  async #send(request: Request, timeoutMs = this.#options.timeoutMs ?? 30_000): Promise<RpcRecord> {
    if (this.#failure) throw this.#failure;
    const id = String(++this.#sequence);
    const line = JSON.stringify({ ...request, id }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        settle(new RpcTransportError(`OmO RPC timed out waiting for ${request.type}`));
      }, timeoutMs);
      const settle = (outcome: RpcRecord | Error) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        if (outcome instanceof Error) reject(outcome);
        else resolve(outcome);
      };
      this.#pending.set(id, { request, settle });
      this.#child.stdin.write(line);
    });
  }

  #fail(error: RpcTransportError): void {
    if (this.#failure) return;
    this.#failure = error;
    for (const pending of this.#pending.values()) pending.settle(error);
  }

  #read(chunk: string): void {
    // Only LF delimits JSONL. Unicode separators can appear in message text.
    this.#buffer += chunk;
    let end: number;
    while ((end = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 1);
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      if (isRecord(record)) this.#dispatch(record);
    }
  }

  #dispatch(record: RpcRecord): void {
    const { type, sessionId, id, command, success, data } = record;
    if (type === "response") {
      const pending = typeof id === "string" ? this.#pending.get(id) : undefined;
      if (!pending || command !== pending.request.type || typeof success !== "boolean") return;
      if (pending.request.sessionId !== undefined && sessionId !== pending.request.sessionId) return;
      // Bind before the next record in the same stdout chunk can dispatch.
      if (command === "open_session" && success && isRecord(data) && isRecord(data.state) &&
          typeof data.sessionId === "string" && data.sessionId && sessionId === data.sessionId) {
        this.#sessionId = data.sessionId;
      }
      pending.settle(success ? record : new RpcCommandError(pending.request.type, record));
    } else if (type === "subscription_limits" && sessionId === undefined) {
      for (const listener of this.#limitListeners) listener(record);
    } else if (typeof type === "string" && typeof sessionId === "string" && sessionId === this.#sessionId) {
      for (const listener of this.#listeners) listener({ ...record, type, sessionId });
    }
  }
}
