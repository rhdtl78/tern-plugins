import { afterEach, beforeEach, expect, test } from "bun:test";
import { mock } from "node:test";
import { Clipboard } from "./clipboard";

const b64 = (text: string) => Buffer.from(text).toString("base64");
const offer = (status: string, token: string) => `type=read:status=${status}:pw=${token}`;

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => mock.timers.reset());

test("an interrupted offer expires at its deadline and ignores late packets", () => {
  const sent: string[] = [], errors: string[] = [];
  const clipboard = new Clipboard(packet => sent.push(packet), () => {}, reason => errors.push(reason));
  clipboard.receive(offer("OK", "interrupted"));
  clipboard.receive(`${offer("DATA", "interrupted")}:mime=${b64(".")};${b64("text/plain")}`);

  mock.timers.tick(2999);
  expect(clipboard.pending).toBe(true);
  mock.timers.tick(1);
  expect(clipboard.pending).toBe(false);
  clipboard.receive(offer("DONE", "interrupted"));

  expect(sent).toEqual([]);
  expect(errors).toEqual(["Tern did not complete the paste."]);
});

test("cancelled and replaced offers cannot time out a newer offer", () => {
  const errors: string[] = [];
  const clipboard = new Clipboard(() => {}, () => {}, reason => errors.push(reason));
  clipboard.receive(offer("OK", "cancelled"));
  mock.timers.tick(500);
  clipboard.cancel();
  expect(clipboard.pending).toBe(false);
  clipboard.receive(offer("OK", "replaced"));
  mock.timers.tick(500);
  clipboard.receive(offer("OK", "current"));
  mock.timers.tick(2500);

  expect(clipboard.pending).toBe(true);
  expect(errors).toEqual([]);
  mock.timers.tick(500);
  expect(clipboard.pending).toBe(false);
  expect(errors).toHaveLength(1);
});

test("a completed offer gives the selected format its own read deadline", () => {
  const sent: string[] = [], errors: string[] = [];
  const clipboard = new Clipboard(packet => sent.push(packet), () => {}, reason => errors.push(reason));
  clipboard.receive(offer("OK", "complete"));
  mock.timers.tick(2500);
  clipboard.receive(`${offer("DATA", "complete")}:mime=${b64(".")};${b64("text/plain")}`);
  clipboard.receive(offer("DONE", "complete"));
  expect(sent).toHaveLength(1);
  mock.timers.tick(2999);
  expect(clipboard.pending).toBe(true);
  expect(errors).toEqual([]);
  mock.timers.tick(1);
  expect(clipboard.pending).toBe(false);
  expect(errors).toHaveLength(1);
});
