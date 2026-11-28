import { attachmentCount, imageMimes, previewPixelLimit } from "./attachments";
import { attachmentLimit } from "./clipboard";
import { node, plain, record, string, type Op } from "./surface";

type BlobWriter = (mime: string, bytes: Uint8Array) => string;
type PendingImage = {
  readonly id: string;
  readonly label: string;
  readonly mime: string;
  readonly data: string;
  readonly size: number;
};
const unavailable = (id: string, label: string) => node(id, "text", { text: `${label} unavailable` });
const viewerSide = 4096;
const fullSizeQualities = [80, 50, 45] as const;
const resizedProbes = 4;

async function displayImage({ mime, data, size }: PendingImage, remaining: number, active: () => boolean) {
  if (typeof Bun.Image !== "function") return;
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) return;
  const source = new Bun.Image(bytes);
  const { width, height, format } = await source.metadata();
  if (!active() || `image/${format}` !== mime || !width || !height || width * height > previewPixelLimit) return;
  const longSide = Math.max(width, height);
  if (longSide > viewerSide) {
    const aspect = Math.min(width, height) / longSide;
    let side = viewerSide;
    // Prefer the viewer's full resolution; only trade pixels for bytes after a quality retry.
    for (let attempt = 0; attempt < fullSizeQualities.length + resizedProbes; attempt++) {
      if (!active()) return;
      const quality = fullSizeQualities[attempt] ?? fullSizeQualities[2];
      const reduced = await new Bun.Image(bytes).resize(side, side, { fit: "inside" }).webp({ quality }).bytes();
      if (reduced.length <= remaining) return { mime: "image/webp", bytes: reduced, resized: true };
      if (attempt < fullSizeQualities.length - 1) continue;
      if (side === 1) break;
      const ratio = remaining / reduced.length;
      const shortSide = Math.max(1, Math.round(side * aspect));
      // Area scaling becomes linear at a one-pixel short edge. Encoded bytes
      // need not follow area, so temper the first large cut and remeasure.
      const scale = Math.min(Math.sqrt(ratio), ratio * shortSide);
      const next = side === viewerSide ? Math.max(0.4, 0.98 * scale) : 0.98 * scale;
      side = Math.max(1, Math.floor(side * next));
    }
    return;
  }
  if (size > remaining) return;
  // Verify decoding, but preserve the original for images the viewer can already show.
  await source.resize(64, 64, { fit: "inside" }).png().bytes();
  return { mime, bytes, resized: false };
}

export function sentMessage(id: string, content: unknown, publish?: BlobWriter) {
  const blocks: readonly unknown[] = Array.isArray(content) ? content : [{ type: "text", text: content }];
  const children: ReturnType<typeof node>[] = [];
  const pending: PendingImage[] = [];
  let imageNumber = 0;
  const paragraphs: string[] = [];
  const flushText = () => {
    const text = paragraphs.join("\n\n");
    if (text) children.push(node(`${id}.body${children.length || ""}`, "text", { text }));
    paragraphs.length = 0;
  };
  for (const value of blocks) {
    const block = record(value);
    if (block.type === "text") paragraphs.push(plain(string(block.text)));
    if (block.type !== "image") continue;
    flushText();
    const index = ++imageNumber, imageId = `${id}.image${index}`, label = `Image ${index}`;
    // Reject unsupported MIME and oversized encoded data before allocating
    // a decode buffer. Engine messages need not obey composer limits.
    const mime = string(block.mimeType), data = string(block.data);
    const size = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    if (!publish || index > attachmentCount || !imageMimes.has(mime) || !data.length ||
        data.length % 4 !== 0 || size > attachmentLimit) {
      children.push(unavailable(imageId, label));
      continue;
    }
    children.push(node(`${imageId}.pending`, "text", { text: `Loading ${label.toLowerCase()}…` }));
    pending.push({ id: imageId, label, mime, data, size });
  }
  flushText();
  if (!children.length) return;
  return {
    view: node(id, "message", { side: "end", variant: "auto", author: "You" }, children),
    resolve: publish && pending.length ? async (frame: (...ops: Op[]) => void, active: () => boolean) => {
      let sourceRemaining = attachmentLimit, publishedRemaining = attachmentLimit;
      for (const item of pending) {
        if (!active()) return;
        let blob: string | undefined;
        let alt = item.label;
        try {
          if (item.size <= sourceRemaining && publishedRemaining > 0) {
            const image = await displayImage(item, publishedRemaining, active);
            if (image && active()) {
              blob = publish(image.mime, image.bytes);
              // A validated original and its emitted rendition spend separate budgets.
              sourceRemaining -= item.size;
              publishedRemaining -= image.bytes.length;
              if (image.resized) alt = `${item.label} (resized)`;
            }
          }
        } catch {
          // Decode and blob I/O failures must not reject the queue for later images.
        }
        if (!active()) return;
        // No custom click handler: the host's native viewer opens this blob.
        const child = blob === undefined ? unavailable(item.id, item.label)
          : node(item.id, "image", { blob, alt, max: { h: "5lines" } });
        const placeholder = `${item.id}.pending`;
        frame(["add", child.id, id, placeholder, child], ["del", placeholder]);
      }
    } : undefined,
  };
}
