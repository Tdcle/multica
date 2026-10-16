import { test, expect } from "@playwright/test";
import { TestApiClient } from "./fixtures";

const renderer = process.env.DESKTOP_RENDERER_URL;
const apiBase = process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.PORT || 8080}`;
test.use({ actionTimeout: 10000 });
test.skip(!renderer || !process.env.MULTICA_AGENT_MEMORY_CORE_URL, "Requires desktop renderer and native Memory services");

test("desktop Memory restores each tab's page, selection and scroll after remount", async ({ page }, testInfo) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const api = new TestApiClient();
  const suffix = `${Date.now()}-${process.pid}`;
  await api.login(`memory-position-${suffix}@localhost`, "Memory position");
  const workspace = await api.ensureWorkspace("Memory position", `memory-position-${suffix}`);
  await api.markUserOnboarded();
  const headers = { Authorization: `Bearer ${api.getToken()}`, "X-Workspace-ID": workspace.id, "Content-Type": "application/json" };
  const post = (url: string, body: unknown, h = headers) => fetch(url, { method: "POST", signal: AbortSignal.timeout(15000), headers: h, body: JSON.stringify(body) });
  let panel: ((path: string, body: unknown) => Promise<any>) | undefined;
  let skillId: string | undefined;
  let nativeTeam: string | undefined;
  let wikiId: string | undefined;
  try {
    const agent = await api.createAgent("Position space");
    const memory = async () => (await (await fetch(apiBase + `/api/agents/${agent.id}/memory`, { headers })).json()).binding;
    await expect.poll(async () => (await memory())?.status, { timeout: 45000 }).toBe("ready");
    const binding = (await (await fetch(apiBase + "/api/knowledge", { headers })).json()).binding;
    nativeTeam = binding.team_id;
    const session = await (await post(apiBase + "/api/knowledge/panel-session", {})).json();
    const ticket = new URLSearchParams(session.url.split("#")[1]).get("session")!;
    const root = `${apiBase}/api/knowledge-panel/${workspace.id}/`;
    const panelHeaders = { "Content-Type": "application/json", "X-Multica-Knowledge-Session": ticket };
    panel = async (path, body) => {
      const response = await post(root + "api/v1/" + path, body, panelHeaders);
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.code, JSON.stringify(result)).toBe(0);
      return result.data;
    };
    const bootstrap = await (await fetch(root + "bootstrap", { headers: panelHeaders })).json();
    skillId = (await panel("skill/create", {
      team_id: binding.team_id, user_id: bootstrap.session.user.user_id,
      name: "position-fixture", content: "---\nname: position-fixture\ndescription: Position fixture\n---\n\n" + Array.from({ length: 180 }, (_, i) => `## Paragraph ${i}\n\nMemory position regression fixture.\n\n`).join(""),
    })).skill_id;
    await panel("meta/asset/update", { asset_id: skillId, visibility: "team" });
    // Exercise the real desktop App/router/tab coordinator in Chromium. Only
    // Electron IPC is inert: no user daemon, agent CLI or credentials are touched.
    await page.addInitScript(({ token, apiBase, renderer }) => {
      if (window.self !== window.top) return;
      localStorage.setItem("multica_token", token);
      localStorage.setItem("multica:chat:isOpen", "false");
      const noEvents = () => () => {};
      const ipc = (overrides: Record<string, unknown>) => new Proxy(overrides, { get: (object, key: string) => object[key] ?? (key.startsWith("on") ? noEvents : async () => null) });
      Object.assign(window, {
        desktopAPI: ipc({ appInfo: { version: "e2e", os: "macos" }, systemLocale: "en", windowContext: { kind: "main" }, runtimeConfig: { ok: true, config: { apiUrl: apiBase, wsUrl: apiBase.replace("http", "ws") + "/ws", appUrl: renderer } }, getLastFreeze: () => null }),
        daemonAPI: ipc({ getStatus: async () => ({ state: "stopped" }) }),
        updater: ipc({ getPreferences: async () => ({ autoUpdate: false }) }),
      });
    }, { token: api.getToken()!, apiBase, renderer: renderer! });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(renderer!);
    // Use the actual platform store for deterministic tab setup. Tab switching
    // below uses the same visible tab buttons a person clicks.
    const tabs = await page.evaluate(async slug => {
      // @ts-expect-error Vite serves the real desktop source in this E2E.
      const { useTabStore } = await import("/src/stores/tab-store.ts");
      const store = useTabStore.getState();
      store.switchWorkspace(slug);
      const memory = store.addTab(`/${slug}/knowledge`, "Memory");
      const other = store.addTab(`/${slug}/issues`, "Issues");
      store.setActiveTab(memory);
      return { memory, other };
    }, workspace.slug);
    const frame = () => page.frameLocator("iframe");
    await expect(frame().locator(".multica-memory-nav")).toBeVisible();
    await frame().getByRole("button", { name: /^Skip$|跳过/ }).click();
    await frame().locator(".multica-memory-nav-item").nth(3).click();
    await frame().locator("._alp-item-btn", { hasText: "position-fixture" }).click();
    const pane = () => frame().locator("._memory-skill-detail-scroll");
    await expect(pane().getByRole("heading", { name: "Paragraph 179", exact: true })).toBeAttached();
    await pane().evaluate(element => { element.scrollTop = 620; });
    await expect.poll(() => pane().evaluate(element => element.scrollTop)).toBe(620);
    // Wait for the user-visible position to reach the existing tab memento.
    await expect.poll(() => page.evaluate(async id => {
      // @ts-expect-error Vite source import.
      const { useTabStore } = await import("/src/stores/tab-store.ts");
      const state = useTabStore.getState();
      const tab = state.byWorkspace[state.activeWorkspaceSlug].tabs.find((t: { id: string }) => t.id === id);
      return Object.values(tab.memento.view).some(value => String(value).includes('"top":620'));
    }, tabs.memory)).toBe(true);
    const switchTo = async (id: string) => {
      const index = await page.evaluate(async id => {
        // @ts-expect-error Vite source import.
        const { useTabStore } = await import("/src/stores/tab-store.ts");
        const state = useTabStore.getState();
        return state.byWorkspace[state.activeWorkspaceSlug].tabs.findIndex((tab: { id: string }) => tab.id === id);
      }, id);
      await page.locator('button[aria-roledescription="sortable"]').nth(index).click();
    };
    await switchTo(tabs.other);
    await expect(page.locator("iframe")).toHaveCount(0);
    await switchTo(tabs.memory);
    await expect(pane().getByRole("heading", { name: "Paragraph 179", exact: true })).toBeAttached();
    await expect.poll(() => pane().evaluate(element => element.scrollTop)).toBe(620);
    await expect(frame().locator("._alp-item--selected")).toContainText("position-fixture");
    // A second Memory tab starts independently and does not overwrite tab one.
    const second = await page.evaluate(async slug => {
      // @ts-expect-error Vite source import.
      const { useTabStore } = await import("/src/stores/tab-store.ts");
      return useTabStore.getState().addTab(`/${slug}/knowledge`, "Memory two");
    }, workspace.slug);
    await switchTo(second);
    await expect(frame().locator(".multica-memory-nav")).toBeVisible();
    await expect.poll(() => page.frames().find(f => f.url().includes("/api/knowledge-panel/"))?.url()).toContain("#/memory");
    await frame().locator(".multica-memory-nav-item").nth(4).click();
    await switchTo(tabs.memory);
    await expect.poll(() => pane().evaluate(element => element.scrollTop)).toBe(620);
    await switchTo(second);
    await expect(frame().getByRole("heading", { name: "Knowledge Spaces", exact: true })).toBeVisible();
    // Memory's own selected block and layer also survive list reloading.
    await frame().locator(".multica-memory-nav-item").nth(0).click();
    await frame().locator("._alp-item-btn").first().click();
    await frame().locator("._memory-detail-layer-btn").filter({ hasText: "L2" }).click();
    await switchTo(tabs.other);
    await switchTo(second);
    await expect(frame().locator("._alp-item--selected")).toContainText("Memory of Position space");
    await expect(frame().locator("._memory-detail-layer-btn--active")).toContainText("L2");
    // Wiki keeps its selected document, re-fetching its content under the new session.
    wikiId = (await panel("knowledge/wiki/create", { team_id: binding.team_id, name: "position-wiki" })).wiki_id;
    expect(wikiId).toBeTruthy();
    await panel("knowledge/wiki/raw/write", { team_id: binding.team_id, wiki_id: wikiId,
      files: [{ filename: "position.md", content: "# Position document\n\nA restored Wiki document.\n\n" + "Wiki position paragraph.\n\n".repeat(150) }],
    });
    await frame().locator(".multica-memory-nav-item").nth(1).click();
    await frame().getByText("Team Wiki Pool", { exact: true }).click();
    await frame().locator("._asset-wiki-card-name", { hasText: "position-wiki" }).click();
    await frame().locator("._wiki-detail-tab-label").filter({ hasText: /^Pages$/ }).click();
    await frame().locator("._wiki-detail-rawfiles-item button").filter({ hasText: "position.md" }).click();
    await expect(frame().getByText("A restored Wiki document.", { exact: true })).toBeVisible();
    await frame().locator("._wiki-detail-split-content").evaluate(element => { element.scrollTop = 480; });
    await switchTo(tabs.other);
    await switchTo(second);
    await expect(frame().locator("._wiki-detail-content-title")).toHaveText("position.md");
    await expect.poll(() => frame().locator("._wiki-detail-split-content").evaluate(element => element.scrollTop)).toBe(480);
    await expect(frame().getByText("A restored Wiki document.", { exact: true })).toBeAttached();
    // Explicit reload renews the session without discarding this tab's position.
    await switchTo(tabs.memory);
    await page.evaluate(async () => {
      // @ts-expect-error Vite source import.
      const { useTabStore } = await import("/src/stores/tab-store.ts");
      useTabStore.getState().reloadActiveTab();
    });
    await expect.poll(() => pane().evaluate(element => element.scrollTop)).toBe(620);
    await page.screenshot({ path: testInfo.outputPath("memory-tab-position.png") });
    expect(errors).toEqual([]);
  } catch (error) {
    await testInfo.attach("position-failure", { body: await page.screenshot(), contentType: "image/png" });
    const embedded = page.frames().find(frame => frame.url().includes("/api/knowledge-panel/"));
    if (embedded) await testInfo.attach("position-state", { body: JSON.stringify(await embedded.evaluate(() => ({
      route: location.hash,
      // @ts-expect-error Native iframe diagnostic, containing only view metadata.
      restored: window.__MULTICA_PANEL_CONTEXT__?.view_state,
      selected: document.querySelector("._alp-item--selected")?.textContent,
      body: document.body.innerText.slice(0, 700),
    }))), contentType: "application/json" });
    throw error;
  } finally {
    if (wikiId && panel) await panel("knowledge/wiki/delete", { wiki_ids: [wikiId] });
    if (skillId && panel) await panel("skill/delete", { skill_id: skillId });
    await fetch(apiBase + `/api/workspaces/${workspace.id}`, { method: "DELETE", headers });
    if (nativeTeam) {
      const native = async (action: string, body: unknown) => {
        const result = await post(process.env.MULTICA_AGENT_MEMORY_CORE_URL + "/v3/meta/" + action, body, {
          Authorization: "Bearer " + process.env.MULTICA_AGENT_MEMORY_API_KEY,
          "Content-Type": "application/json", "X-Tdai-Service-Id": process.env.MULTICA_AGENT_MEMORY_INSTANCE_ID || "default",
          "X-Tdai-User-Key": process.env.MULTICA_AGENT_MEMORY_ADMIN_KEY!,
        });
        expect(result.status).toBe(200);
        return (await result.json()).data;
      };
      const admin = await native("auth/verify", { user_key: process.env.MULTICA_AGENT_MEMORY_ADMIN_KEY });
      await native("team/managed-owner", { team_id: nativeTeam, user_id: admin.user.user_id });
      await native("team/delete", { team_ids: [nativeTeam] });
    }
  }
});
