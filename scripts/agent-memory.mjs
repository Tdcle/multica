import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rename, open, rm, access } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const execute = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const project = resolve(dirname(script), "..");
const [command = "status", component = "all", workerDirectory] = process.argv.slice(2);
const directory = resolve(workerDirectory || process.env.MULTICA_AGENT_MEMORY_STATE_DIR || join(project, ".agent-memory/local"));
const names = ["runtime", "core", "knowledge", "panel", "proxy"];
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
const json = path => readFile(path, "utf8").then(JSON.parse);
const secret = () => randomBytes(32).toString("hex");

async function save(path, value) {
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

// Serialize controller operations; service wrappers do not acquire this lock.
async function control(operation) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "controller.lock");
  let lock;
  try { lock = await open(path, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`Another controller owns ${path}; if interrupted, verify its recorded PID has exited before removing this lock`);
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, fingerprint: await fingerprint(process.pid) }));
    await operation();
  } finally { await lock.close(); await rm(path, { force: true }); }
}

async function fingerprint(pid) {
  try {
    const { stdout } = await execute("ps", ["-p", String(pid), "-o", "lstart=", "-o", "args="]);
    return stdout.trim();
  } catch { return ""; }
}

async function listening(port) {
  return new Promise(resolveResult => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); resolveResult(true); });
    socket.once("error", () => resolveResult(false));
    socket.once("timeout", () => { socket.destroy(); resolveResult(false); });
  });
}

async function waitFor(predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  do { if (await predicate()) return; await pause(200); } while (Date.now() < deadline);
  throw new Error("Service operation timed out; inspect the private component log");
}

function launch(config, name) {
  const base = config.urls.runtime + "/v1";
  const common = { ...process.env, LOG_LEVEL: "warn", LOG_PATH: join(directory, "logs") };
  // A host's metadata backend must not silently replace this local data directory.
  for (const key of Object.keys(common)) if (key.startsWith("TDAI_METADATA_")) delete common[key];
  switch (name) {
    case "runtime": return { cwd: project, args: [join(project, "scripts/agent-memory-runtime.mjs")], env: { ...common, MULTICA_MEMORY_RUNTIME_PORT: String(config.ports.runtime), MULTICA_MEMORY_RUNTIME_TOKEN: config.runtime.token, MULTICA_MEMORY_RUNTIME_COMMAND: config.runtime.command || "codex", ...(config.runtime.model ? { MULTICA_MEMORY_RUNTIME_MODEL: config.runtime.model } : {}) } };
    case "core": return { cwd: join(config.source, "MemoryCore"), args: ["--import", "tsx", "src/gateway/server.ts"], env: { ...common, TDAI_GATEWAY_CONFIG: join(directory, "core.yaml"), TDAI_DATA_DIR: config.core.data, TDAI_STATE_BACKEND: "local", WORKER_CONCURRENCY: "1", TDAI_SKILL_WORKER_CONCURRENCY: "1" } };
    case "knowledge": return { cwd: join(config.source, "MemoryKnowledge"), args: ["bin/server.mjs"], env: { ...common, HOST: "127.0.0.1", PORT: String(config.ports.knowledge), KNOWLEDGE_SERVICE_KEY: config.knowledge.key, KNOWLEDGE_DATA_DIR: config.knowledge.data, KNOWLEDGE_DB_PATH: join(config.knowledge.data, "knowledge.db"), KNOWLEDGE_PUBLIC_BASE_URL: config.urls.knowledge + "/v3", TMC_CALLBACK_URL: config.urls.panel, LLM_MODE: "custom", LLM_BASE_URL: base, LLM_MODEL: "codex", LLM_API_KEY: config.runtime.token, LLM_STREAM: "false", KNOWLEDGE_LLM_GLOBAL_CONCURRENCY: "1", KNOWLEDGE_INGEST_CONCURRENCY: "1" } };
    case "panel": return { cwd: join(config.source, "MemoryPanel"), args: ["dist/index.js"], env: { ...common, HOST: "127.0.0.1", PORT: String(config.ports.panel), METADATA_INSTANCES_CONFIG: join(directory, "instances.json"), KNOWLEDGE_SERVICE_URL: config.urls.knowledge, KNOWLEDGE_AUTH_TOKEN: config.knowledge.key, KNOWLEDGE_LLM_BINDING_SYNC: "false", TDAI_AGENT_TEMPLATE_DIR: join(directory, "agent-templates") } };
    case "proxy": return { cwd: join(config.source, "MemoryProxy"), args: ["--import", "tsx/esm", "src/index.ts", "--config", join(directory, "proxy.yaml")], env: common };
    default: throw new Error("Unknown component");
  }
}

async function initialize() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { await access(join(directory, "config.json")); throw new Error("Configuration already exists; preserve it or choose another state directory"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const source = resolve(process.env.MULTICA_AGENT_MEMORY_SOURCE_DIR || join(project, ".agent-memory/upstream"));
  const first = Number(process.env.MULTICA_MEMORY_PORT_BASE || 8430);
  const ports = { runtime: first, core: first + 10, knowledge: first + 11, panel: first + 15, proxy: first + 16 };
  if (Object.values(ports).some(port => !Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error("Invalid service port base");
  const urls = Object.fromEntries(Object.entries(ports).map(([name, port]) => [name, `http://127.0.0.1:${port}`]));
  const config = {
    source, ports, urls, instance: process.env.MULTICA_AGENT_MEMORY_INSTANCE_ID || "default",
    core: { key: process.env.MULTICA_AGENT_MEMORY_API_KEY || secret(), admin: process.env.MULTICA_AGENT_MEMORY_ADMIN_KEY || "sk-mem-" + secret(), data: resolve(process.env.MULTICA_AGENT_MEMORY_CORE_STORAGE_DIR || join(directory, "core-data")) },
    knowledge: { key: process.env.MULTICA_AGENT_MEMORY_KNOWLEDGE_KEY || secret(), data: resolve(process.env.MULTICA_AGENT_MEMORY_KNOWLEDGE_DATA_DIR || join(directory, "knowledge-data")) },
    runtime: { token: process.env.MULTICA_MEMORY_RUNTIME_TOKEN || secret(), command: process.env.MULTICA_MEMORY_RUNTIME_COMMAND || "codex", model: process.env.MULTICA_MEMORY_RUNTIME_MODEL || "" },
    encryptionKey: process.env.MULTICA_AGENT_MEMORY_SECRET_KEY || randomBytes(32).toString("base64"),
  };
  await save(join(directory, "config.json"), config);
  await mkdir(join(directory, "agent-templates"), { mode: 0o700 });
  await mkdir(join(directory, "logs"), { mode: 0o700 });
  // JSON is valid YAML and avoids adding a second parser to the launcher.
  await save(join(directory, "core.yaml"), {
    deployMode: "standalone", stateBackend: "local", server: { host: "127.0.0.1", port: ports.core, apiKey: config.core.key }, data: { baseDir: config.core.data },
    llm: { baseUrl: urls.runtime + "/v1", apiKey: config.runtime.token, model: "codex", timeoutMs: 600_000, maxTokens: 16_384 },
    memory: { capture: { enabled: true }, extraction: { enabled: true, enableDedup: true, maxMemoriesPerSession: 20, promptMode: "code" }, persona: { triggerEveryN: 1, maxScenes: 15, promptMode: "code" }, pipeline: { everyNConversations: 1, enableWarmup: true, l1IdleTimeoutSeconds: 1, l2DelayAfterL1Seconds: 1, l2MinIntervalSeconds: 1, l2MaxIntervalSeconds: 60 }, recall: { enabled: true, maxResults: 5, strategy: "hybrid", timeoutMs: 5000 }, storeBackend: "sqlite", embedding: { provider: "none" }, bm25: { enabled: true, language: "zh" } },
    skill: { enabled: true, extraction: { enabled: true, maxIterations: 8 } },
  });
  await save(join(directory, "instances.json"), { instances: [{ id: config.instance, name: "Multica knowledge", gateway_endpoint: urls.core, proxy_endpoint: urls.proxy, api_key: config.core.key }] });
  await save(join(directory, "proxy.yaml"), {
    server: { host: "127.0.0.1", port: ports.proxy }, upstream: { url: urls.runtime + "/v1", apiKey: config.runtime.token }, log: { level: "warn", file: "" },
    auth: { enabled: true, url: urls.core, serviceToken: config.core.key, timeoutMs: 5000 },
    skill: { endpoint: urls.core, serviceToken: config.core.key, serviceId: config.instance, timeoutMs: 5000 }, knowledge: { enabled: true, endpoint: urls.core, serviceToken: config.core.key, serviceId: config.instance, timeoutMs: 5000 },
    tdai: { enabled: true, endpoint: urls.core, apiKey: config.core.key, serviceId: config.instance, memory: { enabled: true, inject: true, writeL0: false, recallL1: true, injectL2L3: true, timeoutMs: 5000 } },
    skillRuntime: { allowLlmWrite: false }, injection: { enabled: true, injectors: ["skill", "knowledge", "tdai-memory"], externalGatewayUrl: urls.proxy },
  });
  const env = {
    MULTICA_AGENT_MEMORY_CORE_URL: urls.core, MULTICA_AGENT_MEMORY_PANEL_URL: urls.panel, MULTICA_AGENT_MEMORY_PROXY_URL: urls.proxy, MULTICA_AGENT_MEMORY_KNOWLEDGE_URL: urls.knowledge,
    MULTICA_AGENT_MEMORY_KNOWLEDGE_KEY: config.knowledge.key, MULTICA_AGENT_MEMORY_API_KEY: config.core.key, MULTICA_AGENT_MEMORY_ADMIN_KEY: config.core.admin, MULTICA_AGENT_MEMORY_SECRET_KEY: config.encryptionKey, MULTICA_AGENT_MEMORY_INSTANCE_ID: config.instance,
  };
  await writeFile(join(directory, "multica.env"), Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n") + "\n", { mode: 0o600 });
  process.stdout.write(`Private service configuration created in ${directory}\nBackend environment: ${join(directory, "multica.env")}\n`);
}

async function readRecord(name) {
  try { return await json(join(directory, name + ".pid.json")); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function owned(record, key) {
  return record && record[key] && record[key + "Fingerprint"] && (await fingerprint(record[key])) === record[key + "Fingerprint"];
}

async function serve(config, name) {
  const spec = launch(config, name);
  const log = await open(join(directory, name + ".log"), "a", 0o600);
  const child = spawn(process.execPath, spec.args, { cwd: spec.cwd, env: spec.env, detached: true, stdio: ["ignore", log.fd, log.fd] });
  const exited = new Promise(resolveExit => child.once("exit", codeValue => resolveExit(codeValue)));
  await new Promise((resolveSpawn, reject) => { child.once("spawn", resolveSpawn); child.once("error", reject); });
  await save(join(directory, name + ".pid.json"), { wrapper: process.pid, wrapperFingerprint: await fingerprint(process.pid), child: child.pid, childFingerprint: await fingerprint(child.pid), port: config.ports[name] });
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 20_000);
    timer.unref();
  };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  const code = await exited;
  await log.close();
  process.exitCode = stopping ? 0 : code || 1;
}

async function start(config, name) {
  const record = await readRecord(name);
  if (await owned(record, "wrapper")) {
    if (!(await owned(record, "child")) || !(await healthy(config, name))) throw new Error(`${name} has an unhealthy owned process; inspect its log or restart it`);
    process.stdout.write(`${name} already running\n`); return;
  }
  if (await listening(config.ports[name])) throw new Error(`${name} port is occupied by an unmanaged process; it was left untouched`);
  const wrapper = spawn(process.execPath, [script, "_serve", name, directory], { cwd: project, detached: true, stdio: "ignore" });
  wrapper.unref();
  await waitFor(async () => {
    const active = await readRecord(name);
    return (await owned(active, "wrapper")) && (await owned(active, "child")) && (await healthy(config, name));
  });
  process.stdout.write(`${name} ready at ${config.urls[name]}\n`);
}

async function healthy(config, name) {
  try {
    const response = await fetch(config.urls[name] + "/health", { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.json()).status === "ok";
  } catch { return false; }
}

async function stop(config, name) {
  const record = await readRecord(name);
  if (await owned(record, "wrapper")) process.kill(record.wrapper, "SIGTERM");
  else if (await owned(record, "child")) process.kill(-record.child, "SIGTERM");
  else { process.stdout.write(`${name} has no owned live process\n`); return; }
  await waitFor(async () => !(await owned(record, "child")) && !(await listening(config.ports[name])));
  await rm(join(directory, name + ".pid.json"), { force: true });
  process.stdout.write(`${name} stopped; data retained\n`);
}

async function bootstrap(config) {
  const call = async (path, body) => {
    const response = await fetch(config.urls.core + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.core.key}`, "x-tdai-service-id": config.instance }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    return { response, body: await response.json() };
  };
  const existing = await call("/v3/meta/auth/verify", { user_key: config.core.admin });
  if (existing.body.data?.valid === true) return;
  const seeded = await call("/v3/internal/meta/user/init-admin", { username: "multica_provisioner", user_key: config.core.admin });
  if (!seeded.response.ok || seeded.body.code !== 0) throw new Error("Core provisioning account could not be initialized; preserve an existing account's admin key");
}

if (command === "init") await control(initialize);
else {
  const config = await json(join(directory, "config.json"));
  if (command === "_serve") { if (!names.includes(component)) throw new Error("Unknown component"); await serve(config, component); }
  else {
    const selected = component === "all" ? names : [component];
    if (selected.some(name => !names.includes(name))) throw new Error("Unknown component");
    if (command === "status") {
      for (const name of selected) {
        const record = await readRecord(name);
        const state = (await owned(record, "wrapper")) && (await owned(record, "child")) ? (await healthy(config, name)) ? "running" : "unhealthy" : (await owned(record, "child")) ? "orphaned child" : "stopped";
        process.stdout.write(`${name}: ${state} (${config.urls[name]})\n`);
      }
    } else if (["start", "stop", "restart"].includes(command)) {
      await control(async () => {
      if (command !== "start") for (const name of [...selected].reverse()) await stop(config, name);
      if (command !== "stop") {
        for (const name of selected) { await start(config, name); if (name === "core") await bootstrap(config); }
      }
      });
    } else if (command === "test-recovery") {
      if (process.env.MULTICA_RUN_REAL_AGENT_SMOKE !== "1") throw new Error("Set MULTICA_RUN_REAL_AGENT_SMOKE=1 to authorize inference and a managed Core crash test");
      const child = spawn("bash", [join(project, "scripts/dev-env.sh"), "exec", "--", process.execPath, script, "_test-recovery", "all", directory], { cwd: project, stdio: "inherit" });
      process.exitCode = await new Promise((resolveExit, reject) => { child.once("error", reject); child.once("exit", code => resolveExit(code ?? 1)); });
    } else if (command === "_test-recovery") {
      if (process.env.MULTICA_RUN_REAL_AGENT_SMOKE !== "1") throw new Error("Real inference requires explicit opt-in");
      if (process.env.PORT && await listening(Number(process.env.PORT))) throw new Error("Stop this checkout's API before testing an alternate Core against its database; its worker competes for the same outbox");
      const env = { ...process.env, MULTICA_AGENT_MEMORY_CORE_STORAGE_DIR: config.core.data, MULTICA_AGENT_MEMORY_RESTART_TEST_STATE_DIR: directory };
      for (const line of (await readFile(join(directory, "multica.env"), "utf8")).trim().split("\n")) { const index = line.indexOf("="); env[line.slice(0, index)] = line.slice(index + 1); }
      const timeout = process.env.MULTICA_AGENT_MEMORY_LARGE_SOURCE_TEST === "1" ? "40m" : "15m";
      const child = spawn("go", ["-C", "server", "test", "-tags=agentintegration", "./internal/handler", "-run", "^TestKnowledgeLiveFailedSkillRetry$", "-count=1", "-timeout=" + timeout, "-v"], { cwd: project, env, stdio: "inherit" });
      process.exitCode = await new Promise((resolveExit, reject) => { child.once("error", reject); child.once("exit", code => resolveExit(code ?? 1)); });
    } else if (command === "build") {
      await control(async () => {
      await execute(process.execPath, [join(project, "scripts/prepare-agent-memory.mjs")], { cwd: project, env: { ...process.env, MULTICA_AGENT_MEMORY_SOURCE_DIR: config.source } });
      for (const module of ["MemoryKnowledge", "MemoryPanel", "MemoryPanel/web"]) await execute("npm", ["run", "build"], { cwd: join(config.source, module), maxBuffer: 4 * 1024 * 1024 });
      process.stdout.write("Native Knowledge and Panel builds complete\n");
      });
    } else throw new Error("Use init, build, start, stop, restart, status, or test-recovery; optionally specify a component");
  }
}
