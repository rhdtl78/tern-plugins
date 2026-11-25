import { plain, type Input } from "./surface";

export type SubmitMode = "prompt" | "steer" | "follow_up";
export const isStopKey = (key: string) =>
  key === "\x1b" || key === "\x1b[27u" || key === "\x03" || key === "\x1b[99;5u";

const words = new Intl.Segmenter(undefined, { granularity: "word" });
function wordBoundary(text: string, cursor: number, direction: -1 | 1): number {
  let left = 0;
  for (const { index, segment, isWordLike } of words.segment(text)) {
    if (!isWordLike) continue;
    if (direction === -1) {
      if (index >= cursor) break;
      left = index;
    } else if (index + segment.length > cursor) return index + segment.length;
  }
  return direction === -1 ? left : text.length;
}

type UndoStep = {
  readonly from: number;
  readonly inserted: number;
  readonly removed: string;
  readonly cursor: number;
};
const undoLimit = 100;

export class Editor {
  text = "";
  cursor = 0;
  #undo: UndoStep[] = [];
  reset(text: string, cursor = text.length) {
    this.text = text; this.cursor = cursor; this.#undo = [];
  }
  #replace(from: number, to: number, text: string, cursor = from + text.length) {
    const removed = this.text.slice(from, to);
    if (removed !== text) {
      this.#undo.push({ from, inserted: text.length, removed, cursor: this.cursor });
      if (this.#undo.length > undoLimit) this.#undo.shift();
    }
    this.text = this.text.slice(0, from) + text + this.text.slice(to);
    this.cursor = Math.min(this.text.length, Math.max(0, cursor));
  }
  replaceDraft(text: string) { this.#replace(0, this.text.length, text); }
  #undoEdit(): "edit" | undefined {
    const step = this.#undo.pop();
    if (!step) return;
    const { from, inserted, removed, cursor } = step;
    this.text = this.text.slice(0, from) + removed + this.text.slice(from + inserted);
    this.cursor = cursor;
    return "edit";
  }
  apply(input: Input): SubmitMode | "exit" | "fold" | "edit" | undefined {
    if (input.kind === "event") {
      const { ev, id, len, from, to, cursor, text } = input.value;
      if (id !== "draft") return;
      if (ev === "undo") return this.#undoEdit();
      if (ev !== "edit" || len !== this.text.length || typeof text !== "string" ||
        typeof from !== "number" || typeof to !== "number" || typeof cursor !== "number" ||
        ![from, to, cursor].every(Number.isInteger) || from < 0 || from > to || to > len) return;
      this.#replace(from, to, text, cursor);
    } else if (input.kind === "paste") {
      this.#replace(this.cursor, this.cursor, plain(input.value));
    } else if (input.kind === "key") {
      const left = this.cursor - ([...this.text.slice(0, this.cursor)].pop()?.length ?? 0);
      const right = this.cursor + (String.fromCodePoint(this.text.codePointAt(this.cursor) ?? 0).length);
      switch (input.value) {
        case "\x1b[122;9u": return this.#undoEdit();
        case "\r": case "\x1b[13u": return "prompt";
        case "\x1b[13;9u": return "steer";
        case "\x1b[13;5u": case "\x1b[27;5;13~": return "follow_up";
        case "\n": case "\x1b[13;2u": case "\x1b[27;2;13~": this.#replace(this.cursor, this.cursor, "\n"); break;
        case "\x04": case "\x1b[100;5u": return "exit";
        case "\x0f": case "\x1b[111;5u": return "fold";
        case "\x01": this.cursor = 0; break;
        case "\x05": this.cursor = this.text.length; break;
        // Tern sends Cmd+Backspace as the terminal's line-kill byte.
        case "\x15": this.#replace(this.cursor === 0 ? 0 : this.text.lastIndexOf("\n", this.cursor - 1) + 1, this.cursor, ""); break;
        case "\x0b": this.#replace(this.cursor, this.text.length, ""); break;
        case "\x1b[127;3u": this.#replace(wordBoundary(this.text, this.cursor, -1), this.cursor, ""); break;
        // Tern translates Option+Left/Right to the corresponding Meta-b/f terminal keys.
        case "\x1b[98;3u": this.cursor = wordBoundary(this.text, this.cursor, -1); break;
        case "\x1b[102;3u": this.cursor = wordBoundary(this.text, this.cursor, 1); break;
        case "\x7f": case "\b": this.#replace(left, this.cursor, ""); break;
        case "\x1b[3~": this.#replace(this.cursor, right, ""); break;
        case "\x1b[D": this.cursor = left; break;
        case "\x1b[C": this.cursor = Math.min(right, this.text.length); break;
        default:
          if (!/^[^\p{Cc}]$/u.test(input.value)) return;
          this.#replace(this.cursor, this.cursor, input.value);
      }
    } else return;
    return "edit";
  }
}
