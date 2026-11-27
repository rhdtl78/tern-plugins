/** Projects an engine-owned name into the pane title, not Tern's explicit tab name. */
export class SessionTitle {
  #shown = "OMO";
  #revision = 0;
  #closed = false;

  constructor(private readonly write: (sequence: string) => void) {}

  get revision(): number { return this.#revision; }

  observe(name: unknown) {
    this.#revision++;
    if (this.#closed) return;
    // Session names are untrusted; don't let control bytes escape the OSC payload.
    const title = (typeof name === "string" ? name.replace(/[\p{Cc}\u2028\u2029]/gu, " ").trim() : "") || "OMO";
    if (title === this.#shown) return;
    this.#shown = title;
    this.write(`\x1b]0;${title}\x1b\\`);
  }

  restore(name: unknown, revision: number) {
    if (revision === this.#revision) this.observe(name);
  }

  close() { this.#closed = true; }
}
