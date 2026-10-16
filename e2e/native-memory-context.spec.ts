import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TestApiClient } from './fixtures';

const base = process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.PORT || 8080}`;
const executable = process.env.MULTICA_KNOWLEDGE_CLI_PATH;
test.skip(process.env.MULTICA_RUN_REAL_AGENT_SMOKE !== '1' || !executable || !process.env.MULTICA_KNOWLEDGE_CODEX_MODEL || !process.env.MULTICA_AGENT_MEMORY_CORE_URL, 'Requires explicit real-agent opt-in, bundled CLI, model and native Memory');

test('real agents extract only on Done, share native context, recall history, search and read full text', async ({}, testInfo) => {
  test.setTimeout(900000);
  expect(isAbsolute(executable!)).toBe(true);
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
    await panel('knowledge/model-settings/set',{model:process.env.MULTICA_KNOWLEDGE_CODEX_MODEL,effort:'low'});
    const marker = `full-body-${randomUUID()}`;
    const name = `paired-cli-guide-${suffix}`;
    const content = `---\nname: ${name}\ndescription: Desktop paired CLI and workspace retrieval procedure\n---\n\n# Desktop paired CLI\n\n` + 'Use the desktop paired CLI for workspace retrieval. Search for the guide, then read its complete content.\n'.repeat(45) + `\n## Full-text verification\n\nVerification marker: ${marker}.\nThe marker exists only in this section, beyond the automatic context excerpt.\n`;
    skill = (await panel('skill/create', { team_id: team, agent_id: memory!.native_agent_id, user_id: bootstrap.session.user.user_id, name, content })).skill_id;
    await panel('meta/agent-fixed-asset/set', { agent_id: memory!.native_agent_id, bindings: [{ asset_id: `chat_memory-${team}-${memory!.native_agent_id}`, asset_type: 'chat_memory', injection_mode: 'summary', priority: 50, created_by: bootstrap.session.user.user_id }, { asset_id: skill, asset_type: 'skill', injection_mode: 'reference', priority: 50, created_by: bootstrap.session.user.user_id }] });
    const db = await import('pg'); const client = new db.default.Client(process.env.DATABASE_URL); await client.connect();
    const producerMarker = `producer-result-${suffix}`;
    let taskId = "";
    try {
      const source = await api.createIssue(`Orchard rollout policy ${suffix}`, {
        status: 'todo', assignee_type: 'agent', assignee_id: agent.id,
        description: `Produce a short reusable Orchard rollout runbook: validate tenant scope from persisted bindings, take a snapshot, run a dry-run, then roll out gradually and roll back on elevated errors. Explain why caller-supplied tenant IDs are unsafe. Include this exact final result marker: ${producerMarker}. You may add a final issue comment, but do not move the issue to Done; the acceptance controller will do that. Do not modify code or files.`,
      });
      expect(source.id).toBeTruthy();
      let producerTask: any;
      await expect.poll(async () => {
        producerTask = (await client.query('SELECT id,status,error,result FROM agent_task_queue WHERE issue_id=$1 ORDER BY created_at DESC LIMIT 1', [source.id])).rows[0];
        if (producerTask?.status === 'failed') throw new Error(`Producer failed: ${producerTask.error}`);
        return producerTask?.status;
      }, { timeout: 180000, intervals: [1000] }).toBe('completed');
      const sourceComments = await (await call(`/api/issues/${source.id}/comments`)).json();
      expect(JSON.stringify({result:producerTask.result,comments:sourceComments})).toContain(producerMarker);
      const count = async () => Number((await client.query('SELECT count(*) FROM knowledge_extraction WHERE workspace_id=$1',[workspace.id])).rows[0].count);
      expect(await count()).toBe(0);
      await api.updateIssue(source.id, {status:'done'});
      let job: any;
      await expect.poll(async () => {
        job = (await client.query('SELECT id,status,last_error FROM knowledge_extraction WHERE issue_id=$1',[source.id])).rows[0];
        if (job?.status === 'failed') throw new Error(`Extraction failed: ${job.last_error}`);
        return job?.status;
      }, { timeout: 600000, intervals: [2000] }).toBe('ready');
      expect(await count()).toBe(1);
      const readerCreated = await call('/api/agents','POST',{name:'Independent memory reader',runtime_id:runtime!.id,model:process.env.MULTICA_KNOWLEDGE_CODEX_MODEL,thinking_level:'low',custom_args:['-c','features.skip_host_skill_discovery=true','--disable','apps','--disable','plugins','--disable','multi_agent','--disable','browser_use','--disable','computer_use']});
      expect(readerCreated.status).toBe(201); const reader = await readerCreated.json();
      const producerBinding = (await (await call(`/api/agents/${agent.id}/memory`)).json()).binding;
      expect((await call(`/api/agents/${reader.id}/memory`,'PUT',{memory_id:producerBinding.id})).status).toBe(200);
      const chat = await call('/api/chat/sessions','POST',{agent_id:reader.id,title:'Independent memory recall acceptance'}); expect(chat.status).toBe(201);
      const chatId = (await chat.json()).id;
      const sent = await call(`/api/chat/sessions/${chatId}/messages`,'POST',{content:`Read-only acceptance. Recall the Orchard rollout policy from historical memory: search for Orchard rollout, then read its original conversation at layer L0 to verify the producer's final result marker. Also use the supplied Skill catalog (or search if needed) to find ${name}, read its full content, and report its full-text verification marker. Explain the remembered policy with source IDs. Use the paired Multica knowledge CLI. Do not inspect local files/configuration, credentials, raw HTTP, or databases, and do not modify resources.`});
      expect(sent.status).toBe(201); taskId = (await sent.json()).task_id;
      await expect.poll(async () => {
        const task=(await client.query('SELECT status,error FROM agent_task_queue WHERE id=$1',[taskId])).rows[0];
        if(task?.status==='failed')throw new Error(`Reader failed: ${task.error}`);
        return task?.status;
      },{timeout:180000,intervals:[1000]}).toBe('completed');
      const replies = await (await call(`/api/chat/sessions/${chatId}/messages`)).json();
      expect(JSON.stringify(replies)).toContain(producerMarker);
      expect(JSON.stringify(replies)).toContain(marker);
      expect(await count()).toBe(1); // Ordinary chat completion never extracts.
      const priorSession=(await client.query('SELECT session_id FROM agent_task_queue WHERE id=$1',[taskId])).rows[0].session_id;
      expect(priorSession).toBeTruthy();
      expect((await call(`/api/agents/${reader.id}/memory`,'PUT',{memory_id:null})).status).toBe(200);
      const followup=await call(`/api/chat/sessions/${chatId}/messages`,'POST',{content:'Read-only check after unbinding Memory: run the paired CLI knowledge list, report whether any assets are currently accessible, and stop. Do not modify resources.'});
      expect(followup.status).toBe(201);const followupId=(await followup.json()).task_id;
      let nextTask:any;
      await expect.poll(async()=>{
        nextTask=(await client.query('SELECT status,error,session_id FROM agent_task_queue WHERE id=$1',[followupId])).rows[0];
        if(nextTask?.status==='failed')throw new Error(`Unbound follow-up failed: ${nextTask.error}`);
        return nextTask?.status;
      },{timeout:180000,intervals:[1000]}).toBe('completed');
      expect(nextTask.session_id).toBeTruthy();expect(nextTask.session_id).not.toBe(priorSession);
      const followupMessages=await(await call(`/api/tasks/${followupId}/messages`)).json();
      expect(followupMessages.some((m:any)=>m.type==='tool_result'&&m.output?.includes('"items": []'))).toBe(true);
      expect(await count()).toBe(1);
      await testInfo.attach('memory-scope-session-reset',{body:JSON.stringify({priorSession,newSession:nextTask.session_id,followupId,assetsAfterDetach:[]}),contentType:'application/json'});

      await testInfo.attach('done-extraction-evidence',{body:JSON.stringify({producerTaskId:producerTask.id,extractionJobId:job.id,readerTaskId:taskId,producerMarker,fullTextMarker:marker,extractionsAfterChat:1}),contentType:'application/json'});
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
    // The native Skill catalog already supplies its ID; historical memory is searched on demand.
    const successfulSearch = results.find((m: { output: string }) => m.output?.includes('"asset_id"') && m.output?.includes('"chat_memory"'));
    expect(successfulSearch).toBeTruthy();
    expect(successfulSearch.output).not.toContain(marker);
    expect(results.some((m: { output: string }) => m.output?.includes('unknown command "knowledge"'))).toBe(false);
    expect(results.some((m: {output:string}) => m.output?.includes(producerMarker))).toBe(true);
    const historyRead = messages.findIndex((m: {type:string;input:unknown}) => m.type==='tool_use' && JSON.stringify(m.input).includes('knowledge read') && JSON.stringify(m.input).includes('L0'));
    expect(historyRead).toBeGreaterThanOrEqual(0);
    expect(messages.slice(historyRead+1).find((m: {type:string})=>m.type==='tool_result')?.output).toContain(producerMarker);
    console.log('Real Done extraction and independent recall passed', {taskId,toolCalls:uses.length,producerMarkerRead:true,fullTextMarkerRead:true});
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
