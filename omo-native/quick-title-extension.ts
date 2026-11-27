type Row = Record<string, unknown>;
type Model = { provider: string; id: string; api: string; baseUrl: string };
type Context = {
  sessionManager: { getSessionId(): string };
  modelRegistry: {
    find(provider: string, id: string): Model | undefined;
    streamSimple(model: Model, context: Row, options: Row): {
      result(): Promise<{ stopReason: string; content: Row[] }>;
    };
  };
};
type Api = {
  on(event: string, handler: (event: Row, context: Context) => void): void;
  rpc?: { emit(name: string, data: Row): void; handle?(name: string, handler: (data: unknown) => void): void };
  getSessionName(): string | undefined;
  setSessionName(name: string): void;
};

const name = "tern.quickTitle";
const provider = "opencode-go";
const instruction = "Write a short title for the following request. Return only the title, on one line.\n\n";

function fields(value: unknown): Row {
  return value !== null && typeof value === "object" ? value as Row : {};
}

export default function quickTitle(pi: Api) {
  const rpc = pi.rpc;
  if (!rpc?.handle) return;
  let binding: {
    id: string; fresh: boolean; used: boolean; life: AbortController;
    pending?: { ticket: string; clientMessageId: string; ctx: Context };
  } | undefined;
  function retire() {
    binding?.life.abort();
    binding = undefined;
  }
  pi.on("session_start", (event, ctx) => {
    retire();
    binding = {
      id: ctx.sessionManager.getSessionId(),
      fresh: event.reason === "new" || (event.reason === "startup" && process.env.TERN_QUICK_TITLE_FRESH === "1"),
      used: false, life: new AbortController(),
    };
  });
  pi.on("session_shutdown", retire);
  pi.on("message_start", (event, ctx) => {
    const live = binding;
    const { role, clientMessageId } = fields(event.message);
    if (!live?.fresh || live.used || role !== "user" || live.id !== ctx.sessionManager.getSessionId()) return;
    live.used = true;
    if (typeof clientMessageId !== "string" || !clientMessageId || pi.getSessionName()) return;
    const ticket = crypto.randomUUID();
    live.pending = { ticket, clientMessageId, ctx };
    rpc.emit(name, { ticket, clientMessageId, durableSessionId: live.id });
  });
  rpc.handle(name, (data) => {
    const live = binding;
    const pending = live?.pending;
    const { ticket, clientMessageId, durableSessionId, route, originalText } = fields(data);
    if (!live || !pending || ticket !== pending.ticket || clientMessageId !== pending.clientMessageId ||
        durableSessionId !== live.id) return;
    live.pending = undefined;
    if (typeof originalText !== "string" || !originalText.trim() || [...originalText.slice(0, 1201)].length > 600) return;
    if (typeof route !== "string" || !route.startsWith(`${provider}/`) || pi.getSessionName() ||
        live.id !== pending.ctx.sessionManager.getSessionId()) return;
    const id = route.slice(provider.length + 1);
    const registry = pending.ctx.modelRegistry;
    const model = registry.find(provider, id);
    if (!model || model.provider !== provider || model.id !== id || model.api !== "anthropic-messages") return;
    void generate(registry, model, originalText, live.life.signal).then(title => {
      if (title && binding === live && pending.ctx.sessionManager.getSessionId() === live.id && !pi.getSessionName())
        pi.setSessionName(title);
    }).catch(() => { /* Titles are best effort; never disturb the parent turn. */ });
  });
}

async function generate(registry: Context["modelRegistry"], model: Model, text: string, life: AbortSignal) {
  const signal = AbortSignal.any([life, AbortSignal.timeout(10_000)]);
  const content = instruction + text;
  const body = { model: model.id, max_tokens: 64, messages: [{ role: "user", content }], stream: true };
  let endpoint: URL | undefined;
  let used = false;
  const result = await registry.streamSimple(model, {
    messages: [{ role: "user", content, timestamp: Date.now() }],
  }, {
    signal, maxTokens: 64, maxRetries: 0, cacheRetention: "none", abortServerSideFallback: true,
    onPayload(_payload: unknown, target: Model) {
      if (endpoint || target.provider !== provider || target.api !== model.api || target.id !== model.id)
        throw new Error("Unexpected Quick title adapter");
      endpoint = new URL(target.baseUrl.replace(/\/+$/, "") + "/v1/messages");
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
          (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1")))
        throw new Error("Unexpected Quick title endpoint");
      return body;
    },
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      if (used) throw new Error("Quick title request already consumed");
      used = true;
      signal.throwIfAborted();
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (!endpoint || url.origin !== endpoint.origin || url.pathname !== endpoint.pathname ||
          (url.search && url.search !== "?beta=true") || request.method !== "POST")
        throw new Error("Unexpected Quick title transport");
      const actual = fields(await request.clone().json());
      const keys = Object.keys(actual).sort().join(",");
      const messages = actual.messages;
      if (keys !== "max_tokens,messages,model,stream" || actual.model !== model.id ||
          actual.max_tokens !== 64 || actual.stream !== true || !Array.isArray(messages) || messages.length !== 1 ||
          Object.keys(fields(messages[0])).sort().join(",") !== "content,role" ||
          messages[0].role !== "user" || messages[0].content !== content)
        throw new Error("Unexpected Quick title payload");
      signal.throwIfAborted();
      return globalThis.fetch(request, { redirect: "error" });
    },
  }).result();
  if (!used || signal.aborted || result.stopReason !== "stop" || result.content.length !== 1) return;
  const block = result.content[0];
  if (block.type !== "text" || typeof block.text !== "string") return;
  const title = block.text.trim();
  if (title && title.length <= 80 && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(title)) return title;
}
