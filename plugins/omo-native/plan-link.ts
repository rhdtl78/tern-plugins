import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { record, string } from "./surface";

const contained = (root: string, path: string) => {
  const rel = relative(root, path);
  return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const unsafe = /[\p{Cc}\p{Cf}]/u;
const registryLimit = 1024 * 1024;
const run = promisify(execFile);

async function registeredWorktree(root: string, target: string) {
  const marker = await lstat(join(root, ".git"));
  if (!marker.isDirectory() && !marker.isFile()) return false;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const { stdout } = await run("git", ["-C", root, "worktree", "list", "--porcelain", "-z"],
    { env, timeout: 2000, maxBuffer: registryLimit });
  const entries = stdout.split("\0\0").map(entry => entry.split("\0"));
  return entries.some(([path, ...fields]) => path === `worktree ${root}` && !fields.includes("bare")) &&
    entries.some(([path, ...fields]) => path === `worktree ${target}` && !fields.includes("bare") &&
      !fields.some(field => field === "prunable" || field.startsWith("prunable ")));
}

/** Only a genuinely absent component permits fallback, not a broken symlink. */
async function mappedPlan(root: string, rel: string): Promise<string | null | undefined> {
  let path = root;
  const parts = rel.split(sep);
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (!info) return undefined;
    if (index < parts.length - 1 ? !info.isDirectory() : !info.isFile()) return null;
  }
  return await realpath(path) === path ? path : null;
}

/** OmO v5.1.81 Boulder v2. The workspace mirror cannot identify a session's plan. */
export async function sessionPlanPath(cwd: string, owner: string): Promise<string | undefined> {
  if (!owner || unsafe.test(owner)) return;
  try {
    const root = await realpath(cwd);
    const registry = join(root, ".omo", "boulder.json");
    if (await realpath(registry) !== registry) return;
    const file = await open(registry, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let data: unknown;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > registryLimit) return;
      const bytes = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) return;
        offset += bytesRead;
      }
      if ((await file.stat()).size !== info.size) return;
      data = JSON.parse(bytes.toString("utf8"));
    } finally {
      await file.close();
    }
    const state = record(data);
    if (state.schema_version !== 2) return;
    const owned = Object.values(record(state.works)).map(record).filter(work =>
      Array.isArray(work.session_ids) && work.session_ids.includes(`senpi:${owner}`));
    if (owned.some(work => !Array.isArray(work.session_ids) || !work.session_ids.every(id => typeof id === "string"))) return;
    let selected = owned[0];
    if (owned.length > 1) {
      const ranked = owned.map(work => ({ work, at: Date.parse(string(work.updated_at ?? work.started_at)) }));
      if (ranked.some(entry => !Number.isFinite(entry.at))) return;
      ranked.sort((a, b) => b.at - a.at);
      if (ranked[0]?.at === ranked[1]?.at) return;
      selected = ranked[0]?.work;
    }
    if (!selected) return;
    const plan = string(selected.active_plan);
    if (!/\.md$/i.test(plan) || unsafe.test(plan)) return;
    const tracked = resolve(cwd, plan);
    if (!contained(resolve(cwd), tracked)) return;
    if (selected.worktree_path != null && typeof selected.worktree_path !== "string") return;
    const override = string(selected.worktree_path).trim();
    if (override) {
      if (unsafe.test(override)) return;
      const target = await realpath(resolve(cwd, override));
      if (target !== root) {
        const rel = relative(resolve(cwd), tracked);
        if (!rel.startsWith(`.omo${sep}plans${sep}`) || !await registeredWorktree(root, target)) return;
        const mapped = await mappedPlan(target, rel);
        if (mapped !== undefined) return mapped ?? undefined;
      }
    }
    const canonical = await realpath(tracked);
    if (contained(root, canonical) && /\.md$/i.test(canonical) && !unsafe.test(canonical) &&
        (await stat(canonical)).isFile()) return canonical;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
}
