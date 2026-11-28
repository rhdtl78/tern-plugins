import { attachmentCount, imageMimes, previewPixelLimit } from "./attachments";
import { attachmentLimit } from "./clipboard";
import { node, plain, record, string, type Op } from "./surface";

type BlobWriter = (mime: string, bytes: Uint8Array) => string;
const unavailable = (id: string, label: string) => node(id, "text", { text: `${label} unavailable` });

async function displayImage(mime: string, data: string) {
  if (typeof Bun.Image !== "function") return;
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) return;
  const source = new Bun.Image(bytes);
  const { width, height, format } = await source.metadata();
  if (`image/${format}` !== mime || !width || !height || width * height > previewPixelLimit) return;
  // Decode before handing a blob to Tern. Use a bounded rendition above the renderer's side limit.
  if (Math.max(width, height) > 4096) {
    const reduced = await source.resize(2048, 2048, { fit: "inside" }).webp().bytes();
    if (reduced.length <= attachmentLimit) return { mime: "image/webp", bytes: reduced };
    return;
  }
  await source.resize(64, 64, { fit: "inside" }).png().bytes();
  return { mime, bytes };
}

export function sentMessage(id: string, content: unknown, publish?: BlobWriter) {
  const blocks: readonly unknown[] = Array.isArray(content) ? content : [{ type: "text", text: content }];
  const children: ReturnType<typeof node>[] = [];
  const pending: { readonly id: string; readonly label: string; readonly mime: string; readonly data: string }[] = [];
  let imageNumber = 0, remaining = attachmentLimit;
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
        data.length % 4 !== 0 || size > remaining) {
      children.push(unavailable(imageId, label));
      continue;
    }
    remaining -= size;
    children.push(node(`${imageId}.pending`, "text", { text: `Loading ${label.toLowerCase()}…` }));
    pending.push({ id: imageId, label, mime, data });
  }
  flushText();
  if (!children.length) return;
  return {
    view: node(id, "message", { side: "end", variant: "auto", author: "You" }, children),
    resolve: publish && pending.length ? async (frame: (...ops: Op[]) => void, active: () => boolean) => {
      for (const item of pending) {
        if (!active()) return;
        let blob: string | undefined;
        try {
          const image = await displayImage(item.mime, item.data);
          if (image && active()) blob = publish(image.mime, image.bytes);
        } catch {
          // Decode and blob I/O failures must not reject the queue for later images.
        }
        if (!active()) return;
        // No custom click handler: the host's native viewer opens this blob.
        const child = blob === undefined ? unavailable(item.id, item.label)
          : node(item.id, "image", { blob, alt: item.label, max: { h: "5lines" } });
        const placeholder = `${item.id}.pending`;
        frame(["add", child.id, id, placeholder, child], ["del", placeholder]);
      }
    } : undefined,
  };
}
