import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The upstream engines keep their own tool loops. Codex only chooses the next
// response; it never executes a requested memory tool on the host itself.
const responseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    content: { type: "string" },
    tool_calls: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { name: { type: "string" }, arguments: { type: "string" } },
        required: ["name", "arguments"],
      },
    },
  },
  required: ["content", "tool_calls"],
};

const port = Number(process.env.MULTICA_MEMORY_RUNTIME_PORT || 8430);
const token = process.env.MULTICA_MEMORY_RUNTIME_TOKEN;
if (!token) throw new Error("MULTICA_MEMORY_RUNTIME_TOKEN is required");
const command = process.env.MULTICA_MEMORY_RUNTIME_COMMAND || "codex";
const model = process.env.MULTICA_MEMORY_RUNTIME_MODEL;
let busy = false;
const queue = [];
const controllers = new Set();
const maxPending = 8;
let stopping = false;

function authorized(req) {
  const actual = Buffer.from(req.headers.authorization || "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function send(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new Error("request exceeds 4 MiB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function complete(body, signal) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error("messages must be a non-empty array");
  }
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const directory = await mkdtemp(join(tmpdir(), "multica-memory-inference-"));
  const schemaPath = join(directory, "response-schema.json");
  const outputPath = join(directory, "response.json");
  try {
    await writeFile(schemaPath, JSON.stringify(responseSchema), { mode: 0o600 });
    const prompt = [
      "You are the model for one Chat Completions inference request.",
      "Follow the supplied system/developer messages, then continue the conversation.",
      "Do not use your native tools, inspect the host, or perform the requested operations yourself.",
      "Choose only from the function tools supplied below. The caller executes them and supplies their results on the next request.",
      "Return content as the literal assistant response, including JSON or Markdown when requested by the supplied messages.",
      "Return tool_calls with function names and JSON-encoded arguments, or an empty array when no tool call is needed.",
      "Honor tool_choice. Never invent a tool. The enclosing response schema is transport only; it does not replace a JSON format requested inside content.",
      JSON.stringify({ messages: body.messages, tools, tool_choice: body.tool_choice, response_format: body.response_format }),
    ].join("\n\n");
    const args = [
      "exec", "--ignore-user-config", "--skip-git-repo-check", "--ephemeral",
      "--sandbox", "read-only", "--cd", directory, "--json",
      "--output-schema", schemaPath, "--output-last-message", outputPath,
      "-c", 'web_search="disabled"',
      "-c", "features.skip_host_skill_discovery=true",
    ];
    for (const feature of ["shell_tool", "unified_exec", "apps", "plugins", "multi_agent", "browser_use", "computer_use", "image_generation", "view_image", "memories", "hooks"]) {
      args.push("--disable", feature);
    }
    if (model) args.push("--model", model);
    args.push("-");
    let usage;
    let pending = "";
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], signal });
    child.stdout.on("data", (chunk) => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === "turn.completed") usage = event.usage;
        } catch { /* Non-JSON diagnostic lines are not conversation output. */ }
      }
    });
    // Runtime diagnostics can contain request content. Never forward them to
    // clients or print them in this service's logs.
    child.stderr.resume();
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.stdin.once("error", reject);
      child.once("exit", (code, exitSignal) => code === 0 ? resolve() : reject(new Error(`runtime exited with ${code ?? exitSignal}`)));
      child.stdin.end(prompt);
    });
    const answer = JSON.parse(await readFile(outputPath, "utf8"));
    if (typeof answer.content !== "string" || !Array.isArray(answer.tool_calls)) throw new Error("invalid runtime response");
    const allowed = new Set(tools.map((tool) => tool.function?.name));
    const calls = answer.tool_calls.map((call) => {
      if (!allowed.has(call.name) || body.tool_choice === "none") throw new Error("runtime requested an unavailable tool");
      JSON.parse(call.arguments);
      return { id: `call_${randomUUID().replaceAll("-", "")}`, type: "function", function: call };
    });
    return {
      id: `chatcmpl-${randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000),
      model: model || body.model || "codex",
      choices: [{ index: 0, message: { role: "assistant", content: answer.content, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? "tool_calls" : "stop" }],
      ...(usage ? { usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.input_tokens + usage.output_tokens } } : {}),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function drain() {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  busy = true;
  try {
    if (!job.controller.signal.aborted) {
      send(job.res, 200, await complete(job.body, job.controller.signal));
    }
  } catch {
    send(job.res, 502, { error: { message: "Codex inference failed" } });
  } finally {
    job.cleanup();
    busy = false;
    void drain();
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { status: stopping ? "stopping" : "ok", provider: "codex", busy, queued: queue.length });
  if (!authorized(req)) return send(res, 401, { error: { message: "unauthorized" } });
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") return send(res, 404, { error: { message: "not found" } });
  if (stopping) return send(res, 503, { error: { message: "runtime is stopping" } });
  if (controllers.size >= maxPending) return send(res, 429, { error: { message: "runtime queue is full; retry later" } });
  const controller = new AbortController();
  controllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
  const cleanup = () => { clearTimeout(timeout); controllers.delete(controller); };
  controller.signal.addEventListener("abort", () => {
    const index = queue.findIndex(job => job.controller === controller);
    if (index >= 0) { queue.splice(index, 1); cleanup(); }
    send(res, 504, { error: { message: "inference request expired" } });
  }, { once: true });
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  try {
    const body = await readBody(req);
    if (!Array.isArray(body.messages) || !body.messages.length || body.stream === true) {
      cleanup();
      return send(res, 400, { error: { message: body.stream ? "configure the upstream engine for non-streaming inference" : "invalid inference request" } });
    }
    if (controller.signal.aborted) { cleanup(); return; }
    queue.push({ body, res, controller, cleanup });
    void drain();
  } catch (error) {
    cleanup();
    const status = error instanceof SyntaxError || /messages|exceeds/.test(error.message) ? 400 : 502;
    send(res, status, { error: { message: status === 400 ? "invalid inference request" : "Codex inference failed" } });
  }
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`Memory runtime listening on 127.0.0.1:${port}\n`));
for (const event of ["SIGTERM", "SIGINT"]) process.on(event, () => {
  stopping = true;
  server.close();
  for (const controller of controllers) controller.abort();
  server.closeIdleConnections();
});
