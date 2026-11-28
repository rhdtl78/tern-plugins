import { expect, test } from "bun:test";
import { attachmentLimit } from "./clipboard";
import { exercise, withText } from "./notice-pty";
import { sentMessage } from "./sent-images";
import { record, type Op } from "./surface";
import { Transcript } from "./transcript";

const red = "iVBORw0KGgoAAAANSUhEUgAAAIAAAABQCAIAAABeYuqzAAAAqUlEQVR4nO3RQQ0AIAzAwEnBAP4lYQMZe/SSCmhy887VYrN+EA8AgHYAALQDAKAdAADtAABoBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtAABoBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtAABoBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtAABoBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtAABoBwBAOwAA2n01RCLRWCjwowAAAABJRU5ErkJggg==";
const blue = "iVBORw0KGgoAAAANSUhEUgAAAIAAAABQCAIAAABeYuqzAAAAqUlEQVR4nO3RQQ0AIAzAwElBD/49YAMZe/SSCmhyc+7TYrN+EA8AgHYAALQDAKAdAADtAABoBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtAABoBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtAABoBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtAABoBwBAOwAA2gEA0A4AgHYAALQDAKAdAADtAABoBwBAOwAA2n1Da6sNEMKbkwAAAABJRU5ErkJggg==";
const digest = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const blobIds = [red, blue].map(data => digest(Buffer.from(data, "base64")));
const block = (data: string, mimeType = "image/png") => ({ type: "image", mimeType, data });
const osc = (fields: string) => `\x1b]5522;type=read:${fields}\x1b\\`;
const b64 = (text: string) => Buffer.from(text).toString("base64");

test("#32 displays two real clipboard images in send order after OmO acknowledges the prompt", async () => {
  let pasted = 0, submitted = false;
  let observed: unknown[] = [];
  const offer = (index: number) =>
    osc(`status=OK:pw=fixture${index}`) +
    osc(`status=DATA:pw=fixture${index}:mime=${b64(".")};${b64("image/png")}`) +
    osc(`status=DONE:pw=fixture${index}`);
  await exercise(false, (views, { key, event, clipboardReadId }) => {
    if (clipboardReadId) {
      const data = pasted === 1 ? red : blue;
      key(osc(`status=DATA:id=${clipboardReadId}:mime=${b64("image/png")};${data}`) +
        osc(`status=DONE:id=${clipboardReadId}`));
    } else if (!pasted && withText(views, "Hot-reloaded: fixture/omo.jsonc").length) {
      key(offer(++pasted));
    } else if (pasted === 1 && [...views.values()].filter(view => view.parent === "attachments").length === 1) {
      key(offer(++pasted));
    } else if (!submitted && pasted === 2 && [...views.values()].filter(view => view.parent === "attachments").length === 2) {
      submitted = true;
      event({ ev: "send", id: "draft", text: "Live pair" });
    } else if (submitted) {
      const transcript = [...views.values()].filter(view => view.kind === "image" && views.get(view.parent)?.kind === "message");
      if (views.get("attachments")?.props.hidden === true && transcript.length === 2) {
        observed = transcript.map(view => view.props.blob);
        return true;
      }
      if (withText(views, "Live pair\n\n[Image]\n\n[Image]").length) return true;
    }
    return false;
  }, "images");
  expect(observed).toEqual(blobIds);
}, 8000);

test("#32 unavailable images don't open blobs or prevent valid neighbors in saved history", async () => {
  const published: string[] = [];
  const { promise, resolve } = Promise.withResolvers<readonly string[]>();
  const blocks = [
    block("file:///private/no-file.png"), block("abcd", "image/svg+xml"),
    block("YWJjZA=="),
    block(red), block(blue), block(red), block(blue),
  ];
  const children: ReturnType<typeof record>[] = [];
  const project = (...ops: Op[]) => {
    for (const [verb, id, parent, before, child] of ops) {
      const entry = record(child);
      if (verb === "add" && parent === "main" && Array.isArray(entry.c)) children.push(...entry.c.map(record));
      if (verb === "add" && typeof before === "string") {
        children.splice(children.findIndex(node => node.id === before), 0, entry);
      }
      if (verb === "del") children.splice(children.findIndex(node => node.id === id), 1);
    }
    if (children.length === blocks.length + 1 && !children.some(node => String(node.id).endsWith(".pending")))
      resolve(children.map(node => String(record(node.p).blob ?? record(node.p).text)));
  };
  new Transcript(project, undefined, undefined, (_mime, bytes) => {
    const id = digest(bytes);
    published.push(id);
    return id;
  }).message({ role: "user", content: [...blocks, { type: "text", text: "After images" }] });
  expect(await promise).toEqual([
    "Image 1 unavailable", "Image 2 unavailable", "Image 3 unavailable",
    blobIds[0], blobIds[1], blobIds[0], "Image 7 unavailable", "After images",
  ]);
  expect(published).toEqual([blobIds[0], blobIds[1], blobIds[0]]);
});

test("#32 rejects an oversized history image before publishing and keeps the next valid image", async () => {
  const { promise, resolve } = Promise.withResolvers<string[]>();
  const transcript = new Transcript((...ops) => {
    const image = ops.find(op => op[0] === "add" && record(op[4]).k === "image");
    if (image) resolve([String(record(record(image[4]).p).blob)]);
  }, undefined, undefined, (_mime, bytes) => digest(bytes));
  transcript.message({ role: "user", content: [
    block("A".repeat(Math.ceil((attachmentLimit + 1) / 3) * 4)), block(blue),
  ] });
  expect(await promise).toEqual([blobIds[1]]);
});

test("#32 failed blob publication leaves later images and messages usable", async () => {
  const updates: unknown[] = [];
  const { promise, resolve } = Promise.withResolvers<void>();
  const transcript = new Transcript((...ops) => {
    for (const [verb, , , before, child] of ops) if (verb === "add" && before) {
      const props = record(record(child).p);
      updates.push(props.blob ?? props.text);
      if (updates.length === 3) resolve();
    }
  }, undefined, undefined, (_mime, bytes) => {
    const id = digest(bytes);
    if (id === blobIds[0]) throw new Error("fixture publication failed");
    return id;
  });
  transcript.message({ role: "user", content: [block(red), block(blue)] });
  transcript.message({ role: "user", content: [block(blue)] });
  await promise;
  expect(updates).toEqual(["Image 1 unavailable", blobIds[1], blobIds[1]]);
});

test("#32 retirement fences blob publication and frames after an in-flight decode", async () => {
  const published: string[] = [], frames: Op[] = [];
  let active = true;
  const message = sentMessage("m1", [block(red), block(blue)], (_mime, bytes) => {
    const id = digest(bytes);
    published.push(id);
    return id;
  });
  if (!message?.resolve) throw new Error("Expected a pending image decode");
  const decoding = message.resolve((...ops) => { frames.push(...ops); }, () => active);
  active = false;
  await decoding;
  expect(published).toEqual([]);
  expect(frames).toEqual([]);
});

test("#32 text-only messages retain their body ID and paragraph breaks", () => {
  const frames: Op[] = [];
  const transcript = new Transcript((...ops) => { frames.push(...ops); });
  transcript.message({ role: "user", content: [
    { type: "text", text: "" }, { type: "text", text: "Plain text" }, { type: "text", text: "" },
  ] });
  const children = record(frames[0]?.[4]).c;
  expect(children).toEqual([{ id: "m1.body", k: "text", p: { text: "\n\nPlain text\n\n" }, c: [] }]);
});
