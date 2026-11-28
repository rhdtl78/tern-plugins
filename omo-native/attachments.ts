import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { attachmentLimit } from "./clipboard";
import { add, node, plain } from "./surface";

const mimes = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".gif", "image/gif"], [".webp", "image/webp"],
]);
const unsupported = "This session only accepts image attachments.";
export const attachmentCount = 6;
export type Image = { type: "image"; mimeType: string; data: string };
export type Attachment = { name: string; label: string; size?: number; reason?: string; image?: Image; preview?: Buffer };

export const imageMimes = new Set(mimes.values());
export const previewPixelLimit = 16_000_000;

function details(path: string) {
  const name = plain(basename(path)).replace(/[\n\r\t\u202a-\u202e\u2066-\u2069]/g, " ").trim() || "Unnamed file";
  const ext = extname(name).slice(1).toUpperCase();
  return { name, label: mimes.has(`.${ext.toLowerCase()}`) ? `${ext} image` : ext.slice(0, 10) || "File" };
}

async function image(file: Attachment, mimeType: string, bytes: Buffer, previews: boolean): Promise<Attachment> {
  file.size = bytes.length;
  if (bytes.length > attachmentLimit) return { ...file, reason: "The image exceeds the 4 MiB attachment limit." };
  if (!previews) return { ...file, reason: "This Tern host does not support image previews." };
  try {
    // Send original bytes to OmO, but give Tern a bounded preview rather than a full-size blob.
    if (typeof Bun.Image !== "function") return { ...file, reason: "This Bun runtime does not support image previews." };
    const source = new Bun.Image(bytes);
    const { width, height, format } = await source.metadata();
    if (`image/${format}` !== mimeType) return { ...file, reason: "The image data does not match its file type." };
    if (width * height > previewPixelLimit) return { ...file, reason: "The image exceeds the 16 megapixel preview limit." };
    const preview = Buffer.from(await source.resize(64, 64, { fit: "inside" }).png().bytes());
    return { ...file, preview, image: { type: "image", mimeType, data: bytes.toString("base64") } };
  } catch {
    return { ...file, reason: "The image could not be decoded for preview." };
  }
}

export async function clipboardImage(mime: string, data: Buffer, previews: boolean) {
  const ext = mime.split("/")[1] ?? "image";
  return image(details(`Pasted image.${ext}`), mime, data, previews);
}

export function fileEntries(data: Buffer) {
  return data.toString("utf8").split(/\r?\n/).filter(line => line && !line.startsWith("#"));
}

export async function clipboardFile(uri: string, previews: boolean): Promise<Attachment> {
  let path: string;
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) throw new Error();
    path = fileURLToPath(url);
  } catch {
    return { name: "Clipboard item", label: "File", reason: "Only local files can be attached." };
  }
  const file: Attachment = details(path);
  const checked = (stat: Stats) => {
    if (!stat.isFile()) return { ...file, reason: "Only regular files can be attached." };
    file.size = stat.size;
    if (file.size > attachmentLimit) return { ...file, reason: "The file exceeds the 4 MiB attachment limit." };
  };
  try {
    const rejected = checked(await lstat(path));
    if (rejected) return rejected;
    const mime = mimes.get(extname(path).toLowerCase());
    if (!mime) return { ...file, reason: unsupported };
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const changed = checked(await handle.stat());
      if (changed) return changed;
      const buffer = Buffer.alloc(attachmentLimit + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      return await image(file, mime, buffer.subarray(0, size), previews);
    } finally {
      await handle.close();
    }
  } catch {
    return { ...file, reason: "The local file could not be read." };
  }
}

export function sendBlock(files: readonly Attachment[], modelInput: unknown) {
  return files.find(file => file.reason)?.reason ??
    (files.length && Array.isArray(modelInput) && !modelInput.includes("image")
      ? "The selected model does not accept images." : undefined) ??
    (files.reduce((total, file) => total + (file.size ?? 0), 0) > attachmentLimit
      ? "Images exceed the 4 MiB combined attachment limit." : undefined);
}

export function attachmentCard(id: string, file: Attachment, blob?: string) {
  const size = file.size === undefined ? "" : file.size < 1024 ? ` · ${file.size} B`
    : ` · ${(file.size / 1024).toFixed(1)} KiB`;
  return add("attachments", node(id, "row", { role: "omp.attachment" }, [
    ...(blob ? [node(`${id}.preview`, "image", { role: "omp.attachment.preview", blob, alt: file.name,
      actions: { click: "ignore" } })] : []),
    node(`${id}.info`, "col", { role: "omp.attachment.info", grow: 1 }, [
      node(`${id}.name`, "text", { role: "omp.attachment.name", text: file.name, title: file.name }),
      node(`${id}.meta`, "text", { role: "omp.attachment.meta", text: file.label + size }),
      ...(file.reason ? [node(`${id}.reason`, "text", { role: "omp.attachment.meta", text: file.reason })] : []),
    ]),
    node(`${id}.remove`, "button", { text: "×", aria: `Remove ${file.name}`, variant: "quiet",
      actions: { click: "remove-attachment" } }),
  ]));
}

export const attachmentsCss = `
  .sf-col[data-id="composer"] > .sf-col[data-id="attachments"] {
    min-width: 0;
    max-height: 112px;
    overflow-y: auto;
    overflow-x: hidden;
    gap: 4px;
  }
  .sf-row[data-role="omp.attachment"] {
    min-width: 0;
    flex: none;
    align-items: center;
    gap: 6px;
    border: 1px solid var(--l3);
    border-radius: 8px;
    padding: 3px 6px;
  }
  .sf-col[data-role="omp.attachment.info"] { min-width: 0; gap: 1px; }
  .sf-text[data-role^="omp.attachment."] { overflow-wrap: anywhere; }
  .sf-text[data-role="omp.attachment.name"] {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sf-text[data-role="omp.attachment.meta"] { color: var(--t2); font-size: .8em; }
  .sf-image[data-role="omp.attachment.preview"] { width: 40px; height: 40px; flex: 0 0 40px; }
  .sf-row[data-role="omp.attachment"] > .sf-button { flex: none; }
`;
