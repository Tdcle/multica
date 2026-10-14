import { test, expect } from '@playwright/test';
import pg from 'pg';
import { TestApiClient } from './fixtures';

const base=process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.PORT || 8080}`;
test.skip(!process.env.MULTICA_AGENT_MEMORY_CORE_URL,'Requires native Memory services');

test('Multica owns Memory identity, shared binding and live membership permissions',async({page})=>{
 test.setTimeout(120000);
 const suffix=`${Date.now()}-${process.pid}`;
 const owner=new TestApiClient(),admin=new TestApiClient();
 await owner.login(`memory-access-owner-${suffix}@localhost`,'记忆所有者');
 const adminEmail=`memory-access-admin-${suffix}@localhost`;
 await admin.login(adminEmail,'团队管理员');
 const workspace=await owner.ensureWorkspace('Memory access',`memory-access-${suffix}`);
 const adminID=await owner.addWorkspaceMember(adminEmail,'admin');
 admin.setWorkspaceId(workspace.id);admin.setWorkspaceSlug(workspace.slug);
 const headers=(api:TestApiClient)=>({Authorization:`Bearer ${api.getToken()}`,'X-Workspace-ID':workspace.id,'Content-Type':'application/json'});
 const call=(api:TestApiClient,path:string,method='GET',body?:unknown)=>fetch(base+path,{method,headers:headers(api),...(body===undefined?{}:{body:JSON.stringify(body)})});
 const state=async(id:string)=>{const r=await call(owner,`/api/agents/${id}/memory`);expect(r.status).toBe(200);return (await r.json()).binding;};
 const native=async(path:string,body:unknown,key=process.env.MULTICA_AGENT_MEMORY_ADMIN_KEY!)=>fetch(process.env.MULTICA_AGENT_MEMORY_CORE_URL+'/v3/meta/'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.MULTICA_AGENT_MEMORY_API_KEY,'X-Tdai-Service-Id':process.env.MULTICA_AGENT_MEMORY_INSTANCE_ID || 'default','X-Tdai-User-Key':key},body:JSON.stringify(body)});
 let keyID:string|undefined,ownerNativeKey:string|undefined;
 const db=new pg.Client(process.env.DATABASE_URL);await db.connect();
 try {
  const a=await owner.createAgent('Shared writer'),b=await owner.createAgent('Shared reader');
  await expect.poll(async()=>(await state(a.id))?.status,{timeout:45000}).toBe('ready');
  await expect.poll(async()=>(await state(b.id))?.status,{timeout:45000}).toBe('ready');
  const memory=await state(a.id);
  const bound=await call(owner,`/api/agents/${b.id}/memory`,'PUT',{memory_id:memory.id});expect(bound.status).toBe(200);
  expect((await state(b.id)).native_agent_id).toBe(memory.native_agent_id);
  const adminAgent=await admin.createAgent('Admin private agent');
  const stolen=await call(admin,`/api/agents/${adminAgent.id}/memory`,'PUT',{memory_id:memory.id});
  expect(stolen.status).toBe(403);
  const session=await call(owner,'/api/knowledge/panel-session','POST');expect(session.status).toBe(200);
  const ticket=new URLSearchParams((await session.json()).url.split('#')[1]).get('session')!;
  const panelRoot=`${base}/api/knowledge-panel/${workspace.id}/`;
  const panelHeaders={'Content-Type':'application/json','X-Multica-Knowledge-Session':ticket};
  const panel=(path:string,body:unknown={})=>fetch(panelRoot+'api/v1/'+path,{method:'POST',headers:panelHeaders,body:JSON.stringify(body)});
  const boot=await fetch(panelRoot+'bootstrap',{headers:panelHeaders});expect(boot.status).toBe(200);
  const identity=await boot.json();const nativeID=identity.session.user.user_id;
  const bindingResponse=await call(owner,'/api/knowledge');const binding=(await bindingResponse.json()).binding;
  // Privileged fixture access is confined to this test user's account.
  const issued=await native('user-key/create',{user_id:nativeID,name:'Temporary permission fixture'});
  expect(issued.status).toBe(200);const key=(await issued.json()).data;keyID=key.key_id;ownerNativeKey=key.key_value;
  for(const [path,body] of [
   ['meta/user-key/list',{}],['meta/user-key/create',{name:'Bypass'}],['meta/user-key/revoke',{key_id:keyID}],
   ['meta/user/create',{username:'bypass'}],['meta/user/bind-external',{user_id:nativeID,external_id:'bypass'}],
   ['meta/team/create',{name:'Bypass',owner_user_id:nativeID}],['meta/team/update',{team_id:binding.team_id,name:'Bypass'}],
   ['meta/team/managed-owner',{team_id:binding.team_id,user_id:nativeID}],
   ['meta/team-member/add',{team_id:binding.team_id,user_id:nativeID}],['meta/team-member/remove',{team_id:binding.team_id,user_id:nativeID}],
  ] as [string,unknown][]){const denied=await panel(path,body);expect(denied.status,path).toBe(403);}
  for(const [path,body] of [
   ['user-key/create',{name:'Native bypass'}],
   ['team/update',{team_id:binding.team_id,name:'Native bypass'}],
   ['team-member/add',{team_id:binding.team_id,user_id:nativeID}],
  ] as [string,unknown][]) expect((await native(path,body,ownerNativeKey)).status,path).toBe(403);
  const rawTransfer=await native('team/managed-owner',{team_id:binding.team_id,user_id:nativeID},ownerNativeKey);
  expect(rawTransfer.status).toBe(403);
  let directory=await(await panel('meta/team-member/list',{team_id:binding.team_id})).json();
  expect(directory.data.items.map((u:{username:string})=>u.username).sort()).toEqual(['记忆所有者','团队管理员'].sort());
  expect(directory.data.total).toBe(2); // Internal service identity is not a human member.
  const renamed=await call(owner,'/api/me','PATCH',{name:'新的记忆姓名'});expect(renamed.status).toBe(200);
  const nativeProfile=await panel('meta/user/get',{user_id:nativeID});expect(nativeProfile.status).toBe(200);
  expect((await nativeProfile.json()).data.username).toBe('新的记忆姓名');
  const persisted=await native('user/get',{user_id:nativeID},ownerNativeKey);expect(persisted.status).toBe(200);
  expect((await persisted.json()).data.display_name).toBe('新的记忆姓名');
  // Exercise the real, isolated iframe, including entry-point hiding.
  await owner.markUserOnboarded();
  await page.addInitScript(token=>{if(window.self!==window.top)return;localStorage.setItem('multica_token',token);localStorage.setItem('multica:chat:isOpen','false');},owner.getToken()!);
  await page.goto(`/${workspace.slug}/knowledge`);
  const frame=page.frameLocator('iframe');
  await expect(frame.locator('._memory-app-shell')).toBeVisible();
  const skip=frame.getByRole('button',{name:/^Skip$|跳过/});await expect(skip).toBeVisible();await skip.click();
  await expect(frame.getByText('API Key',{exact:true})).toHaveCount(0);
  await frame.locator('._memory-app-shell').getByText(/^(Members|成员管理)$/).first().click();
  await expect(frame.getByText(/Members and permissions are managed in Multica|成员与权限由 Multica/)).toBeVisible();
  await expect(frame.locator('._memory-member-card').filter({hasText:'新的记忆姓名'})).toBeVisible();
  await expect(frame.locator('[data-guide="add-member"]')).toHaveCount(0);
  await expect(frame.locator('._memory-member-remove-btn')).toHaveCount(0);
  // Claim a real queued task through the daemon API; no model is invoked.
  const issue=await owner.createIssue('Memory permission credential');
  await db.query("INSERT INTO agent_task_queue (agent_id,issue_id,runtime_id,status) VALUES ($1,$2,$3,'queued')",[b.id,issue.id,b.runtime_id]);
  const claim=await call(owner,`/api/daemon/runtimes/${b.runtime_id}/tasks/claim`,'POST');
  expect(claim.status,await claim.clone().text()).toBe(200);
  const task=(await claim.json()).task;expect(task?.auth_token).toMatch(/^mat_/);
  const taskToken=task.auth_token;
  const taskHeaders={Authorization:'Bearer '+taskToken,'X-Workspace-ID':workspace.id};
  expect((await fetch(base+'/api/knowledge/assets',{headers:taskHeaders})).status).toBe(200);
  const members=await(await call(owner,`/api/workspaces/${workspace.id}/members`)).json();
  const oldMember=members.find((m:{role:string})=>m.role==='owner');const next=members.find((m:{user_id:string})=>m.user_id===adminID);
  expect((await call(owner,`/api/workspaces/${workspace.id}/members/${next.id}`,'PATCH',{role:'owner'})).status).toBe(200);
  expect((await call(admin,`/api/workspaces/${workspace.id}/members/${oldMember.id}`,'PATCH',{role:'member'})).status).toBe(200);
  // Check the actual native role, not just the gateway's display model.
  const nativeRole=await native('team-member/get',{team_id:binding.team_id,user_id:nativeID},ownerNativeKey);
  expect(nativeRole.status).toBe(200);expect((await nativeRole.json()).data.role).toBe('member');
  const downgraded=await fetch(panelRoot+'bootstrap',{headers:panelHeaders});expect(downgraded.status).toBe(200);expect((await downgraded.json()).can_manage_space).toBe(false);
  expect((await panel('meta/team-member/add',{team_id:binding.team_id,user_id:nativeID})).status).toBe(403);
  expect((await fetch(base+'/api/knowledge/assets',{headers:taskHeaders})).status).toBe(200);
  expect((await call(admin,`/api/workspaces/${workspace.id}/members/${oldMember.id}`,'DELETE')).status).toBe(204);
  expect((await fetch(panelRoot+'bootstrap',{headers:panelHeaders})).status).toBe(401);
  expect([401,403,404]).toContain((await fetch(base+'/api/knowledge/assets',{headers:taskHeaders})).status);
  expect((await call(owner,'/api/memories')).status).toBe(404);
  const nativeRemoved=await native('team-member/list',{team_id:binding.team_id},ownerNativeKey);expect(nativeRemoved.status).toBe(403);
  // Removing the original creator leaves the internal service and remaining members operational.
  expect((await call(admin,'/api/knowledge/assets')).status).toBe(200);
  const remainingSession=await call(admin,'/api/knowledge/panel-session','POST');expect(remainingSession.status).toBe(200);
  const remainingTicket=new URLSearchParams((await remainingSession.json()).url.split('#')[1]).get('session')!;
  const remaining=await fetch(panelRoot+'api/v1/meta/team-member/list',{method:'POST',headers:{...panelHeaders,'X-Multica-Knowledge-Session':remainingTicket},body:JSON.stringify({team_id:binding.team_id})});
  expect(remaining.status).toBe(200);directory=await remaining.json();expect(directory.data.items.map((u:{username:string})=>u.username)).toEqual(['团队管理员']);
 }finally{
  if(keyID)await native('user-key/revoke',{key_id:keyID});
  await db.query('DELETE FROM task_token WHERE workspace_id=$1',[workspace.id]);await db.end();
  const cleanup=await call(admin,`/api/workspaces/${workspace.id}`,'DELETE');
  if(cleanup.status!==204)await call(owner,`/api/workspaces/${workspace.id}`,'DELETE');
 }
});
