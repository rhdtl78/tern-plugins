import { expect, test } from "bun:test";
import { link, mkdir, mkdtemp, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listSavedSessions } from "./history";

const envKeys = ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR",
  "OMO_AGENT_DIR", "HOME", "USERPROFILE"] as const;

async function fixture(run: (root: string) => Promise<void>) {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, "omo-native-history-"));
  const previous = envKeys.map(key => [key, process.env[key]] as const);
  try {
    for (const key of envKeys) delete process.env[key];
    process.env.HOME = root;
    await run(root);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

function bucket(agent: string, cwd: string) {
  return join(agent, "sessions", `--${cwd.slice(1).replaceAll("/", "-")}--`);
}

const name = (value: string) => ({ type: "session_info", name: value });
const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const row = async (path: string, title: string, time: number) => {
  const { dev, ino } = await stat(path, { bigint: true });
  return { path, title, modifiedAt: time * 1000, sessionId: `fixture:${path}`, fileId: `${dev}:${ino}` };
};

async function save(path: string, cwd: string, time: number, ...entries: readonly unknown[]) {
  const header = { type: "session", id: `fixture:${path}`, cwd, version: 3, timestamp: "2026-01-01T00:00:00.000Z" };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, [header, ...entries].map(e => JSON.stringify(e)).join("\n") + "\n");
  await utimes(path, time, time);
}

test("isolates by canonical cwd and sorts named and untitled sessions by mtime", () => fixture(async root => {
  const cwd = join(root, "work/project"), alias = join(root, "project-link"), collision = join(root, "work-project");
  const agent = join(root, ".omo", "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(collision);
  await symlink(cwd, alias);
  const older = join(bucket(agent, cwd), "a.jsonl"), tied = join(bucket(agent, cwd), "b.jsonl");
  const newer = join(bucket(agent, alias), "z.jsonl");
  await save(older, cwd, 100, user("  First\n prompt  "), name("obsolete"), name(""));
  await save(tied, cwd, 100, name("Second"));
  await save(newer, alias, 200, name("Old name"), user("x".repeat(150_000)), name("  Latest name  "));
  await save(join(bucket(agent, collision), "foreign.jsonl"), collision, 300, name("Not our project"));

  expect(await listSavedSessions(cwd)).toEqual([
    await row(newer, "Latest name", 200), await row(older, "First prompt", 100), await row(tied, "Second", 100),
  ]);
}));

test("skips malformed headers, child sessions, and links without losing a good row", () => fixture(async root => {
  const cwd = join(root, "repo"), agent = join(root, ".omo", "agent");
  const dir = bucket(agent, cwd), outside = join(root, "outside");
  const good = join(dir, "good.jsonl");
  await mkdir(cwd);
  await save(good, cwd, 100, name("Good"));
  await save(join(outside, "outside.jsonl"), cwd, 200, name("Escaped"));
  await symlink(join(outside, "outside.jsonl"), join(dir, "escape.jsonl"));
  await symlink(join(outside, "missing.jsonl"), join(dir, "gone.jsonl"));
  await symlink(outside, join(agent, "sessions", "--escape--"));
  await link(good, join(dir, "hardlink.jsonl"));
  await writeFile(join(dir, "bad.jsonl"), "not a session\n" + JSON.stringify({ type: "session", id: "fake", cwd }));
  await writeFile(join(dir, "large.jsonl"), JSON.stringify({ type: "session", id: "large", cwd, meta: "x".repeat(150_000) }) + "\n");
  await writeFile(join(dir, "child.jsonl"), [
    { type: "session", id: "child", cwd, spawnedBy: { taskId: "task" } }, name("Child"),
  ].map(e => JSON.stringify(e)).join("\n") + "\n");
  await writeFile(join(dir, "header-only.jsonl"), JSON.stringify({ type: "session", id: "unfinished", cwd }) + "\n");

  expect(await listSavedSessions(cwd)).toEqual([await row(good, "Good", 100)]);
}));

test("uses launcher override precedence and never merges stores", () => fixture(async root => {
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const [omo, senpi, pi, fallback] = ["omo", "senpi", "pi", ".omo/agent"].map(dir => join(root, dir));
  if (!omo || !senpi || !pi || !fallback) throw new Error("Missing fixture directory");
  for (const agent of [omo, senpi, pi, fallback]) await save(join(bucket(agent, cwd), "saved.jsonl"), cwd, 100, name(agent));
  process.env.OMO_AGENT_DIR = join(root, "not-an-override");

  for (const [current, legacy, piLegacy, winner] of [
    [` ${omo} `, senpi, pi, omo], [" \t", senpi, pi, senpi], ["", "", pi, pi], ["", "", "", fallback],
  ] as const) {
    process.env.OMO_CODING_AGENT_DIR = current;
    process.env.SENPI_CODING_AGENT_DIR = legacy;
    process.env.PI_CODING_AGENT_DIR = piLegacy;
    expect(await listSavedSessions(cwd)).toEqual([await row(join(bucket(winner, cwd), "saved.jsonl"), winner, 100)]);
  }
}));

test("returns no rows when the sessions directory itself is a symlink", () => fixture(async root => {
  const cwd = join(root, "repo"), agent = join(root, ".omo", "agent"), external = join(root, "external");
  await mkdir(cwd);
  await mkdir(agent, { recursive: true });
  await save(join(bucket(external, cwd), "saved.jsonl"), cwd, 100, name("Outside store"));
  await symlink(join(external, "sessions"), join(agent, "sessions"));

  expect(await listSavedSessions(cwd)).toEqual([]);
}));
