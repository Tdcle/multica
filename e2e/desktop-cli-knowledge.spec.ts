import { test, expect } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TestApiClient } from './fixtures';

const base = process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.PORT || 8080}`;
const executable = process.env.MULTICA_KNOWLEDGE_CLI_PATH;
test.skip(process.env.MULTICA_RUN_REAL_AGENT_SMOKE !== '1' || !executable || !process.env.MULTICA_KNOWLEDGE_CODEX_MODEL || !process.env.MULTICA_AGENT_MEMORY_CORE_URL, 'Requires explicit real-agent opt-in, bundled CLI, model and native Memory');

test('desktop-paired daemon CLI survives shell startup and a real agent searches and reads full knowledge', async ({}, testInfo) => {
  test.setTimeout(240000);
  expect(isAbsolute(executable!)).toBe(true);
  const pairedVersion = JSON.parse(execFileSync(executable!, ['version', '--output', 'json'], { encoding: 'utf8' })).version;
  const suffix = randomUUID();
  const profile = `cli-knowledge-${suffix}`;
  const profileDir = join(homedir(), '.multica', 'profiles', profile);
  const workspaces = await mkdtemp(join(tmpdir(), 'multica-cli-knowledge-'));
  const api = new TestApiClient();
  await api.login(`cli-knowledge-${suffix}@localhost`, 'CLI knowledge reader');
  const workspace = await api.ensureWorkspace('CLI knowledge reader', `cli-reader-${suffix}`);
  const headers = { Authorization: `Bearer ${api.getToken()}`, 'X-Workspace-ID': workspace.id, 'Content-Type': 'application/json' };
  const call = async (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  let child: ChildProcess | undefined, diagnostics = '', team: string | undefined, skill: string | undefined;
  let panel: ((path: string, body: unknown) => Promise<any>) | undefined;
  try {
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    await writeFile(join(profileDir, 'config.json'), JSON.stringify({ server_url: base, workspace_id: workspace.id, token: api.getToken(), workspaces_root: workspaces }), { mode: 0o600 });
    child = spawn(executable!, ['daemon', 'start', '--foreground', '--profile', profile, '--daemon-id', profile, '--poll-interval', '500ms', '--heartbeat-interval', '2s', '--max-concurrent-tasks', '1', '--no-auto-update', '--no-auto-reload', '--agent-timeout', '150s', '--workspaces-root', workspaces], {
      cwd: workspaces, env: { ...process.env, MULTICA_SERVER_URL: base }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-100000); });
    let runtime: { id: string } | undefined;
    await expect.poll(async () => {
      if (child?.exitCode !== null) throw new Error(`Test daemon exited: ${diagnostics.slice(-3000)}`);
      const runtimes = await (await call('/api/runtimes')).json();
      runtime = runtimes.find((r: { daemon_id: string; provider: string }) => r.daemon_id === profile && r.provider === 'codex');
      return !!runtime;
    }, { timeout: 45000, intervals: [1000] }).toBe(true);
    const created = await call('/api/agents', 'POST', { name: 'CLI knowledge reader', runtime_id: runtime!.id, model: process.env.MULTICA_KNOWLEDGE_CODEX_MODEL, thinking_level: 'low', custom_args: ['-c', 'features.skip_host_skill_discovery=true', '--disable', 'apps', '--disable', 'plugins', '--disable', 'multi_agent', '--disable', 'browser_use', '--disable', 'computer_use'] });
    expect(created.status, await created.clone().text()).toBe(201);
    const agent = await created.json();
    let memory: { native_agent_id: string } | undefined;
    await expect.poll(async () => { memory = (await (await call(`/api/agents/${agent.id}/memory`)).json()).binding; return (memory as any)?.status; }, { timeout: 45000, intervals: [1000] }).toBe('ready');
    const binding = (await (await call('/api/knowledge')).json()).binding; team = binding.team_id;
    const session = await (await call('/api/knowledge/panel-session', 'POST', {})).json();
    const ticket = new URLSearchParams(session.url.split('#')[1]).get('session')!;
    const panelRoot = `${base}/api/knowledge-panel/${workspace.id}/api/v1/`;
    panel = async (path, body) => {
      const res = await fetch(panelRoot + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Multica-Knowledge-Session': ticket }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      expect(res.status, await res.clone().text()).toBe(200); const env = await res.json(); expect(env.code).toBe(0); return env.data;
    };
    const bootstrap = await (await fetch(`${base}/api/knowledge-panel/${workspace.id}/bootstrap`, { headers: { 'X-Multica-Knowledge-Session': ticket } })).json();
    const marker = `full-body-${randomUUID()}`;
    const name = `paired-cli-guide-${suffix}`;
    const content = `---\nname: ${name}\ndescription: Desktop paired CLI and workspace retrieval procedure\n---\n\n# Desktop paired CLI\n\n` + 'Use the desktop paired CLI for workspace retrieval. Search for the guide, then read its complete content.\n'.repeat(45) + `\n## Full-text verification\n\nVerification marker: ${marker}.\nThe marker exists only in this section, beyond the automatic context excerpt.\n`;
    skill = (await panel('skill/create', { team_id: team, agent_id: memory!.native_agent_id, user_id: bootstrap.session.user.user_id, name, content })).skill_id;
    await panel('meta/agent-fixed-asset/set', { agent_id: memory!.native_agent_id, bindings: [{ asset_id: skill, asset_type: 'skill', injection_mode: 'reference', priority: 50, created_by: bootstrap.session.user.user_id }] });
    const chat = await call('/api/chat/sessions', 'POST', { agent_id: agent.id, title: 'Read-only paired CLI acceptance' }); expect(chat.status).toBe(201);
    const chatId = (await chat.json()).id;
    const sent = await call(`/api/chat/sessions/${chatId}/messages`, 'POST', { content: `Read-only acceptance. Follow the managed Multica CLI instructions. First run command -v multica and the paired CLI's version. On macOS also run /bin/zsh -lc '\"$MULTICA_CLI_PATH\" version' to verify an explicitly nested login shell uses the paired executable. Search the workspace knowledge for ${name} using knowledge search. Use the returned asset ID to run knowledge read and read the complete guide. Report its full-text verification marker and executable path. Do not modify any resource, post issue comments or change issue status. Do not read local database/config files, inspect credentials, use raw HTTP, or infer the marker from excerpts.` });
    expect(sent.status).toBe(201); const taskId = (await sent.json()).task_id;
    const db = await import('pg'); const client = new db.default.Client(process.env.DATABASE_URL); await client.connect();
    try {
      await expect.poll(async () => {
        const task = (await client.query('SELECT status, error FROM agent_task_queue WHERE id=$1', [taskId])).rows[0];
        if (task?.status === 'failed') throw new Error(`Agent failed: ${task.error}`);
        return task?.status;
      }, { timeout: 170000, intervals: [1000] }).toBe('completed');
    } finally { await client.end(); }
    const messages = await (await call(`/api/tasks/${taskId}/messages`)).json();
    const transcriptPath = testInfo.outputPath('tool-transcript.json');
    await writeFile(transcriptPath, JSON.stringify(messages, null, 2));
    await testInfo.attach('tool-transcript', { path: transcriptPath, contentType: 'application/json' });
    const uses = messages.filter((m: { type: string }) => m.type === 'tool_use');
    const results = messages.filter((m: { type: string }) => m.type === 'tool_result');
    expect(uses.some((m: { input: unknown }) => JSON.stringify(m.input).includes('knowledge search'))).toBe(true);
    expect(uses.some((m: { input: unknown }) => JSON.stringify(m.input).includes('knowledge read'))).toBe(true);
    expect(results.some((m: { output: string }) => m.output?.includes(marker))).toBe(true);
    // Execution output redacts the username in home paths; compare the stable
    // suffix of command-v's result rather than expecting unredacted user data.
    const pathSuffix = executable!.startsWith(homedir()) ? executable!.slice(homedir().length) : executable!;
    const lookupIndex = messages.findIndex((m: { type: string; input: unknown }) => m.type === 'tool_use' && JSON.stringify(m.input).includes('command -v multica'));
    expect(lookupIndex).toBeGreaterThanOrEqual(0);
    const lookupResult = messages.slice(lookupIndex + 1).find((m: { type: string }) => m.type === 'tool_result');
    expect(lookupResult?.output?.split('\n').some((line: string) => line.trim().endsWith(pathSuffix))).toBe(true);
    const combinedResults = results.map((m: { output: string }) => m.output || '').join('\n');
    expect(combinedResults.split(`multica ${pairedVersion}`).length - 1).toBeGreaterThanOrEqual(process.platform === 'darwin' ? 2 : 1);
    if (process.platform === 'darwin') expect(uses.some((m: { input: unknown }) => JSON.stringify(m.input).includes('/bin/zsh -lc'))).toBe(true);
    const successfulSearch = results.find((m: { output: string }) => m.output?.includes('"asset_id"') && m.output?.includes(skill!));
    expect(successfulSearch).toBeTruthy();
    expect(successfulSearch.output).not.toContain(marker);
    expect(results.some((m: { output: string }) => m.output?.includes('unknown command "knowledge"'))).toBe(false);
    const replies = await (await call(`/api/chat/sessions/${chatId}/messages`)).json();
    expect(JSON.stringify(replies)).toContain(marker);
    await testInfo.attach('real-cli-knowledge-evidence', { body: JSON.stringify({ executable, taskId, skillId: skill, marker, toolCalls: uses.map((m: { tool: string; input: unknown }) => ({ tool: m.tool, input: m.input })), markerRead: true }), contentType: 'application/json' });
    console.log('Real daemon knowledge read passed', { executable, toolCalls: uses.length, fullTextMarkerRead: true });
  } catch (error) {
    try { diagnostics += await readFile(join(profileDir, 'daemon.log'), 'utf8'); } catch { /* Terminal logging may be active. */ }
    const diagnosticPath = testInfo.outputPath('daemon-diagnostics.log');
    await writeFile(diagnosticPath, diagnostics);
    await testInfo.attach('daemon-diagnostics', { path: diagnosticPath, contentType: 'text/plain' });
    const runtimes = await (await call('/api/runtimes')).json();
    console.log('Fixture runtime registration', runtimes.map((r: { id: string; daemon_id: string; provider: string }) => ({ id: r.id, daemon: r.daemon_id, provider: r.provider })));
    throw error;
  } finally {
    if (child?.exitCode === null) {
      const done = once(child, 'exit'); child.kill('SIGTERM');
      await Promise.race([done, new Promise(r => setTimeout(r, 5000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    if (skill && panel) await panel('skill/delete', { team_id: team, skill_id: skill });
    await call(`/api/workspaces/${workspace.id}`, 'DELETE');
    if (team) {
      const native = async (action: string, body: unknown) => {
        const res = await fetch(process.env.MULTICA_AGENT_MEMORY_CORE_URL + '/v3/meta/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.MULTICA_AGENT_MEMORY_API_KEY, 'X-Tdai-Service-Id': process.env.MULTICA_AGENT_MEMORY_INSTANCE_ID || 'default', 'X-Tdai-User-Key': process.env.MULTICA_AGENT_MEMORY_ADMIN_KEY! }, body: JSON.stringify(body) }); return (await res.json()).data;
      };
      const admin = await native('auth/verify', { user_key: process.env.MULTICA_AGENT_MEMORY_ADMIN_KEY });
      await native('team/managed-owner', { team_id: team, user_id: admin.user.user_id }); await native('team/delete', { team_ids: [team] });
    }
    await rm(profileDir, { recursive: true, force: true }); await rm(workspaces, { recursive: true, force: true });
  }
});
