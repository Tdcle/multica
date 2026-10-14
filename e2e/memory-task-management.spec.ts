import { test, expect } from '@playwright/test';
import { TestApiClient } from './fixtures';

const apiBase = process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.PORT || 8080}`;
const coreBase = process.env.MULTICA_AGENT_MEMORY_CORE_URL;
const panelBase = process.env.MULTICA_AGENT_MEMORY_PANEL_URL;
test.skip(!coreBase || !panelBase, 'Requires native Memory services');

test('Memory has no task management UI or managed task API; Multica still owns tasks', async ({ page }) => {
  test.setTimeout(90000);
  const suffix = `${Date.now()}-${process.pid}`;
  const owner = new TestApiClient();
  const member = new TestApiClient();
  await owner.login(`memory-tasks-owner-${suffix}@localhost`, 'Memory task owner');
  const memberEmail = `memory-tasks-member-${suffix}@localhost`;
  await member.login(memberEmail, 'Memory task member');
  const workspace = await owner.ensureWorkspace('Memory task management', `memory-tasks-${suffix}`);
  await owner.addWorkspaceMember(memberEmail);
  member.setWorkspaceId(workspace.id);
  member.setWorkspaceSlug(workspace.slug);
  const headers = (api: TestApiClient) => ({
    Authorization: `Bearer ${api.getToken()}`,
    'X-Workspace-ID': workspace.id,
    'Content-Type': 'application/json',
  });
  const post = (url: string, requestHeaders: Record<string, string>, body: unknown = {}) =>
    fetch(url, { method: 'POST', headers: requestHeaders, body: JSON.stringify(body) });
  const nativeHeaders = (key: string) => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.MULTICA_AGENT_MEMORY_API_KEY}`,
    'X-Tdai-Service-Id': process.env.MULTICA_AGENT_MEMORY_INSTANCE_ID || 'default',
    'X-Tdai-User-Key': key,
  });
  const privileged = (action: string, body: unknown) =>
    post(`${coreBase}/v3/meta/${action}`, nativeHeaders(process.env.MULTICA_AGENT_MEMORY_ADMIN_KEY!), body);
  const keyIDs: string[] = [];
  const prefix = `${apiBase}/api/knowledge-panel/${workspace.id}/`;
  try {
    const provision = await post(apiBase + '/api/knowledge/binding', headers(owner), { name: `Memory tasks ${suffix}` });
    expect(provision.status, await provision.clone().text()).toBe(201);
    const binding = await provision.json();
    const taskActions = [
      'task/list', 'task/create', 'task/get', 'task/update', 'task/delete', 'task/archive',
      'task-agent/list', 'task-agent/link', 'task-agent/unlink',
      'participation-log/list', 'participation-log/append',
    ];
    const sourceActions = ['providers', 'workspaces', 'candidates', 'import'];
    const body = {
      team_id: binding.team_id, title: 'Must not become a native task',
      task_id: 'blocked-task-fixture', task_ids: ['blocked-task-fixture'],
      agent_id: 'blocked-agent-fixture', agent_ids: ['blocked-agent-fixture'],
      credential: { kind: 'bearer', secret: 'unused-test-credential' },
    };
    for (const api of [owner, member]) {
      const session = await post(apiBase + '/api/knowledge/panel-session', headers(api));
      expect(session.status).toBe(200);
      const ticket = new URLSearchParams((await session.json()).url.split('#')[1]).get('session')!;
      const panelHeaders = { 'Content-Type': 'application/json', 'X-Multica-Knowledge-Session': ticket };
      const boot = await fetch(prefix + 'bootstrap', { headers: panelHeaders });
      expect(boot.status).toBe(200);
      const userID = (await boot.json()).session.user.user_id;
      for (const action of taskActions) {
        expect((await post(prefix + 'api/v1/meta/' + action, panelHeaders, body)).status, `gateway ${action}`).toBe(403);
      }
      for (const action of ['list-with-agents', ...sourceActions.map(action => 'source/' + action)]) {
        expect((await post(prefix + 'api/v1/task/' + action, panelHeaders, body)).status, `gateway task/${action}`).toBe(403);
      }
      // A legacy user key must not bypass the same policy by addressing native services.
      const issued = await privileged('user-key/create', { user_id: userID, name: 'Temporary task policy fixture' });
      expect(issued.status).toBe(200);
      const key = (await issued.json()).data;
      keyIDs.push(key.key_id);
      const directHeaders = nativeHeaders(key.key_value);
      for (const action of taskActions) {
        expect((await post(`${coreBase}/v3/meta/${action}`, directHeaders, body)).status, `Core ${action}`).toBe(403);
        expect((await post(`${panelBase}/api/v1/meta/${action}`, directHeaders, body)).status, `Panel ${action}`).toBe(403);
      }
      for (const action of sourceActions) {
        expect((await post(`${coreBase}/v3/task-source/${action}`, directHeaders, body)).status, `Core source/${action}`).toBe(403);
        expect((await post(`${panelBase}/api/v1/task/source/${action}`, directHeaders, body)).status, `Panel source/${action}`).toBe(403);
      }
      expect((await post(`${panelBase}/api/v1/task/list-with-agents`, directHeaders, body)).status).toBe(403);
      expect((await post(prefix + 'api/v1/meta/agent/list', panelHeaders, { team_id: binding.team_id })).status).toBe(200);
      expect((await fetch(apiBase + '/api/knowledge/assets', { headers: headers(api) })).status).toBe(200);
    }
    // Native task metadata is independent of Multica's issue lifecycle and recall APIs.
    const issue = await owner.createIssue('Tasks belong to Multica');
    expect(issue.id).toBeTruthy();
    expect((await fetch(apiBase + '/api/issues/' + issue.id, { headers: headers(owner) })).status).toBe(200);

    await owner.markUserOnboarded();
    await page.addInitScript(token => {
      if (window.self !== window.top) return;
      localStorage.setItem('multica_token', token);
      localStorage.setItem('multica:chat:isOpen', 'false');
    }, owner.getToken()!);
    const taskRequests: string[] = [];
    page.on('request', request => {
      if (/\/api\/v1\/(?:task\/|meta\/(?:task|task-agent|participation-log)\/)/.test(request.url())) taskRequests.push(request.url());
    });
    await page.goto(`/${workspace.slug}/knowledge`);
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('._memory-app-shell')).toBeVisible();
    await frame.getByRole('button', { name: /^Skip$|跳过/ }).click();
    await expect(frame.getByText(/^(Task Board|任务看板)$/)).toHaveCount(0);
    await expect(frame.getByRole('button', { name: /Create Task|创建 Task|新建 Task/ })).toHaveCount(0);
    const embedded = page.frames().find(item => item.url().includes('/api/knowledge-panel/'))!;
    for (const route of ['/', '/workbench/board', '/tasks/new']) {
      await embedded.evaluate(hash => { location.hash = '#' + hash; }, route);
      await expect.poll(() => embedded.url()).toContain('#/memory');
      await expect(frame.getByText(/^(Task Board|任务看板)$/)).toHaveCount(0);
      await expect(frame.getByText(/Unexpected Application Error/)).toHaveCount(0);
    }
    await embedded.evaluate(() => { location.hash = '#/guide'; });
    await frame.locator('.guide-main-tabs button').nth(2).click();
    await expect(frame.locator('.guide-mem')).toContainText('mem:sync');
    await expect(frame.locator('.guide-mem')).not.toContainText('mem:create-task');
    await expect(frame.locator('.guide-mem')).not.toContainText('mem:update-task');
    expect(taskRequests).toEqual([]);
  } finally {
    for (const keyID of keyIDs) await privileged('user-key/revoke', { key_id: keyID });
    await fetch(apiBase + `/api/workspaces/${workspace.id}`, { method: 'DELETE', headers: headers(owner) });
  }
});
