import {test,expect} from '@playwright/test';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {TestApiClient} from './fixtures';
const base=process.env.NEXT_PUBLIC_API_URL||`http://localhost:${process.env.PORT||8080}`;
test.skip(!process.env.MULTICA_AGENT_MEMORY_CORE_URL||!process.env.MULTICA_AGENT_MEMORY_PROXY_URL,'Requires native Memory');

test('original injectors expose only current bindings and preserve private/shared Memory scopes',async()=>{
 test.setTimeout(90000);
 const api=new TestApiClient(),admin=new TestApiClient(),suffix=randomUUID();
 await api.login(`context-${suffix}@localhost`,'Context owner');
 const ws=await api.ensureWorkspace('Native context',`context-${suffix}`);
 await admin.login(`context-admin-${suffix}@localhost`,'Context administrator');
 const adminID=await api.addWorkspaceMember(`context-admin-${suffix}@localhost`,'admin');
 admin.setWorkspaceId(ws.id);admin.setWorkspaceSlug(ws.slug);
 const adminHeaders={Authorization:`Bearer ${admin.getToken()}`,'X-Workspace-ID':ws.id,'Content-Type':'application/json'};
 const headers={Authorization:`Bearer ${api.getToken()}`,'X-Workspace-ID':ws.id,'Content-Type':'application/json'};
 const call=(path:string,method='GET',body?:unknown)=>fetch(base+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
 const db=new pg.Client(process.env.DATABASE_URL);await db.connect();
 let panel:((path:string,body:unknown)=>Promise<any>)|undefined,skill:string|undefined,team:string|undefined;
 try{
  const a=await api.createAgent('Writer'),b=await api.createAgent('Reader');
  const state=async(id:string)=>(await(await call(`/api/agents/${id}/memory`)).json()).binding;
  await expect.poll(async()=>(await state(a.id))?.status,{timeout:45000}).toBe('ready');
  await expect.poll(async()=>(await state(b.id))?.status,{timeout:45000}).toBe('ready');
  const memory=await state(a.id);
  const binding=(await(await call('/api/knowledge')).json()).binding;team=binding.team_id;
  const session=await(await call('/api/knowledge/panel-session','POST',{})).json();
  const ticket=new URLSearchParams(session.url.split('#')[1]).get('session')!;
  const root=`${base}/api/knowledge-panel/${ws.id}/`;
  const panelHeaders={'Content-Type':'application/json','X-Multica-Knowledge-Session':ticket};
  const boot=await(await fetch(root+'bootstrap',{headers:panelHeaders})).json(),user=boot.session.user.user_id;
  panel=async(path,body)=>{const r=await fetch(root+'api/v1/'+path,{method:'POST',headers:panelHeaders,body:JSON.stringify(body)});expect(r.status,await r.clone().text()).toBe(200);const env=await r.json();expect(env.code).toBe(0);return env.data;};
  const asset=`chat_memory-${team}-${memory.native_agent_id}`;
  await panel('meta/asset/update',{asset_id:asset,name:'Private profile',visibility:'private',status:'approved'});
  skill=(await panel('skill/create',{team_id:team,user_id:user,name:`team-runbook-${suffix}`,content:`---\nname: team-runbook-${suffix}\ndescription: Scoped team runbook\n---\n\nFULL-BODY-MUST-NOT-BE-PRELOADED`})).skill_id;
  await panel('meta/agent-fixed-asset/set',{agent_id:memory.native_agent_id,bindings:[{asset_id:asset,asset_type:'chat_memory',injection_mode:'summary',priority:50,created_by:user},{asset_id:skill,asset_type:'skill',injection_mode:'reference',priority:50,created_by:user}]});
  const marker=`L3-PRIVATE-${suffix}`;
  const written=await fetch(process.env.MULTICA_AGENT_MEMORY_CORE_URL+'/v3/core/write',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.MULTICA_AGENT_MEMORY_API_KEY,'X-Tdai-Service-Id':binding.instance_id},body:JSON.stringify({team_id:team,user_id:user,agent_id:memory.native_agent_id,content:`# Long-term memory\n\n${marker}\nAlways verify persisted tenant scope.`})});
  expect(written.status,await written.clone().text()).toBe(200);expect((await written.json()).code).toBe(0);
  const issue=await api.createIssue('Context permission fixture');
  const claim=async(agent:any)=>{
   await db.query("INSERT INTO agent_task_queue(agent_id,issue_id,runtime_id,status) VALUES($1,$2,$3,'queued')",[agent.id,issue.id,agent.runtime_id]);
   const r=await call(`/api/daemon/runtimes/${agent.runtime_id}/tasks/claim`,'POST',{});expect(r.status).toBe(200);
   const t=(await r.json()).task;expect(t).toBeTruthy();
   await db.query("UPDATE agent_task_queue SET status='completed' WHERE id=$1",[t.id]);return t;
  };
  const own=await claim(a);expect(own.knowledge_context).toContain(marker);expect(own.knowledge_context).toContain(skill);
  expect(own.knowledge_context).toContain('tdai-profile-memory-injector');expect(own.knowledge_context).toContain('skill-injector');
  expect(own.knowledge_context).not.toContain('FULL-BODY-MUST-NOT-BE-PRELOADED');
  expect(own.knowledge_context).not.toContain('/memory-bridge');expect(own.knowledge_context).not.toContain('127.0.0.1');
  const isolated=await claim(b);expect(isolated.knowledge_context||'').not.toContain(marker);
  expect((await call(`/api/agents/${b.id}/memory`,'PUT',{memory_id:memory.id})).status).toBe(200);
  const shared=await claim(b);expect(shared.knowledge_context).toContain(marker);expect(shared.knowledge_context).toContain(skill);expect(shared.knowledge_scope).toBe(own.knowledge_scope);
  expect((await call(`/api/agents/${b.id}/memory`,'PUT',{memory_id:null})).status).toBe(200);
  const detached=await claim(b);expect(detached.knowledge_scope).toBe('unbound');expect(detached.knowledge_context||'').not.toContain(marker);
  for(const token of ['',api.getToken(),own.auth_token]){
   const denied=await fetch(process.env.MULTICA_AGENT_MEMORY_PROXY_URL+'/v3/multica/context',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:'{}'});expect(denied.status).toBe(401);
  }
  expect(Number((await db.query('SELECT count(*) FROM knowledge_extraction WHERE workspace_id=$1',[ws.id])).rows[0].count)).toBe(0);
  const taskHeaders={Authorization:'Bearer '+own.auth_token,'X-Workspace-ID':ws.id};
  const members=await(await call(`/api/workspaces/${ws.id}/members`)).json();
  const old=members.find((m:any)=>m.role==='owner'),next=members.find((m:any)=>m.user_id===adminID);
  expect((await call(`/api/workspaces/${ws.id}/members/${next.id}`,'PATCH',{role:'owner'})).status).toBe(200);
  const adminCall=(path:string,method:string,body?:unknown)=>fetch(base+path,{method,headers:adminHeaders,...(body===undefined?{}:{body:JSON.stringify(body)})});
  expect((await adminCall(`/api/workspaces/${ws.id}/members/${old.id}`,'PATCH',{role:'member'})).status).toBe(200);
  expect((await fetch(base+`/api/knowledge/assets/${asset}?layer=L3`,{headers:taskHeaders})).status).toBe(200);
  expect((await adminCall(`/api/workspaces/${ws.id}/members/${old.id}`,'DELETE')).status).toBe(204);
  expect([401,403,404]).toContain((await fetch(base+`/api/knowledge/assets/${asset}?layer=L3`,{headers:taskHeaders})).status);
  expect((await call(`/api/daemon/runtimes/${a.runtime_id}/tasks/claim`,'POST',{})).status).not.toBe(200);

 }finally{
  // The remaining owner cleans up after the original creator is removed.
  const removed=await fetch(base+`/api/workspaces/${ws.id}`,{method:'DELETE',headers:adminHeaders});
  if(!removed.ok)await call(`/api/workspaces/${ws.id}`,'DELETE');
  if(team){
   const native=async(action:string,body:unknown)=>{
    const r=await fetch(process.env.MULTICA_AGENT_MEMORY_CORE_URL+'/v3/meta/'+action,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.MULTICA_AGENT_MEMORY_API_KEY,'X-Tdai-Service-Id':process.env.MULTICA_AGENT_MEMORY_INSTANCE_ID||'default','X-Tdai-User-Key':process.env.MULTICA_AGENT_MEMORY_ADMIN_KEY!},body:JSON.stringify(body)});
    return(await r.json()).data;
   };
   const provisioner=await native('auth/verify',{user_key:process.env.MULTICA_AGENT_MEMORY_ADMIN_KEY});
   await native('team/managed-owner',{team_id:team,user_id:provisioner.user.user_id});await native('team/delete',{team_ids:[team]});
  }
  await db.end();
 }
});
