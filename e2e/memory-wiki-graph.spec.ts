import { test, expect } from '@playwright/test';
import { TestApiClient } from './fixtures';

const apiBase=process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.PORT || 8080}`;
test.skip(!process.env.MULTICA_AGENT_MEMORY_CORE_URL || !process.env.MULTICA_AGENT_MEMORY_PANEL_URL || !process.env.MULTICA_AGENT_MEMORY_KNOWLEDGE_URL,'Requires native Memory services');

test('Wiki graph loads its lazy script and stylesheet inside the scoped Memory panel',async({page})=>{
 const api=new TestApiClient();
 const suffix=`${Date.now()}-${process.pid}`;
 await api.login(`wiki-graph-${suffix}@localhost`,'Wiki graph regression');
 const workspace=await api.ensureWorkspace('Wiki graph regression',`wiki-graph-${suffix}`);
 const headers={Authorization:`Bearer ${api.getToken()}`,'X-Workspace-ID':workspace.id,'Content-Type':'application/json'};
 const response=await fetch(apiBase+'/api/knowledge/binding',{method:'POST',headers,body:JSON.stringify({name:`Graph ${suffix}`})});
 expect(response.status,await response.clone().text()).toBe(201);
 const binding=await response.json();
 const session=await fetch(apiBase+'/api/knowledge/panel-session',{method:'POST',headers});expect(session.status).toBe(200);
 const ticket=new URLSearchParams((await session.json()).url.split('#')[1]).get('session')!;
 const panelHeaders={'X-Multica-Knowledge-Session':ticket,'Content-Type':'application/json'};
 const prefix=`/api/knowledge-panel/${workspace.id}/`;
 const panel=async(path:string,body:unknown)=>{
  const r=await fetch(apiBase+prefix+'api/v1/'+path,{method:'POST',headers:panelHeaders,body:JSON.stringify(body)});
  expect(r.status,await r.clone().text()).toBe(200);const envelope=await r.json();expect(envelope.code).toBe(0);return envelope.data;
 };
 let wikiID:string|undefined;
 try {
  const name=`Graph fixture ${suffix}`;
  const wiki=await panel('knowledge/wiki/create',{team_id:binding.team_id,name});wikiID=wiki.wiki_id;
  // The lazy graph bundle must load even for a newly created, empty Wiki.
  await api.markUserOnboarded();
  const errors:string[]=[],assetFailures:string[]=[],graphAssets:{url:string;status:number;type:string}[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('requestfailed',request=>{if(request.url().includes('/assets/'))assetFailures.push(request.url());});
  page.on('response',response=>{
   if(response.url().includes('/assets/')&&response.status()>=400)assetFailures.push(response.url());
   if(/\/KnowledgeGraph-[^/]+\.(css|js)$/.test(response.url()))graphAssets.push({url:response.url(),status:response.status(),type:response.headers()['content-type'] || ''});
  });
  await page.addInitScript(token=>{if(window.self!==window.top)return;localStorage.setItem('multica_token',token);localStorage.setItem('multica:chat:isOpen','false');},api.getToken()!);
  const openGraph=async(skipGuide:boolean)=>{
   const frame=page.frameLocator('iframe');
   await expect(frame.locator('._memory-app-shell')).toBeVisible();
   if(skipGuide)await frame.getByRole('button',{name:/^Skip$|跳过/}).click();
   await frame.locator('._memory-app-shell').getByText(/^(Wiki Knowledge Base|Wiki 知识库)$/).first().click();
   await frame.getByText(/^(Team Wiki Pool|团队 Wiki 池)$/).click();
   await frame.locator('._asset-wiki-card-name').filter({hasText:name}).click();
   await frame.locator('._wiki-detail-tab-label').filter({hasText:/^(Graph|图谱)$/}).click({timeout:5000});
   await expect(frame.locator('._wiki-detail-graph-embed')).toContainText(/No graph data|暂无图谱数据/);
   await expect(frame.getByText(/Unexpected Application Error|Unable to preload CSS/)).toHaveCount(0);
  };
  await page.goto(`/${workspace.slug}/knowledge`);await openGraph(true);
  await page.reload();await openGraph(false);
  expect(graphAssets.some(asset=>asset.type.includes('text/css'))).toBe(true);
  expect(graphAssets.some(asset=>asset.type.includes('javascript'))).toBe(true);
  for(const asset of graphAssets){expect(asset.status,asset.url).toBe(200);expect(new URL(asset.url).pathname).toMatch(new RegExp('^'+prefix+'assets/KnowledgeGraph-'));}
  expect(assetFailures).toEqual([]);expect(errors).toEqual([]);
 }finally{
  if(wikiID)await panel('knowledge/wiki/delete',{wiki_ids:[wikiID]});
  await fetch(apiBase+`/api/workspaces/${workspace.id}`,{method:'DELETE',headers});
 }
});
