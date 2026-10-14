CREATE TABLE workspace_knowledge (
    workspace_id uuid NOT NULL,
    team_id text NOT NULL,
    instance_id text NOT NULL,
    name text NOT NULL,
    memory_agent_id text NOT NULL,
    memory_user_id text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_extraction (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    issue_id uuid NOT NULL,
    issue_revision bigint NOT NULL,
    instance_id text NOT NULL,
    team_id text NOT NULL,
    memory_agent_id text NOT NULL,
    memory_user_id text NOT NULL,
    issue_snapshot jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'submitted', 'ready', 'failed')),
    attempts integer NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL DEFAULT now(),
    lease_until timestamptz,
    lease_token uuid,
    source_payload jsonb,
    upstream_result jsonb,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
