import { plain, type Input } from "./surface";

export type SubmitMode = "prompt" | "steer" | "follow_up";
export const isStopKey = (key: string) =>
  key === "\x1b" || key === "\x1b[27u" || key === "\x03" || key === "\x1b[99;5u";

const words = new Intl.Segmenter(undefined, { granularity: "word" });
const characters = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const lineStart = (text: string, cursor: number) => cursor > 0 ? text.lastIndexOf("\n", cursor - 1) + 1 : 0;
function lineEnd(text: string, cursor: number) {
  const end = text.indexOf("\n", cursor);
  return end < 0 ? text.length : end;
}
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
  readonly inserted: string;
  readonly removed: string;
  readonly before: number;
  readonly after: number;
};
const undoLimit = 100;

export class Editor {
  text = "";
  cursor = 0;
  #undo: UndoStep[] = [];
  #redo: UndoStep[] = [];
  #column?: number;
  reset(text: string, cursor = text.length) {
    this.text = text; this.cursor = cursor;
    this.#undo = []; this.#redo = []; this.#column = undefined;
  }
  #replace(from: number, to: number, text: string, cursor = from + text.length) {
    const removed = this.text.slice(from, to);
    const after = Math.min(this.text.length - (to - from) + text.length, Math.max(0, cursor));
    if (removed !== text) {
      this.#undo.push({ from, inserted: text, removed, before: this.cursor, after });
      if (this.#undo.length > undoLimit) this.#undo.shift();
      this.#redo = [];
      this.text = this.text.slice(0, from) + text + this.text.slice(to);
    }
    this.cursor = after;
    this.#column = undefined;
  }
  replaceDraft(text: string) { this.#replace(0, this.text.length, text); }
  #history(redo: boolean): "edit" | undefined {
    const step = (redo ? this.#redo : this.#undo).pop();
    if (!step) return;
    const { from, inserted, removed, before, after } = step;
    const previous = redo ? removed : inserted;
    const next = redo ? inserted : removed;
    this.text = this.text.slice(0, from) + next + this.text.slice(from + previous.length);
    this.cursor = redo ? after : before;
    this.#column = undefined;
    (redo ? this.#undo : this.#redo).push(step);
    return "edit";
  }
  #moveLine(direction: -1 | 1) {
    const start = lineStart(this.text, this.cursor);
    const end = lineEnd(this.text, this.cursor);
    if (direction < 0 ? start === 0 : end === this.text.length) return;
    this.#column ??= [...characters.segment(this.text.slice(start, this.cursor))].length;
    const target = direction < 0 ? lineStart(this.text, start - 1) : end + 1;
    const line = this.text.slice(target, lineEnd(this.text, target));
    this.cursor = target + ([...characters.segment(line)][this.#column]?.index ?? line.length);
  }
  apply(input: Input): SubmitMode | "exit" | "fold" | "edit" | undefined {
    if (input.kind === "event") {
      const { ev, id, len, from, to, cursor, text } = input.value;
      if (id !== "draft") return;
      if (ev === "undo" || ev === "redo") return this.#history(ev === "redo");
      if (ev !== "edit" || len !== this.text.length || typeof text !== "string" ||
        typeof from !== "number" || typeof to !== "number" || typeof cursor !== "number" ||
        ![from, to, cursor].every(Number.isInteger) || from < 0 || from > to || to > len) return;
      this.#replace(from, to, text, cursor);
    } else if (input.kind === "paste") {
      this.#replace(this.cursor, this.cursor, plain(input.value));
    } else if (input.kind === "key") {
      // Tern owns selection, clipboard and IME. Unselected terminal keys can
      // still reach us alongside the editor's addressed replacement events.
      if (input.value === "\x1b[A" || input.value === "\x1b[B") {
        this.#moveLine(input.value === "\x1b[A" ? -1 : 1);
        return "edit";
      }
      const left = () => characters.segment(this.text).containing(this.cursor - 1)?.index ?? 0;
      const right = () => {
        const next = characters.segment(this.text).containing(this.cursor);
        return next ? next.index + next.segment.length : this.text.length;
      };
      switch (input.value) {
        case "\x1b[122;9u": case "\x1b[122;5u": return this.#history(false);
        case "\x1b[122;10u": case "\x1b[122;6u": case "\x1b[121;5u": return this.#history(true);
        case "\r": case "\x1b[13u": return "prompt";
        case "\x1b[13;9u": return "steer";
        case "\x1b[13;5u": case "\x1b[27;5;13~": return "follow_up";
        case "\n": case "\x1b[13;2u": case "\x1b[27;2;13~": this.#replace(this.cursor, this.cursor, "\n"); break;
        case "\x04": case "\x1b[100;5u": return "exit";
        case "\x0f": case "\x1b[111;5u": return "fold";
        case "\x01": case "\x1b[1;5H": this.cursor = 0; break;
        case "\x05": case "\x1b[1;5F": this.cursor = this.text.length; break;
        // Tern sends Cmd+Backspace as the terminal's line-kill byte.
        case "\x15": this.#replace(lineStart(this.text, this.cursor), this.cursor, ""); break;
        case "\x0b": this.#replace(this.cursor, this.text.length, ""); break;
        case "\x1b[127;3u": case "\x1b[127;5u": this.#replace(wordBoundary(this.text, this.cursor, -1), this.cursor, ""); break;
        case "\x1b[3;3~": case "\x1b[3;5~": this.#replace(this.cursor, wordBoundary(this.text, this.cursor, 1), ""); break;
        // Tern translates Option+Left/Right to the corresponding Meta-b/f terminal keys.
        case "\x1b[98;3u": case "\x1b[1;5D": this.cursor = wordBoundary(this.text, this.cursor, -1); break;
        case "\x1b[102;3u": case "\x1b[1;5C": this.cursor = wordBoundary(this.text, this.cursor, 1); break;
        case "\x7f": case "\b": this.#replace(left(), this.cursor, ""); break;
        case "\x1b[3~": this.#replace(this.cursor, right(), ""); break;
        case "\x1b[D": this.cursor = left(); break;
        case "\x1b[C": this.cursor = right(); break;
        default:
          if (!/^[^\p{Cc}]$/u.test(input.value)) return;
          this.#replace(this.cursor, this.cursor, input.value);
      }
      this.#column = undefined;
    } else return;
    return "edit";
  }
}
