import { test, expect } from "@playwright/test";
import { TestApiClient } from "./fixtures";

const apiBase =
  process.env.NEXT_PUBLIC_API_URL ||
  `http://localhost:${process.env.PORT || 8080}`;
test.skip(
  !process.env.MULTICA_AGENT_MEMORY_CORE_URL ||
    !process.env.MULTICA_AGENT_MEMORY_KNOWLEDGE_URL,
  "Requires native Memory services",
);

test.use({
  actionTimeout: 10000,
  screenshot: "only-on-failure",
  launchOptions: {
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  },
});

test("Memory shares Multica appearance across pages, dialogs, graph and live theme changes", async ({
  page,
}, testInfo) => {
  const realIngestion = process.env.MULTICA_RUN_REAL_AGENT_SMOKE === "1";
  test.setTimeout(realIngestion ? 420000 : 120000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const api = new TestApiClient();
  const suffix = `${Date.now()}-${process.pid}`;
  await api.login(`memory-appearance-${suffix}@localhost`, "Memory appearance");
  const workspace = await api.ensureWorkspace(
    "Memory appearance",
    `memory-appearance-${suffix}`,
  );
  const headers = {
    Authorization: `Bearer ${api.getToken()}`,
    "X-Workspace-ID": workspace.id,
    "Content-Type": "application/json",
  };
  const post = (url: string, body: unknown, requestHeaders = headers) =>
    fetch(url, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(body),
    });
  const errors: string[] = [],
    failedAssets: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/assets/") && response.status() >= 400)
      failedAssets.push(response.url());
  });
  let wikiID: string | undefined, skillID: string | undefined;
  let panel: ((path: string, body: unknown) => Promise<any>) | undefined;
  try {
    const agent = await api.createAgent("Memory designer");
    const memory = async () =>
      (
        await (
          await fetch(apiBase + `/api/agents/${agent.id}/memory`, { headers })
        ).json()
      ).binding;
    await expect
      .poll(async () => (await memory())?.status, { timeout: 45000 })
      .toBe("ready");
    const binding = (
      await (await fetch(apiBase + "/api/knowledge", { headers })).json()
    ).binding;
    const session = await post(apiBase + "/api/knowledge/panel-session", {});
    expect(session.status).toBe(200);
    const ticket = new URLSearchParams(
      (await session.json()).url.split("#")[1],
    ).get("session")!;
    const root = `${apiBase}/api/knowledge-panel/${workspace.id}/`;
    const panelHeaders = {
      "Content-Type": "application/json",
      "X-Multica-Knowledge-Session": ticket,
    };
    const bootstrap = await (
      await fetch(root + "bootstrap", { headers: panelHeaders })
    ).json();
    panel = async (path, body) => {
      const response = await post(root + "api/v1/" + path, body, panelHeaders);
      expect(response.status, await response.clone().text()).toBe(200);
      const envelope = await response.json();
      expect(envelope.code, JSON.stringify(envelope)).toBe(0);
      return envelope.data;
    };
    const scope = {
      team_id: binding.team_id,
      agent_id: (await memory()).native_agent_id,
      user_id: bootstrap.session.user.user_id,
    };
    // Store fixture messages without invoking extraction or a model.
    const conversation = await post(
      process.env.MULTICA_AGENT_MEMORY_CORE_URL + "/v3/conversation/add",
      {
        ...scope,
        session_id: "appearance-" + suffix,
        task_id: "appearance-" + suffix,
        defer_pipeline: true,
        messages: [
          {
            role: "user",
            content:
              "Use Multica typography, neutral surfaces and accessible controls.",
          },
          {
            role: "assistant",
            content:
              "The Memory console follows the workspace theme. Keep source attribution and Markdown readable.",
          },
        ],
      },
      {
        "Content-Type": "application/json",
        Authorization: "Bearer " + process.env.MULTICA_AGENT_MEMORY_API_KEY,
        "X-Tdai-Service-Id": binding.instance_id,
      },
    );
    expect(conversation.status).toBe(200);
    skillID = (
      await panel("skill/create", {
        ...scope,
        name: "memory-design-guide",
        content:
          '---\nname: memory-design-guide\ndescription: Visual regression fixture\n---\n\n# Memory design\n\nUse **Multica** surfaces and `semantic tokens`.\n\n| Control | Purpose |\n| --- | --- |\n| Search | Recall experience |\n\n```ts\nconst theme = "multica";\n```',
      })
    ).skill_id;
    await api.markUserOnboarded();
    await page.addInitScript((token) => {
      if (window.self !== window.top) return;
      localStorage.setItem("multica_token", token);
      localStorage.setItem("multica:chat:isOpen", "false");
    }, api.getToken()!);
    await page.goto(`/${workspace.slug}/knowledge`);
    const frame = page.frameLocator("iframe");
    await expect(frame.locator(".multica-memory-nav")).toBeVisible();
    await frame.getByRole("button", { name: /^Skip$|跳过/ }).click();
    const embedded = page
      .frames()
      .find((item) => item.url().includes("/api/knowledge-panel/"))!;
    await embedded.evaluate(() => document.fonts.ready);
    expect(
      await embedded.evaluate(() =>
        document.fonts.check('14px "Inter Variable"'),
      ),
    ).toBe(true);
    const navigate = async (route: string) => {
      const routes = [
        "/memory",
        "/wiki",
        "/code",
        "/skills",
        "/team/agents",
        "/team/members",
      ];
      if (route === "/guide")
        await frame.locator("._memory-global-header-guide-btn").click();
      else
        await frame
          .locator(".multica-memory-nav-item")
          .nth(routes.indexOf(route))
          .click();
      await expect(frame.locator("._memory-page-frame")).toBeVisible();
      await expect.poll(() => embedded.url()).toContain("#" + route);
      await expect(frame.locator(".tea-layout__sider")).toHaveCount(0);
      await expect(frame.locator("._memory-tabbar")).toHaveCount(0);
    };
    const checkSurface = async () => {
      const readAppearance = () => {
        const probe = document.createElement("span");
        probe.style.color = "var(--page-canvas)";
        document.body.append(probe);
        const canvas = getComputedStyle(probe).color;
        probe.style.color = "var(--foreground)";
        const foreground = getComputedStyle(probe).color;
        probe.remove();
        return {
          canvas,
          foreground,
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
        };
      };
      const host = await page.evaluate(readAppearance);
      const child = await embedded.evaluate(readAppearance);
      expect(child.canvas).toBe(host.canvas);
      expect(child.foreground).toBe(host.foreground);
      expect(child.overflow).toBe(false);
    };
    const closeDialog = async () => {
      await frame.locator(".tea-dialog__header .tea-btn--icon").click();
      await expect(frame.locator(".tea-dialog")).toHaveCount(0);
    };
    const screenshot = async (name: string) => {
      const popups = frame.locator(".tea-dialog__inner:visible");
      const bounds = (await popups.count())
        ? await popups.first().boundingBox()
        : null;
      if (bounds) {
        const viewport = await page.locator("iframe").boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(viewport!.x);
        expect(bounds.y).toBeGreaterThanOrEqual(viewport!.y);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(
          viewport!.x + viewport!.width + 1,
        );
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(
          viewport!.y + viewport!.height + 1,
        );
      }
      await frame
        .locator("._memory-app-shell")
        .screenshot({ path: testInfo.outputPath(name + ".png") });
    };

    // Create an actual Wiki using the redesigned form, then seed linked pages for the real graph.
    await navigate("/wiki");
    await frame
      .getByRole("radio", { name: /Team Wiki Pool|团队 Wiki 池/ })
      .click();
    await frame.locator('[data-guide="create-wiki"]').click();
    const dialog = frame.locator(".tea-dialog");
    await expect(dialog).toBeVisible();
    await dialog.locator("input").first().fill("Memory visual guide");
    await screenshot("wiki-create-light");
    await dialog.locator(".tea-dialog__footer .tea-btn").first().click();
    await expect(dialog).toHaveCount(0);
    const wikis = await panel("knowledge/wiki/list", {
      team_id: binding.team_id,
    });
    wikiID = wikis.items.find(
      (item: { name: string }) => item.name === "Memory visual guide",
    )?.wiki_id;
    expect(wikiID).toBeTruthy();
    if (realIngestion) {
      await panel("knowledge/wiki/raw/write", {
        wiki_id: wikiID,
        team_id: binding.team_id,
        files: [
          {
            filename: "memory-design.md",
            content:
              "# Multica Memory\n\nMultica is a project workspace for human and agent teams. Every agent has a memory container. Multiple agents can share the same container. The Memory console uses Multica typography and semantic colors. It follows the workspace light or dark theme. Completed tasks extract memories; future tasks recall relevant experience.\n\nThe workspace is the permission boundary. Members keep their native display names. Removed members lose access to the console and recalled memory. Wiki knowledge pages link the concepts of workspace, agent memory and shared experience.",
          },
        ],
      });
      await panel("knowledge/wiki/ingest", { wiki_id: wikiID });
      await expect
        .poll(
          async () => {
            const result = await panel!("knowledge/wiki/get", {
              wiki_id: wikiID,
            });
            expect(result.status, JSON.stringify(result)).not.toBe("failed");
            return result.status;
          },
          { timeout: 300000, intervals: [1000, 3000, 5000] },
        )
        .toBe("ready");
    }
    const pages = await post(
      process.env.MULTICA_AGENT_MEMORY_KNOWLEDGE_URL + "/v3/wiki/page/write",
      {
        team_id: binding.team_id,
        wiki_id: wikiID,
        pages: [
          {
            ref: "entities/multica",
            content:
              "---\ntitle: Multica\ntype: entity\n---\n# Multica\n\nUses [[concepts/memory]] to preserve team experience.",
          },
          {
            ref: "concepts/memory",
            content:
              "---\ntitle: Agent memory\ntype: concept\n---\n# Agent memory\n\nBelongs to [[entities/multica]]. Supports **recall** and `source attribution`.",
          },
        ],
      },
      {
        "Content-Type": "application/json",
        Authorization:
          "Bearer " + process.env.MULTICA_AGENT_MEMORY_KNOWLEDGE_KEY,
        "X-Tdai-Service-Id": binding.instance_id,
      },
    );
    expect(pages.status, await pages.clone().text()).toBe(200);
    const graph = await panel("knowledge/wiki/graph", { wiki_id: wikiID });
    if (realIngestion) expect(graph.nodes.length).toBeGreaterThan(0);
    await testInfo.attach("graph-data", {
      body: JSON.stringify(graph, null, 2),
      contentType: "application/json",
    });

    for (const dark of [false, true]) {
      const theme = dark ? "dark" : "light";
      await page.evaluate(
        (value) => document.documentElement.classList.toggle("dark", value),
        dark,
      );
      await expect
        .poll(() =>
          embedded.evaluate(() =>
            document.documentElement.classList.contains("dark"),
          ),
        )
        .toBe(dark);
      for (const route of [
        "/memory",
        "/wiki",
        "/code",
        "/skills",
        "/team/agents",
        "/team/members",
        "/guide",
      ]) {
        await navigate(route);
        await checkSurface();
        if (route === "/memory") {
          await frame.locator("._alp-item-btn").first().click();
          await expect(frame.locator("._memory-detail")).toBeVisible();
          await screenshot(`memory-${theme}`);
          for (const layer of ["L0", "L1", "L2", "L3"]) {
            await frame
              .locator("._memory-detail-layer-btn")
              .filter({ hasText: layer })
              .click();
            await expect(frame.locator("._memory-detail")).toBeVisible();
          }
          await frame
            .getByRole("button", { name: /Import Memory|导入记忆/ })
            .click();
          await expect(frame.locator(".tea-dialog")).toBeVisible();
          await frame.locator(".tea-dialog textarea").fill("invalid JSON");
          await expect(
            frame.locator(".tea-dialog__footer .tea-btn").first(),
          ).toBeDisabled();
          await screenshot(`memory-import-${theme}`);
          await closeDialog();
        } else if (route === "/wiki") {
          await frame.getByText(/^(Team Wiki Pool|团队 Wiki 池)$/).click();
          await frame
            .locator("._asset-wiki-card-name")
            .filter({ hasText: "Memory visual guide" })
            .click();
          await frame
            .locator("._wiki-detail-tab-label")
            .filter({ hasText: /^(Graph|图谱)$/ })
            .click();
          if (graph.nodes.length > 0)
            await expect(
              frame.locator("._wiki-detail-graph-embed canvas").first(),
            ).toBeVisible();
          else
            await expect(
              frame.locator("._wiki-detail-graph-embed"),
            ).toContainText(/No graph data|暂无图谱数据/);
          await screenshot(`wiki-graph-${theme}`);
          if (graph.nodes.length > 0) {
            const stage = frame.locator("._wiki-detail-graph-embed");
            await stage
              .getByRole("button", { name: /^(Community|社区)$/ })
              .click();
            await expect(
              stage.getByRole("button", { name: /^(Community|社区)$/ }),
            ).toHaveAttribute("aria-pressed", "true");
            await stage.getByRole("button", { name: /^(Type|类型)$/ }).click();
            const node = graph.nodes.find(
              (item: { type: string }) => item.type === "entity",
            );
            if (node) {
              await stage
                .getByPlaceholder(/Search nodes|搜索节点/)
                .fill(node.label);
              await stage
                .getByText(node.label, { exact: true })
                .first()
                .click();
              await expect(
                frame.locator("._wiki-detail-side-title"),
              ).toHaveText(node.label);
              await screenshot(`wiki-node-${theme}`);
            }
          }
          await frame
            .locator("._wiki-detail-tab-label")
            .filter({ hasText: /^(Pages|页面)$/ })
            .click();
          await screenshot(`wiki-pages-${theme}`);
        } else if (route === "/code") {
          await frame
            .getByRole("radio", {
              name: /Team Code Pool|团队 Code 池|团队代码池/,
            })
            .click();
          await frame.locator('[data-guide="create-code"]').click();
          await expect(frame.locator(".tea-dialog")).toBeVisible();
          await screenshot(`code-create-${theme}`);
          await closeDialog();
        } else if (route === "/skills") {
          await frame.locator("._alp-item-btn").first().click();
          await expect(
            frame.locator("._memory-skill-detail-card"),
          ).toContainText("Memory design");
          await screenshot(`skill-detail-${theme}`);
          await frame.locator('[data-guide="import-skill"]').click();
          await expect(frame.locator(".tea-dialog")).toBeVisible();
          await screenshot(`skill-import-${theme}`);
          await closeDialog();
        } else if (route === "/team/agents") {
          await screenshot(`agents-${theme}`);
          await frame
            .locator('[data-guide="agent-name-editable"]')
            .first()
            .click();
          await expect(frame.locator(".tea-dialog")).toBeVisible();
          await screenshot(`agent-detail-${theme}`);
          await closeDialog();
        } else if (route === "/guide") {
          for (let index = 0; index < 3; index++) {
            await frame.locator(".guide-main-tabs button").nth(index).click();
            await checkSurface();
          }
          await screenshot(`guide-${theme}`);
        } else {
          await screenshot(`${route.split("/").pop()}-${theme}`);
        }
        await expect(
          frame.getByText(/Unexpected Application Error|Unable to preload CSS/),
        ).toHaveCount(0);
      }
      await frame.locator("._memory-global-header-icon-btn").click();
      await expect(frame.locator(".tea-dialog")).toBeVisible();
      await screenshot(`settings-${theme}`);
      await closeDialog();
      await frame.locator("._memory-global-header-user-btn").click();
      await frame
        .getByText(/^(My Profile|Profile|我的资料)$/)
        .first()
        .click();
      await expect(frame.locator(".tea-dialog")).toBeVisible();
      await screenshot(`profile-${theme}`);
      await closeDialog();
    }
    for (const width of [900, 560, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of ["/memory", "/wiki", "/code", "/skills"]) {
        await navigate(route);
        await checkSurface();
      }
      await navigate("/memory");
      await screenshot(`responsive-${width}`);
    }
    expect(failedAssets).toEqual([]);
    expect(errors).toEqual([]);
  } catch (error) {
    await testInfo.attach("memory-failure", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await testInfo.attach("browser-errors", {
      body: JSON.stringify(errors),
      contentType: "application/json",
    });
    throw error;
  } finally {
    try {
      if (wikiID && panel)
        await panel("knowledge/wiki/delete", { wiki_ids: [wikiID] });
      if (skillID && panel) await panel("skill/delete", { skill_id: skillID });
    } finally {
      await fetch(apiBase + `/api/workspaces/${workspace.id}`, {
        method: "DELETE",
        headers,
      });
    }
  }
});
