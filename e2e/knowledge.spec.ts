import { test, expect } from "@playwright/test";
import { TestApiClient } from "./fixtures";

const apiBase = process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.PORT || "8080"}`;

async function call(api: TestApiClient, workspaceId: string, path: string, init?: RequestInit) {
  return fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${api.getToken()}`,
      "X-Workspace-ID": workspaceId,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}

test.describe("connected knowledge services", () => {
test.skip(!process.env.MULTICA_AGENT_MEMORY_CORE_URL, "Requires the separately deployed Core service");
test("knowledge spaces can be created, detached and rebound without crossing workspace boundaries", async () => {
  const suffix = `${Date.now()}-${process.pid}`;
  const owner = new TestApiClient();
  const outsider = new TestApiClient();
  await owner.login(`knowledge-owner-${suffix}@multica.ai`, "Knowledge owner");
  await outsider.login(`knowledge-outsider-${suffix}@multica.ai`, "Knowledge outsider");
  const alpha = await owner.ensureWorkspace("Knowledge Alpha", `knowledge-alpha-${suffix}`);
  const betaResponse = await call(owner, alpha.id, "/api/workspaces", {
    method: "POST", body: JSON.stringify({ name: "Knowledge Beta", slug: `knowledge-beta-${suffix}` }),
  });
  expect(betaResponse.status).toBe(201);
  const beta = await betaResponse.json();
  const foreign = await outsider.ensureWorkspace("Knowledge Foreign", `knowledge-foreign-${suffix}`);
  try {
    const initial = await call(owner, alpha.id, "/api/knowledge");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ configured: true, binding: null });

    const created = await call(owner, alpha.id, "/api/knowledge/binding", {
      method: "POST", body: JSON.stringify({ name: `Knowledge Alpha ${suffix}` }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const binding = await created.json();
    expect(binding.workspace_id).toBe(alpha.id);
    expect(binding.team_id).toBeTruthy();

    const duplicate = await call(owner, beta.id, "/api/knowledge/binding", {
      method: "POST", body: JSON.stringify({ team_id: binding.team_id }),
    });
    expect(duplicate.status, await duplicate.clone().text()).toBe(409);
    expect((await (await call(owner, beta.id, "/api/knowledge")).json()).binding).toBeNull();

    const forbidden = await call(outsider, alpha.id, "/api/knowledge");
    expect([403, 404]).toContain(forbidden.status);
    const inaccessible = await call(outsider, foreign.id, "/api/knowledge/binding", {
      method: "POST", body: JSON.stringify({ team_id: binding.team_id }),
    });
    expect([403, 404]).toContain(inaccessible.status);

    const detached = await call(owner, alpha.id, "/api/knowledge/binding", { method: "DELETE" });
    expect(detached.status).toBe(204);
    const spaces = await call(owner, alpha.id, "/api/knowledge/spaces");
    expect(spaces.status, await spaces.clone().text()).toBe(200);
    expect((await spaces.json()).some((space: { team_id: string }) => space.team_id === binding.team_id)).toBe(true);

    const rebound = await call(owner, alpha.id, "/api/knowledge/binding", {
      method: "POST", body: JSON.stringify({ team_id: binding.team_id }),
    });
    expect(rebound.status, await rebound.clone().text()).toBe(201);
    expect((await rebound.json()).memory_agent_id).toBe(binding.memory_agent_id);
  } finally {
    await call(owner, alpha.id, "/api/knowledge/binding", { method: "DELETE" });
    await fetch(`${apiBase}/api/workspaces/${alpha.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${owner.getToken()}` } });
    await fetch(`${apiBase}/api/workspaces/${beta.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${owner.getToken()}` } });
    await fetch(`${apiBase}/api/workspaces/${foreign.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${outsider.getToken()}` } });
  }
});

test("Done exports issue evidence through the real Codex runtime and makes it retrievable", async () => {
  test.skip(process.env.MULTICA_RUN_REAL_AGENT_SMOKE !== "1", "Requires explicit real-agent account authorization");
  test.setTimeout(360_000);
  const suffix = `${Date.now()}-${process.pid}`;
  const api = new TestApiClient();
  await api.login(`knowledge-extraction-${suffix}@multica.ai`, "Knowledge extraction");
  const workspace = await api.ensureWorkspace("Knowledge extraction", `knowledge-extraction-${suffix}`);
  const created = await call(api, workspace.id, "/api/knowledge/binding", {
    method: "POST", body: JSON.stringify({ name: `Knowledge extraction ${suffix}` }),
  });
  expect(created.status, await created.clone().text()).toBe(201);
  try {
    const issue = await api.createIssue("Use scope headers for workspace isolation", {
      description: "Engineering decision: every knowledge lookup derives team_id, agent_id and user_id from the persisted workspace binding. Never accept these scope IDs from a task's arguments. This prevents an agent from selecting another workspace's knowledge. The test marker is orchard-scope-8427. This issue records the decision and its rationale; it does not claim that every permission test has passed.",
    });
    await api.updateIssue(issue.id, { status: "done" });
    const extraction = async () => {
      const response = await call(api, workspace.id, "/api/knowledge/extractions");
      expect(response.status).toBe(200);
      const jobs = await response.json();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].issue_id).toBe(issue.id);
      expect(jobs[0].status, jobs[0].error ?? "").not.toBe("failed");
      return jobs[0];
    };
    await expect.poll(async () => (await extraction()).status, { timeout: 30_000, intervals: [1000] }).toBe("submitted");
    await expect.poll(async () => {
      const response = await call(api, workspace.id, "/api/knowledge/search?q=workspace%20scope%20isolation");
      expect(response.status, await response.clone().text()).toBe(200);
      const memories = await response.json();
      return memories.map((memory: { content: string; background: string }) => `${memory.content} ${memory.background}`).join("\n");
    }, { timeout: 300_000, intervals: [5000] }).toMatch(/workspace|team_id|scope/i);
    await expect.poll(async () => (await extraction()).status, { timeout: 300_000, intervals: [5000] }).toBe("ready");
    await api.updateIssue(issue.id, { status: "done" });
    expect((await (await call(api, workspace.id, "/api/knowledge/extractions")).json())).toHaveLength(1);
  } finally {
    await api.cleanup();
    await call(api, workspace.id, "/api/knowledge/binding", { method: "DELETE" });
    await fetch(`${apiBase}/api/workspaces/${workspace.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${api.getToken()}` } });
  }
});

test("Knowledge tab creates a space and can detach and rebind it", async ({ page }) => {
  const suffix = `${Date.now()}-${process.pid}`;
  const api = new TestApiClient();
  await api.login(`knowledge-browser-${suffix}@multica.ai`, "Knowledge browser");
  const workspace = await api.ensureWorkspace("Knowledge browser", `knowledge-browser-${suffix}`);
  await api.markUserOnboarded();
  await page.addInitScript((token) => {
    if (window.self !== window.top) return;
    localStorage.setItem("multica_token", token);
    localStorage.setItem("multica:chat:isOpen", "false");
    localStorage.setItem("multica_locale", "en");
  }, api.getToken()!);
  try {
    await page.goto(`/${workspace.slug}/knowledge`);
    const create = page.getByRole("button", { name: /Create space|新建知识空间/ });
    await expect(create).toBeVisible();
    await create.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox").fill(`Browser knowledge ${suffix}`);
    await dialog.getByRole("button", { name: /Create space|新建知识空间/ }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText(`Browser knowledge ${suffix}`, { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: /Extraction history|提取记录/ }).click();
    await expect(page.getByText(/Completed issues will appear|任务完成并开始提取/)).toBeVisible();
    await page.getByRole("button", { name: /Detach space|解除绑定/ }).click();
    await dialog.getByRole("button", { name: /Detach space|解除绑定/ }).click();
    await expect(create).toBeVisible();
    await page.getByRole("button", { name: /Bind existing space|绑定已有空间/ }).click();
    await dialog.getByRole("button", { name: `Browser knowledge ${suffix}`, exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText(`Browser knowledge ${suffix}`, { exact: true })).toBeVisible();
    // Installed clients must render safely when the backend response drifts.
    await page.route("**/api/knowledge", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configured: "unexpected", binding: { name: 42 } }) }));
    await page.reload();
    await expect(page.getByText(/The knowledge service is not configured|尚未配置知识库服务/)).toBeVisible();
    await expect(create).not.toBeVisible();
  } finally {
    await call(api, workspace.id, "/api/knowledge/binding", { method: "DELETE" });
    await fetch(`${apiBase}/api/workspaces/${workspace.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${api.getToken()}` } });
  }
});
});

test("Knowledge tab explains missing configuration and handles response drift", async ({page}) => {
  const suffix=`${Date.now()}-${process.pid}`;
  const api=new TestApiClient();
  await api.login(`knowledge-unconfigured-${suffix}@multica.ai`,"Knowledge setup");
  const workspace=await api.ensureWorkspace("Knowledge setup",`knowledge-setup-${suffix}`);
  await api.markUserOnboarded();
  await page.addInitScript(token=>{
    localStorage.setItem("multica_token",token);
    localStorage.setItem("multica_locale","en");
  },api.getToken()!);
  try {
    await page.route("**/api/knowledge",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({configured:false,binding:null})}));
    await page.goto(`/${workspace.slug}/knowledge`);
    await expect(page.getByText("The knowledge service is not configured.")).toBeVisible();
    await expect(page.getByRole("button",{name:"Create space"})).not.toBeVisible();
    await page.route("**/api/knowledge",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({configured:"unexpected",binding:{name:42}})}));
    await page.reload();
    await expect(page.getByText("The knowledge service is not configured.")).toBeVisible();
  } finally {
    await fetch(`${apiBase}/api/workspaces/${workspace.id}`,{method:"DELETE",headers:{Authorization:`Bearer ${api.getToken()}`}});
  }
});
