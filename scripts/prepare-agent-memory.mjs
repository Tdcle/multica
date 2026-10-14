import { spawn } from "node:child_process";
import { access, mkdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(root, "services/agent-memory/upstream.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const source = process.env.MULTICA_AGENT_MEMORY_SOURCE_DIR || resolve(root, ".agent-memory/upstream");

async function run(command, args, cwd = root, capture = false, env = process.env) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let output = "";
    if (capture) child.stdout.on("data", (chunk) => { output += chunk; });
    if (capture) child.stderr.resume();
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveResult(output.trim()) : reject(new Error(`${command} ${args[0]} failed (${code})`)));
  });
}

try {
  await access(resolve(source, ".git"));
} catch {
  await mkdir(dirname(source), { recursive: true });
  await run("git", ["init", source]);
  await run("git", ["remote", "add", "origin", manifest.repository], source);
  await run("git", ["fetch", "--depth", "1", "origin", manifest.revision], source);
  await run("git", ["checkout", "--detach", manifest.revision], source);
}

const revision = await run("git", ["rev-parse", "HEAD"], source, true);
if (revision !== manifest.revision) throw new Error("Agent Memory checkout does not match the pinned revision");
const patches = await Promise.all(manifest.patches.map(async relative => {
  const path = resolve(dirname(manifestPath), relative);
  return { path, contents: await readFile(path, "utf8") };
}));
const affected = [...new Set(patches.flatMap(patch => [...patch.contents.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map(match => match[1])))];
const scratch = await mkdtemp(join(tmpdir(), "multica-memory-patches-"));
try {
  let applied = -1;
  // Later patches can change earlier hunk context. Validate the ordered series
  // in an isolated index; never reverse patches or reset the real checkout.
  for (let prefix = patches.length; prefix >= 0; prefix--) {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, `index-${prefix}`) };
    try {
      await run("git", ["read-tree", "HEAD"], source, true, env);
      const present = [];
      for (const path of affected) {
        try { await access(resolve(source, path)); present.push(path); } catch {}
      }
      await run("git", ["add", "--", ...present], source, true, env);
      for (const patch of patches.slice(0, prefix).reverse()) await run("git", ["apply", "--cached", "--reverse", patch.path], source, true, env);
      for (const patch of patches.slice(prefix)) await run("git", ["apply", "--cached", patch.path], source, true, env);
      applied = prefix;
      break;
    } catch {}
  }
  if (applied < 0) throw new Error("Agent Memory source does not match the ordered integration patches; existing edits were preserved");
  for (const patch of patches.slice(applied)) await run("git", ["apply", patch.path], source);
} finally { await rm(scratch, { recursive: true, force: true }); }

if (process.argv.includes("--install")) {
  for (const module of ["MemoryCore", "MemoryKnowledge", "MemoryPanel", "MemoryPanel/web", "MemoryProxy"]) {
    const args = ["install", "--no-audit", "--no-fund", "--legacy-peer-deps"];
    // The standalone engine does not use the OpenClaw peer or its host patch.
    if (module === "MemoryCore") args.push("--omit=dev", "--ignore-scripts");
    await run("npm", args, resolve(source, module));
  }
}

process.stdout.write(`Agent Memory ${revision} prepared at ${source}\n`);
