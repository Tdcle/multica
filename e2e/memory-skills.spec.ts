import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { TestApiClient } from './fixtures';

const apiBase = process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.PORT || 8080}`;
test.skip(!process.env.MULTICA_AGENT_MEMORY_CORE_URL, 'Requires native Memory services');
test.use({ actionTimeout: 10000 });

test('one Skills entry, lossless team migration, shared bindings and task recall', async ({ page }, testInfo) => {
  test.setTimeout(120000);
  const suffix = `${Date.now()}-${process.pid}`;
  const owner = new TestApiClient();
  await owner.login(`memory-skills-${suffix}@localhost`, 'Skills owner');
  const workspace = await owner.ensureWorkspace('Memory Skills', `memory-skills-${suffix}`);
  const headers = { Authorization: `Bearer ${owner.getToken()}`, 'X-Workspace-ID': workspace.id, 'Content-Type': 'application/json' };
  const call = (path: string, method = 'GET', body?: unknown) => fetch(apiBase + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const db = new pg.Client(process.env.DATABASE_URL);
  await db.connect();
  const directory = await mkdtemp(join(tmpdir(), 'multica-skill-migration-'));
  const backup = join(directory, 'backup.json');
  let nativeTeam: string | undefined;
  let nativeSkill: string | undefined;
  const extraSkills: string[] = [];
  let forkedSkill: string | undefined;
  try {
    const provision = await call('/api/knowledge/binding', 'POST', { name: 'Memory Skills' });
    expect(provision.status, await provision.clone().text()).toBe(201);
    const binding = await provision.json();
    nativeTeam = binding.team_id;
    const session = await call('/api/knowledge/panel-session', 'POST');
    expect(session.status).toBe(200);
    const ticket = new URLSearchParams((await session.json()).url.split('#')[1]).get('session')!;
    const prefix = `${apiBase}/api/knowledge-panel/${workspace.id}/`;
    const panelHeaders = { 'Content-Type': 'application/json', 'X-Multica-Knowledge-Session': ticket };
    const panel = (action: string, body: unknown) => fetch(prefix + 'api/v1/' + action, { method: 'POST', headers: panelHeaders, body: JSON.stringify(body) });
    const bootstrap = await fetch(prefix + 'bootstrap', { headers: panelHeaders });
    const nativeUser = (await bootstrap.json()).session.user.user_id;
    const name = 'deployment-recovery';
    const marker = `recovery-${suffix}`;
    const content = `---\nname: ${name}\ndescription: Deployment recovery procedure\n---\n\n# Recovery\nUse ${marker} to recover deployments.\n`;
    const file = '# Recovery reference\nPreserve Unicode: 团队经验 🧠\n' + 'Large resource content.\n'.repeat(60000);
    const created = await call('/api/skills', 'POST', { name, description: 'Deployment recovery procedure', content, files: [{ path: 'references/recovery.md', content: file }] });
    expect(created.status, await created.clone().text()).toBe(201);
    const oldID = (await created.json()).id;
    const runMigration = (apply = false) => promisify(execFile)(process.execPath, ['scripts/migrate-agent-memory-skills.mjs', '--workspace', workspace.slug, '--backup', backup, ...(apply ? ['--apply'] : [])], { env: process.env, timeout: 30000 });
    expect(JSON.parse((await runMigration()).stdout)).toMatchObject({ skills: 1, files: 1, dryRun: true });
    expect(JSON.parse((await runMigration(true)).stdout)).toMatchObject({ migrated: 1, files: 1, target: 'team' });
    expect((await db.query('SELECT id FROM skill WHERE id=$1', [oldID])).rows).toHaveLength(0);
    expect(JSON.parse(await readFile(backup, 'utf8')).source.skills[0].content).toBe(content);
    expect(JSON.parse((await runMigration()).stdout)).toMatchObject({ skills: 0, dryRun: true });
    const receipt = JSON.parse(await readFile(backup + '.receipt.json', 'utf8'));
    const skillID = receipt.skills[0].nativeID;
    nativeSkill = skillID;
    const detail = await panel('skill/get', { team_id: binding.team_id, skill_id: skillID });
    expect((await detail.json()).data).toMatchObject({ content, owner_agent_id: '', owner_user_id: nativeUser });
    const asset = await panel('meta/asset/get', { asset_id: skillID });
    expect((await asset.json()).data).toMatchObject({ visibility: 'team', team_id: binding.team_id });
    // Exercise the console gateway above its former 8 MiB limit, within native resource limits.
    const large = 'x'.repeat(4_300_000);
    const bundle = await panel('skill/create', { user_id: nativeUser, team_id: binding.team_id,
      name: 'large-team-bundle', content: '---\nname: large-team-bundle\ndescription: Large import fixture\n---\nBundle fixture.',
      resources: ['a.md', 'b.md'].map(path => ({ path, content: large, encoding: 'utf-8' })),
    });
    expect(bundle.status, await bundle.clone().text()).toBe(200);
    const bundleResult = await bundle.json();
    expect(bundleResult.code).toBe(0);
    expect((await panel('skill/delete', { team_id: binding.team_id, skill_id: bundleResult.data.skill_id })).status).toBe(200);
    // Native team import works before any agent exists; no artificial owner-agent is created.
    expect((await panel('meta/agent/list', { team_id: binding.team_id })).status).toBe(200);
    const taskTokens: string[] = [];
    const agents = [await owner.createAgent('Reader A'), await owner.createAgent('Reader B')];
    const memory = async (id: string) => (await (await call(`/api/agents/${id}/memory`)).json()).binding;
    const issue = await owner.createIssue('Deployment recovery');
    expect(issue.title, JSON.stringify(issue)).toBe('Deployment recovery');
    for (const agent of agents) {
      await expect.poll(async () => (await memory(agent.id))?.status, { timeout: 45000 }).toBe('ready');
      const nativeAgent = (await memory(agent.id)).native_agent_id;
      const result = await panel('meta/agent-fixed-asset/set', { agent_id: nativeAgent, bindings: [{ asset_id: skillID, asset_type: 'skill', injection_mode: 'reference', priority: 50, created_by: nativeUser }] });
      expect(result.status, await result.clone().text()).toBe(200);
      expect((await result.json()).code).toBe(0);
      const fixed = await panel('meta/agent-fixed-asset/list-with-detail', { agent_id: nativeAgent });
      expect((await fixed.json()).data.items.map((item: { asset_id: string }) => item.asset_id)).toContain(skillID);
      await db.query("INSERT INTO agent_task_queue (agent_id,issue_id,runtime_id,status) VALUES ($1,$2,$3,'queued')", [agent.id, issue.id, agent.runtime_id]);
      const claim = await call(`/api/daemon/runtimes/${agent.runtime_id}/tasks/claim`, 'POST');
      expect(claim.status).toBe(200);
      const task = (await claim.json()).task;
      taskTokens.push(task.auth_token);
      expect(task.knowledge_context, JSON.stringify({ agent: agent.id, returnedAgent: task.agent_id, available: task.knowledge_available, memory: await memory(agent.id) })).toContain(skillID);
      const read = await fetch(apiBase + `/api/knowledge/assets/${skillID}`, { headers: { Authorization: `Bearer ${task.auth_token}` } });
      expect(read.status, await read.clone().text()).toBe(200);
      expect(await read.text()).toContain(marker);
      const resource = await fetch(apiBase + `/api/knowledge/assets/${skillID}?ref=references%2Frecovery.md`, { headers: { Authorization: `Bearer ${task.auth_token}` } });
      expect(resource.status).toBe(200);
      expect((await resource.json()).content).toBe(file);
    }
    const admin = new TestApiClient();
    const adminEmail = `memory-skills-admin-${suffix}@localhost`;
    await admin.login(adminEmail, 'Skills administrator');
    const adminID = await owner.addWorkspaceMember(adminEmail, 'admin');
    const adminSession = await fetch(apiBase + '/api/knowledge/panel-session', { method: 'POST', headers: { ...headers, Authorization: `Bearer ${admin.getToken()}` } });
    expect(adminSession.status).toBe(200);
    const adminTicket = new URLSearchParams((await adminSession.json()).url.split('#')[1]).get('session')!;
    const adminPanel = (body: unknown) => fetch(prefix + 'api/v1/meta/agent-fixed-asset/set', { method: 'POST', headers: { ...panelHeaders, 'X-Multica-Knowledge-Session': adminTicket }, body: JSON.stringify(body) });
    const adminChange = { agent_id: (await memory(agents[0].id)).native_agent_id, bindings: [] };
    expect((await adminPanel(adminChange)).status).toBe(200);
    const members = await (await call(`/api/workspaces/${workspace.id}/members`)).json();
    const member = members.find((item: { user_id: string }) => item.user_id === adminID);
    expect((await call(`/api/workspaces/${workspace.id}/members/${member.id}`, 'PATCH', { role: 'member' })).status).toBe(200);
    expect((await adminPanel(adminChange)).status).toBe(403);
    expect((await call(`/api/workspaces/${workspace.id}/members/${member.id}`, 'DELETE')).status).toBe(204);
    expect((await adminPanel(adminChange)).status).toBe(401);
    // A different workspace cannot use a panel capability to create or edit team assets.
    const foreignResponse = await call('/api/workspaces', 'POST', { name: 'Other Skills', slug: `other-skills-${suffix}` });
    expect(foreignResponse.status).toBe(201);
    const foreign = await foreignResponse.json();
    owner.setWorkspaceId(workspace.id); owner.setWorkspaceSlug(workspace.slug);
    expect((await panel('skill/create', { team_id: foreign.id, user_id: nativeUser, name: 'forbidden', content })).status).toBe(403);
    await fetch(apiBase + `/api/workspaces/${foreign.id}`, { method: 'DELETE', headers: { ...headers, 'X-Workspace-ID': foreign.id } });
    await owner.markUserOnboarded();
    await page.addInitScript(token => {
      if (window.self !== window.top) return;
      localStorage.setItem('multica_token', token);
      localStorage.setItem('multica:chat:isOpen', 'false');
    }, owner.getToken()!);
    await page.goto(`/${workspace.slug}/skills`);
    await expect(page).toHaveURL(new RegExp(`/${workspace.slug}/knowledge\\?section=skills`));
    const frame = page.frameLocator('iframe');
    await expect(frame.locator('._memory-app-shell')).toBeVisible();
    await frame.getByRole('button', { name: /^Skip$|跳过/ }).click();
    await expect(frame.locator('._memory-app-shell')).toContainText(name);
    expect(page.frames().some(item => item.url().includes('#/skills'))).toBe(true);
    await expect(page.locator(`a[href="/${workspace.slug}/skills"]`)).toHaveCount(0);
    await expect(frame.getByRole('button', { name: 'Fork (writable)', exact: true })).toHaveCount(0);
    await frame.getByText(name, { exact: true }).first().click();
    await expect(frame.getByText(marker, { exact: false })).toBeVisible();
    // Fork belongs to the selected skill and keeps its complete content and resources.
    await expect(frame.locator('._asset-page-header-actions').getByRole('button', { name: /Fork/ })).toHaveCount(0);
    await expect(frame.getByRole('button', { name: 'Add file', exact: true })).toHaveCount(0);
    const detailActions = frame.locator('._memory-skill-detail-actions');
    await expect(detailActions.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
    await detailActions.getByRole('button', { name: 'Fork (writable)', exact: true }).click();
    const forkDialog = frame.getByRole('dialog');
    await expect(forkDialog.getByRole('textbox')).toHaveValue(name);
    const copyName = 'deployment-recovery-copy';
    await forkDialog.getByRole('textbox').fill(copyName);
    const forkResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/skill/create') && response.request().method() === 'POST');
    await forkDialog.getByRole('button', { name: 'Fork', exact: true }).click();
    const copied = await (await forkResponse).json();
    expect(copied.code).toBe(0);
    forkedSkill = copied.data.skill_id;
    expect(forkedSkill).toBeTruthy();
    await expect(forkDialog).toHaveCount(0);
    const copy = (await (await panel('skill/get', { team_id: nativeTeam, skill_id: forkedSkill })).json()).data;
    expect(copy.name).toBe(copyName);
    expect(copy.owner_agent_id).toBeTruthy();
    expect(copy.content).toBe(content.replace(`name: ${name}`, `name: ${copyName}`));
    const copyFile = await panel('skill/files/read', { team_id: nativeTeam, skill_id: forkedSkill, path: 'references/recovery.md' });
    expect((await copyFile.json()).data.content).toBe(file);
    expect((await (await panel('skill/get', { team_id: nativeTeam, skill_id: skillID })).json()).data.content).toBe(content);
    await page.screenshot({ path: testInfo.outputPath('skill-detail-actions.png'), animations: 'disabled' });
    // Bulk reference allocation persists independently for each agent and retains other assets.
    for (const name of ['release-checklist', 'incident-triage']) {
      const response = await panel('skill/create', { user_id: nativeUser, team_id: nativeTeam,
        name, content: `---\nname: ${name}\ndescription: Bulk allocation fixture\n---\n${name}` });
      expect(response.status).toBe(200);
      extraSkills.push((await response.json()).data.skill_id);
    }
    const nativeA = (await memory(agents[0].id)).native_agent_id;
    const nativeB = (await memory(agents[1].id)).native_agent_id;
    const otherID = `chat_memory-${nativeTeam}-${nativeA}`;
    expect((await panel('meta/asset/get', { asset_id: otherID })).status).toBe(200);
    const otherBinding = { asset_id: otherID, asset_type: 'chat_memory', injection_mode: 'summary', priority: 17, created_by: nativeUser };
    for (const agent_id of [nativeA, nativeB]) {
      expect((await panel('meta/agent-fixed-asset/set', { agent_id, bindings: [otherBinding] })).status).toBe(200);
    }
    const bindings = async (agent_id: string) => (await (await panel('meta/agent-fixed-asset/list', { agent_id })).json()).data.items;
    // No skill needs to be selected before opening the manager.
    await frame.getByText('Space Assets', { exact: true }).click();
    await expect(frame.getByText(name, { exact: true })).toHaveCount(0);
    await frame.getByRole('button', { name: 'Allocate', exact: true }).click();
    const dialog = frame.locator('._skill-transfer-modal');
    const available = dialog.getByRole('region', { name: 'Available skills', exact: true });
    const assigned = dialog.getByRole('region', { name: 'Assigned skills', exact: true });
    const selectAgent = async (name: string) => {
      await dialog.locator('._skill-transfer-target .tea-dropdown').click();
      await frame.locator('._skill-transfer-agent-options [aria-selected]').getByText(name, { exact: true }).click();
      await expect(frame.locator('._skill-transfer-agent-options').first()).not.toBeVisible();
      await expect(available.locator('._skill-transfer-list')).toHaveAttribute('aria-busy', 'false');
    };
    await selectAgent('Reader A');
    await available.getByRole('checkbox', { name: 'deployment-recovery', exact: true }).check();
    await available.getByRole('checkbox', { name: 'release-checklist', exact: true }).check();
    // A rejected write keeps the batch selected and reports the error.
    await page.route('**/api/v1/meta/agent-fixed-asset/set', route => route.fulfill({
      status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Allocation temporarily unavailable' }),
    }), { times: 1 });
    await dialog.getByRole('button', { name: 'Allocate', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText(/503|unavailable/i);
    await expect(available.getByRole('checkbox', { name: 'release-checklist', exact: true })).toBeChecked();
    await dialog.getByRole('button', { name: 'Allocate', exact: true }).click();
    await expect(assigned.getByRole('checkbox', { name: name, exact: true })).toBeVisible();
    await expect(assigned.getByRole('checkbox', { name: 'release-checklist', exact: true })).toBeVisible();
    expect(await bindings(nativeA)).toEqual(expect.arrayContaining([expect.objectContaining(otherBinding),
      expect.objectContaining({ asset_id: skillID, injection_mode: 'reference', priority: 50 }),
      expect.objectContaining({ asset_id: extraSkills[0] })]));
    expect(await bindings(nativeB)).toHaveLength(1);
    // Switching agents clears selection and exposes the same team skills for shared allocation.
    await available.getByRole('checkbox', { name: 'incident-triage', exact: true }).check();
    await selectAgent('Reader B');
    await expect(dialog.getByRole('button', { name: 'Allocate', exact: true })).toBeDisabled();
    await available.getByRole('textbox').fill('release');
    await expect(available.getByRole('checkbox', { name: 'deployment-recovery', exact: true })).toHaveCount(0);
    await available.getByRole('checkbox', { name: 'Select all', exact: true }).check();
    await available.getByRole('textbox').fill('');
    await available.getByRole('checkbox', { name: 'deployment-recovery', exact: true }).check();
    await dialog.getByRole('button', { name: 'Allocate', exact: true }).click();
    await expect(assigned.getByRole('checkbox', { name: 'release-checklist', exact: true })).toBeVisible();
    await assigned.getByRole('checkbox', { name: 'Select all', exact: true }).check();
    await dialog.getByRole('button', { name: 'Unassign', exact: true }).click();
    await expect(assigned.getByText('No skills assigned')).toBeVisible();
    expect(await bindings(nativeB)).toEqual([expect.objectContaining(otherBinding)]);
    expect(await bindings(nativeA)).toHaveLength(3);
    await selectAgent('Reader A');
    // Both directions support multi-selection and keyboard activation.
    await assigned.getByRole('checkbox', { name: 'deployment-recovery', exact: true }).focus();
    await assigned.getByRole('checkbox', { name: 'deployment-recovery', exact: true }).press('Space');
    await assigned.getByRole('checkbox', { name: 'release-checklist', exact: true }).check();
    const checkbox = assigned.getByRole('checkbox', { name: 'release-checklist', exact: true });
    expect(await checkbox.evaluate(input => {
      const label = input.closest('label')!;
      const text = label.querySelector('.tea-form-check__label')!;
      const a = input.getBoundingClientRect(), b = text.getBoundingClientRect();
      return Math.abs(a.y + a.height / 2 - b.y - b.height / 2);
    })).toBeLessThan(3);
    await page.screenshot({ path: testInfo.outputPath('bulk-allocation.png'), animations: 'disabled' });
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expect.poll(() => dialog.evaluate(node => node.ownerDocument.documentElement.classList.contains('dark'))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('bulk-allocation-dark.png'), animations: 'disabled' });
    await page.evaluate(() => document.documentElement.classList.remove('dark'));
    await expect.poll(() => dialog.evaluate(node => node.ownerDocument.documentElement.classList.contains('dark'))).toBe(false);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dialog.getByRole('button', { name: 'Unassign', exact: true })).toBeInViewport();
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await available.locator('._skill-transfer-list').evaluate(node => node.getBoundingClientRect().height)).toBeLessThan(165);
    await page.screenshot({ path: testInfo.outputPath('bulk-allocation-mobile.png') });
    await dialog.getByRole('button', { name: 'Unassign', exact: true }).click();
    await expect(assigned.getByText('No skills assigned')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
    expect(await bindings(nativeA)).toEqual([expect.objectContaining(otherBinding)]);
    await page.setViewportSize({ width: 1280, height: 720 });
    // Reopening reloads persisted state. Detaching preserves assets and revokes task reads.
    await frame.getByRole('button', { name: 'Allocate', exact: true }).click();
    await expect(dialog.getByRole('region', { name: 'Assigned skills', exact: true }).getByText('No skills assigned')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
    for (const id of [skillID, ...extraSkills]) {
      expect((await panel('skill/get', { team_id: nativeTeam, skill_id: id })).status).toBe(200);
    }
    for (const token of taskTokens) {
      expect((await fetch(apiBase + `/api/knowledge/assets/${skillID}?ref=references%2Frecovery.md`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(403);
    }
    await page.goto(`/${workspace.slug}/skills/${oldID}`);
    await expect(page).toHaveURL(new RegExp(`/${workspace.slug}/knowledge\\?section=skills`));
    await page.goto(`/${workspace.slug}/agents/new/manual`);
    await expect(page.getByRole('button', { name: /Add skill|添加 skill/i })).toHaveCount(0);
    await page.goto(`/${workspace.slug}/agents/${agents[0].id}?view=instructions`);
    await expect(page.getByRole('tab', { name: /^Skills$|^技能$/ })).toHaveCount(0);
  } finally {
    await call(`/api/workspaces/${workspace.id}`, 'DELETE');
    if (nativeTeam) {
      for (const nativeSkillID of [nativeSkill, forkedSkill, ...extraSkills].filter(Boolean)) {
        const removed = await fetch(process.env.MULTICA_AGENT_MEMORY_CORE_URL + '/v3/skill/delete', {
          method: 'POST', headers: { Authorization: 'Bearer ' + process.env.MULTICA_AGENT_MEMORY_API_KEY,
            'Content-Type': 'application/json', 'X-Tdai-Service-Id': process.env.MULTICA_AGENT_MEMORY_INSTANCE_ID || 'default' },
          body: JSON.stringify({ team_id: nativeTeam, skill_id: nativeSkillID }),
        });
        expect(removed.status).toBe(200);
      }
      const native = async (action: string, body: unknown) => {
        const response = await fetch(process.env.MULTICA_AGENT_MEMORY_CORE_URL + '/v3/meta/' + action, {
          method: 'POST', headers: { Authorization: 'Bearer ' + process.env.MULTICA_AGENT_MEMORY_API_KEY,
            'Content-Type': 'application/json', 'X-Tdai-Service-Id': process.env.MULTICA_AGENT_MEMORY_INSTANCE_ID || 'default',
            'X-Tdai-User-Key': process.env.MULTICA_AGENT_MEMORY_ADMIN_KEY! }, body: JSON.stringify(body),
        });
        expect(response.status).toBe(200);
        return (await response.json()).data;
      };
      const admin = await native('auth/verify', { user_key: process.env.MULTICA_AGENT_MEMORY_ADMIN_KEY });
      await native('team/managed-owner', { team_id: nativeTeam, user_id: admin.user.user_id });
      await native('team/delete', { team_ids: [nativeTeam] });
    }
    await db.end();
    await rm(directory, { recursive: true, force: true });
  }
});
