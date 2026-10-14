import { test, expect } from "@playwright/test";
import { TestApiClient } from "./fixtures";
const base =
  process.env.NEXT_PUBLIC_API_URL ||
  `http://localhost:${process.env.PORT || 8080}`;
test.skip(
  !process.env.MULTICA_AGENT_MEMORY_CORE_URL,
  "Requires native memory services",
);

test("each agent automatically owns an independent, detachable memory lifecycle", async () => {
  test.setTimeout(120000);
  const api = new TestApiClient();
  const other = new TestApiClient();
  const suffix = `${Date.now()}-${process.pid}`;
  await api.login(`memory-lifecycle-${suffix}@localhost`, "Memory lifecycle");
  const workspace = await api.ensureWorkspace(
    "Memory lifecycle",
    `memory-lifecycle-${suffix}`,
  );
  const headers = {
    Authorization: `Bearer ${api.getToken()}`,
    "X-Workspace-ID": workspace.id,
    "Content-Type": "application/json",
  };
  const call = (path: string, method = "GET", body?: unknown) =>
    fetch(base + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const state = async (id: string) => {
    const r = await call(`/api/agents/${id}/memory`);
    expect(r.status, await r.clone().text()).toBe(200);
    return r.json();
  };
  const list = async () => {
    const r = await call("/api/memories");
    expect(r.status).toBe(200);
    return r.json();
  };
  const bind = async (
    agentId: string,
    memoryId: string | null,
    status = 200,
  ) => {
    const r = await call(`/api/agents/${agentId}/memory`, "PUT", {
      memory_id: memoryId,
    });
    expect(r.status, await r.clone().text()).toBe(status);
  };
  try {
    const a = await api.createAgent("Writer");
    const b = await api.createAgent("Reader");
    await expect
      .poll(async () => (await state(a.id)).binding?.status, {
        timeout: 45000,
        intervals: [500, 1000],
      })
      .toBe("ready");
    await expect
      .poll(async () => (await state(b.id)).binding?.status, {
        timeout: 45000,
        intervals: [500, 1000],
      })
      .toBe("ready");
    const am = (await state(a.id)).binding;
    const bm = (await state(b.id)).binding;
    expect(am.id).not.toBe(bm.id);
    expect(am.native_agent_id).not.toBe(bm.native_agent_id);
    expect((await list()).length).toBe(2);
    const malformed = await call(`/api/agents/${a.id}/memory`, "PUT", {
      memory_id: "not-a-uuid",
    });
    expect(malformed.status).toBe(400);
    for (const body of [{}, null, { memory_id: 17 }]) {
      const response = await call(`/api/agents/${a.id}/memory`, "PUT", body);
      expect(response.status).toBe(400);
      expect((await state(a.id)).binding.id).toBe(am.id);
    }
    await bind(b.id, am.id, 409);
    await bind(a.id, null);
    expect((await state(a.id)).binding).toBeNull();
    expect(
      (await list()).find((m: { id: string }) => m.id === am.id).agent_id,
    ).toBeNull();
    await bind(b.id, am.id);
    expect((await state(b.id)).binding.id).toBe(am.id);
    expect(
      (await list()).find((m: { id: string }) => m.id === bm.id).agent_id,
    ).toBeNull();
    await bind(a.id, bm.id);
    const kept = await call(
      `/api/agents/${a.id}/archive?delete_memory=false`,
      "POST",
    );
    expect(kept.status, await kept.clone().text()).toBe(200);
    expect((await state(a.id)).binding).toBeNull();
    expect(
      (await list()).find((m: { id: string }) => m.id === bm.id),
    ).toBeTruthy();
    const restored = await call(`/api/agents/${a.id}/restore`, "POST");
    expect(restored.status).toBe(200);
    await bind(a.id, bm.id);
    const deleted = await call(
      `/api/agents/${a.id}/archive?delete_memory=true`,
      "POST",
    );
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    await expect
      .poll(
        async () => (await list()).some((m: { id: string }) => m.id === bm.id),
        { timeout: 30000, intervals: [500, 1000] },
      )
      .toBe(false);
    const independent = await call(`/api/memories/${am.id}`, "DELETE");
    expect(independent.status).toBe(202);
    await expect
      .poll(
        async () => (await list()).some((m: { id: string }) => m.id === am.id),
        { timeout: 30000, intervals: [500, 1000] },
      )
      .toBe(false);
    expect((await state(b.id)).binding).toBeNull();
    const bResponse = await call(`/api/agents/${b.id}`);
    expect(bResponse.status).toBe(200);
    expect((await bResponse.json()).archived_at).toBeNull();
    await other.login(`memory-outsider-${suffix}@multica.ai`, "Outsider");
    const forbidden = await fetch(base + "/api/memories", {
      headers: {
        Authorization: `Bearer ${other.getToken()}`,
        "X-Workspace-ID": workspace.id,
      },
    });
    expect([403, 404]).toContain(forbidden.status);
  } finally {
    await fetch(base + `/api/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers,
    });
  }
});

test("concurrent binding preserves the exclusive memory owner and the losing binding", async () => {
  test.setTimeout(60000);
  const api = new TestApiClient();
  const suffix = `${Date.now()}-${process.pid}`;
  await api.login(`memory-race-${suffix}@localhost`, "Memory race");
  const workspace = await api.ensureWorkspace(
    "Memory race",
    `memory-race-${suffix}`,
  );
  const headers = {
    Authorization: `Bearer ${api.getToken()}`,
    "X-Workspace-ID": workspace.id,
    "Content-Type": "application/json",
  };
  const call = (path: string, method = "GET", body?: unknown) =>
    fetch(base + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const a = await api.createAgent("Concurrent A");
    const b = await api.createAgent("Concurrent B");
    const created = await call("/api/memories", "POST", {
      name: "Exclusive memory",
    });
    expect(created.status).toBe(201);
    const spare = await created.json();
    const original = new Map<string, string>();
    for (const id of [a.id, b.id]) {
      const response = await call(`/api/agents/${id}/memory`);
      original.set(id, (await response.json()).binding.id);
    }
    const responses = await Promise.all(
      [a.id, b.id].map(async (id) => ({
        id,
        response: await call(`/api/agents/${id}/memory`, "PUT", {
          memory_id: spare.id,
        }),
      })),
    );
    expect(responses.map((r) => r.response.status).sort()).toEqual([200, 409]);
    for (const result of responses) {
      const state = await (
        await call(`/api/agents/${result.id}/memory`)
      ).json();
      expect(state.binding.id).toBe(
        result.response.status === 200 ? spare.id : original.get(result.id),
      );
    }
  } finally {
    await fetch(base + `/api/workspaces/${workspace.id}`, {
      method: "DELETE",
      headers,
    });
  }
});
