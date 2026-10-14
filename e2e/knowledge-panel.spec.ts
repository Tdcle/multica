import {test,expect} from '@playwright/test';
import {TestApiClient} from './fixtures';
const apiBase=process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.PORT || '8080'}`;
test.skip(!process.env.MULTICA_AGENT_MEMORY_CORE_URL || !process.env.MULTICA_AGENT_MEMORY_PANEL_URL || !process.env.MULTICA_AGENT_MEMORY_KNOWLEDGE_URL,'Requires the separately deployed native memory services');

test('original knowledge panel opens with the workspace identity and all knowledge pages',async({page})=>{
 const api=new TestApiClient();
 const suffix=`${Date.now()}-${process.pid}`;
 await api.login(`knowledge-panel-${suffix}@multica.ai`,'Knowledge panel');
 const workspace=await api.ensureWorkspace('Knowledge panel',`knowledge-panel-${suffix}`);
 await api.markUserOnboarded();
 const headers={Authorization:`Bearer ${api.getToken()}`,'X-Workspace-ID':workspace.id,'Content-Type':'application/json'};
 const created=await fetch(`${apiBase}/api/knowledge/binding`,{method:'POST',headers,body:JSON.stringify({name:`Panel ${suffix}`})});
 expect(created.status,await created.clone().text()).toBe(201);
 const errors:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(token=>{if(window.self!==window.top)return;localStorage.setItem('multica_token',token);localStorage.setItem('multica:chat:isOpen','false')},api.getToken()!);
 try {
  await page.goto(`/${workspace.slug}/knowledge`);
  const frame=page.frameLocator('iframe');
  await expect(frame.locator('._memory-app-shell')).toBeVisible();
  await expect(frame.getByText(/Unexpected Application Error|404 Not Found/)).not.toBeVisible();
  await expect(frame.getByText(`Panel ${suffix}`,{exact:true}).first()).toBeVisible();
  const skip = frame.getByRole('button', {name:/^Skip$|跳过/});
  if (await skip.isVisible()) await skip.click();
  for (const name of ['Wiki Knowledge Base','Code_Graph','Skills','Chat_Memory']) {
   const item=frame.locator('._memory-app-shell').getByText(name,{exact:true}).first();
   await expect(item).toBeVisible();
   await item.click();
   await expect(frame.locator('._memory-page-frame')).toBeVisible();
   if(name==='Wiki Knowledge Base') {
    await frame.getByText('Team Wiki Pool',{exact:true}).click();
    await expect(frame.locator('[data-guide="create-wiki"]')).toBeVisible();
   }
  }
  await frame.locator('._memory-team-switcher-trigger').click();
  await expect(frame.locator('._memory-team-switcher-create-form')).not.toBeVisible();
  await expect(frame.locator('._memory-team-switcher-panel').getByText(/^Create Team$|^新建团队$/)).not.toBeVisible();
  await frame.locator('body').evaluate(body=>body.setAttribute('data-panel-retained','yes'));
  await page.getByRole('tab',{name:'Extraction history'}).click();
  await expect(page.locator('iframe')).not.toBeVisible();
  await page.getByRole('tab',{name:'Knowledge space'}).click();
  await expect(frame.locator('body')).toHaveAttribute('data-panel-retained','yes');
  await page.getByRole('button',{name:'Reload panel'}).click();
  await expect(frame.locator('._memory-app-shell')).toBeVisible();
  await expect(frame.locator('body')).not.toHaveAttribute('data-panel-retained','yes');
  expect(errors).toEqual([]);
 } finally {
  await fetch(`${apiBase}/api/knowledge/binding`,{method:'DELETE',headers});
  await fetch(`${apiBase}/api/workspaces/${workspace.id}`,{method:'DELETE',headers});
 }
});

test('panel capabilities reject other workspaces, foreign resource IDs and stale bindings',async()=>{
 const api=new TestApiClient();
 const suffix=`${Date.now()}-${process.pid}`;
 await api.login(`knowledge-panel-scope-${suffix}@multica.ai`,'Knowledge panel scope');
 const alpha=await api.ensureWorkspace('Panel Alpha',`panel-alpha-${suffix}`);
 const auth={Authorization:`Bearer ${api.getToken()}`,'Content-Type':'application/json'};
 const betaResponse=await fetch(`${apiBase}/api/workspaces`,{method:'POST',headers:auth,body:JSON.stringify({name:'Panel Beta',slug:`panel-beta-${suffix}`})});
 expect(betaResponse.status).toBe(201);
 const beta=await betaResponse.json();
 const scoped=(id:string)=>({...auth,'X-Workspace-ID':id});
 const bind=async(id:string,name:string)=>{
  const response=await fetch(`${apiBase}/api/knowledge/binding`,{method:'POST',headers:scoped(id),body:JSON.stringify({name})});
  expect(response.status,await response.clone().text()).toBe(201);
  return response.json();
 };
 const a=await bind(alpha.id,`Panel Alpha ${suffix}`);
 const b=await bind(beta.id,`Panel Beta ${suffix}`);
 try {
  const response=await fetch(`${apiBase}/api/knowledge/panel-session`,{method:'POST',headers:scoped(alpha.id)});
  expect(response.status).toBe(200);
  const session=await response.json();
  const ticket=new URLSearchParams(session.url.split('#')[1]).get('session')!;
  const root=`${apiBase}/api/knowledge-panel/${alpha.id}/`;
  const headers={'X-Multica-Knowledge-Session':ticket,'Content-Type':'application/json',Origin:'null'};
  const request=(path:string,body:unknown)=>fetch(root+`api/v1/${path}`,{method:'POST',headers,body:JSON.stringify(body)});
  const bootstrap=await fetch(root+'bootstrap',{headers});
  expect(bootstrap.status).toBe(200);
  const identity=await bootstrap.json();
  expect(identity.team_id).toBe(a.team_id);
  expect(identity.session.userKey).toBe('multica-panel');
  const betaSessionResponse=await fetch(`${apiBase}/api/knowledge/panel-session`,{method:'POST',headers:scoped(beta.id)});
  expect(betaSessionResponse.status).toBe(200);
  const betaSession=await betaSessionResponse.json();
  const betaTicket=new URLSearchParams(betaSession.url.split('#')[1]).get('session')!;
  const betaRequest=(path:string,body:unknown)=>fetch(`${apiBase}/api/knowledge-panel/${beta.id}/api/v1/${path}`,{method:'POST',headers:{...headers,'X-Multica-Knowledge-Session':betaTicket},body:JSON.stringify(body)});
  const teams=await request('meta/team/list',{});
  expect(teams.status).toBe(200);
  expect((await teams.json()).data.items.map((team:{team_id:string})=>team.team_id)).toEqual([a.team_id]);
  const emptyBody=await fetch(root+'api/v1/meta/team/list',{method:'POST',headers});
  expect(emptyBody.status).toBe(200);
  const nullBody=await fetch(root+'api/v1/meta/team/list',{method:'POST',headers,body:'null'});
  expect(nullBody.status).toBe(400);
  const foreignTeam=await request('meta/agent/list',{team_id:b.team_id});
  expect(foreignTeam.status).toBe(403);
  const foreignAgent=await request('meta/agent/get',{agent_id:b.memory_agent_id});
  expect(foreignAgent.status).toBe(403);
  const foreignAsset=await request('meta/asset/get',{asset_id:`chat_memory-${b.team_id}-${b.memory_agent_id}`});
  expect(foreignAsset.status).toBe(403);
  const foreignMemory=await request('chat-memory/search',{block_id:`chat_memory-${b.team_id}-${b.memory_agent_id}`,query:'workspace'});
  expect(foreignMemory.status).toBe(403);
  const foreignUnifiedRead=await fetch(`${apiBase}/api/knowledge/assets/chat_memory-${b.team_id}-${b.memory_agent_id}`,{headers:scoped(alpha.id)});
  expect(foreignUnifiedRead.status).toBe(403);
  const unifiedAssets=await fetch(`${apiBase}/api/knowledge/assets`,{headers:scoped(alpha.id)});
  expect(unifiedAssets.status).toBe(200);
  expect((await unifiedAssets.json()).items.every((asset:{team_id:string})=>asset.team_id===a.team_id)).toBe(true);
  const granted=await betaRequest('meta/acl/grant',{asset_id:`chat_memory-${b.team_id}-${b.memory_agent_id}`,subject_type:'user',subject_id:identity.session.user.user_id,permission:'read',effect:'allow',granted_by:identity.session.user.user_id});
  expect(granted.status,await granted.clone().text()).toBe(200);
  const acl=(await granted.json()).data;
  expect(acl.id).toBeTruthy();
  const foreignRevoke=await request('meta/acl/revoke',{id:acl.id});
  expect(foreignRevoke.status).toBe(403);
  const revoked=await betaRequest('meta/acl/revoke',{id:acl.id});
  expect(revoked.status,await revoked.clone().text()).toBe(200);
  const wrongRoute=await fetch(`${apiBase}/api/knowledge-panel/${beta.id}/bootstrap`,{headers});
  expect(wrongRoute.status).toBe(401);
  const forged=await fetch(root+'bootstrap',{headers:{...headers,'X-Multica-Knowledge-Session':ticket.slice(0,-12)+'not-a-ticket'}});
  expect(forged.status).toBe(401);
  const preflight=await fetch(root+'bootstrap',{method:'OPTIONS',headers:{Origin:'null','Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'x-multica-knowledge-session'}});
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-origin')).toBe('null');
  const detached=await fetch(`${apiBase}/api/knowledge/binding`,{method:'DELETE',headers:scoped(alpha.id)});
  expect(detached.status).toBe(204);
  const stale=await fetch(root+'bootstrap',{headers});
  expect(stale.status).toBe(401);
 } finally {
  await fetch(`${apiBase}/api/knowledge/binding`,{method:'DELETE',headers:scoped(alpha.id)});
  await fetch(`${apiBase}/api/knowledge/binding`,{method:'DELETE',headers:scoped(beta.id)});
  await fetch(`${apiBase}/api/workspaces/${alpha.id}`,{method:'DELETE',headers:auth});
  await fetch(`${apiBase}/api/workspaces/${beta.id}`,{method:'DELETE',headers:auth});
 }
});

test('native Wiki can be created, populated, read and removed through the scoped panel',async()=>{
 test.setTimeout(300_000);
 const api=new TestApiClient();
 const suffix=`${Date.now()}-${process.pid}`;
 await api.login(`knowledge-wiki-${suffix}@multica.ai`,'Knowledge Wiki');
 const workspace=await api.ensureWorkspace('Knowledge Wiki',`knowledge-wiki-${suffix}`);
 const auth={Authorization:`Bearer ${api.getToken()}`,'X-Workspace-ID':workspace.id,'Content-Type':'application/json'};
 const created=await fetch(`${apiBase}/api/knowledge/binding`,{method:'POST',headers:auth,body:JSON.stringify({name:`Wiki ${suffix}`})});
 expect(created.status,await created.clone().text()).toBe(201);
 const binding=await created.json();
 const sessionResponse=await fetch(`${apiBase}/api/knowledge/panel-session`,{method:'POST',headers:auth});
 expect(sessionResponse.status).toBe(200);
 const session=await sessionResponse.json();
 const token=new URLSearchParams(session.url.split('#')[1]).get('session')!;
 const headers={'X-Multica-Knowledge-Session':token,'Content-Type':'application/json'};
 const root=`${apiBase}/api/knowledge-panel/${workspace.id}/api/v1/knowledge/wiki/`;
 const request=async(path:string,body:unknown)=>{
  const response=await fetch(root+path,{method:'POST',headers,body:JSON.stringify(body)});
  const text=await response.text();
  expect(response.status,text).toBe(200);
  const envelope=JSON.parse(text);
  expect(envelope.code,text).toBe(0);
  return envelope.data;
 };
 let wikiID:string|undefined;
 try {
  const wiki=await request('create',{team_id:binding.team_id,name:`Workspace decisions ${suffix}`});
  wikiID=wiki.wiki_id;
  expect(wikiID).toBeTruthy();
  await request('raw/write',{team_id:binding.team_id,wiki_id:wikiID,files:[{filename:'decisions.md',content:'# Workspace decisions\n\nKnowledge requests derive scope from the persisted workspace binding. An agent cannot supply an arbitrary team ID. Marker: amber-wiki-5724.'}]});
  const files=await request('raw/ls',{wiki_id:wikiID});
  expect(files.items.some((file:{filename:string})=>file.filename==='decisions.md')).toBe(true);
  const raw=await request('raw/read',{wiki_id:wikiID,filenames:['decisions.md']});
  expect(JSON.stringify(raw)).toContain('amber-wiki-5724');
  const detail=await request('get',{wiki_id:wikiID});
  expect(detail.wiki_id).toBe(wikiID);
  if(process.env.MULTICA_RUN_REAL_AGENT_SMOKE==='1') {
   await request('ingest',{wiki_id:wikiID});
   await expect.poll(async()=>{
    const status=await request('get',{wiki_id:wikiID});
    expect(status.status,JSON.stringify(status)).not.toBe('failed');
    return status.status;
   },{timeout:240_000,intervals:[1000,3000,5000]}).toBe('ready');
   const pages=await request('page/ls',{wiki_id:wikiID});
   expect(pages.items.length).toBeGreaterThan(0);
   const compiled=await request('page/read',{wiki_id:wikiID,refs:pages.items.map((item:{path:string})=>item.path)});
   expect(JSON.stringify(compiled)).toContain('amber-wiki-5724');
   const search=await request('search',{wiki_id:wikiID,query:'amber-wiki-5724',limit:10});
   expect(search.results.length,JSON.stringify(search)).toBeGreaterThan(0);
   const retrieved=await fetch(`${apiBase}/api/knowledge/retrieve?type=wiki&q=amber-wiki-5724`,{headers:auth});
   expect(retrieved.status,await retrieved.clone().text()).toBe(200);
   const hits=await retrieved.json();
   expect(hits.warnings).toEqual([]);
   expect(hits.items.some((item:{asset_id:string;ref:string})=>item.asset_id===wikiID&&item.ref===search.results[0].path)).toBe(true);
   const readPage=await fetch(`${apiBase}/api/knowledge/assets/${wikiID}?ref=${encodeURIComponent(search.results[0].path)}`,{headers:auth});
   expect(readPage.status,await readPage.clone().text()).toBe(200);
   expect(JSON.stringify(await readPage.json())).toContain('amber-wiki-5724');
  }
  await request('delete',{wiki_ids:[wikiID]});
  wikiID=undefined;
 } finally {
  if(wikiID)await request('delete',{wiki_ids:[wikiID]});
  await fetch(`${apiBase}/api/knowledge/binding`,{method:'DELETE',headers:auth});
  await fetch(`${apiBase}/api/workspaces/${workspace.id}`,{method:'DELETE',headers:auth});
 }
});

test('Skill privacy and ACLs are preserved for two Multica members',async()=>{
 const suffix=`${Date.now()}-${process.pid}`;
 const owner=new TestApiClient();
 const member=new TestApiClient();
 const memberEmail=`knowledge-acl-member-${suffix}@multica.ai`;
 await owner.login(`knowledge-acl-owner-${suffix}@multica.ai`,'Knowledge ACL owner');
 await member.login(memberEmail,'Knowledge ACL member');
 const workspace=await owner.ensureWorkspace('Knowledge ACL',`knowledge-acl-${suffix}`);
 await owner.addWorkspaceMember(memberEmail);
 const scoped=(api:TestApiClient)=>({Authorization:`Bearer ${api.getToken()}`,'X-Workspace-ID':workspace.id,'Content-Type':'application/json'});
 const created=await fetch(`${apiBase}/api/knowledge/binding`,{method:'POST',headers:scoped(owner),body:JSON.stringify({name:`ACL ${suffix}`})});
 expect(created.status,await created.clone().text()).toBe(201);
 const binding=await created.json();
 const sessionFor=async(api:TestApiClient)=>{
  const response=await fetch(`${apiBase}/api/knowledge/panel-session`,{method:'POST',headers:scoped(api)});
  expect(response.status).toBe(200);
  const session=await response.json();
  const ticket=new URLSearchParams(session.url.split('#')[1]).get('session')!;
  const headers={'X-Multica-Knowledge-Session':ticket,'Content-Type':'application/json'};
  const root=`${apiBase}/api/knowledge-panel/${workspace.id}/`;
  const bootstrap=await fetch(root+'bootstrap',{headers});
  expect(bootstrap.status,await bootstrap.clone().text()).toBe(200);
  const identity=await bootstrap.json();
  return {headers,identity,request:(path:string,body:unknown)=>fetch(root+'api/v1/'+path,{method:'POST',headers,body:JSON.stringify(body)})};
 };
 let skillID:string|undefined;
 const privateCandidates:string[]=[];
 const a=await sessionFor(owner);
 const b=await sessionFor(member);
 const scope={team_id:binding.team_id,agent_id:binding.memory_agent_id,user_id:a.identity.session.user.user_id};
 const name=`private-panel-${suffix}`;
 const original=`---\nname: ${name}\ndescription: Private panel evidence\n---\n\n# Private skill\n\nThe private marker is cherry-acl-5832.`;
 try {
  const response=await a.request('skill/create',{...scope,name,content:original});
  expect(response.status,await response.clone().text()).toBe(200);
  const result=await response.json();
  expect(result.code,JSON.stringify(result)).toBe(0);
  skillID=result.data.skill_id;
  expect(skillID).toBeTruthy();
  const privateGet=await b.request('skill/get',{...scope,skill_id:skillID,include_content:true});
  expect(privateGet.status).toBe(403);
  const list=await b.request('skill/list',{...scope,pagination:{limit:100}});
  expect(list.status,await list.clone().text()).toBe(200);
  const listed=await list.json();
  expect(JSON.stringify(listed)).not.toContain('cherry-acl-5832');
  expect(listed.data.items.some((item:{skill_id:string})=>item.skill_id===skillID)).toBe(false);
  const privateRead=await fetch(`${apiBase}/api/knowledge/assets/${skillID}`,{headers:scoped(member)});
  expect(privateRead.status).toBe(404);
  expect(await privateRead.text()).not.toContain('cherry-acl-5832');
  const privateCatalog=await fetch(`${apiBase}/api/knowledge/assets`,{headers:scoped(member)});
  expect(privateCatalog.status).toBe(200);
  expect((await privateCatalog.json()).items.some((asset:{asset_id:string})=>asset.asset_id===skillID)).toBe(false);
  const ownerRead=await fetch(`${apiBase}/api/knowledge/assets/${skillID}`,{headers:scoped(owner)});
  expect(ownerRead.status,await ownerRead.clone().text()).toBe(200);
  expect(JSON.stringify(await ownerRead.json())).toContain('cherry-acl-5832');
  const ownerList=await a.request('skill/list',{...scope,pagination:{limit:100}});
  expect(ownerList.status).toBe(200);
  expect((await ownerList.json()).data.items.some((item:{skill_id:string})=>item.skill_id===skillID)).toBe(true);
  const search=await b.request('skill/search',{...scope,query:'cherry-acl-5832',scope:'team',top_k:50});
  expect(search.status,await search.clone().text()).toBe(200);
  expect(JSON.stringify(await search.json())).not.toContain('cherry-acl-5832');
  const shared=await a.request('meta/asset/update',{asset_id:skillID,visibility:'team'});
  expect(shared.status,await shared.clone().text()).toBe(200);
  const read=await b.request('skill/get',{...scope,skill_id:skillID,include_content:true});
  expect(read.status,await read.clone().text()).toBe(200);
  const detail=await read.json();
  expect(JSON.stringify(detail)).toContain('cherry-acl-5832');
  const memberRead=await fetch(`${apiBase}/api/knowledge/assets/${skillID}`,{headers:scoped(member)});
  expect(memberRead.status,await memberRead.clone().text()).toBe(200);
  expect(JSON.stringify(await memberRead.json())).toContain('cherry-acl-5832');
  const retrieve=await fetch(`${apiBase}/api/knowledge/retrieve?type=skill&q=cherry-acl-5832`,{headers:scoped(member)});
  expect(retrieve.status,await retrieve.clone().text()).toBe(200);
  const retrieved=await retrieve.json();
  expect(retrieved.warnings).toEqual([]);
  expect(retrieved.items.some((hit:{asset_id:string;content:string})=>hit.asset_id===skillID&&hit.content.includes('cherry-acl-5832'))).toBe(true);
  // Private hits must not consume the native top-50 before ACL filtering.
  for(let index=0;index<51;index++) {
   const candidateName=`private-candidate-${suffix}-${index}`;
   const candidate=await a.request('skill/create',{...scope,name:candidateName,content:`---\nname: ${candidateName}\ndescription: Ranked private fixture\n---\n\n${'cherry-acl-5832 '.repeat(100)}`});
   expect(candidate.status,await candidate.clone().text()).toBe(200);
   privateCandidates.push((await candidate.json()).data.skill_id);
  }
  const unrestricted=await a.request('skill/search',{...scope,query:'cherry-acl-5832',scope:'team',top_k:50});
  expect(unrestricted.status).toBe(200);
  const ranked=await unrestricted.json();
  expect(ranked.data.items).toHaveLength(50);
  expect(ranked.data.items.some((hit:{skill_id:string})=>hit.skill_id===skillID)).toBe(false);
  const scopedSearch=await fetch(`${apiBase}/api/knowledge/retrieve?type=skill&q=cherry-acl-5832`,{headers:scoped(member)});
  expect(scopedSearch.status,await scopedSearch.clone().text()).toBe(200);
  const scopedHits=await scopedSearch.json();
  expect(scopedHits.warnings).toEqual([]);
  expect(scopedHits.items.map((hit:{asset_id:string})=>hit.asset_id)).toEqual([skillID]);
  const changed=original.replace('cherry-acl-5832','cherry-acl-approved');
  const write=await b.request('skill/update',{...scope,skill_id:skillID,expected_version:detail.data.version,content:changed});
  expect(write.status,await write.clone().text()).toBe(403);
  const grant=await a.request('meta/acl/grant',{asset_id:skillID,subject_type:'user',subject_id:b.identity.session.user.user_id,permission:'write',effect:'allow',granted_by:a.identity.session.user.user_id});
  expect(grant.status,await grant.clone().text()).toBe(200);
  const approved=await b.request('skill/update',{...scope,skill_id:skillID,expected_version:detail.data.version,content:changed});
  expect(approved.status,await approved.clone().text()).toBe(200);
  expect((await approved.json()).code).toBe(0);
 } finally {
  for(const id of privateCandidates)await a.request('skill/delete',{...scope,skill_id:id});
  if(skillID)await a.request('skill/delete',{...scope,skill_id:skillID});
  await fetch(`${apiBase}/api/knowledge/binding`,{method:'DELETE',headers:scoped(owner)});
  await fetch(`${apiBase}/api/workspaces/${workspace.id}`,{method:'DELETE',headers:scoped(owner)});
 }
});

test('native CodeGraph builds a repository, searches symbols and supports deletion',async()=>{
 test.setTimeout(120_000);
 const api=new TestApiClient();
 const suffix=`${Date.now()}-${process.pid}`;
 await api.login(`knowledge-code-${suffix}@multica.ai`,'Knowledge CodeGraph');
 const workspace=await api.ensureWorkspace('Knowledge CodeGraph',`knowledge-code-${suffix}`);
 const auth={Authorization:`Bearer ${api.getToken()}`,'X-Workspace-ID':workspace.id,'Content-Type':'application/json'};
 const created=await fetch(`${apiBase}/api/knowledge/binding`,{method:'POST',headers:auth,body:JSON.stringify({name:`Code ${suffix}`})});
 expect(created.status,await created.clone().text()).toBe(201);
 const binding=await created.json();
 const sessionResponse=await fetch(`${apiBase}/api/knowledge/panel-session`,{method:'POST',headers:auth});
 expect(sessionResponse.status).toBe(200);
 const session=await sessionResponse.json();
 const token=new URLSearchParams(session.url.split('#')[1]).get('session')!;
 const headers={'X-Multica-Knowledge-Session':token,'Content-Type':'application/json'};
 const root=`${apiBase}/api/knowledge-panel/${workspace.id}/api/v1/knowledge/code-graph/`;
 const request=async(path:string,body:unknown)=>{
  const response=await fetch(root+path,{method:'POST',headers,body:JSON.stringify(body)});
  const text=await response.text();
  expect(response.status,text).toBe(200);
  const envelope=JSON.parse(text);
  expect(envelope.code,text).toBe(0);
  return envelope.data;
 };
 let codeID:string|undefined;
 try {
  const code=await request('create',{team_id:binding.team_id,repo_url:'https://github.com/jonschlinkert/is-number.git',branch:'master',repo_name:`is-number-${suffix}`});
  codeID=code.code_graph_id;
  expect(codeID).toBeTruthy();
  await expect.poll(async()=>{
   const detail=await request('get',{code_graph_id:codeID});
   expect(detail.status,JSON.stringify(detail)).not.toBe('failed');
   return detail.status;
  },{timeout:90_000,intervals:[1000,3000]}).toBe('ready');
  const search=await request('search',{code_graph_id:codeID,query:'isNumber'});
  expect(search.isError,JSON.stringify(search)).not.toBe(true);
  expect(search.text).toContain('index.js');
  expect(search.text).not.toMatch(/no (matches|results|symbols) found/i);
  const catalog=await fetch(`${apiBase}/api/knowledge/assets`,{headers:auth});
  expect(catalog.status).toBe(200);
  expect((await catalog.json()).items.some((item:{asset_id:string;asset_type:string})=>item.asset_id===codeID&&item.asset_type==='code_graph')).toBe(true);
  const retrieved=await fetch(`${apiBase}/api/knowledge/retrieve?type=code_graph&q=isNumber`,{headers:auth});
  expect(retrieved.status,await retrieved.clone().text()).toBe(200);
  const result=await retrieved.json();
  expect(result.warnings).toEqual([]);
  expect(result.items.some((item:{asset_id:string;content:string})=>item.asset_id===codeID&&item.content.includes('index.js'))).toBe(true);
  const noHit=await fetch(`${apiBase}/api/knowledge/retrieve?type=code_graph&q=nonexistentsymbolorchard94765`,{headers:auth});
  expect(noHit.status).toBe(200);
  expect((await noHit.json()).items).toEqual([]);
  const readCode=await fetch(`${apiBase}/api/knowledge/assets/${codeID}?q=isNumber`,{headers:auth});
  expect(readCode.status,await readCode.clone().text()).toBe(200);
  const read=await readCode.json();
  expect(read.isError).not.toBe(true);
  expect(read.text).toContain('index.js');
  await request('delete',{code_graph_ids:[codeID]});
  codeID=undefined;
 } finally {
  if(codeID)await request('delete',{code_graph_ids:[codeID]});
  await fetch(`${apiBase}/api/knowledge/binding`,{method:'DELETE',headers:auth});
  await fetch(`${apiBase}/api/workspaces/${workspace.id}`,{method:'DELETE',headers:auth});
 }
});

test('workspace role changes and removal revoke panel management without losing member reads',async()=>{
 const suffix=`${Date.now()}-${process.pid}`;
 const originalOwner=new TestApiClient();const newOwner=new TestApiClient();
 const email=`knowledge-role-new-${suffix}@multica.ai`;
 await originalOwner.login(`knowledge-role-old-${suffix}@multica.ai`,'Original knowledge owner');
 await newOwner.login(email,'New knowledge owner');
 const workspace=await originalOwner.ensureWorkspace('Knowledge roles',`knowledge-roles-${suffix}`);
 await originalOwner.addWorkspaceMember(email,'admin');
 const headers=(api:TestApiClient)=>({Authorization:`Bearer ${api.getToken()}`,'X-Workspace-ID':workspace.id,'Content-Type':'application/json'});
 const created=await fetch(`${apiBase}/api/knowledge/binding`,{method:'POST',headers:headers(originalOwner),body:JSON.stringify({name:`Roles ${suffix}`})});
 expect(created.status).toBe(201);const binding=await created.json();
 const session=await fetch(`${apiBase}/api/knowledge/panel-session`,{method:'POST',headers:headers(originalOwner)});
 expect(session.status).toBe(200);const data=await session.json();
 const ticket=new URLSearchParams(data.url.split('#')[1]).get('session')!;
 const panelHeaders={'X-Multica-Knowledge-Session':ticket,'Content-Type':'application/json'};
 const root=`${apiBase}/api/knowledge-panel/${workspace.id}/`;
 const membersResponse=await fetch(`${apiBase}/api/workspaces/${workspace.id}/members`,{headers:headers(originalOwner)});
 expect(membersResponse.status).toBe(200);
 const members=await membersResponse.json();
 const oldMember=members.find((member:{role:string})=>member.role==='owner');
 const nextMember=members.find((member:{role:string})=>member.role==='admin');
 expect(oldMember).toBeTruthy();expect(nextMember).toBeTruthy();
 try {
  const promoted=await fetch(`${apiBase}/api/workspaces/${workspace.id}/members/${nextMember.id}`,{method:'PATCH',headers:headers(originalOwner),body:JSON.stringify({role:'owner'})});
  expect(promoted.status,await promoted.clone().text()).toBe(200);
  const demoted=await fetch(`${apiBase}/api/workspaces/${workspace.id}/members/${oldMember.id}`,{method:'PATCH',headers:headers(newOwner),body:JSON.stringify({role:'member'})});
  expect(demoted.status,await demoted.clone().text()).toBe(200);
  const bootstrap=await fetch(root+'bootstrap',{headers:panelHeaders});
  expect(bootstrap.status,await bootstrap.clone().text()).toBe(200);
  const nativeManage=await fetch(root+'api/v1/meta/team/update',{method:'POST',headers:panelHeaders,body:JSON.stringify({team_id:binding.team_id,name:'Unauthorized rename'})});
  expect(nativeManage.status).toBe(403);
  const catalog=await fetch(`${apiBase}/api/knowledge/assets`,{headers:headers(originalOwner)});
  expect(catalog.status,await catalog.clone().text()).toBe(200);
  const removed=await fetch(`${apiBase}/api/workspaces/${workspace.id}/members/${oldMember.id}`,{method:'DELETE',headers:headers(newOwner)});
  expect(removed.status,await removed.clone().text()).toBe(204);
  const revoked=await fetch(root+'bootstrap',{headers:panelHeaders});
  expect(revoked.status).toBe(401);
  const denied=await fetch(`${apiBase}/api/knowledge/assets`,{headers:headers(originalOwner)});
  expect(denied.status).toBe(404);
  const remaining=await fetch(`${apiBase}/api/knowledge/assets`,{headers:headers(newOwner)});
  expect(remaining.status,await remaining.clone().text()).toBe(200);
 }finally{
  await fetch(`${apiBase}/api/knowledge/binding`,{method:'DELETE',headers:headers(newOwner)});
  await fetch(`${apiBase}/api/workspaces/${workspace.id}`,{method:'DELETE',headers:headers(newOwner)});
 }
});

test('a metadata alias cannot expose another space\'s persisted Wiki content',async()=>{
 const api=new TestApiClient();
 const suffix=`${Date.now()}-${process.pid}`;
 await api.login(`knowledge-alias-${suffix}@multica.ai`,'Knowledge alias');
 const alpha=await api.ensureWorkspace('Alias Alpha',`alias-alpha-${suffix}`);
 const auth={Authorization:`Bearer ${api.getToken()}`,'Content-Type':'application/json'};
 const betaResponse=await fetch(`${apiBase}/api/workspaces`,{method:'POST',headers:auth,body:JSON.stringify({name:'Alias Beta',slug:`alias-beta-${suffix}`})});
 expect(betaResponse.status).toBe(201);
 const beta=await betaResponse.json();
 const scoped=(id:string)=>({...auth,'X-Workspace-ID':id});
 const setup=async(workspace:{id:string},name:string)=>{
  const bound=await fetch(`${apiBase}/api/knowledge/binding`,{method:'POST',headers:scoped(workspace.id),body:JSON.stringify({name})});
  expect(bound.status).toBe(201);
  const binding=await bound.json();
  const session=await fetch(`${apiBase}/api/knowledge/panel-session`,{method:'POST',headers:scoped(workspace.id)});
  expect(session.status).toBe(200);
  const ticket=new URLSearchParams((await session.json()).url.split('#')[1]).get('session')!;
  const root=`${apiBase}/api/knowledge-panel/${workspace.id}/`;
  const headers={'Content-Type':'application/json','X-Multica-Knowledge-Session':ticket};
  const identity=await(await fetch(root+'bootstrap',{headers})).json();
  return {binding,identity,request:(path:string,body:unknown)=>fetch(root+'api/v1/'+path,{method:'POST',headers,body:JSON.stringify(body)})};
 };
 const a=await setup(alpha,`Alias Alpha ${suffix}`);
 const b=await setup(beta,`Alias Beta ${suffix}`);
 let wikiID:string|undefined;
 let personalKey:{key_id:string;key_value:string}|undefined;
 const native=async(path:string,body:unknown)=>{
  const response=await fetch(process.env.MULTICA_AGENT_MEMORY_CORE_URL+'/v3/meta/'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.MULTICA_AGENT_MEMORY_API_KEY,'X-Tdai-Service-Id':a.binding.instance_id,'X-Tdai-User-Key':personalKey!.key_value},body:JSON.stringify(body)});
  expect(response.status).toBe(200);
  expect((await response.json()).code).toBe(0);
 };
 try {
  // A temporary caller-owned key permits restoring the test's native metadata
  // without exposing or changing the backend's managed integration key.
  const keyResponse=await a.request('meta/user-key/create',{name:`Alias test ${suffix}`});
  expect(keyResponse.status).toBe(200);
  personalKey=(await keyResponse.json()).data;
  expect(typeof personalKey?.key_id).toBe('string');
  expect(typeof personalKey?.key_value).toBe('string');
  const created=await b.request('knowledge/wiki/create',{team_id:b.binding.team_id,name:`Alias private source ${suffix}`});
  expect(created.status).toBe(200);
  wikiID=(await created.json()).data.wiki_id;
  const raw=await b.request('knowledge/wiki/raw/write',{team_id:b.binding.team_id,wiki_id:wikiID,files:[{filename:'scope.md',content:'Private Beta content: alias-orchard-8319.'}]});
  expect(raw.status).toBe(200);
  const removed=await b.request('meta/asset/delete',{asset_ids:[wikiID]});
  expect(removed.status).toBe(200);
  const alias=await a.request('meta/asset/create',{asset_id:wikiID,team_id:a.binding.team_id,asset_type:'llm_wiki',name:'Metadata alias',owner_user_id:a.identity.session.user.user_id,source_type:'native',visibility:'team',status:'approved'});
  expect(alias.status).toBe(200);
  const panelRead=await a.request('knowledge/wiki/raw/read',{wiki_id:wikiID,filenames:['scope.md']});
  expect(panelRead.status).toBe(403);
  expect(await panelRead.text()).not.toContain('alias-orchard-8319');
  const read=await fetch(`${apiBase}/api/knowledge/assets/${wikiID}`,{headers:scoped(alpha.id)});
  expect(read.status).toBe(403);
  const retrieve=await fetch(`${apiBase}/api/knowledge/retrieve?type=wiki&q=alias-orchard-8319`,{headers:scoped(alpha.id)});
  expect(retrieve.status).toBe(200);
  const hits=await retrieve.json();
  expect(hits.items).toEqual([]);
  expect(hits.warnings.some((item:{asset_id:string})=>item.asset_id===wikiID)).toBe(true);
 } finally {
  try {
   if(wikiID&&personalKey) {
    await native('asset/delete',{asset_ids:[wikiID]});
    await native('asset/create',{asset_id:wikiID,team_id:b.binding.team_id,asset_type:'llm_wiki',name:'Restored alias test',owner_user_id:a.identity.session.user.user_id,source_type:'native',visibility:'team',status:'approved'});
    const removed=await b.request('knowledge/wiki/delete',{wiki_ids:[wikiID]});
    expect(removed.status).toBe(200);
   }
  } finally {
   try {
    if(personalKey) {const revoke=await a.request('meta/user-key/revoke',{key_id:personalKey.key_id});expect(revoke.status).toBe(200);}
   } finally {
    for(const workspace of [alpha,beta]) {
     await fetch(`${apiBase}/api/knowledge/binding`,{method:'DELETE',headers:scoped(workspace.id)});
     await fetch(`${apiBase}/api/workspaces/${workspace.id}`,{method:'DELETE',headers:auth});
    }
   }
  }
 }
});
