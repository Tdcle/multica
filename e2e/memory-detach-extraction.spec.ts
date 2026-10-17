import { test, expect } from '@playwright/test';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { TestApiClient } from './fixtures';

const base = process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.PORT || 8080}`;
test.skip(process.env.MULTICA_RUN_REAL_AGENT_SMOKE !== '1' || !process.env.MULTICA_KNOWLEDGE_CODEX_MODEL || !process.env.MULTICA_AGENT_MEMORY_CORE_URL, 'Requires explicit native extraction/model opt-in');

test('detach and rebind preserve original Done extraction, including retries and shared memories', async ({}, testInfo) => {
  test.setTimeout(600000);
  const suffix = randomUUID();
  const api = new TestApiClient();
  await api.login(`detach-extraction-${suffix}@localhost`, 'Extraction lifecycle');
  const workspace = await api.ensureWorkspace('Extraction lifecycle', `detach-${suffix}`);
  const headers = { Authorization: `Bearer ${api.getToken()}`, 'X-Workspace-ID': workspace.id, 'Content-Type': 'application/json' };
  const call = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  const state = async (agent: string) => (await (await call(`/api/agents/${agent}/memory`)).json()).binding;
  const bind = async (agent: string, memory: string | null) => {
    const result = await call(`/api/agents/${agent}/memory`, 'PUT', { memory_id: memory });
    expect(result.status, await result.clone().text()).toBe(200);
  };
  const db = new pg.Client(process.env.DATABASE_URL); await db.connect();
  let team: string | undefined;
  try {
    const writer = await api.createAgent('Writer'), shared = await api.createAgent('Shared reader');
    for (const agent of [writer, shared]) await expect.poll(async () => (await state(agent.id))?.status, { timeout: 45000 }).toBe('ready');
    const original = await state(writer.id), next = await state(shared.id);
    team = (await (await call('/api/knowledge')).json()).binding.team_id;
    await bind(shared.id, original.id);
    const session = await (await call('/api/knowledge/panel-session', 'POST', {})).json();
    const ticket = new URLSearchParams(session.url.split('#')[1]).get('session')!;
    const settings = await fetch(`${base}/api/knowledge-panel/${workspace.id}/api/v1/knowledge/model-settings/set`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Multica-Knowledge-Session': ticket }, body: JSON.stringify({ model: process.env.MULTICA_KNOWLEDGE_CODEX_MODEL, effort: 'low' }) });
    expect(settings.status, await settings.clone().text()).toBe(200);

    const marker = `original-space-${suffix}`;
    const source = await api.createIssue('Completed Orchard deployment procedure', { description: 'Verified release procedure: resolve tenant scope from persisted bindings, snapshot before changes, dry-run the release, then deploy gradually. Roll back on elevated errors.' });
    await db.query("INSERT INTO agent_task_queue(agent_id,issue_id,runtime_id,status,result) VALUES($1,$2,$3,'completed',$4::jsonb)", [writer.id, source.id, writer.runtime_id, JSON.stringify({ summary: `Verified snapshot and dry-run before release. Evidence marker: ${marker}` })]);
    // Hold a real Done outbox job's lease so the API race is deterministic.
    await db.query('BEGIN');
    await db.query("UPDATE issue SET status='done',updated_at=now(),revision=revision+1 WHERE id=$1 AND workspace_id=$2", [source.id, workspace.id]);
    const held = (await db.query("UPDATE knowledge_extraction SET status='processing',lease_token=gen_random_uuid(),lease_until=now()+interval '10 minutes',available_at=now()+interval '10 minutes' WHERE issue_id=$1 RETURNING *", [source.id])).rows[0];
    await db.query('COMMIT');
    expect(held.memory_id).toBe(original.id);
    await bind(writer.id, null);
    await bind(writer.id, next.id);
    const job = async () => (await db.query('SELECT * FROM knowledge_extraction WHERE id=$1', [held.id])).rows[0];
    expect((await job()).status).toBe('processing');
    expect((await job()).lease_token).toBe(held.lease_token);
    expect((await job()).memory_id).toBe(original.id);
    expect((await call(`/api/memories/${original.id}`, 'DELETE')).status).toBe(409);
    const archived = await call(`/api/agents/${shared.id}/archive?delete_memory=false`, 'POST');
    expect(archived.status, await archived.clone().text()).toBe(200);
    expect(await state(shared.id)).toBeNull();
    expect((await job()).status).toBe('processing');

    // A queued job also survives binding changes before its source is collected.
    await db.query("UPDATE knowledge_extraction SET status='pending',lease_token=NULL,lease_until=NULL WHERE id=$1", [held.id]);
    await bind(writer.id, null);
    await bind(writer.id, next.id);
    expect((await job()).status).toBe('pending');
    expect((await job()).source_payload).toBeNull();
    // Failed-job retry resolves the original memory even after every agent detached.
    await db.query("UPDATE knowledge_extraction SET status='failed',last_error='Fixture transient failure' WHERE id=$1", [held.id]);
    const retry = await call(`/api/knowledge/extractions/${held.id}/retry`, 'POST', {});
    expect(retry.status, await retry.clone().text()).toBe(204);
    let switchedDuringNativeExtraction = false;
    await expect.poll(async () => {
      const current = await job();
      if (current.status === 'submitted' && !switchedDuringNativeExtraction) {
        await bind(writer.id, original.id);
        await bind(writer.id, null);
        await bind(writer.id, next.id);
        switchedDuringNativeExtraction = true;
      }
      if (current.status === 'failed' || current.status === 'cancelled') throw new Error(`Original extraction ${current.status}: ${current.last_error}`);
      return current.status;
    }, { timeout: 480000, intervals: [1000, 2000] }).toBe('ready');
    expect(switchedDuringNativeExtraction).toBe(true);
    const finished = await job();
    expect(finished.memory_id).toBe(original.id);
    const originalRead = await call(`/api/knowledge/assets/chat_memory-${team}-${original.native_agent_id}?layer=L0`);
    expect(originalRead.status, await originalRead.clone().text()).toBe(200);
    expect(await originalRead.text()).toContain(marker);
    const nextRead = await call(`/api/knowledge/assets/chat_memory-${team}-${next.native_agent_id}?layer=L0`);
    expect([200, 404]).toContain(nextRead.status);
    expect(await nextRead.text()).not.toContain(marker);

    const followup = await api.createIssue('New Done uses the new memory');
    await db.query("INSERT INTO agent_task_queue(agent_id,issue_id,runtime_id,status) VALUES($1,$2,$3,'completed')", [writer.id, followup.id, writer.runtime_id]);
    await db.query('BEGIN');
    await db.query("UPDATE issue SET status='done',updated_at=now(),revision=revision+1 WHERE id=$1 AND workspace_id=$2", [followup.id, workspace.id]);
    const future = (await db.query("UPDATE knowledge_extraction SET available_at=now()+interval '10 minutes' WHERE issue_id=$1 RETURNING memory_id", [followup.id])).rows;
    await db.query('COMMIT');
    expect(future).toEqual([{ memory_id: next.id }]);
    await bind(writer.id, null);
    expect((await db.query('SELECT status FROM knowledge_extraction WHERE issue_id=$1', [followup.id])).rows[0].status).toBe('pending');
    await testInfo.attach('original-extraction-target', { body: JSON.stringify({ originalMemory: original.id, newMemory: next.id, extraction: held.id, originalStatus: finished.status, originalContentVerified: true }), contentType: 'application/json' });
  } finally {
    await db.query('ROLLBACK');
    await call(`/api/workspaces/${workspace.id}`, 'DELETE');
    if (team) {
      const native = async (action: string, body: unknown) => {
        const response = await fetch(process.env.MULTICA_AGENT_MEMORY_CORE_URL + '/v3/meta/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.MULTICA_AGENT_MEMORY_API_KEY, 'X-Tdai-Service-Id': process.env.MULTICA_AGENT_MEMORY_INSTANCE_ID || 'default', 'X-Tdai-User-Key': process.env.MULTICA_AGENT_MEMORY_ADMIN_KEY! }, body: JSON.stringify(body) });
        const envelope = await response.json(); expect(response.status).toBe(200); expect(envelope.code).toBe(0); return envelope.data;
      };
      const admin = await native('auth/verify', { user_key: process.env.MULTICA_AGENT_MEMORY_ADMIN_KEY });
      await native('team/managed-owner', { team_id: team, user_id: admin.user.user_id });
      await native('team/delete', { team_ids: [team] });
    }
    await db.end();
  }
});
