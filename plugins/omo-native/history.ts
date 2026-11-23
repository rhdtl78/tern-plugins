import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { plain, record, string } from "./surface";

export type SavedTarget = {
  readonly path: string;
  readonly sessionId: string;
  readonly fileId: string;
};
export type SavedSession = SavedTarget & {
  readonly title: string;
  readonly modifiedAt: number;
};

const windowBytes = 64 * 1024;
// Darwin's O_NOFOLLOW_ANY rejects symlinks in *every* component. On Linux,
// check the kernel's path for the opened descriptor before reading any bytes.
const openFlags = constants.O_RDONLY | constants.O_NONBLOCK
  | (process.platform === "darwin" ? 0x20000000 : constants.O_NOFOLLOW);

function fileId(stat: { dev: bigint; ino: bigint }) { return `${stat.dev}:${stat.ino}`; }

function agentDirectory() {
  // Mirrors omo-ai/bin/lib/agent-dir.js (not bare Senpi's default).
  for (const key of ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"]) {
    const path = process.env[key]?.trim();
    if (path) return resolve(path);
  }
  return join(process.env.HOME || process.env.USERPROFILE || homedir(), ".omo", "agent");
}

function filesystemError(error: unknown) {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

function parse(line: string) {
  try { return record(JSON.parse(line)); }
  catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function readInto(file: FileHandle, buffer: Buffer, start: number, chunkSize = buffer.length) {
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await file.read(buffer, length, Math.min(chunkSize, buffer.length - length), start + length);
    if (bytesRead === 0) break;
    length += bytesRead;
    // Header discovery stops at the first LF without reading the body window.
    if (chunkSize < buffer.length && buffer.subarray(length - bytesRead, length).includes(10)) break;
  }
  return buffer.subarray(0, length);
}

function displayTitle(text: string) {
  return plain(text.replace(/\s+/gu, " ")).trim().slice(0, 160);
}

async function readSession(path: string, cwd: string) {
  try {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile()) return;
    const file = await open(path, openFlags);
    try {
      const stat = await file.stat({ bigint: true });
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) return;
      if (process.platform === "linux" && await readlink(`/proc/self/fd/${file.fd}`) !== path) return;

      const headerBytes = await readInto(file, Buffer.allocUnsafe(windowBytes), 0, 1024);
      const newline = headerBytes.indexOf(10);
      if (newline < 0) return;
      const header = parse(headerBytes.toString("utf8", 0, newline));
      const savedCwd = string(header?.cwd);
      if (header?.type !== "session" || !string(header.id) || header.spawnedBy !== undefined
        || !isAbsolute(savedCwd) || savedCwd.includes("\0") || await realpath(savedCwd) !== cwd) return;

      const size = Number(stat.size), start = newline + 1;
      if (start >= size) return;
      const head = await readInto(file, Buffer.allocUnsafe(Math.min(size - start, windowBytes)), start);
      const end = Math.max(start + head.length, size - windowBytes);
      let title = "", firstPrompt = "", hasEntry = false;
      const scan = (bytes: Buffer, fromHead: boolean) => {
        // Only process complete JSONL records, including when a write is in progress.
        const last = bytes.lastIndexOf(10);
        if (last < 0) return;
        for (const line of bytes.toString("utf8", 0, last).split("\n")) {
          const entry = parse(line);
          if (!entry || !string(entry.type) || entry.type === "session") continue;
          hasEntry = true;
          if (entry.type === "session_info" && typeof entry.name === "string") title = displayTitle(entry.name);
          if (!fromHead || firstPrompt || entry.type !== "message") continue;
          const message = record(entry.message);
          if (message.role !== "user") continue;
          const content = message.content;
          firstPrompt = displayTitle(Array.isArray(content)
            ? content.map(record).filter(block => block.type === "text").map(block => string(block.text)).join(" ")
            : string(content));
        }
      };
      scan(head, true);
      if (start + head.length < size) {
        const tail = await readInto(file, Buffer.allocUnsafe(size - end + 1), end - 1);
        const firstNewline = tail.indexOf(10);
        if (firstNewline >= 0) scan(tail.subarray(firstNewline + 1), false);
      }
      if (!hasEntry) return;

      // Drop a replaced, removed or rewritten file rather than returning a stale path.
      const after = await lstat(path, { bigint: true });
      if (!after.isFile() || after.dev !== stat.dev || after.ino !== stat.ino
        || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || await realpath(path) !== path) return;
      return { path, sessionId: string(header.id), fileId: fileId(stat),
        title: title || firstPrompt || displayTitle(basename(path, ".jsonl")) || "Untitled session",
        modifiedAt: Number(stat.mtimeNs) / 1_000_000 };
    } finally { await file.close(); }
  } catch (error) {
    if (filesystemError(error)) return;
    throw error;
  }
}

/** Bind the header bytes to the catalogued file, including across a concurrent rename. */
export async function listedHeader(target: SavedTarget) {
  const { path } = target;
  const stale = () => new Error("Saved session was replaced or changed at its listed path. Reload the list.");
  if (await realpath(path) !== path) throw stale();
  const file = await open(path, openFlags);
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || fileId(stat) !== target.fileId) throw stale();
    const bytes = await readInto(file, Buffer.allocUnsafe(windowBytes), 0, 1024);
    const end = bytes.indexOf(10);
    const header = end < 0 ? undefined : parse(bytes.toString("utf8", 0, end));
    if (!header || header.type !== "session" || header.id !== target.sessionId || header.spawnedBy !== undefined
      || fileId(await lstat(path, { bigint: true })) !== target.fileId || await realpath(path) !== path) throw stale();
    return header;
  } finally { await file.close(); }
}

async function directories(path: string) {
  try {
    if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) return [];
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (filesystemError(error)) return [];
    throw error;
  }
}

/** Read only the local OmO home store, without creating files or loading the engine. */
export async function listSavedSessions(cwd: string): Promise<readonly SavedSession[]> {
  if (process.platform !== "darwin" && process.platform !== "linux") return [];
  let canonicalCwd: string, root: string;
  try {
    [canonicalCwd, root] = await Promise.all([realpath(cwd), realpath(agentDirectory())]);
  } catch (error) {
    if (filesystemError(error)) return [];
    throw error;
  }
  const sessions = join(root, "sessions");
  const found = [];
  // Encoded names are lossy and different aliases can have different buckets.
  // Only the direct engine bucket shape is eligible; the header decides scope.
  for (const bucket of await directories(sessions)) {
    if (!bucket.isDirectory() || !/^--.*--$/su.test(bucket.name)) continue;
    const folder = join(sessions, bucket.name);
    for (const entry of await directories(folder)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const result = await readSession(join(folder, entry.name), canonicalCwd);
      if (result) found.push(result);
    }
  }
  const seen = new Set<string>();
  return found.sort((a, b) => b.modifiedAt - a.modifiedAt
    || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .filter(row => {
      if (seen.has(row.fileId)) return false;
      seen.add(row.fileId);
      return true;
    });
}
