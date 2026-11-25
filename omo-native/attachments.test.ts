import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { attachmentCard, clipboardFile, clipboardImage, fileEntries, sendBlock } from "./attachments";
import { attachmentLimit, Clipboard } from "./clipboard";
import { Editor } from "./editor";
import { InputStream } from "./surface";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=", "base64");
const b64 = (s: string) => Buffer.from(s).toString("base64");
let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

test("user clipboard offer selects actual file flavor and matches the fragmented response", () => {
  const stream = new InputStream(), sent: string[] = [], received: [string, string][] = [];
  const clipboard = new Clipboard(p => sent.push(p), (mime, bytes) => received.push([mime, bytes.toString()]), e => { throw new Error(e); });
  const feed = (value: string) => {
    for (const ch of `\x1b]5522;${value}\x1b\\`) {
      for (const i of stream.feed(ch)) if (i.kind === "clipboard") clipboard.receive(i.value);
    }
  };
  clipboard.receive("type=read:status=DONE:pw=offer");
  expect(sent).toEqual([]);
  feed("type=read:status=OK:pw=offer");
  feed(`type=read:status=DATA:pw=offer:mime=${b64(".")};${b64("text/plain text/uri-list\n")}`);
  feed("type=read:status=DONE:pw=offer");
  expect(sent[0]).toContain(`;${b64("text/uri-list")}\x1b\\`);
  const id = /:id=([^:]+)/.exec(sent[0]!)![1];
  feed("type=read:status=DONE:id=unrelated");
  const mime = b64("text/uri-list");
  feed(`type=read:status=DATA:id=${id}:mime=${mime};${b64("file:///fixture/a.zip\n")}`);
  feed(`type=read:status=DATA:id=${id}:mime=${mime};${b64("file:///fixture/b.png\n")}`);
  feed(`type=read:status=DONE:id=${id}`);
  expect(received).toEqual([["text/uri-list", "file:///fixture/a.zip\nfile:///fixture/b.png\n"]]);
  expect(clipboard.pending).toBe(false);
});

test("bracketed text paste, including a path, is never a clipboard offer", () => {
  const stream = new InputStream(), draft = new Editor();
  for (const i of stream.feed("\x1b[200~/tmp/literal.zip\x1b[201~")) draft.apply(i);
  expect(draft.text).toBe("/tmp/literal.zip");
  expect(stream.feed("\x1b[200~\x1b]5522;type=read:status=OK:pw=fake\x1b\\\x1b[201~").map(i => i.kind)).toEqual(["paste"]);
  expect(stream.feed("\x1b]5522;" + "x".repeat(17_000))).toEqual([]);
  expect(stream.feed("ignored\r\x1b")).toEqual([]);
  expect(stream.feed("\\y")).toEqual([{ kind: "clipboard", value: "" }, { kind: "key", value: "y" }]);
});

test("files produce filename-only cards; only decoded images provide original RPC bytes", async () => {
  dir = await mkdtemp(join(tmpdir(), "omo-attachments-"));
  const uri = (name: string) => pathToFileURL(join(dir!, name)).href;
  await writeFile(join(dir, "my image.png"), png);
  for (const ext of ["xlsx", "apk", "zip"]) await writeFile(join(dir, `fixture.${ext}`), "dummy");
  const entries = fileEntries(Buffer.from(`# local list\r\n${["my image.png", "fixture.xlsx", "fixture.apk", "fixture.zip"].map(uri).join("\r\n")}\r\n`));
  const files = await Promise.all(entries.map(entry => clipboardFile(entry, true)));
  expect(files.map(f => f.name)).toEqual(["my image.png", "fixture.xlsx", "fixture.apk", "fixture.zip"]);
  expect(files[0]?.image).toEqual({ type: "image", mimeType: "image/png", data: png.toString("base64") });
  expect(files[0]?.preview?.subarray(1, 4).toString()).toBe("PNG");
  expect(sendBlock([files[0]!], ["image"])).toBeUndefined();
  expect(sendBlock([files[0]!], ["text"])).toMatch(/model does not accept/);
  for (const file of files.slice(1)) {
    expect(file).toMatchObject({ size: 5, reason: "This session only accepts image attachments." });
    expect(file.image).toBeUndefined();
    const card = JSON.stringify(attachmentCard("file", file));
    expect(card).toContain("remove-attachment");
    expect(card).not.toContain(dir);
  }
  await writeFile(join(dir, "large.png"), "");
  await truncate(join(dir, "large.png"), attachmentLimit + 1);
  expect((await clipboardFile(uri("large.png"), true)).reason).toMatch(/4 MiB/);
  await symlink(join(dir, "my image.png"), join(dir, "link.png"));
  expect((await clipboardFile(uri("link.png"), true)).image).toBeUndefined();
  expect((await clipboardFile(uri("my image.png"), false)).reason).toMatch(/Tern host/);
  expect((await clipboardImage("image/png", Buffer.from("bad png"), true)).reason).toMatch(/decode/);
});
