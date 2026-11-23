import { plain, type Input } from "./surface";

export class Editor {
  text = "";
  cursor = 0;
  reset(text: string) { this.text = text; this.cursor = text.length; }
  #replace(from: number, to: number, text: string, cursor = from + text.length) {
    this.text = this.text.slice(0, from) + text + this.text.slice(to);
    this.cursor = Math.min(this.text.length, Math.max(0, cursor));
  }
  apply(input: Input): "submit" | "stop" | "exit" | "fold" | "edit" | undefined {
    if (input.kind === "event") {
      const { ev, id, len, from, to, cursor, text } = input.value;
      if (ev !== "edit" || id !== "draft" || len !== this.text.length || typeof text !== "string" ||
        typeof from !== "number" || typeof to !== "number" || typeof cursor !== "number" ||
        ![from, to, cursor].every(Number.isInteger) || from < 0 || from > to || to > len) return;
      this.#replace(from, to, text, cursor);
    } else if (input.kind === "paste") {
      this.#replace(this.cursor, this.cursor, plain(input.value));
    } else {
      const left = this.cursor - ([...this.text.slice(0, this.cursor)].pop()?.length ?? 0);
      const right = this.cursor + (String.fromCodePoint(this.text.codePointAt(this.cursor) ?? 0).length);
      switch (input.value) {
        case "\r": case "\x1b[13u": return "submit";
        case "\n": case "\x1b[13;2u": case "\x1b[27;2;13~": this.#replace(this.cursor, this.cursor, "\n"); break;
        case "\x1b": case "\x03": case "\x1b[99;5u": return "stop";
        case "\x04": case "\x1b[100;5u": return "exit";
        case "\x0f": case "\x1b[111;5u": return "fold";
        case "\x01": this.cursor = 0; break;
        case "\x05": this.cursor = this.text.length; break;
        case "\x15": this.#replace(0, this.cursor, ""); break;
        case "\x0b": this.#replace(this.cursor, this.text.length, ""); break;
        case "\x7f": case "\b": this.#replace(left, this.cursor, ""); break;
        case "\x1b[3~": this.#replace(this.cursor, right, ""); break;
        case "\x1b[D": this.cursor = left; break;
        case "\x1b[C": this.cursor = Math.min(right, this.text.length); break;
        default:
          if (!/^[^\p{Cc}]$/u.test(input.value)) return;
          this.#replace(this.cursor, this.cursor, input.value);
      }
    }
    return "edit";
  }
}
