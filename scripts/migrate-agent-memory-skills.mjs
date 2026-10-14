import pg from "pg";
import { createDecipheriv, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

// Run through scripts/dev-env.sh exec so the database and encryption key match.
const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const workspaceSlug = option("--workspace");
const backup = option("--backup");
const apply = args.includes("--apply");
if (!workspaceSlug || !backup) {
  throw new Error("Usage: --workspace <slug> --backup <private-json-path> [--apply]");
}
const requireNative = createRequire(resolve(process.env.MULTICA_AGENT_MEMORY_SOURCE_DIR || ".agent-memory/upstream", "MemoryCore/package.json"));
const yaml = requireNative("yaml");
const db = new pg.Client(process.env.DATABASE_URL);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = message => { throw new Error(message); };
const receiptPath = backup + ".receipt.json";
const coreURL = process.env.MULTICA_AGENT_MEMORY_CORE_URL;
const apiKey = process.env.MULTICA_AGENT_MEMORY_API_KEY;
const secret = process.env.MULTICA_AGENT_MEMORY_SECRET_KEY;
if (!coreURL || !apiKey || !secret) fail("Memory service configuration is required");

function decrypt(sealed) {
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(secret, "base64"), sealed.subarray(0, 12));
  decipher.setAuthTag(sealed.subarray(-16));
  return Buffer.concat([decipher.update(sealed.subarray(12, -16)), decipher.final()]).toString();
}

async function snapshot(workspaceID) {
  const { rows: skills } = await db.query("SELECT * FROM skill WHERE workspace_id=$1 ORDER BY id", [workspaceID]);
  const { rows: files } = await db.query("SELECT f.* FROM skill_file f JOIN skill s ON s.id=f.skill_id WHERE s.workspace_id=$1 ORDER BY f.skill_id,f.path", [workspaceID]);
  const { rows: bindings } = await db.query("SELECT a.* FROM agent_skill a JOIN skill s ON s.id=a.skill_id WHERE s.workspace_id=$1 ORDER BY a.agent_id,a.skill_id", [workspaceID]);
  return { skills, files, bindings };
}

function contentOf(skill) {
  const match = skill.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const meta = match ? yaml.parse(match[1]) : {};
  if (meta?.name && meta.name !== skill.name) fail(`Frontmatter name differs: ${skill.name}`);
  if (meta?.name && meta?.description) return skill.content;
  const body = match ? skill.content.slice(match[0].length) : skill.content;
  return `---\n${yaml.stringify({ ...meta, name: skill.name, description: skill.description || skill.name }).trimEnd()}\n---\n${body}`;
}

await db.connect();
try {
  const { rows: workspaces } = await db.query("SELECT w.id,k.team_id,k.instance_id FROM workspace w JOIN workspace_knowledge k ON k.workspace_id=w.id WHERE w.slug=$1", [workspaceSlug]);
  const workspace = workspaces[0] || fail("Workspace has no configured Memory team");
  const source = await snapshot(workspace.id);
  if (source.bindings.length) fail("Existing agent bindings need an explicit migration; source was preserved");
  if (source.skills.some(skill => skill.plugin_installation_id)) fail("Plugin-owned skills need their installation lifecycle migrated; source was preserved");
  const { rows: accounts } = await db.query("SELECT k.user_id,k.upstream_user_id,k.user_key_ciphertext FROM knowledge_identity k JOIN member m ON m.user_id=k.user_id WHERE m.workspace_id=$1 AND k.instance_id=$2", [workspace.id, workspace.instance_id]);
  const identities = new Map(accounts.map(account => [account.user_id, { id: account.upstream_user_id, key: decrypt(account.user_key_ciphertext) }]));
  const call = async (action, identity, input) => {
    const response = await fetch(`${coreURL}/v3/${action}`, {
      method: "POST", signal: AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "X-Tdai-Service-Id": workspace.instance_id, "X-Tdai-User-Key": identity.key },
      body: JSON.stringify(input),
    });
    const envelope = await response.json();
    if (!response.ok || envelope.code !== 0) fail(`Memory ${action} failed (HTTP ${response.status}, code ${envelope.code})`);
    return envelope.data;
  };
  const planned = source.skills.map(skill => {
    const identity = identities.get(skill.created_by);
    if (!identity?.id) fail(`Creator must open Memory before migration: ${skill.id}`);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill.name)) fail(`Unsupported skill name: ${skill.name}`);
    const files = source.files.filter(file => file.skill_id === skill.id);
    if (files.length > 100 || files.some(file => Buffer.byteLength(file.content) > 5 * 1024 * 1024)) fail(`Native resource limits exceeded: ${skill.name}`);
    return { skill, identity, files, content: contentOf(skill) };
  });
  if (!apply) {
    console.log(JSON.stringify({ workspace: workspaceSlug, skills: planned.length, files: source.files.length, bindings: 0, target: "team", dryRun: true }));
  } else {
    await mkdir(dirname(resolve(backup)), { recursive: true, mode: 0o700 });
    const backupData = { workspace, source };
    try { await writeFile(backup, JSON.stringify(backupData, null, 2), { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const saved = JSON.parse(await readFile(backup, "utf8"));
      if (digest(saved) !== digest(backupData)) fail("Backup differs from current source; preserve both and investigate before retrying");
    }
    const receipt = { workspace: workspaceSlug, teamID: workspace.team_id, sourceHash: digest(source), skills: [] };
    for (const item of planned) {
      // Recover an accepted create whose HTTP response or local receipt was lost.
      const candidates = [];
      for (let offset = 0; ; offset += 200) {
        const page = await call("skill/list", item.identity, { team_id: workspace.team_id, filters: { status: ["active"] }, pagination: { offset, limit: 200 } });
        candidates.push(...page.items);
        if (offset + page.items.length >= page.total || !page.items.length) break;
      }
      const prior = candidates.find(skill => skill.metadata?.multica_skill_id === item.skill.id);
      if (candidates.some(skill => skill.name === item.skill.name && !skill.owner_agent_id && skill.skill_id !== prior?.skill_id)) fail(`Team skill name already exists: ${item.skill.name}`);
      const result = prior || await call("skill/create", item.identity, {
        user_id: item.identity.id, team_id: workspace.team_id, name: item.skill.name, content: item.content,
        resources: item.files.map(file => ({ path: file.path, content: file.content, encoding: "utf-8" })),
        metadata: { multica_skill_id: item.skill.id, multica_workspace_id: workspace.id, multica_config: item.skill.config },
      });
      const saved = await call("skill/get", item.identity, { team_id: workspace.team_id, skill_id: result.skill_id, include_content: true, include_manifest: true });
      if (saved.content !== item.content || saved.owner_agent_id || saved.manifest.length !== item.files.length || saved.owner_user_id !== item.identity.id) fail(`Skill verification failed: ${item.skill.name}`);
      for (const file of item.files) {
        const read = await call("skill/files/read", item.identity, { team_id: workspace.team_id, skill_id: result.skill_id, path: file.path, encoding: "utf-8" });
        if (read.content !== file.content) fail(`Resource verification failed: ${item.skill.name}/${file.path}`);
      }
      const asset = await call("meta/asset/get", item.identity, { asset_id: result.skill_id });
      if (asset.team_id !== workspace.team_id || asset.visibility !== "team") fail(`Team visibility verification failed: ${item.skill.name}`);
      receipt.skills.push({ oldID: item.skill.id, nativeID: result.skill_id, name: item.skill.name, files: item.files.length });
      await writeFile(receiptPath, JSON.stringify(receipt, null, 2), { mode: 0o600 });
    }
    // Retire the original rows only after every body and supporting file was read back.
    await db.query("BEGIN");
    try {
      await db.query("SELECT id FROM skill WHERE workspace_id=$1 FOR UPDATE", [workspace.id]);
      await db.query("SELECT f.id FROM skill_file f JOIN skill s ON s.id=f.skill_id WHERE s.workspace_id=$1 FOR UPDATE OF f", [workspace.id]);
      if (digest(await snapshot(workspace.id)) !== receipt.sourceHash) fail("Source changed during migration; originals were preserved");
      for (const item of planned) {
        await db.query("DELETE FROM skill_file WHERE skill_id=$1", [item.skill.id]);
        await db.query("DELETE FROM skill WHERE id=$1 AND workspace_id=$2", [item.skill.id, workspace.id]);
      }
      await db.query("COMMIT");
    } catch (error) { await db.query("ROLLBACK"); throw error; }
    console.log(JSON.stringify({ workspace: workspaceSlug, migrated: receipt.skills.length, files: source.files.length, target: "team", backup, receipt: receiptPath }));
  }
} finally { await db.end(); }
