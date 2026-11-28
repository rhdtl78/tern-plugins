import { expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
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

function pngChunk(type: string, data: Uint8Array) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, 4, "ascii");
  chunk.set(data, 8);
  chunk.writeUInt32BE(Bun.hash.crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function widePng(width: number, padTo?: number, pattern: "stripes" | "inverted" | "noise" = "stripes") {
  const header = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0]);
  header.writeUInt32BE(width);
  header.writeUInt32BE(900, 4);
  const row = Buffer.alloc(width + 1);
  const pixels = Buffer.alloc(row.length * 900);
  if (pattern === "noise") {
    let state = 17;
    for (let y = 0; y < 900; y++) for (let x = 1; x <= width; x++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      pixels[y * row.length + x] = state >>> 24;
    }
  } else {
    for (let x = 0; x < width; x++) row[x + 1] = (x % 16 < 8) !== (pattern === "inverted") ? 255 : 0;
    pixels.fill(row);
  }
  const chunks = [
    Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0)),
  ];
  if (padTo !== undefined) {
    const padding = Buffer.alloc(padTo - chunks.reduce((sum, chunk) => sum + chunk.length, 0) - 12, 65);
    padding.write("note\0");
    chunks.splice(-1, 0, pngChunk("tEXt", padding));
  }
  return Buffer.concat(chunks);
}

async function resolveImages(blocks: readonly ReturnType<typeof block>[], failFirst = false) {
  const blobs: { readonly mime: string; readonly bytes: Uint8Array; readonly id: string }[] = [];
  const views = new Map<string, ReturnType<typeof record>>();
  let failed = false;
  const message = sentMessage("m1", blocks, (mime, bytes) => {
    if (failFirst && !failed) {
      failed = true;
      throw new Error("fixture publication failed");
    }
    const id = digest(bytes);
    blobs.push({ mime, bytes, id });
    return id;
  });
  if (!message?.resolve) throw new Error("Expected pending image decode");
  for (const child of message.view.c) views.set(child.id, child.p);
  await message.resolve((...ops) => {
    for (const [verb, id, , , child] of ops) if (verb === "add") views.set(String(id), record(record(child).p));
  }, () => true);
  return { blobs, views: blocks.map((_, index) => views.get(`m1.image${index + 1}`)) };
}

test("#32 publishes a 4097px image at the viewer limit", async () => {
  const { blobs } = await resolveImages([block(widePng(4097).toString("base64"))]);
  expect(blobs.map(blob => blob.mime)).toEqual(["image/webp"]);
  const dimensions = await Promise.all(blobs.map(blob => new Bun.Image(blob.bytes).metadata()));
  expect(dimensions.map(({ width, height }) => [width, height])).toEqual([[4096, 900]]);
});

test("#32 discloses the resize in the native viewer alt label", async () => {
  const { views } = await resolveImages([block(widePng(4097).toString("base64"))]);
  expect(views.map(view => view?.alt)).toEqual([expect.stringMatching(/^Image 1.*resized/i)]);
});

test("#32 passes a padded 4096px source to the viewer byte for byte", async () => {
  const exact = widePng(4096, attachmentLimit);
  const { blobs, views } = await resolveImages([block(exact.toString("base64"))]);
  expect(blobs.map(({ mime, id }) => [mime, id])).toEqual([["image/png", digest(exact)]]);
  expect(views.map(view => view?.alt)).toEqual(["Image 1"]);
});

test.each([
  ["a MIME mismatch", "image/jpeg", false, ["Image 1 unavailable", "Image 2"]],
  ["a successfully published source", "image/png", false, ["Image 1", "Image 2 unavailable"]],
  ["a failed publication", "image/png", true, ["Image 1 unavailable", "Image 2"]],
] as const)("#32 charges padded original bytes only for %s when it publishes", async (_case, mime, failFirst, expected) => {
  const first = widePng(4097, 2_400_000).toString("base64");
  const second = widePng(4097, 2_400_000, "inverted").toString("base64");
  const { blobs, views } = await resolveImages([block(first, mime), block(second)], failFirst);
  expect(views.map(view => String(view?.text ?? view?.alt).replace(/ \(resized\)$/i, ""))).toEqual([...expected]);
  expect(blobs.map(blob => blob.mime)).toEqual(["image/webp"]);
});

test.each([
  ["retries at full viewer resolution", 1_800_000, 4096],
  ["falls back to a smaller rendition", 1_000_000, 2048],
] as const)("#32 %s when the best rendition exceeds the published budget", async (_case, remaining, width) => {
  const jpeg = await new Bun.Image(widePng(4097, undefined, "noise")).jpeg({ quality: 1 }).bytes();
  const noisy = block(Buffer.from(jpeg).toString("base64"), "image/jpeg");
  const ordinary = widePng(128, 900_000);
  const first = widePng(128, attachmentLimit - remaining);
  const later = block(blue);
  // This compliant neighbor fits the source budget but not the published
  // budget after the full-resolution rendition. A tiny neighbor still fits.
  const neighbors = width === 4096 ? [block(ordinary.toString("base64")), later] : [later];
  const { blobs, views } = await resolveImages([block(first.toString("base64")), noisy, ...neighbors]);
  expect(blobs.map(blob => blob.mime)).toEqual(["image/png", "image/webp", "image/png"]);
  const rendition = blobs.find(blob => blob.mime === "image/webp");
  if (!rendition) throw new Error("Expected a viewer rendition");
  expect((await new Bun.Image(rendition.bytes).metadata()).width).toBe(width);
  expect(blobs.reduce((total, blob) => total + blob.bytes.length, 0)).toBeLessThanOrEqual(attachmentLimit);
  if (width === 4096) expect(views[2]?.text).toBe("Image 3 unavailable");
  expect(views.at(-1)?.blob).toBe(blobIds[1]);
});

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
