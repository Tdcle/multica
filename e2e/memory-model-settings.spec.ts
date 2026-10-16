import { test, expect } from '@playwright/test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TestApiClient } from './fixtures';

const base = process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.PORT || 8080}`;
test.use({ actionTimeout: 10000 });
test.skip(!process.env.MULTICA_AGENT_MEMORY_CORE_URL, 'Requires managed Memory services');

test('Memory model settings persist, reject invalid responses, and enforce live workspace permissions', async ({ page }, testInfo) => {
  test.setTimeout(process.env.MULTICA_RUN_REAL_AGENT_SMOKE === '1' ? 300000 : 90000);
  const suffix = `${Date.now()}-${process.pid}`;
  const owner = new TestApiClient(), admin = new TestApiClient();
  await owner.login(`memory-model-owner-${suffix}@localhost`, 'Model owner');
  const workspace = await owner.ensureWorkspace('Memory models', `memory-model-${suffix}`);
  await owner.markUserOnboarded();
  const adminEmail = `memory-model-admin-${suffix}@localhost`;
  await admin.login(adminEmail, 'Model admin');
  const adminId = await owner.addWorkspaceMember(adminEmail, 'admin');
  admin.setWorkspaceId(workspace.id); admin.setWorkspaceSlug(workspace.slug);
  const headers = (api = owner) => ({ Authorization: `Bearer ${api.getToken()}`, 'X-Workspace-ID': workspace.id, 'Content-Type': 'application/json' });
  const call = (path: string, method = 'GET', body?: unknown, api = owner) => fetch(base + path, { method, headers: headers(api), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let nativeTeam: string | undefined, panelRoot = '', panelHeaders: Record<string, string> = {}, wiki: string | undefined;
  const panel = (path: string, body: unknown = {}) => fetch(panelRoot + 'api/v1/' + path, { method: 'POST', headers: panelHeaders, body: JSON.stringify(body) });
  try {
    const agent = await owner.createAgent('Model space');
    await expect.poll(async () => (await (await call(`/api/agents/${agent.id}/memory`)).json()).binding?.status, { timeout: 45000 }).toBe('ready');
    const binding = (await (await call('/api/knowledge')).json()).binding;
    nativeTeam = binding.team_id;
    const session = await (await call('/api/knowledge/panel-session', 'POST', {})).json();
    panelRoot = `${base}/api/knowledge-panel/${workspace.id}/`;
    panelHeaders = { 'Content-Type': 'application/json', 'X-Multica-Knowledge-Session': new URLSearchParams(session.url.split('#')[1]).get('session')! };
    const originalResponse = await panel('knowledge/model-settings/get');
    expect(originalResponse.status, await originalResponse.clone().text()).toBe(200);
    const original = (await originalResponse.json()).data;
    const candidate = original.models.find((m: { efforts: string[] }) => m.efforts.length > 1);
    const effort = candidate.efforts.find((e: string) => e !== original.effort) || candidate.efforts[0];
    expect((await panel('knowledge/model-settings/set', { model: candidate.id, effort: 'invalid-effort' })).status).toBe(400);
    expect((await panel('knowledge/model-settings/get', { team_id: 'another-team' })).status).toBe(403);
    await page.addInitScript(token => { if (window.self === window.top) { localStorage.setItem('multica_token', token); localStorage.setItem('multica:chat:isOpen', 'false'); } }, owner.getToken()!);
    await page.goto(`/${workspace.slug}/knowledge`);
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('.multica-memory-nav')).toBeVisible();
    const skip = frame.getByRole('button', { name: /^Skip$|跳过/ });
    if (await skip.isVisible()) await skip.click();
    await frame.locator('._memory-global-header-icon-btn').click();
    await expect(frame.locator('.tea-dialog')).toContainText(/Extraction model|抽取模型/);
    await expect(frame.locator('.tea-dialog')).toContainText(original.models.find((m: { id: string }) => m.id === original.model)?.name || original.model);
    // The two real controls must expose the runtime's model and effort choices.
    const selects = frame.locator('.tea-dialog .tea-dropdown');
    await expect(selects).toHaveCount(2);
    await selects.first().click();
    await frame.getByRole('listitem', { name: candidate.name, exact: true }).first().click();
    await selects.nth(1).click();
    const labels: Record<string, string> = { none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Very high', max: 'Maximum', ultra: 'Ultra' };
    await frame.getByRole('listitem', { name: labels[effort] || effort, exact: true }).first().click();
    await frame.getByRole('button', { name: /Save model settings|保存模型设置/ }).click();
    await expect(frame.locator('.tea-dialog')).toContainText(/Saved|已保存/);
    const stored = (await (await panel('knowledge/model-settings/get')).json()).data;
    expect(stored.model).toBe(candidate.id); expect(stored.effort).toBe(effort);
    await page.screenshot({ path: testInfo.outputPath('memory-model-settings.png') });
    await frame.locator('.tea-dialog').getByRole('button', { name: /^Close$|关闭/ }).click();
    await frame.locator('._memory-global-header-icon-btn').click();
    await expect(frame.locator('.tea-dialog')).toContainText(labels[effort] || effort);
    await frame.locator('.tea-dialog').getByRole('button', { name: /^Close$|关闭/ }).click();
    // Malformed data must be surfaced, without crashing or enabling Save.
    await page.route('**/api/v1/knowledge/model-settings/get', route => route.fulfill({ json: { code: 0, data: { models: [null], model: 9 } } }));
    await frame.locator('._memory-global-header-icon-btn').click();
    await expect(frame.locator('.tea-dialog')).toContainText('Invalid model settings response');
    await expect(frame.getByRole('button', { name: /Save model settings|保存模型设置/ })).toBeDisabled();
    await page.unroute('**/api/v1/knowledge/model-settings/get');
    await frame.locator('.tea-dialog').getByRole('button', { name: /^Close$|关闭/ }).click();
    // Exercise progress rendering with a real Wiki; intercept only its read status.
    const created = await panel('knowledge/wiki/create', { name: 'Model progress', team_id: nativeTeam });
    wiki = (await created.json()).data.wiki_id;
    let progressPercent = 0, reads = 0, writes = 0;
    await page.route('**/api/v1/knowledge/wiki/team-assets', async route => {
      const response = await route.fetch(); const data = await response.json();
      for (const item of data.data?.items || []) if (item.knowledge_id === wiki) { item.status = 'processing'; item.internal_status = 'ingesting'; }
      await route.fulfill({ response, json: data });
    });
    await page.route('**/api/v1/knowledge/wiki/get', async route => {
      const response = await route.fetch(); const data = await response.json();
      if (data.data?.wiki_id === wiki) { reads++; data.data.status = 'processing'; data.data.internal_status = 'ingesting'; data.data.progress = { phase: 'extracting', total: 4, completed: progressPercent ? 1 : 0, failed: 0, skipped: 3, percent: progressPercent }; }
      await route.fulfill({ response, json: data });
    });
    page.on('request', request => { if (request.url().endsWith('/wiki/ingest')) writes++; });
    await frame.locator('.multica-memory-nav-item').nth(1).click();
    await frame.getByText('Team Wiki Pool', { exact: true }).click();
    await frame.locator('._asset-wiki-card-name', { hasText: 'Model progress' }).click();
    await expect(frame.locator('._wiki-detail-ingest-card')).toContainText('0/4 completed');
    await expect(frame.locator('._wiki-detail-ingest-card')).toContainText('0%');
    progressPercent = 23;
    await expect(frame.locator('._wiki-detail-ingest-card')).toContainText('1/4 completed');
    await expect(frame.locator('._wiki-detail-ingest-card')).toContainText('23%');
    expect(reads).toBeGreaterThan(1); expect(writes).toBe(0);
    await page.unroute('**/api/v1/knowledge/wiki/get');
    await page.unroute('**/api/v1/knowledge/wiki/team-assets');
    await panel('knowledge/wiki/delete', { wiki_ids: [wiki] }); wiki = undefined;
    // Explicit opt-in: extract an isolated Wiki through the user's real local runtime.
    if (process.env.MULTICA_RUN_REAL_AGENT_SMOKE === '1') {
      const smokeModel = original.models.find((m: { id: string }) => m.id === 'gpt-6-luna') || candidate;
      const smokeEffort = smokeModel.efforts.includes('low') ? 'low' : smokeModel.default_effort;
      expect((await panel('knowledge/model-settings/set', { model: smokeModel.id, effort: smokeEffort })).status).toBe(200);
      const smoke = await panel('knowledge/wiki/create', { name: 'Model extraction smoke', team_id: nativeTeam });
      wiki = (await smoke.json()).data.wiki_id;
      expect((await panel('knowledge/wiki/raw/write', { team_id: nativeTeam, wiki_id: wiki, files: [{ filename: 'scope.md', content: '# Workspace memory settings\n\nEach Multica workspace selects an extraction model and reasoning effort. Administrators edit these settings in Memory. Wiki, conversation memory and Skill extraction use that workspace configuration. Changes apply to subsequent inference calls. Status polling only reads progress and never starts extraction. Existing document hashes skip unchanged sources. Other workspaces have independent configuration.' }] })).status).toBe(200);
      expect((await panel('knowledge/wiki/ingest', { wiki_id: wiki })).status).toBe(200);
      let result: { status?: string; sync_error?: string; page_count?: number } = {};
      await expect.poll(async () => {
        result = (await (await panel('knowledge/wiki/get', { wiki_id: wiki })).json()).data;
        if (result.status === 'failed') {
          const state = process.env.MULTICA_AGENT_MEMORY_STATE_DIR;
          if (state && wiki && nativeTeam) {
            const directory = join(state, 'knowledge-data', process.env.MULTICA_AGENT_MEMORY_INSTANCE_ID || 'default', nativeTeam, wiki, '_debug');
            try {
              for (const filename of await readdir(directory)) if (filename.startsWith('generate-fail-scope.md-')) {
                const output = testInfo.outputPath(filename);
                await writeFile(output, await readFile(join(directory, filename)));
                await testInfo.attach(filename, { path: output, contentType: 'text/plain' });
              }
            } catch { /* Diagnostics are optional and restricted to this test's source. */ }
          }
          throw new Error(result.sync_error || 'Wiki extraction failed');
        }
        return result.status;
      }, { timeout: 180000, intervals: [2000] }).toBe('ready');
      expect(result.page_count).toBeGreaterThan(0);
      const pages = (await (await panel('knowledge/wiki/page/ls', { wiki_id: wiki })).json()).data;
      expect(pages.items?.length).toBeGreaterThan(0);
      expect(pages.items.some((item: { type: string }) => item.type === 'source')).toBe(true);
      await testInfo.attach('real-wiki-extraction', { body: JSON.stringify({ model: smokeModel.id, effort: smokeEffort, status: result.status, pages: result.page_count }), contentType: 'application/json' });
      console.log('Real Wiki extraction:', { model: smokeModel.id, effort: smokeEffort, pages: result.page_count });
      await panel('knowledge/wiki/delete', { wiki_ids: [wiki] }); wiki = undefined;
    }
    const members = await (await call(`/api/workspaces/${workspace.id}/members`)).json();
    const oldOwner = members.find((m: { role: string }) => m.role === 'owner');
    const nextOwner = members.find((m: { user_id: string }) => m.user_id === adminId);
    expect((await call(`/api/workspaces/${workspace.id}/members/${nextOwner.id}`, 'PATCH', { role: 'owner' })).status).toBe(200);
    expect((await call(`/api/workspaces/${workspace.id}/members/${oldOwner.id}`, 'PATCH', { role: 'member' }, admin)).status).toBe(200);
    expect((await panel('knowledge/model-settings/get')).status).toBe(200);
    expect((await panel('knowledge/model-settings/set', { model: candidate.id, effort })).status).toBe(403);
    await page.reload();
    await expect(frame.locator('.multica-memory-nav')).toBeVisible();
    await frame.locator('._memory-global-header-icon-btn').click();
    await expect(frame.locator('.tea-dialog')).toContainText('Only workspace administrators can change these settings.');
    await expect(frame.getByRole('button', { name: 'Save model settings' })).toHaveCount(0);

    expect((await call(`/api/workspaces/${workspace.id}/members/${oldOwner.id}`, 'DELETE', undefined, admin)).status).toBe(204);
    expect((await panel('knowledge/model-settings/get')).status).toBe(401);
    expect((await panel('knowledge/model-settings/set', { model: candidate.id, effort })).status).toBe(401);
  } catch (error) {
    await testInfo.attach('model-settings-failure', { body: await page.screenshot(), contentType: 'image/png' });
    throw error;
  } finally {
    if (wiki) await panel('knowledge/wiki/delete', { wiki_ids: [wiki] });
    const removed = await call(`/api/workspaces/${workspace.id}`, 'DELETE', undefined, admin);
    if (removed.status !== 204) await call(`/api/workspaces/${workspace.id}`, 'DELETE');
    if (nativeTeam) {
      const native = async (action: string, body: unknown) => {
        const res = await fetch(process.env.MULTICA_AGENT_MEMORY_CORE_URL + '/v3/meta/' + action, { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.MULTICA_AGENT_MEMORY_API_KEY, 'Content-Type': 'application/json', 'X-Tdai-Service-Id': process.env.MULTICA_AGENT_MEMORY_INSTANCE_ID || 'default', 'X-Tdai-User-Key': process.env.MULTICA_AGENT_MEMORY_ADMIN_KEY! }, body: JSON.stringify(body) });
        expect(res.status).toBe(200); return (await res.json()).data;
      };
      const adminIdentity = await native('auth/verify', { user_key: process.env.MULTICA_AGENT_MEMORY_ADMIN_KEY });
      await native('team/managed-owner', { team_id: nativeTeam, user_id: adminIdentity.user.user_id });
      await native('team/delete', { team_ids: [nativeTeam] });
    }
  }
});
