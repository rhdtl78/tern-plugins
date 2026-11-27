import { RpcCommandError, RpcRequestTimeoutError, RpcTransportError, type OmoRpc, type RpcRecord } from "./rpc";
import { record } from "./surface";

type Submission = {
  readonly id: string;
  readonly text: string;
  readonly admission: Promise<RpcRecord>;
};

/** Composer submissions and the claimed first title have separate lifetimes. */
export class QuickTitleClient {
  #submission?: Submission;
  #claim?: Submission;

  constructor(private readonly client: Pick<OmoRpc, "prompt" | "request">) {}

  invalidate() {
    this.#submission = undefined;
    this.#claim = undefined;
  }

  async prompt(text: string, fields: RpcRecord) {
    const id = crypto.randomUUID();
    const original = Array.from(text.slice(0, 1200)).slice(0, 600).join("").trim();
    const input = { id, text: original, admission: this.client.prompt(text, { ...fields, clientMessageId: id }) };
    this.#submission = input;
    try {
      const reply = await input.admission;
      if (record(reply.data).disposition !== "started" && this.#submission === input) this.#submission = undefined;
      return reply;
    } catch (error) {
      if (error instanceof RpcTransportError) this.invalidate();
      else if (this.#submission === input) this.#submission = undefined;
      throw error;
    }
  }

  async offer({ ticket, clientMessageId, durableSessionId }: RpcRecord) {
    const input = this.#submission;
    if (!input || this.#claim || clientMessageId !== input.id || typeof ticket !== "string" ||
        typeof durableSessionId !== "string" || !durableSessionId) return;
    try {
      const ack = record((await input.admission).data);
      const admission = record(ack.admission);
      if (this.#submission !== input || this.#claim || ack.disposition !== "started" ||
          ack.clientMessageId !== input.id || admission.clientMessageId !== input.id ||
          admission.disposition !== "started" || admission.durableSessionId !== durableSessionId) return;
      this.#submission = undefined;
      this.#claim = input;
      const { data } = await this.client.request("extension_request", { name: "omo.modelRouting.resolve", data: {} });
      const { schemaVersion, rows } = record(data);
      if (this.#claim !== input || schemaVersion !== 1 || !Array.isArray(rows)) return;
      const quick = record(rows.find(value => {
        const row = record(value);
        return row.kind === "category" && row.name === "quick";
      }));
      await this.client.request("extension_request", {
        name: "tern.quickTitle", data: { ticket, clientMessageId, durableSessionId, originalText: input.text,
          route: typeof quick.effective === "string" ? quick.effective : null },
      });
    } catch (error) {
      if (error instanceof RpcTransportError) this.invalidate();
      else if (!(error instanceof RpcCommandError || error instanceof RpcRequestTimeoutError)) throw error;
    } finally {
      if (this.#claim === input) this.#claim = undefined;
    }
  }
}
