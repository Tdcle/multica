// Exercise the real controller and native services without model inference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const controller = join(root, "scripts/agent-memory.mjs");
const source = process.env.MULTICA_AGENT_MEMORY_SOURCE_DIR || join(root, ".agent-memory/upstream");
const names = ["runtime", "core", "knowledge", "panel", "proxy"];
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MULTICA_AGENT_MEMORY_") && !key.startsWith("MULTICA_MEMORY_")));
const run = (args, extra = {}) => execute(process.execPath, [controller, ...args], { cwd: root, env: { ...env, ...extra }, timeout: 60000 });
const hash = async path => createHash("sha256").update(await readFile(path)).digest("hex");

async function availableBase() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const base = 36000 + Math.floor(Math.random() * 15000);
    const reservations = [];
    try {
      for (const offset of [0, 10, 11, 15, 16]) {
        const listener = net.createServer();
        await new Promise((ready, reject) => { listener.once("error", reject); listener.listen(base + offset, "127.0.0.1", ready); });
        reservations.push(listener);
      }
      return base;
    } catch { /* Try another complete port range. */ }
    finally { await Promise.all(reservations.map(listener => new Promise(done => listener.close(done)))); }
  }
  throw new Error("No free local Memory test port range");
}

test("configured Memory starts on app launch, reuses processes and retains knowledge after a cold restart", { timeout: 90000 }, async t => {
  try {
    for (const path of ["MemoryCore/node_modules/tsx/package.json", "MemoryKnowledge/bin/server.mjs", "MemoryPanel/dist/index.js"]) await access(join(source, path));
  } catch { t.skip("Prepare and build the native Memory services first"); return; }
  const temporary = await mkdtemp(join(tmpdir(), "multica-memory-startup-"));
  const directory = join(temporary, "state with spaces and 'quote'");
  await mkdir(directory);
  let unmanaged;
  let stopSucceeded = false;
  try {
    // No local state configured: remote deployments retain their lifecycle.
    assert.equal((await run(["ensure"])).stdout, "");
    const base = await availableBase();
    await run(["init", "all", directory], {
      MULTICA_AGENT_MEMORY_SOURCE_DIR: source,
      MULTICA_MEMORY_PORT_BASE: String(base),
      MULTICA_MEMORY_RUNTIME_COMMAND: "/nonexistent/multica-memory-test-runtime",
    });
    const config = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
    const hashes = await Promise.all(["config.json", "multica.env"].map(name => hash(join(directory, name))));
    const managedEnv = {
      MULTICA_AGENT_MEMORY_STATE_DIR: directory,
      MULTICA_AGENT_MEMORY_CORE_URL: config.urls.core,
      MULTICA_AGENT_MEMORY_PANEL_URL: config.urls.panel,
      MULTICA_AGENT_MEMORY_PROXY_URL: config.urls.proxy,
      MULTICA_AGENT_MEMORY_KNOWLEDGE_URL: config.urls.knowledge,
      MULTICA_AGENT_MEMORY_API_KEY: config.core.key,
      MULTICA_AGENT_MEMORY_ADMIN_KEY: config.core.admin,
      MULTICA_AGENT_MEMORY_KNOWLEDGE_KEY: config.knowledge.key,
      MULTICA_AGENT_MEMORY_SECRET_KEY: config.encryptionKey,
      MULTICA_AGENT_MEMORY_INSTANCE_ID: config.instance,
    };
    await assert.rejects(run(["ensure"], { ...managedEnv, MULTICA_AGENT_MEMORY_CORE_URL: "http://127.0.0.1:1" }), /MULTICA_AGENT_MEMORY_CORE_URL does not match/);
    // A foreign listener must remain untouched even if it uses a configured port.
    unmanaged = net.createServer(socket => socket.end());
    await new Promise(done => unmanaged.listen(base, "127.0.0.1", done));
    await assert.rejects(run(["ensure"], managedEnv), /unmanaged process/);
    assert.equal(unmanaged.listening, true);
    await new Promise(done => unmanaged.close(done));
    unmanaged = null;
    // Read the generated environment through Bash exactly as the app launcher does.
    const start = () => execute("bash", ["-c", 'set -a; . "$1"; set +a; exec "$2" "$3" ensure', "_", join(directory, "multica.env"), process.execPath, controller], { cwd: root, env, timeout: 60000 });
    const started = await Promise.all([start(), start()]);
    assert.ok(started.some(result => result.stdout.includes("panel ready")));
    const records = async () => Promise.all(names.map(async name => JSON.parse(await readFile(join(directory, name + ".pid.json"), "utf8"))));
    const first = await records();
    await start();
    const second = await records();
    assert.deepEqual(second, first);
    for (const name of names) {
      const health = await fetch(config.urls[name] + "/health");
      assert.equal((await health.json()).status, "ok");
    }
    const core = async (action, body) => {
      const response = await fetch(config.urls.core + "/v3/meta/" + action, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.core.key,
          "X-Tdai-Service-Id": config.instance, "X-Tdai-User-Key": config.core.admin }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      const envelope = await response.json();
      assert.equal(envelope.code, 0, envelope.message);
      return envelope.data;
    };
    const admin = await core("auth/verify", { user_key: config.core.admin });
    const team = await core("team/create", { name: "Startup persistence", owner_user_id: admin.user.user_id });
    const space = await core("agent/create", { team_id: team.team_id, owner_user_id: admin.user.user_id, name: "Persistent knowledge space" });
    await run(["stop", "all", directory]);
    // Reboot leaves stale PID files. Old process identity must not count as live.
    for (let index = 0; index < names.length; index++) await writeFile(join(directory, names[index] + ".pid.json"), JSON.stringify(first[index]), { mode: 0o600 });
    await start();
    assert.notDeepEqual((await records()).map(record => record.child), first.map(record => record.child));
    assert.equal((await core("agent/get", { agent_id: space.agent_id })).name, "Persistent knowledge space");
    assert.deepEqual(await Promise.all(["config.json", "multica.env"].map(name => hash(join(directory, name)))), hashes);
  } finally {
    if (unmanaged?.listening) await new Promise(done => unmanaged.close(done));
    try { await run(["stop", "all", directory]); stopSucceeded = true; }
    finally {
      if (stopSucceeded) await rm(temporary, { recursive: true, force: true });
      else t.diagnostic("Cleanup did not finish. Retained private state at " + directory);
    }
  }
});
