import {test,expect} from '@playwright/test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {TestApiClient} from './fixtures';

const execute=promisify(execFile);
const apiBase=process.env.NEXT_PUBLIC_API_URL||`http://localhost:${process.env.PORT||'8080'}`;
test.skip(!process.env.MULTICA_AGENT_MEMORY_CORE_URL||!process.env.MULTICA_KNOWLEDGE_CLI_PATH,'Requires native services and the built CLI');

test('installed CLI lists assets, searches and reads native Skill content',async()=>{
 const api=new TestApiClient();
 const suffix=`${Date.now()}-${process.pid}`;
 await api.login(`knowledge-cli-${suffix}@multica.ai`,'Knowledge CLI');
 const workspace=await api.ensureWorkspace('Knowledge CLI',`knowledge-cli-${suffix}`);
 const headers={Authorization:`Bearer ${api.getToken()}`,'Content-Type':'application/json','X-Workspace-ID':workspace.id};
 const bound=await fetch(apiBase+'/api/knowledge/binding',{method:'POST',headers,body:JSON.stringify({name:`CLI ${suffix}`})});
 expect(bound.status).toBe(201);
 const binding=await bound.json();
 const session=await fetch(apiBase+'/api/knowledge/panel-session',{method:'POST',headers});
 expect(session.status).toBe(200);
 const ticket=new URLSearchParams((await session.json()).url.split('#')[1]).get('session')!;
 const root=`${apiBase}/api/knowledge-panel/${workspace.id}/`;
 const panelHeaders={'Content-Type':'application/json','X-Multica-Knowledge-Session':ticket};
 const identity=await(await fetch(root+'bootstrap',{headers:panelHeaders})).json();
 const scope={team_id:binding.team_id,user_id:identity.session.user.user_id,agent_id:binding.memory_agent_id};
 const panel=(path:string,body:unknown)=>fetch(root+'api/v1/'+path,{method:'POST',headers:panelHeaders,body:JSON.stringify(body)});
 const env={...process.env,MULTICA_SERVER_URL:apiBase,MULTICA_WORKSPACE_ID:workspace.id,MULTICA_TOKEN:api.getToken()!};
 const cli=async(...args:string[])=>JSON.parse((await execute(process.env.MULTICA_KNOWLEDGE_CLI_PATH!,['knowledge',...args],{env,timeout:30_000,maxBuffer:2*1024*1024})).stdout);
 let skillID:string|undefined;
 try {
  const name=`cli-evidence-${suffix}`;
  const created=await panel('skill/create',{...scope,name,content:`---\nname: ${name}\ndescription: CLI smoke evidence\n---\n\nRead marker: installed-orchard-4137.`});
  expect(created.status).toBe(200);
  skillID=(await created.json()).data.skill_id;
  const list=await cli('list','--limit','100');
  expect(list.items.some((item:{asset_id:string})=>item.asset_id===skillID)).toBe(true);
  const hits=await cli('search','installed-orchard-4137','--type','skill');
  expect(hits.warnings).toEqual([]);
  expect(hits.items.some((item:{asset_id:string})=>item.asset_id===skillID)).toBe(true);
  const read=await cli('read',skillID!);
  expect(JSON.stringify(read)).toContain('installed-orchard-4137');
  const empty=await cli('list','--offset','100');
  expect(empty.items).toEqual([]);
 } finally {
  if(skillID)await panel('skill/delete',{...scope,skill_id:skillID});
  await fetch(apiBase+'/api/knowledge/binding',{method:'DELETE',headers});
  await fetch(`${apiBase}/api/workspaces/${workspace.id}`,{method:'DELETE',headers});
 }
});
