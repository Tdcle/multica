BEGIN;
CREATE TABLE agent_memory (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    owner_id uuid NOT NULL,
    initial_agent_id uuid,
    instance_id text NOT NULL DEFAULT '',
    team_id text NOT NULL DEFAULT '',
    native_agent_id text NOT NULL DEFAULT '',
    native_user_id text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','failed','deleting')),
    attempts integer NOT NULL DEFAULT 0,
    last_error text,
    available_at timestamptz NOT NULL DEFAULT now(),
    lease_until timestamptz,
    lease_token uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agent_memory_binding (
    workspace_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    memory_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Retain existing native memory as an independently managed, unbound resource.
INSERT INTO agent_memory (workspace_id,name,owner_id,instance_id,team_id,native_agent_id,native_user_id,status)
SELECT workspace_id,name,created_by,instance_id,team_id,memory_agent_id,memory_user_id,'ready'
FROM workspace_knowledge WHERE memory_agent_id <> '';
INSERT INTO agent_memory (workspace_id,name,owner_id,initial_agent_id)
SELECT workspace_id,name,owner_id,id FROM agent
WHERE archived_at IS NULL AND owner_id IS NOT NULL AND COALESCE(system_key,'') = '';
INSERT INTO agent_memory_binding (workspace_id,agent_id,memory_id)
SELECT workspace_id,initial_agent_id,id FROM agent_memory WHERE initial_agent_id IS NOT NULL;
CREATE FUNCTION initialize_agent_memory() RETURNS trigger AS $$
DECLARE memory_uuid uuid;
BEGIN
    IF NEW.archived_at IS NULL AND NEW.owner_id IS NOT NULL AND COALESCE(NEW.system_key,'') = '' THEN
        INSERT INTO agent_memory (workspace_id,name,owner_id,initial_agent_id)
        VALUES (NEW.workspace_id,NEW.name,NEW.owner_id,NEW.id) RETURNING id INTO memory_uuid;
        INSERT INTO agent_memory_binding (workspace_id,agent_id,memory_id)
        VALUES (NEW.workspace_id,NEW.id,memory_uuid);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER initialize_agent_memory AFTER INSERT ON agent FOR EACH ROW EXECUTE FUNCTION initialize_agent_memory();
ALTER TABLE knowledge_extraction ADD COLUMN agent_id uuid;
ALTER TABLE knowledge_extraction ADD COLUMN memory_id uuid;
ALTER TABLE knowledge_extraction ADD COLUMN binding_created_at timestamptz;
ALTER TABLE knowledge_extraction DROP CONSTRAINT knowledge_extraction_status_check;
ALTER TABLE knowledge_extraction ADD CONSTRAINT knowledge_extraction_status_check CHECK (status IN ('pending','processing','submitted','ready','failed','cancelled'));
UPDATE knowledge_extraction SET status='cancelled', lease_token=NULL, lease_until=NULL,
    last_error='Extraction was superseded by agent-scoped memory.', updated_at=now()
WHERE status IN ('pending','processing','submitted');
DROP INDEX knowledge_extraction_issue_idx;
CREATE OR REPLACE FUNCTION enqueue_issue_knowledge() RETURNS trigger AS $$
DECLARE previous_category text; next_category text;
BEGIN
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
    SELECT category INTO previous_category FROM issue_status WHERE workspace_id=OLD.workspace_id AND key=OLD.status;
    SELECT category INTO next_category FROM issue_status WHERE workspace_id=NEW.workspace_id AND key=NEW.status;
    IF COALESCE(next_category,NEW.status)='done' AND COALESCE(previous_category,OLD.status)<>'done' THEN
        -- The binding row lock serializes completion with detach/rebind/deletion.
        INSERT INTO knowledge_extraction (workspace_id,issue_id,issue_revision,instance_id,team_id,
            memory_agent_id,memory_user_id,issue_snapshot,agent_id,memory_id,binding_created_at)
        SELECT NEW.workspace_id,NEW.id,NEW.revision,m.instance_id,m.team_id,m.native_agent_id,m.native_user_id,
            jsonb_build_object('id',NEW.id,'number',NEW.number,'title',NEW.title,'description',NEW.description,
                'project_id',NEW.project_id,'assignee_type',NEW.assignee_type,'assignee_id',NEW.assignee_id,'revision',NEW.revision),
            b.agent_id,m.id,b.created_at
        FROM agent_memory_binding b JOIN agent_memory m ON m.id=b.memory_id AND m.workspace_id=b.workspace_id
        JOIN agent a ON a.id=b.agent_id AND a.workspace_id=b.workspace_id AND a.archived_at IS NULL
        WHERE b.workspace_id=NEW.workspace_id AND m.status<>'deleting' AND (
            EXISTS (SELECT 1 FROM agent_task_queue t WHERE t.issue_id=NEW.id AND t.agent_id=b.agent_id AND t.created_at<=NEW.updated_at)
            OR (NEW.assignee_type='agent' AND NEW.assignee_id=b.agent_id AND NOT EXISTS (
                SELECT 1 FROM agent_task_queue t WHERE t.issue_id=NEW.id AND t.created_at<=NEW.updated_at)))
        FOR SHARE OF b,m ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
COMMIT;
