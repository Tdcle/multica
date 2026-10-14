import { z } from "zod";

export const KnowledgeBindingSchema = z
  .object({
    workspace_id: z.string().min(1),
    team_id: z.string().min(1),
    instance_id: z.string().min(1),
    name: z.string(),
    memory_agent_id: z.string().optional().default(""),
    panel_available: z.boolean().optional().default(false),
  })
  .transform((value) => ({
    workspaceId: value.workspace_id,
    teamId: value.team_id,
    instanceId: value.instance_id,
    name: value.name,
    memoryAgentId: value.memory_agent_id,
    panelAvailable: value.panel_available,
  }));
export type KnowledgeBinding = z.infer<typeof KnowledgeBindingSchema>;

export const KnowledgeStateSchema = z.object({
  configured: z.boolean(),
  binding: KnowledgeBindingSchema.nullable(),
});
export type KnowledgeState = z.infer<typeof KnowledgeStateSchema>;

export const KnowledgeSpaceListSchema = z.array(
  z
    .object({
      team_id: z.string().min(1),
      name: z.string(),
      owner_user_id: z.string().min(1),
    })
    .transform((value) => ({
      id: value.team_id,
      name: value.name,
      ownerId: value.owner_user_id,
    })),
);
export type KnowledgeSpace = z.infer<typeof KnowledgeSpaceListSchema>[number];

export const KnowledgeExtractionListSchema = z.array(
  z
    .object({
      id: z.string().min(1),
      issue_id: z.string().min(1),
      issue_revision: z.number(),
      issue_title: z.string().optional().default(""),
      status: z.string(),
      attempts: z.number(),
      error: z.string().nullable(),
      created_at: z.string(),
      updated_at: z.string(),
    })
    .transform((value) => ({
      id: value.id,
      issueId: value.issue_id,
      issueRevision: value.issue_revision,
      issueTitle: value.issue_title,
      status: value.status,
      attempts: value.attempts,
      error: value.error,
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    })),
);
export type KnowledgeExtraction = z.infer<
  typeof KnowledgeExtractionListSchema
>[number];

export const KnowledgePanelSessionSchema = z
  .object({
    url: z
      .string()
      .regex(
        /^\/api\/knowledge-panel\/[0-9a-f-]{36}\/#session=[A-Za-z0-9_-]+$/i,
      ),
    expires_at: z.string(),
  })
  .transform((value) => ({ url: value.url, expiresAt: value.expires_at }));
export type KnowledgePanelSession = z.infer<typeof KnowledgePanelSessionSchema>;

export const AgentMemorySchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    status: z.string(),
    error: z.string().nullable().optional().default(null),
    agent_id: z.string().nullable().optional().default(null),
    native_agent_id: z.string().optional().default(""),
    created_at: z.string(),
  })
  .transform((v) => ({
    id: v.id,
    name: v.name,
    status: v.status,
    error: v.error,
    agentId: v.agent_id,
    nativeAgentId: v.native_agent_id,
    createdAt: v.created_at,
  }));
export type AgentMemory = z.infer<typeof AgentMemorySchema>;
export const AgentMemoryListSchema = z.array(AgentMemorySchema);
export const AgentMemoryStateSchema = z.object({
  configured: z.boolean().optional().default(false),
  binding: AgentMemorySchema.nullable(),
});
export type AgentMemoryState = z.infer<typeof AgentMemoryStateSchema>;
